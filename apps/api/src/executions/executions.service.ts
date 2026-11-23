import { BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { PLANNER_VERSION, parseChaosProfile, serializeDeliveryPlan, type ChaosProfile, type DeliveryAttempt } from '@dataforge/chaos';
import {
  ActualStateValidationError,
  ActualWindowsValidationError,
  canonicalJson,
  fileEntry,
  parseActualState,
  parseActualWindows,
  serializeActualState,
  serializeActualWindows,
  type ActualState,
  type ActualWindows,
  type FileEntry,
} from '@dataforge/core';
import {
  DELIVERY_FILES,
  KAFKA_DELIVERY_FILES,
  PLAN_FILES,
  VALIDATION_REPORT_FILE,
  buildValidationReport,
  deliverySummaryFileSchema,
  reportPlanOf,
  reportSourceOf,
  serializeResolvedProfile,
  serializeValidationReport,
  validateExecution,
  type DeliverySummaryFile,
  type KafkaRunFile,
  type TargetRunFile,
  type ValidationReport,
} from '@dataforge/execution';
import { serializeDeliveryLog, type DeliveryLogEntry } from '@dataforge/kafka';
import { chaosProfileNotFound } from '../chaos-profiles/chaos-profiles.service';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { RunIntegrityError } from '../runs/run-integrity';
import { runNotFound } from '../runs/runs.service';
import { loadIntactRun } from '../runs/stored-run';
import { deliveryLogEntryOf, fromAttemptRow } from './attempt-rows';
import { ExecutionIntegrityError } from './execution-integrity';
import type {
  AttemptsQuery,
  ExecutionStatusName,
  FindingsQuery,
  ListExecutionsQuery,
  StartExecutionRequest,
  SubmitActualStateRequest,
  WindowFindingsQuery,
} from './execution-requests';
import { executionTargetSchema } from './execution-requests';
import { ExecutionRunner } from './execution-runner';
import type { AttemptView, AttemptsView, ExecutionListView, ExecutionSummaryView, ExecutionView, FindingsView, ReportView, WindowFindingsView } from './execution-views';
import { ExecutionStatusConflictError, PrismaExecutionStore } from './prisma-execution-store';
import { findingOf, fromReportRows, windowFindingOf } from './report-rows';

/** Every file an execution can have, in the order they are made. */
export const EXECUTION_FILE_NAMES = [
  PLAN_FILES.plan,
  PLAN_FILES.profile,
  PLAN_FILES.summary,
  KAFKA_DELIVERY_FILES.deliveryLog,
  KAFKA_DELIVERY_FILES.kafkaRun,
  DELIVERY_FILES.actualState,
  DELIVERY_FILES.actualWindows,
  DELIVERY_FILES.targetRun,
  VALIDATION_REPORT_FILE,
] as const;
export type ExecutionFileName = (typeof EXECUTION_FILE_NAMES)[number];

export interface ExecutionFileDownload {
  readonly name: ExecutionFileName;
  readonly content: string;
  readonly contentType: string;
}

const withInputs = {
  run: { select: { id: true, seed: true, scenarioVersion: { select: { version: true, scenario: { select: { id: true, name: true } } } } } },
  chaosProfileVersion: { select: { version: true, profileHash: true, chaosProfile: { select: { id: true, name: true } } } },
} as const satisfies Prisma.TestExecutionInclude;

type ExecutionRecord = Prisma.TestExecutionGetPayload<{ include: typeof withInputs }>;

/** Statuses in which the plan and the delivery are stored. */
const DELIVERED: readonly ExecutionStatusName[] = ['awaiting_actual_state', 'completed'];

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger('Executions');
  private readonly store: PrismaExecutionStore;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ExecutionRunner) private readonly runner: ExecutionRunner,
  ) {
    this.store = new PrismaExecutionStore(prisma);
  }

  /** Records a queued execution and hands it to the background runner; the caller follows it with GET /executions/:id. */
  async start(request: StartExecutionRequest): Promise<ExecutionView> {
    const run = await this.prisma.simulationRun.findUnique({ where: { id: request.runId }, select: { id: true, status: true } });
    if (run === null) {
      throw runNotFound(request.runId);
    }
    if (run.status !== 'succeeded') {
      throw new ConflictException(`Run ${run.id} is ${run.status}; start an execution once it has succeeded.`);
    }
    const profile = await this.prisma.chaosProfile.findUnique({ where: { id: request.chaosProfileId }, select: { id: true } });
    if (profile === null) {
      throw chaosProfileNotFound(request.chaosProfileId);
    }
    const version = await this.prisma.chaosProfileVersion.findFirst({
      where: { chaosProfileId: profile.id, ...(request.chaosProfileVersion === undefined ? {} : { version: request.chaosProfileVersion }) },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (version === null) {
      throw new NotFoundException(`Chaos profile ${profile.id} has no version ${String(request.chaosProfileVersion)}.`);
    }
    const execution = await this.prisma.testExecution.create({
      data: {
        runId: run.id,
        chaosProfileVersionId: version.id,
        chaosSeed: request.chaosSeed,
        plannerVersion: PLANNER_VERSION,
        target: request.target,
      },
      select: { id: true },
    });
    const queued = await this.get(execution.id);
    this.runner.enqueue(execution.id);
    return queued;
  }

  async list(query: ListExecutionsQuery): Promise<ExecutionListView> {
    const where: Prisma.TestExecutionWhereInput = {
      ...(query.runId === undefined ? {} : { runId: query.runId }),
      ...(query.chaosProfileId === undefined ? {} : { chaosProfileVersion: { chaosProfileId: query.chaosProfileId } }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.verdict === undefined ? {} : { verdict: query.verdict }),
    };
    const [executions, total] = await Promise.all([
      this.prisma.testExecution.findMany({ where, include: withInputs, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], skip: query.offset, take: query.limit }),
      this.prisma.testExecution.count({ where }),
    ]);
    return { executions: executions.map(summaryView), total, limit: query.limit, offset: query.offset };
  }

  async get(id: string): Promise<ExecutionView> {
    const execution = await this.prisma.testExecution.findUnique({ where: { id }, include: withInputs });
    if (execution === null) {
      throw executionNotFound(id);
    }
    const stored = await this.prisma.executionFile.findMany({ where: { executionId: id }, select: { name: true, document: true, sha256: true, bytes: true } });
    const documents = new Map(stored.map((file) => [file.name, file]));
    const summary = documents.get(PLAN_FILES.summary)?.document as DeliverySummaryFile | undefined;
    const targetRun = documents.get(DELIVERY_FILES.targetRun)?.document as TargetRunFile | undefined;
    const kafkaRun = documents.get(KAFKA_DELIVERY_FILES.kafkaRun)?.document as KafkaRunFile | undefined;
    const report = await this.prisma.validationReport.findUnique({ where: { executionId: id }, select: { sha256: true, bytes: true } });

    const files: Record<string, FileEntry> = {};
    for (const name of EXECUTION_FILE_NAMES) {
      const entry =
        name === PLAN_FILES.plan || name === PLAN_FILES.profile
          ? summary?.files[name]
          : name === KAFKA_DELIVERY_FILES.deliveryLog
            ? kafkaRun?.files[name]
            : name === VALIDATION_REPORT_FILE
              ? (report ?? undefined)
              : documents.get(name);
      if (entry !== undefined) {
        files[name] = { sha256: entry.sha256, bytes: entry.bytes };
      }
    }
    return {
      ...summaryView(execution),
      delivery: summary?.summary ?? null,
      targetResult:
        targetRun === undefined ? null : { delivery: targetRun.delivery, counters: targetRun.counters, parkedEvents: targetRun.parkedEventIds.length },
      kafka:
        kafkaRun === undefined
          ? null
          : {
              topic: kafkaRun.kafka.topic,
              groupId: kafkaRun.kafka.groupId,
              partitions: kafkaRun.kafka.partitions,
              sent: kafkaRun.execution.sent,
              plannedFailures: kafkaRun.execution.plannedFailures,
              durationMs: kafkaRun.execution.durationMs,
              lagZeroAfterMs: kafkaRun.completion.lagZeroAfterMs,
            },
      workDirectory: execution.workDirectory,
      files,
    };
  }

  async attempts(id: string, query: AttemptsQuery): Promise<AttemptsView> {
    await this.requireStatus(id, DELIVERED, 'its delivery attempts exist once it has been delivered');
    const rows = await this.prisma.deliveryAttempt.findMany({
      where: {
        executionId: id,
        deliverySequence: { gte: query.fromSequence },
        ...(query.eventId === undefined ? {} : { eventId: query.eventId }),
        ...(query.aggregateId === undefined ? {} : { aggregateId: query.aggregateId }),
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.plannedOutcome === undefined ? {} : { plannedOutcome: query.plannedOutcome }),
        ...(query.fault === undefined ? {} : { faults: { array_contains: [{ type: query.fault }] } }),
      },
      orderBy: { deliverySequence: 'asc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const attempts = this.integrityChecked(id, () =>
      page.map((row): AttemptView => {
        const log = deliveryLogEntryOf(row);
        return {
          ...fromAttemptRow(row, id),
          kafka:
            log === undefined
              ? null
              : {
                  outcome: log.outcome,
                  partition: log.partition,
                  offset: log.offset,
                  dueAtMs: log.dueAtMs,
                  startedAtMs: log.startedAtMs,
                  ackedAtMs: log.ackedAtMs,
                  driftMs: log.driftMs,
                },
        };
      }),
    );
    const next = rows[query.limit];
    return { executionId: id, attempts, nextSequence: next === undefined ? null : next.deliverySequence };
  }

  async report(id: string): Promise<ReportView> {
    await this.requireStatus(id, ['completed'], 'its report exists once it has completed');
    const stored = await this.prisma.validationReport.findUnique({ where: { executionId: id }, select: { document: true } });
    if (stored === null) {
      throw this.asIntegrityFailure(id, new ExecutionIntegrityError(`Execution ${id} completed but has no validation report.`));
    }
    const { findings: _findings, windows, ...rest } = stored.document as unknown as ValidationReport;
    if (windows === undefined) {
      return rest;
    }
    const { findings: _windowFindings, ...windowSummary } = windows;
    return { ...rest, windows: windowSummary };
  }

  async findings(id: string, query: FindingsQuery): Promise<FindingsView> {
    await this.requireStatus(id, ['completed'], 'its findings exist once it has completed');
    const where: Prisma.ValidationFindingWhereInput = {
      executionId: id,
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.validationFinding.findMany({ where, orderBy: { ordinal: 'asc' }, skip: query.offset, take: query.limit }),
      this.prisma.validationFinding.count({ where }),
    ]);
    return { executionId: id, findings: rows.map((row) => ({ ordinal: row.ordinal, ...findingOf(row) })), total, limit: query.limit, offset: query.offset };
  }

  async windowFindings(id: string, query: WindowFindingsQuery): Promise<WindowFindingsView> {
    await this.requireStatus(id, ['completed'], 'its window findings exist once it has completed');
    const where: Prisma.WindowFindingWhereInput = { executionId: id, ...(query.category === undefined ? {} : { category: query.category }) };
    const [rows, total] = await Promise.all([
      this.prisma.windowFinding.findMany({ where, orderBy: { ordinal: 'asc' }, skip: query.offset, take: query.limit }),
      this.prisma.windowFinding.count({ where }),
    ]);
    return {
      executionId: id,
      findings: rows.map((row) => ({ ordinal: row.ordinal, ...windowFindingOf(row) })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Validates the actual state an external pipeline reports, against the run and with the hints of
   * the plan it was delivered, and completes the execution. Nothing changes when the submission is
   * invalid (400) or the execution is not waiting for it (409).
   */
  async submitActualState(id: string, submission: SubmitActualStateRequest): Promise<ExecutionView> {
    const execution = await this.prisma.testExecution.findUnique({
      where: { id },
      select: { status: true, runId: true, chaosProfileVersion: { select: { definition: true } } },
    });
    if (execution === null) {
      throw executionNotFound(id);
    }
    if (execution.status !== 'awaiting_actual_state') {
      throw new ConflictException(`Execution ${id} is ${execution.status}; only an external execution awaiting its actual state accepts one.`);
    }
    const profile = parseChaosProfile(execution.chaosProfileVersion.definition);
    const { actual, actualWindows } = parseSubmission(submission, profile);

    const { summary, attempts } = await this.integrityCheckedAsync(id, () => this.loadIntactPlan(id));
    const run = await this.integrityCheckedAsync(id, () => loadIntactRun(this.prisma, execution.runId));
    const result = validateExecution({
      events: run.events,
      expected: run.expected,
      actual,
      ...(profile.windowing === undefined || actualWindows === undefined ? {} : { windows: { windowing: profile.windowing, actual: actualWindows } }),
      attempts,
    });
    const report = buildValidationReport({ source: reportSourceOf(run.manifest), target: null, plan: reportPlanOf(summary), result });
    const files = [
      { name: DELIVERY_FILES.actualState, text: serializeActualState(actual) },
      ...(actualWindows === undefined ? [] : [{ name: DELIVERY_FILES.actualWindows, text: serializeActualWindows(actualWindows) }]),
    ];
    try {
      await this.store.completeSubmission(id, { files, report });
    } catch (error) {
      if (error instanceof ExecutionStatusConflictError) {
        throw new ConflictException(`Execution ${id} no longer awaits its actual state (another submission completed it).`);
      }
      throw error;
    }
    return this.get(id);
  }

  /** Rebuilds one file of the execution from the database and sends it only when it matches the checksum recorded when it was made. */
  async readFile(id: string, name: ExecutionFileName): Promise<ExecutionFileDownload> {
    const status = await this.requireStatus(id, DELIVERED, 'its files exist once it has been delivered');
    const content = await this.integrityCheckedAsync(id, () => this.rebuildFile(id, name, status));
    return { name, content, contentType: name.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8' };
  }

  private async rebuildFile(id: string, name: ExecutionFileName, status: ExecutionStatusName): Promise<string> {
    switch (name) {
      case PLAN_FILES.plan:
        return (await this.loadIntactPlan(id)).text;
      case PLAN_FILES.profile: {
        const summary = await this.loadSummary(id);
        const version = await this.prisma.testExecution.findUniqueOrThrow({ where: { id }, select: { chaosProfileVersion: { select: { definition: true } } } });
        const text = serializeResolvedProfile(parseChaosProfile(version.chaosProfileVersion.definition));
        return checked(id, name, text, summary.files[PLAN_FILES.profile]);
      }
      case KAFKA_DELIVERY_FILES.deliveryLog: {
        const kafkaRun = (await this.loadDocument(id, KAFKA_DELIVERY_FILES.kafkaRun, status)) as KafkaRunFile;
        const rows = await this.prisma.deliveryAttempt.findMany({ where: { executionId: id }, orderBy: { deliverySequence: 'asc' } });
        const entries = rows.map((row): DeliveryLogEntry => {
          const entry = deliveryLogEntryOf(row);
          if (entry === undefined) {
            throw new ExecutionIntegrityError(`Stored attempt ${row.deliverySequence} of execution ${id} has no Kafka outcome.`);
          }
          return entry;
        });
        return checked(id, name, serializeDeliveryLog(entries), kafkaRun.files[KAFKA_DELIVERY_FILES.deliveryLog]);
      }
      case VALIDATION_REPORT_FILE: {
        const stored = await this.prisma.validationReport.findUnique({ where: { executionId: id } });
        if (stored === null) {
          throw absentFile(id, name, status);
        }
        const [findings, windowFindings] = await Promise.all([
          this.prisma.validationFinding.findMany({ where: { executionId: id }, orderBy: { ordinal: 'asc' } }),
          this.prisma.windowFinding.findMany({ where: { executionId: id }, orderBy: { ordinal: 'asc' } }),
        ]);
        const report = fromReportRows(stored.document as unknown as ValidationReport, findings, windowFindings);
        return checked(id, name, serializeValidationReport(report), stored);
      }
      default: {
        const stored = await this.prisma.executionFile.findUnique({ where: { executionId_name: { executionId: id, name } } });
        if (stored === null) {
          throw absentFile(id, name, status);
        }
        return checked(id, name, `${canonicalJson(stored.document, 2)}\n`, stored);
      }
    }
  }

  /** delivery-summary.json, checked against its own recorded checksum. */
  private async loadSummary(id: string): Promise<DeliverySummaryFile> {
    const stored = await this.prisma.executionFile.findUnique({ where: { executionId_name: { executionId: id, name: PLAN_FILES.summary } } });
    if (stored === null) {
      throw new ExecutionIntegrityError(`Execution ${id} was delivered but has no ${PLAN_FILES.summary}.`);
    }
    checked(id, PLAN_FILES.summary, `${canonicalJson(stored.document, 2)}\n`, stored);
    const parsed = deliverySummaryFileSchema.safeParse(stored.document);
    if (!parsed.success) {
      throw new ExecutionIntegrityError(`The stored ${PLAN_FILES.summary} of execution ${id} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`);
    }
    return parsed.data;
  }

  /** The plan rebuilt from its rows, checked against the checksum in delivery-summary.json. */
  private async loadIntactPlan(id: string): Promise<{ summary: DeliverySummaryFile; attempts: DeliveryAttempt[]; text: string }> {
    const summary = await this.loadSummary(id);
    const rows = await this.prisma.deliveryAttempt.findMany({ where: { executionId: id }, orderBy: { deliverySequence: 'asc' } });
    const attempts = rows.map((row) => fromAttemptRow(row, id));
    const text = checked(id, PLAN_FILES.plan, serializeDeliveryPlan(attempts), summary.files[PLAN_FILES.plan]);
    return { summary, attempts, text };
  }

  private async loadDocument(id: string, name: string, status: ExecutionStatusName): Promise<unknown> {
    const stored = await this.prisma.executionFile.findUnique({ where: { executionId_name: { executionId: id, name } } });
    if (stored === null) {
      throw absentFile(id, name, status);
    }
    checked(id, name, `${canonicalJson(stored.document, 2)}\n`, stored);
    return stored.document;
  }

  private async requireStatus(id: string, allowed: readonly ExecutionStatusName[], reason: string): Promise<ExecutionStatusName> {
    const execution = await this.prisma.testExecution.findUnique({ where: { id }, select: { status: true } });
    if (execution === null) {
      throw executionNotFound(id);
    }
    if (!allowed.includes(execution.status)) {
      throw new ConflictException(`Execution ${id} is ${execution.status}; ${reason}.`);
    }
    return execution.status;
  }

  private integrityChecked<T>(id: string, read: () => T): T {
    try {
      return read();
    } catch (error) {
      throw this.asIntegrityFailure(id, error);
    }
  }

  private async integrityCheckedAsync<T>(id: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw this.asIntegrityFailure(id, error);
    }
  }

  private asIntegrityFailure(id: string, error: unknown): unknown {
    if (!(error instanceof ExecutionIntegrityError) && !(error instanceof RunIntegrityError)) {
      return error;
    }
    this.logger.error(`Integrity check failed for execution ${id}: ${error.message}`);
    return new InternalServerErrorException({ statusCode: 500, error: 'Execution Integrity Error', message: error.message });
  }
}

export function executionNotFound(id: string): NotFoundException {
  return new NotFoundException(`Execution ${id} not found.`);
}

/** A file that is not part of this execution: not delivered yet would be 409 earlier, so this one does not exist for it. */
function absentFile(id: string, name: string, status: ExecutionStatusName): NotFoundException {
  const why =
    name === DELIVERY_FILES.targetRun
      ? 'only a reference target has one'
      : name === DELIVERY_FILES.actualWindows
        ? 'only a chaos profile with a windowing contract has windows'
        : name === KAFKA_DELIVERY_FILES.kafkaRun
          ? 'only a Kafka execution has one'
          : status === 'awaiting_actual_state'
            ? 'it exists once the actual state has been submitted'
            : 'it was not produced';
  return new NotFoundException(`Execution ${id} has no ${name}: ${why}.`);
}

/** The text, if it matches the checksum and size recorded when the file was made; an integrity error otherwise. */
function checked(id: string, name: string, text: string, recorded: { readonly sha256: string; readonly bytes: number }): string {
  const actual = fileEntry(text);
  if (actual.sha256 !== recorded.sha256 || actual.bytes !== recorded.bytes) {
    throw new ExecutionIntegrityError(
      `${name} rebuilt from the database does not match the checksum recorded when execution ${id} made it ` +
        `(recorded sha256 ${recorded.sha256}, ${recorded.bytes} bytes; rebuilt sha256 ${actual.sha256}, ${actual.bytes} bytes). ` +
        'The stored execution was modified.',
    );
  }
  return text;
}

/** Problems with a submission, listed by path like every other 400 of the API. */
function parseSubmission(submission: SubmitActualStateRequest, profile: ChaosProfile): { actual: ActualState; actualWindows: ActualWindows | undefined } {
  const issues: string[] = [];
  const prefixed = (field: string, path: string) => (path === '(root)' ? field : `${field}.${path}`);
  let actual: ActualState | undefined;
  try {
    actual = parseActualState(submission.actualState);
  } catch (error) {
    if (!(error instanceof ActualStateValidationError)) {
      throw error;
    }
    issues.push(...error.issues.map((issue) => `${prefixed('actualState', issue.path)}: ${issue.message}`));
  }
  let actualWindows: ActualWindows | undefined;
  if (profile.windowing === undefined) {
    if (submission.actualWindows !== undefined) {
      issues.push(`actualWindows: the chaos profile "${profile.name}" has no windowing contract, so there are no windows to validate`);
    }
  } else if (submission.actualWindows === undefined) {
    const { sizeMs, allowedLatenessMs } = profile.windowing;
    issues.push(`actualWindows: required: the chaos profile "${profile.name}" defines event-time windows (sizeMs ${sizeMs}, allowedLatenessMs ${allowedLatenessMs})`);
  } else {
    try {
      actualWindows = parseActualWindows(submission.actualWindows);
    } catch (error) {
      if (!(error instanceof ActualWindowsValidationError)) {
        throw error;
      }
      issues.push(...error.issues.map((issue) => `${prefixed('actualWindows', issue.path)}: ${issue.message}`));
    }
  }
  if (issues.length > 0 || actual === undefined) {
    throw new BadRequestException(issues);
  }
  return { actual, actualWindows };
}

function summaryView(execution: ExecutionRecord): ExecutionSummaryView {
  return {
    id: execution.id,
    status: execution.status,
    verdict: execution.verdict,
    error: execution.error,
    run: {
      id: execution.run.id,
      seed: execution.run.seed,
      scenario: {
        id: execution.run.scenarioVersion.scenario.id,
        name: execution.run.scenarioVersion.scenario.name,
        version: execution.run.scenarioVersion.version,
      },
    },
    chaosProfile: {
      id: execution.chaosProfileVersion.chaosProfile.id,
      name: execution.chaosProfileVersion.chaosProfile.name,
      version: execution.chaosProfileVersion.version,
      profileHash: execution.chaosProfileVersion.profileHash,
    },
    chaosSeed: execution.chaosSeed,
    plannerVersion: execution.plannerVersion,
    target: executionTargetSchema.parse(execution.target),
    requestedAt: execution.requestedAt,
    startedAt: execution.startedAt,
    deliveredAt: execution.deliveredAt,
    finishedAt: execution.finishedAt,
    attemptCount: execution.attemptCount,
    findingCount: execution.findingCount,
    windowFindingCount: execution.windowFindingCount,
  };
}

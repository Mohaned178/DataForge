import { fileEntry } from '@dataforge/core';
import { serializeValidationReport, type ValidationReport } from '@dataforge/execution';
import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { chunkColumns, toAttemptColumns, type AttemptColumns } from './attempt-rows';
import { executionTargetSchema } from './execution-requests';
import type { ClaimedExecution, DeliveredResults, ExecutionFileContent, ExecutionStore, ValidatedResults } from './execution-runner';
import { toReportRows } from './report-rows';

/** Rows per INSERT statement, as for canonical events (ADR-0011). */
export const ROW_INSERT_CHUNK = 5_000;

/** A specification-sized execution (about 19,000 attempts and thousands of findings) must fit. */
const TRANSACTION_TIMEOUT_MS = 10 * 60_000;

export const INTERRUPTED_EXTERNAL_ERROR =
  'Interrupted: the API stopped while this execution was delivering to the external pipeline, which may already have consumed part ' +
  'of the stream. DataForge cannot reset your pipeline: reset its state, then start a new execution.';

type Transaction = Prisma.TransactionClient;

/** The execution was not in the status a change requires (for example, a second submission of its actual state). */
export class ExecutionStatusConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionStatusConflictError';
  }
}

/** Execution status and results in PostgreSQL. */
export class PrismaExecutionStore implements ExecutionStore {
  constructor(private readonly prisma: PrismaService) {}

  async claim(executionId: string): Promise<ClaimedExecution | undefined> {
    const { count } = await this.prisma.testExecution.updateMany({
      where: { id: executionId, status: 'queued' },
      data: { status: 'running', startedAt: new Date() },
    });
    if (count === 0) {
      return undefined;
    }
    const execution = await this.prisma.testExecution.findUniqueOrThrow({
      where: { id: executionId },
      select: {
        id: true,
        runId: true,
        chaosSeed: true,
        plannerVersion: true,
        target: true,
        chaosProfileVersion: { select: { definition: true, profileHash: true } },
      },
    });
    const target = executionTargetSchema.safeParse(execution.target);
    if (!target.success) {
      await this.fail(executionId, `The stored target is invalid: ${target.error.issues[0]?.message ?? 'unknown problem'}`);
      return undefined;
    }
    return {
      id: execution.id,
      runId: execution.runId,
      chaosSeed: execution.chaosSeed,
      plannerVersion: execution.plannerVersion,
      target: target.data,
      profile: execution.chaosProfileVersion,
    };
  }

  async complete(executionId: string, delivered: DeliveredResults, validated: ValidatedResults): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await insertAttempts(tx, executionId, delivered);
        await insertFiles(tx, executionId, [...delivered.files, ...validated.files]);
        await insertReport(tx, executionId, validated.report);
        const now = new Date();
        await transition(tx, executionId, 'running', {
          status: 'completed',
          deliveredAt: now,
          finishedAt: now,
          error: null,
          attemptCount: delivered.attempts.length,
          workDirectory: delivered.workDirectory ?? null,
          ...outcomeOf(validated.report),
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 30_000 },
    );
  }

  async awaitActualState(executionId: string, delivered: DeliveredResults): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await insertAttempts(tx, executionId, delivered);
        await insertFiles(tx, executionId, delivered.files);
        await transition(tx, executionId, 'running', {
          status: 'awaiting_actual_state',
          deliveredAt: new Date(),
          attemptCount: delivered.attempts.length,
          workDirectory: delivered.workDirectory ?? null,
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 30_000 },
    );
  }

  /** Stores the validation of a submitted actual state and completes the execution; refused unless it is awaiting one. */
  async completeSubmission(executionId: string, validated: ValidatedResults): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await transition(tx, executionId, 'awaiting_actual_state', { status: 'completed', finishedAt: new Date(), ...outcomeOf(validated.report) });
        await insertFiles(tx, executionId, validated.files);
        await insertReport(tx, executionId, validated.report);
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 30_000 },
    );
  }

  async fail(executionId: string, error: string): Promise<void> {
    await this.prisma.testExecution.updateMany({
      where: { id: executionId, status: 'running' },
      data: { status: 'failed', finishedAt: new Date(), error },
    });
  }

  async recoverUnfinished(): Promise<{ queued: string[]; interrupted: string[] }> {
    const external = await this.prisma.testExecution.findMany({
      where: { status: 'running', target: { path: ['type'], equals: 'external' } },
      select: { id: true },
    });
    const interrupted = external.map((execution) => execution.id);
    if (interrupted.length > 0) {
      await this.prisma.testExecution.updateMany({
        where: { id: { in: interrupted }, status: 'running' },
        data: { status: 'failed', finishedAt: new Date(), error: INTERRUPTED_EXTERNAL_ERROR },
      });
    }
    await this.prisma.testExecution.updateMany({ where: { status: 'running' }, data: { status: 'queued', startedAt: null } });
    const queued = await this.prisma.testExecution.findMany({
      where: { status: 'queued' },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return { queued: queued.map((execution) => execution.id), interrupted };
  }
}

function outcomeOf(report: ValidationReport) {
  return { verdict: report.verdict, findingCount: report.counts.findings, windowFindingCount: report.windows?.counts.findings ?? null };
}

async function transition(
  tx: Transaction,
  executionId: string,
  from: 'running' | 'awaiting_actual_state',
  data: Prisma.TestExecutionUpdateManyMutationInput,
): Promise<void> {
  const { count } = await tx.testExecution.updateMany({ where: { id: executionId, status: from }, data });
  if (count !== 1) {
    throw new ExecutionStatusConflictError(`Execution ${executionId} is no longer ${from}.`);
  }
}

async function insertFiles(tx: Transaction, executionId: string, files: readonly ExecutionFileContent[]): Promise<void> {
  if (files.length === 0) {
    return;
  }
  await tx.executionFile.createMany({
    data: files.map((file) => {
      const entry = fileEntry(file.text);
      return { executionId, name: file.name, document: JSON.parse(file.text) as Prisma.InputJsonValue, sha256: entry.sha256, bytes: entry.bytes };
    }),
  });
}

async function insertReport(tx: Transaction, executionId: string, report: ValidationReport): Promise<void> {
  const entry = fileEntry(serializeValidationReport(report));
  const rows = toReportRows(report);
  await tx.validationReport.create({
    data: { executionId, verdict: report.verdict, document: asJson(rows.document), sha256: entry.sha256, bytes: entry.bytes },
  });
  for (let start = 0; start < rows.findings.length; start += ROW_INSERT_CHUNK) {
    await tx.validationFinding.createMany({
      data: rows.findings.slice(start, start + ROW_INSERT_CHUNK).map((row) => ({
        executionId,
        ...row,
        differences: asJson(row.differences),
        causes: asJson(row.causes),
      })),
    });
  }
  for (let start = 0; start < rows.windowFindings.length; start += ROW_INSERT_CHUNK) {
    await tx.windowFinding.createMany({
      data: rows.windowFindings.slice(start, start + ROW_INSERT_CHUNK).map((row) => ({
        executionId,
        ...row,
        windowStartMs: BigInt(row.windowStartMs),
        windowEndMs: BigInt(row.windowEndMs),
        differences: asJson(row.differences),
        causes: asJson(row.causes),
      })),
    });
  }
}

async function insertAttempts(tx: Transaction, executionId: string, delivered: DeliveredResults): Promise<void> {
  for (const chunk of chunkColumns(toAttemptColumns(delivered.attempts, delivered.deliveryLog), ROW_INSERT_CHUNK)) {
    await insertAttemptChunk(tx, executionId, chunk);
  }
}

/** One statement per chunk; the column names match prisma/schema.prisma (DeliveryAttempt). */
async function insertAttemptChunk(tx: Transaction, executionId: string, c: AttemptColumns): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO delivery_attempt
      (execution_id, delivery_sequence, attempt_id, attempt_number, kind, planned_outcome, scheduled_delivery_time_ms, event_id,
       event_sequence, event_type, event_time_ms, aggregate_id, aggregate_version, derived_from, faults, kafka_outcome,
       kafka_partition, kafka_offset, due_at_ms, started_at_ms, acked_at_ms, drift_ms)
    SELECT ${executionId}::uuid, a.delivery_sequence, a.attempt_id, a.attempt_number, a.kind, a.planned_outcome,
           a.scheduled_delivery_time_ms, a.event_id, a.event_sequence, a.event_type, a.event_time_ms, a.aggregate_id,
           a.aggregate_version, a.derived_from::jsonb, a.faults::jsonb, a.kafka_outcome, a.kafka_partition, a.kafka_offset,
           a.due_at_ms, a.started_at_ms, a.acked_at_ms, a.drift_ms
    FROM unnest(
      ${c.deliverySequences}::int[], ${c.attemptIds}::text[], ${c.attemptNumbers}::int[], ${c.kinds}::text[],
      ${c.plannedOutcomes}::text[], ${c.scheduledDeliveryTimesMs}::bigint[], ${c.eventIds}::text[], ${c.eventSequences}::int[],
      ${c.eventTypes}::text[], ${c.eventTimesMs}::bigint[], ${c.aggregateIds}::text[], ${c.aggregateVersions}::int[],
      ${c.derivedFroms}::text[], ${c.faults}::text[], ${c.kafkaOutcomes}::text[], ${c.kafkaPartitions}::int[],
      ${c.kafkaOffsets}::text[], ${c.dueAtMs}::int[], ${c.startedAtMs}::int[], ${c.ackedAtMs}::int[], ${c.driftMs}::int[]
    ) AS a(delivery_sequence, attempt_id, attempt_number, kind, planned_outcome, scheduled_delivery_time_ms, event_id,
           event_sequence, event_type, event_time_ms, aggregate_id, aggregate_version, derived_from, faults, kafka_outcome,
           kafka_partition, kafka_offset, due_at_ms, started_at_ms, acked_at_ms, drift_ms)`;
}

/** Validation results are plain JSON data, declared as interfaces TypeScript does not treat as JSON objects. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

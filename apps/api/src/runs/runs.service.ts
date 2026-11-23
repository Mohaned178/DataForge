import { ConflictException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import {
  ENGINE_VERSION,
  RUN_FILES,
  fileEntry,
  parseScenario,
  runManifestSchema,
  serializeEventLog,
  serializeExpectedState,
  serializeResolvedScenario,
  serializeRunManifest,
  type ExpectedState,
  type ExpectedStateSummary,
  type RunFileName,
  type RunManifest,
} from '@dataforge/core';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { scenarioNotFound } from '../scenarios/scenarios.service';
import { fromEventRow } from './event-rows';
import { RunIntegrityError } from './run-integrity';
import type { ListRunsQuery, RunEventsQuery, StartRunRequest } from './run-requests';
import { RunRunner } from './run-runner';
import type { RunEventsView, RunListView, RunView } from './run-views';

const runWithScenario = {
  scenarioVersion: { select: { version: true, scenarioHash: true, scenario: { select: { id: true, name: true } } } },
} as const satisfies Prisma.SimulationRunInclude;

type RunRecord = Prisma.SimulationRunGetPayload<{ include: typeof runWithScenario }>;

export const RUN_FILE_CONTENT_TYPES: Readonly<Record<RunFileName, string>> = {
  [RUN_FILES.events]: 'application/x-ndjson; charset=utf-8',
  [RUN_FILES.expectedState]: 'application/json; charset=utf-8',
  [RUN_FILES.scenario]: 'application/json; charset=utf-8',
  [RUN_FILES.manifest]: 'application/json; charset=utf-8',
};

export interface RunFileContent {
  readonly name: RunFileName;
  readonly content: string;
  readonly contentType: string;
}

@Injectable()
export class RunsService {
  private readonly logger = new Logger('Runs');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RunRunner) private readonly runner: RunRunner,
  ) {}

  /** Records a queued run and hands it to the background runner; the caller follows it with GET /runs/:id. */
  async start(request: StartRunRequest): Promise<RunView> {
    const scenario = await this.prisma.scenario.findUnique({ where: { id: request.scenarioId }, select: { id: true } });
    if (scenario === null) {
      throw scenarioNotFound(request.scenarioId);
    }
    const version = await this.prisma.scenarioVersion.findFirst({
      where: { scenarioId: scenario.id, ...(request.version === undefined ? {} : { version: request.version }) },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (version === null) {
      throw new NotFoundException(`Scenario ${scenario.id} has no version ${String(request.version)}.`);
    }
    const run = await this.prisma.simulationRun.create({
      data: { scenarioVersionId: version.id, seed: request.seed, engineVersion: ENGINE_VERSION },
      include: runWithScenario,
    });
    this.runner.enqueue(run.id);
    return runView(run);
  }

  async list(query: ListRunsQuery): Promise<RunListView> {
    const where: Prisma.SimulationRunWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.scenarioId === undefined ? {} : { scenarioVersion: { scenarioId: query.scenarioId } }),
    };
    const [runs, total] = await Promise.all([
      this.prisma.simulationRun.findMany({
        where,
        include: runWithScenario,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.simulationRun.count({ where }),
    ]);
    return { runs: runs.map(runView), total, limit: query.limit, offset: query.offset };
  }

  async get(id: string): Promise<RunView> {
    const run = await this.prisma.simulationRun.findUnique({ where: { id }, include: runWithScenario });
    if (run === null) {
      throw runNotFound(id);
    }
    return runView(run);
  }

  async events(id: string, query: RunEventsQuery): Promise<RunEventsView> {
    await this.requireSucceeded(id);
    const rows = await this.prisma.canonicalEvent.findMany({
      where: {
        runId: id,
        sequence: { gte: query.fromSequence },
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.aggregateId === undefined ? {} : { aggregateId: query.aggregateId }),
      },
      orderBy: { sequence: 'asc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const events = this.integrityChecked(id, () => page.map((row) => fromEventRow(row, id)));
    const next = rows[query.limit];
    return { runId: id, events, nextSequence: next === undefined ? null : next.sequence };
  }

  /**
   * Rebuilds one run file from the database and sends it only when it matches the checksum recorded
   * when the run was generated: the bytes are exactly those "dataforge generate" writes.
   */
  async readFile(id: string, name: RunFileName): Promise<RunFileContent> {
    const run = await this.requireSucceeded(id);
    const content = await this.integrityCheckedAsync(id, async () => {
      const manifest = parseStoredManifest(id, run.manifest);
      const rebuilt = await this.rebuildFile(id, name, manifest, run.scenarioVersion.definition);
      if (name !== RUN_FILES.manifest) {
        const recorded = manifest.files[name];
        const actual = fileEntry(rebuilt);
        if (actual.sha256 !== recorded.sha256 || actual.bytes !== recorded.bytes) {
          throw new RunIntegrityError(
            `${name} rebuilt from the database does not match the checksum recorded when run ${id} was generated ` +
              `(recorded sha256 ${recorded.sha256}, ${recorded.bytes} bytes; rebuilt sha256 ${actual.sha256}, ${actual.bytes} bytes). ` +
              'The stored run was modified.',
          );
        }
      }
      return rebuilt;
    });
    return { name, content, contentType: RUN_FILE_CONTENT_TYPES[name] };
  }

  private async rebuildFile(id: string, name: RunFileName, manifest: RunManifest, definition: unknown): Promise<string> {
    switch (name) {
      case RUN_FILES.manifest:
        return serializeRunManifest(manifest);
      case RUN_FILES.scenario:
        return serializeResolvedScenario(parseScenario(definition));
      case RUN_FILES.expectedState: {
        const snapshot = await this.prisma.expectedStateSnapshot.findUnique({ where: { runId: id }, select: { document: true } });
        if (snapshot === null) {
          throw new RunIntegrityError(`Run ${id} succeeded but has no expected-state snapshot.`);
        }
        return serializeExpectedState(snapshot.document as unknown as ExpectedState);
      }
      case RUN_FILES.events: {
        const rows = await this.prisma.canonicalEvent.findMany({ where: { runId: id }, orderBy: { sequence: 'asc' } });
        return serializeEventLog(rows.map((row) => fromEventRow(row, id)));
      }
    }
  }

  private async requireSucceeded(id: string) {
    const run = await this.prisma.simulationRun.findUnique({
      where: { id },
      select: { status: true, manifest: true, scenarioVersion: { select: { definition: true } } },
    });
    if (run === null) {
      throw runNotFound(id);
    }
    if (run.status !== 'succeeded') {
      throw new ConflictException(`Run ${id} is ${run.status}; its events and files exist once it has succeeded.`);
    }
    return run;
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
    if (!(error instanceof RunIntegrityError)) {
      return error;
    }
    this.logger.error(`Integrity check failed for run ${id}: ${error.message}`);
    return new InternalServerErrorException({ statusCode: 500, error: 'Run Integrity Error', message: error.message });
  }
}

export function runNotFound(id: string): NotFoundException {
  return new NotFoundException(`Run ${id} not found.`);
}

function parseStoredManifest(id: string, stored: unknown): RunManifest {
  const result = runManifestSchema.safeParse(stored);
  if (!result.success) {
    throw new RunIntegrityError(`The stored manifest of run ${id} is invalid: ${result.error.issues[0]?.message ?? 'unknown problem'}`);
  }
  return result.data;
}

function runView(run: RunRecord): RunView {
  const manifest = runManifestSchema.safeParse(run.manifest);
  return {
    id: run.id,
    status: run.status,
    scenario: {
      id: run.scenarioVersion.scenario.id,
      name: run.scenarioVersion.scenario.name,
      version: run.scenarioVersion.version,
      scenarioHash: run.scenarioVersion.scenarioHash,
    },
    seed: run.seed,
    engineVersion: run.engineVersion,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    eventCount: run.eventCount,
    eventsByType: manifest.success ? manifest.data.counts.eventsByType : null,
    files: manifest.success ? manifest.data.files : null,
    summary: (run.summary as unknown as ExpectedStateSummary | null) ?? null,
  };
}

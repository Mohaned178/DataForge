import { RUN_FILES, sha256Hex, type ExpectedState, type ExpectedStateSummary } from '@dataforge/core';
import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { chunkEventColumns, toEventColumns, type EventColumns } from './event-rows';
import type { GeneratedRun } from './run-generation';
import type { ClaimedRun, RunStore } from './run-runner';

/** Events per INSERT statement: bounded statements, about 4x faster than createMany (ADR-0011). */
export const EVENT_INSERT_CHUNK = 5_000;

/** A run at the specification's limits (about 400,000 events) must fit; nothing else waits on it. */
const COMPLETE_TIMEOUT_MS = 10 * 60_000;

type Transaction = Prisma.TransactionClient;

/** The run status and results in PostgreSQL. */
export class PrismaRunStore implements RunStore {
  constructor(private readonly prisma: PrismaService) {}

  async claim(runId: string): Promise<ClaimedRun | undefined> {
    const { count } = await this.prisma.simulationRun.updateMany({
      where: { id: runId, status: 'queued' },
      data: { status: 'running', startedAt: new Date() },
    });
    if (count === 0) {
      return undefined;
    }
    const run = await this.prisma.simulationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { id: true, seed: true, engineVersion: true, scenarioVersion: { select: { definition: true, scenarioHash: true } } },
    });
    return {
      id: run.id,
      seed: run.seed,
      engineVersion: run.engineVersion,
      definition: run.scenarioVersion.definition,
      scenarioHash: run.scenarioVersion.scenarioHash,
    };
  }

  async complete(runId: string, { result, files }: GeneratedRun): Promise<void> {
    const columns = toEventColumns(result.events);
    const expectedState = files.contents[RUN_FILES.expectedState];
    await this.prisma.$transaction(
      async (tx) => {
        for (const chunk of chunkEventColumns(columns, EVENT_INSERT_CHUNK)) {
          await insertEvents(tx, runId, chunk);
        }
        await tx.expectedStateSnapshot.create({
          data: {
            runId,
            lastSequence: result.expectedState.lastSequence,
            document: asJson(result.expectedState),
            sha256: sha256Hex(expectedState),
          },
        });
        const { count } = await tx.simulationRun.updateMany({
          where: { id: runId, status: 'running' },
          data: {
            status: 'succeeded',
            finishedAt: new Date(),
            error: null,
            eventCount: result.events.length,
            manifest: files.manifest,
            summary: asJson(result.expectedState.summary),
          },
        });
        if (count !== 1) {
          throw new Error(`run ${runId} is no longer running`);
        }
      },
      { timeout: COMPLETE_TIMEOUT_MS, maxWait: 30_000 },
    );
  }

  async fail(runId: string, error: string): Promise<void> {
    await this.prisma.simulationRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'failed', finishedAt: new Date(), error },
    });
  }

  async requeueUnfinished(): Promise<string[]> {
    await this.prisma.simulationRun.updateMany({ where: { status: 'running' }, data: { status: 'queued', startedAt: null } });
    const queued = await this.prisma.simulationRun.findMany({
      where: { status: 'queued' },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return queued.map((run) => run.id);
  }
}

/** One statement per chunk; the column names match prisma/schema.prisma (CanonicalEvent). */
async function insertEvents(tx: Transaction, runId: string, chunk: EventColumns): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO canonical_event
      (run_id, sequence, event_id, type, aggregate_type, aggregate_id, aggregate_version, event_time_ms, schema_version, payload)
    SELECT ${runId}::uuid, e.sequence, e.event_id, e.type, e.aggregate_type, e.aggregate_id, e.aggregate_version,
           e.event_time_ms, e.schema_version, e.payload::jsonb
    FROM unnest(
      ${chunk.sequences}::int[], ${chunk.eventIds}::text[], ${chunk.types}::text[], ${chunk.aggregateTypes}::text[],
      ${chunk.aggregateIds}::text[], ${chunk.aggregateVersions}::int[], ${chunk.eventTimesMs}::bigint[],
      ${chunk.schemaVersions}::int[], ${chunk.payloads}::text[]
    ) AS e(sequence, event_id, type, aggregate_type, aggregate_id, aggregate_version, event_time_ms, schema_version, payload)`;
}

/** Core records are plain JSON data, but declared as interfaces, which TypeScript does not treat as JSON objects. */
function asJson(value: ExpectedState | ExpectedStateSummary): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

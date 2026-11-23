import {
  CanonicalLogViolationError,
  RUN_FILES,
  replayCanonicalLog,
  runManifestSchema,
  serializeEventLog,
  serializeExpectedState,
  sha256Hex,
  type CanonicalEvent,
  type ExpectedState,
  type RunManifest,
} from '@dataforge/core';
import type { PrismaService } from '../database/prisma.service';
import { fromEventRow } from './event-rows';
import { RunIntegrityError } from './run-integrity';

/** A succeeded run as an execution consumes it: everything checked against what was recorded at generation. */
export interface IntactRun {
  readonly manifest: RunManifest;
  readonly events: readonly CanonicalEvent[];
  /** Re-derived by replaying the events; equal to the expected-state.json recorded at generation. */
  readonly expected: ExpectedState;
}

/**
 * Loads a stored run for a test execution, with the guarantees the CLI gives a run directory: the
 * events rebuilt from their rows hash to the manifest's checksum, and replaying them gives exactly
 * the expected state recorded at generation. Anything else is a RunIntegrityError, so nothing is planned from, or
 * validated against, a modified run.
 */
export async function loadIntactRun(prisma: PrismaService, runId: string): Promise<IntactRun> {
  const run = await prisma.simulationRun.findUnique({ where: { id: runId }, select: { status: true, manifest: true } });
  if (run === null || run.status !== 'succeeded') {
    throw new RunIntegrityError(`Run ${runId} ${run === null ? 'does not exist' : `is ${run.status}`}; an execution needs a succeeded run.`);
  }
  const manifest = runManifestSchema.safeParse(run.manifest);
  if (!manifest.success) {
    throw new RunIntegrityError(`The stored manifest of run ${runId} is invalid: ${manifest.error.issues[0]?.message ?? 'unknown problem'}`);
  }
  const rows = await prisma.canonicalEvent.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
  const events = rows.map((row) => fromEventRow(row, runId));
  if (sha256Hex(serializeEventLog(events)) !== manifest.data.files[RUN_FILES.events].sha256) {
    throw new RunIntegrityError(`The stored events of run ${runId} do not match the checksum recorded when it was generated: the stored run was modified.`);
  }
  let expected: ExpectedState;
  try {
    expected = replayCanonicalLog(events).expectedState;
  } catch (error) {
    if (error instanceof CanonicalLogViolationError) {
      throw new RunIntegrityError(`The stored events of run ${runId} break the business rules: ${error.message}`);
    }
    throw error;
  }
  if (sha256Hex(serializeExpectedState(expected)) !== manifest.data.files[RUN_FILES.expectedState].sha256) {
    throw new RunIntegrityError(`The replayed expected state of run ${runId} does not match the checksum recorded when it was generated.`);
  }
  return { manifest: manifest.data, events, expected };
}

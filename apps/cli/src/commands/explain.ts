import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseUtcInstant, simTimeToIso } from '@dataforge/core';
import { UnknownEventError, explainEvent, type DeliveryAttempt, type FaultRecord, type FirstDelivery } from '@dataforge/chaos';
import { EXIT_FAILED, EXIT_OK, UsageError, formatCount, padRight, type CliIo } from '../cli-io';
import { readPlanForRun } from '../plan-directory';
import { readIntactCanonicalLog, readManifest } from '../run-directory';
import { describeEvent, formatSimTime } from './timeline';

export const EXPLAIN_USAGE = 'dataforge explain --run <directory> --plan <directory> --event <eventId>   (e.g. evt_ord_000042_2)';

/** Prints everything a delivery plan says about one canonical event. */
export function runExplain(args: readonly string[], io: CliIo): number {
  const { values } = parseArgs({
    args: [...args],
    options: { run: { type: 'string' }, plan: { type: 'string' }, event: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (values.run === undefined || values.plan === undefined || values.event === undefined) {
    throw new UsageError(`Missing required option.\nUsage: ${EXPLAIN_USAGE}`);
  }
  const runDirectory = resolve(values.run);
  const manifest = readManifest(runDirectory);
  const { events } = readIntactCanonicalLog(runDirectory, manifest);
  const { summaryFile, profile, attempts } = readPlanForRun(resolve(values.plan), manifest);

  let explanation;
  try {
    explanation = explainEvent(events, attempts, values.event);
  } catch (error) {
    if (error instanceof UnknownEventError) {
      io.err(`${error.message}. Event IDs look like evt_<aggregateId>_<version>, for example evt_ord_000042_2.`);
      return EXIT_FAILED;
    }
    throw error;
  }

  const { event } = explanation;
  const epochUnixMs = parseUtcInstant(manifest.simulation.epoch);
  const at = (simTimeMs: number) => `${simTimeToIso(epochUnixMs, simTimeMs)} (${formatSimTime(simTimeMs)})`;

  io.out(`Event ${event.eventId}: ${event.type}, version ${event.aggregateVersion} of ${event.aggregateId}, canonical sequence ${event.sequence}`);
  io.out(`  event time  ${at(event.eventTimeMs)}`);
  io.out(`  details     ${describeEvent(event)}`);
  io.out(`  plan        profile ${summaryFile.profile.name}, chaos seed ${summaryFile.chaosSeed}, planner ${summaryFile.plannerVersion}`);
  io.out('');
  io.out(`Delivery attempts (${explanation.attempts.length}):`);
  io.out(
    `  ${padRight('#', 3)} ${padRight('attempt', 24)} ${padRight('kind', 10)} ${padRight('position', 9)} ` +
      `${padRight('scheduled delivery (UTC)', 25)} ${padRight('after event time', 17)} ${padRight('outcome', 10)} why`,
  );
  for (const attempt of explanation.attempts) {
    io.out(
      `  ${padRight(String(attempt.attemptNumber), 3)} ${padRight(attempt.attemptId, 24)} ${padRight(attempt.kind, 10)} ` +
        `${padRight(`#${attempt.deliverySequence}`, 9)} ${padRight(simTimeToIso(epochUnixMs, attempt.scheduledDeliveryTimeMs), 25)} ` +
        `${padRight(`+${formatCount(attempt.scheduledDeliveryTimeMs - attempt.eventTimeMs)} ms`, 17)} ` +
        `${padRight(attempt.plannedOutcome.toUpperCase(), 10)} ${reasons(attempt).join('; ')}`,
    );
  }
  io.out('');

  if (explanation.outcome === 'lost') {
    io.out(
      `Outcome: LOST. All ${explanation.attempts.length} attempts fail and the sender gives up after ` +
        `${profile.faults.transientFailure.maxRetries} retries (the profile allows loss). The target never receives this event.`,
    );
    io.out(`Aggregate order: not delivered, so it has no place in the delivery order of ${event.aggregateId}.`);
    return EXIT_OK;
  }

  const first = explanation.firstDelivery as DeliveryAttempt;
  io.out(
    explanation.deliveries === 1
      ? `Outcome: delivered once, at position #${first.deliverySequence} of ${formatCount(summaryFile.summary.attempts)} attempts.`
      : `Outcome: delivered ${explanation.deliveries} times with the same eventId (first at position #${first.deliverySequence}). ` +
          'An idempotent target applies it once.',
  );
  if (explanation.overtakenBy.length === 0 && explanation.overtook.length === 0) {
    io.out(`Aggregate order: in order within ${event.aggregateId}.`);
    return EXIT_OK;
  }
  if (explanation.overtakenBy.length > 0) {
    io.out(`Aggregate order: OUT OF ORDER. The target receives later events of ${event.aggregateId} first:`);
    explanation.overtakenBy.forEach((sibling) => io.out(`  ${sibling.eventId}  ${describeSibling(sibling)}`));
  }
  if (explanation.overtook.length > 0) {
    io.out(`Aggregate order: delivered before earlier events of ${event.aggregateId}, which arrive late:`);
    explanation.overtook.forEach((sibling) => io.out(`  ${sibling.eventId}  ${describeSibling(sibling)}`));
  }
  return EXIT_OK;
}

function describeSibling(sibling: FirstDelivery): string {
  return `v${sibling.aggregateVersion} ${padRight(sibling.eventType, 18)} first delivered at position #${sibling.deliverySequence}`;
}

function reasons(attempt: DeliveryAttempt): string[] {
  const lines: string[] = [];
  if (attempt.kind === 'retry' && attempt.derivedFrom !== null) {
    lines.push(`retry ${formatCount(attempt.derivedFrom.offsetMs)} ms after ${attempt.derivedFrom.attemptId} failed`);
  }
  for (const fault of attempt.faults) {
    lines.push(describeFault(fault, attempt));
  }
  if (lines.length === 0) {
    lines.push('no fault');
  }
  return lines;
}

function describeFault(fault: FaultRecord, attempt: DeliveryAttempt): string {
  switch (fault.type) {
    case 'delay':
      return `delay +${formatCount(fault.delayMs)} ms`;
    case 'reorder':
      return (
        `reorder: moved behind ${fault.behindEventId} (${fault.distance} later), ` +
        (fault.shiftMs === 0 ? 'already behind it after the delay' : `+${formatCount(fault.shiftMs)} ms`)
      );
    case 'transientFailure':
      return `transient failure ${fault.failure} of ${fault.failures}`;
    case 'duplicate':
      return `duplicate copy ${fault.copy} of ${fault.copies}, ${formatCount(attempt.derivedFrom?.offsetMs ?? 0)} ms after ${attempt.derivedFrom?.attemptId ?? '?'}`;
  }
}

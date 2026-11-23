import type { Attempt, FaultRecord } from '../api/schemas';
import { formatDuration } from './format';

const ORDINALS: Readonly<Record<number, string>> = { 1: 'next', 2: '2nd next', 3: '3rd next' };

function nth(distance: number): string {
  return ORDINALS[distance] ?? `${distance}th next`;
}

/** What one fault record did to an attempt, in words. */
export function describeFault(fault: FaultRecord): string {
  switch (fault.type) {
    case 'delay':
      return `Delayed by ${formatDuration(fault.delayMs)}`;
    case 'reorder':
      return fault.shiftMs === 0
        ? `Reordered behind ${fault.behindEventId}, the ${nth(fault.distance)} event of its aggregate (a delay already put it there)`
        : `Reordered behind ${fault.behindEventId}, the ${nth(fault.distance)} event of its aggregate, ${formatDuration(fault.shiftMs)} later`;
    case 'late':
      return `Late: held until after its window closed, behind ${fault.behindEventId}, ${formatDuration(fault.shiftMs)} later`;
    case 'transientFailure':
      return `Delivery failure ${fault.failure} of ${fault.failures}`;
    case 'duplicate':
      return `Extra copy ${fault.copy} of ${fault.copies}`;
  }
}

/** Everything notable about an attempt: its faults, and how a retry or a duplicate relates to the attempt it follows. */
export function describeAttempt(attempt: Attempt): string[] {
  const lines = attempt.faults.map(describeFault);
  if (attempt.derivedFrom !== null) {
    const verb = attempt.kind === 'retry' ? 'Retry' : 'Redelivered';
    lines.push(`${verb} ${formatDuration(attempt.derivedFrom.offsetMs)} after ${attempt.derivedFrom.attemptId}`);
  }
  return lines;
}

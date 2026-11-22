import type { CanonicalEvent } from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import { deliveryMessageFor } from '../message';
import type { Target, TargetResult } from '../target';

export interface InMemoryDeliveryInput {
  /** The canonical log the plan was made for. */
  readonly events: readonly CanonicalEvent[];
  /** The delivery plan, in delivery order. */
  readonly attempts: readonly DeliveryAttempt[];
  readonly target: Target;
}

export interface InMemoryDeliveryResult extends TargetResult {
  /** Messages handed to the target: every delivered attempt. */
  readonly messages: number;
  readonly distinctEvents: number;
  /** Messages for an event the target had already received (duplicates, in delivery terms). */
  readonly redeliveries: number;
  /** Planned failures: attempts that never reach the target. */
  readonly failedAttempts: number;
}

export class PlanDoesNotMatchLogError extends Error {
  constructor(readonly attempt: DeliveryAttempt) {
    super(`Attempt ${attempt.attemptId} delivers event ${attempt.eventId}, which is not in the canonical log`);
    this.name = 'PlanDoesNotMatchLogError';
  }
}

/**
 * Plays a delivery plan into a target, synchronously and in delivery order. A failed attempt
 * never reaches the target; a delivered one becomes a message with the canonical event and the
 * attempt's headers. Simulation time is not waited for: only the order matters in process.
 */
export function deliverInMemory(input: InMemoryDeliveryInput): InMemoryDeliveryResult {
  const eventsById = new Map(input.events.map((event) => [event.eventId, event]));
  const received = new Set<string>();
  let messages = 0;
  let failedAttempts = 0;
  const ordered = [...input.attempts].sort((a, b) => a.deliverySequence - b.deliverySequence);
  for (const attempt of ordered) {
    const event = eventsById.get(attempt.eventId);
    if (event === undefined) {
      throw new PlanDoesNotMatchLogError(attempt);
    }
    if (attempt.plannedOutcome === 'failed') {
      failedAttempts += 1;
      continue;
    }
    input.target.handle(deliveryMessageFor(event, attempt));
    received.add(event.eventId);
    messages += 1;
  }
  return {
    ...input.target.finish(),
    messages,
    distinctEvents: received.size,
    redeliveries: messages - received.size,
    failedAttempts,
  };
}

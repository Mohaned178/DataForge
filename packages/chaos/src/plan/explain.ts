import type { CanonicalEvent } from '@dataforge/core';
import type { DeliveryAttempt } from './delivery-attempt';
import { firstDeliveriesByAggregate, type FirstDelivery } from './summary';

export interface EventExplanation {
  readonly event: CanonicalEvent;
  /** Every attempt for the event, in attempt order (which is also its delivery order). */
  readonly attempts: readonly DeliveryAttempt[];
  /** `lost` when no attempt is delivered: every attempt failed and the sender gave up. */
  readonly outcome: 'delivered' | 'lost';
  /** How many times the target receives the event: 1 plus duplicates, or 0 when lost. */
  readonly deliveries: number;
  readonly firstDelivery: DeliveryAttempt | undefined;
  /** Later events of the same aggregate the target receives before this one. Non-empty means out of order. */
  readonly overtakenBy: readonly FirstDelivery[];
  /** Earlier events of the same aggregate the target receives after this one. */
  readonly overtook: readonly FirstDelivery[];
}

export class UnknownEventError extends Error {
  constructor(readonly eventId: string) {
    super(`Event "${eventId}" is not in the canonical log`);
    this.name = 'UnknownEventError';
  }
}

/** Everything the plan says about one canonical event: each attempt, its faults, its outcome and its order. */
export function explainEvent(
  events: readonly CanonicalEvent[],
  attempts: readonly DeliveryAttempt[],
  eventId: string,
): EventExplanation {
  const event = events.find((candidate) => candidate.eventId === eventId);
  if (event === undefined) {
    throw new UnknownEventError(eventId);
  }
  const own = attempts.filter((attempt) => attempt.eventId === eventId).sort((a, b) => a.attemptNumber - b.attemptNumber);
  const delivered = own.filter((attempt) => attempt.plannedOutcome === 'delivered');
  const firstDelivery = delivered[0];

  let overtakenBy: FirstDelivery[] = [];
  let overtook: FirstDelivery[] = [];
  if (firstDelivery !== undefined) {
    const siblings = firstDeliveriesByAggregate(attempts).get(event.aggregateId) ?? [];
    overtakenBy = siblings.filter(
      (sibling) => sibling.aggregateVersion > event.aggregateVersion && sibling.deliverySequence < firstDelivery.deliverySequence,
    );
    overtook = siblings.filter(
      (sibling) => sibling.aggregateVersion < event.aggregateVersion && sibling.deliverySequence > firstDelivery.deliverySequence,
    );
  }

  return {
    event,
    attempts: own,
    outcome: firstDelivery === undefined ? 'lost' : 'delivered',
    deliveries: delivered.length,
    firstDelivery,
    overtakenBy,
    overtook,
  };
}

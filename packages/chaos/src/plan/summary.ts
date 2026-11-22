import { z } from 'zod';
import type { CanonicalEvent } from '@dataforge/core';
import type { ChaosProfile } from '../profile/chaos-profile';
import { ATTEMPT_KINDS, PLANNED_OUTCOMES, type AttemptKind, type DeliveryAttempt, type PlannedOutcome } from './delivery-attempt';

const count = z.number().int().min(0);

const faultTally = {
  /** The configured probability. */
  rate: z.number().min(0).max(1),
  /** Events the fault could apply to. */
  eligibleEvents: count,
  /** Events it was applied to. faultedEvents / eligibleEvents is the observed rate. */
  faultedEvents: count,
};

export const deliverySummarySchema = z.strictObject({
  events: count,
  attempts: count,
  attemptsByKind: z.strictObject({ original: count, retry: count, duplicate: count }),
  attemptsByOutcome: z.strictObject({ delivered: count, failed: count }),
  eventsDelivered: count,
  eventsLost: count,
  faults: z.strictObject({
    /** Every event is eligible. */
    delay: z.strictObject(faultTally),
    /** Events with at least one later event in their aggregate. */
    reorder: z.strictObject(faultTally),
    /** Events that are delivered at least once. */
    duplicate: z.strictObject({ ...faultTally, extraDeliveries: count }),
    /** Every event is eligible. */
    transientFailure: z.strictObject({ ...faultTally, failedAttempts: count, lostEvents: count }),
  }),
  /** Order as the target sees it: each event's first delivered attempt, compared within its aggregate. */
  ordering: z.strictObject({
    /** Events first delivered after a later version of the same aggregate. */
    outOfOrderEvents: count,
    /** Pairs (earlier version, later version) of one aggregate delivered the wrong way round. */
    inversionPairs: count,
    aggregatesAffected: count,
  }),
  lastScheduledDeliveryTimeMs: count,
});

export type DeliverySummary = z.output<typeof deliverySummarySchema>;

/** An event's first delivered attempt, as seen from inside its aggregate. */
export interface FirstDelivery {
  readonly eventId: string;
  readonly eventType: DeliveryAttempt['eventType'];
  readonly aggregateVersion: number;
  readonly deliverySequence: number;
}

/** First delivered attempt of every delivered event, grouped by aggregate and sorted by version. Lost events are absent. */
export function firstDeliveriesByAggregate(attempts: readonly DeliveryAttempt[]): Map<string, FirstDelivery[]> {
  const byAggregate = new Map<string, FirstDelivery[]>();
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.plannedOutcome !== 'delivered' || seen.has(attempt.eventId)) {
      continue;
    }
    seen.add(attempt.eventId);
    const list = byAggregate.get(attempt.aggregateId) ?? [];
    list.push({
      eventId: attempt.eventId,
      eventType: attempt.eventType,
      aggregateVersion: attempt.aggregateVersion,
      deliverySequence: attempt.deliverySequence,
    });
    byAggregate.set(attempt.aggregateId, list);
  }
  for (const list of byAggregate.values()) {
    list.sort((a, b) => a.aggregateVersion - b.aggregateVersion);
  }
  return byAggregate;
}

export function summarizeDeliveryPlan(
  events: readonly CanonicalEvent[],
  attempts: readonly DeliveryAttempt[],
  profile: ChaosProfile,
): DeliverySummary {
  const attemptsByKind = Object.fromEntries(ATTEMPT_KINDS.map((kind) => [kind, 0])) as Record<AttemptKind, number>;
  const attemptsByOutcome = Object.fromEntries(PLANNED_OUTCOMES.map((outcome) => [outcome, 0])) as Record<PlannedOutcome, number>;
  const faulted = { delay: new Set<string>(), reorder: new Set<string>(), duplicate: new Set<string>(), transientFailure: new Set<string>() };
  const deliveredEvents = new Set<string>();
  let failedAttempts = 0;
  let lastScheduledDeliveryTimeMs = 0;

  for (const attempt of attempts) {
    attemptsByKind[attempt.kind] += 1;
    attemptsByOutcome[attempt.plannedOutcome] += 1;
    if (attempt.plannedOutcome === 'delivered') {
      deliveredEvents.add(attempt.eventId);
    } else {
      failedAttempts += 1;
    }
    for (const fault of attempt.faults) {
      faulted[fault.type].add(attempt.eventId);
    }
    lastScheduledDeliveryTimeMs = Math.max(lastScheduledDeliveryTimeMs, attempt.scheduledDeliveryTimeMs);
  }

  const latestVersion = new Map<string, number>();
  for (const event of events) {
    latestVersion.set(event.aggregateId, Math.max(latestVersion.get(event.aggregateId) ?? 0, event.aggregateVersion));
  }
  const reorderEligible = events.filter((event) => event.aggregateVersion < (latestVersion.get(event.aggregateId) ?? 0)).length;
  const lostEvents = events.length - deliveredEvents.size;

  let outOfOrderEvents = 0;
  let inversionPairs = 0;
  let aggregatesAffected = 0;
  for (const deliveries of firstDeliveriesByAggregate(attempts).values()) {
    let affected = false;
    deliveries.forEach((earlier, index) => {
      const overtakers = deliveries.slice(index + 1).filter((later) => later.deliverySequence < earlier.deliverySequence).length;
      if (overtakers > 0) {
        outOfOrderEvents += 1;
        inversionPairs += overtakers;
        affected = true;
      }
    });
    aggregatesAffected += affected ? 1 : 0;
  }

  const { delay, reorder, duplicate, transientFailure } = profile.faults;
  return {
    events: events.length,
    attempts: attempts.length,
    attemptsByKind,
    attemptsByOutcome,
    eventsDelivered: deliveredEvents.size,
    eventsLost: lostEvents,
    faults: {
      delay: { rate: delay.rate, eligibleEvents: events.length, faultedEvents: faulted.delay.size },
      reorder: { rate: reorder.rate, eligibleEvents: reorderEligible, faultedEvents: faulted.reorder.size },
      duplicate: {
        rate: duplicate.rate,
        eligibleEvents: deliveredEvents.size,
        faultedEvents: faulted.duplicate.size,
        extraDeliveries: attemptsByKind.duplicate,
      },
      transientFailure: {
        rate: transientFailure.rate,
        eligibleEvents: events.length,
        faultedEvents: faulted.transientFailure.size,
        failedAttempts,
        lostEvents,
      },
    },
    ordering: { outOfOrderEvents, inversionPairs, aggregatesAffected },
    lastScheduledDeliveryTimeMs,
  };
}

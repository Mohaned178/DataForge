import type { Attempt, CanonicalEvent } from '../api/schemas';

/** What happened to one event on its way to the target. */
export interface EventFlags {
  /** A later version of its aggregate reached the target first (the delivery summary's definition). */
  readonly outOfOrder: boolean;
  /** No attempt reached the target. */
  readonly lost: boolean;
  /** The target received it more than once. */
  readonly duplicated: boolean;
  /** An attempt failed and was retried. */
  readonly retried: boolean;
  readonly delayed: boolean;
  readonly late: boolean;
  readonly reordered: boolean;
}

export interface TimelineEvent {
  readonly event: CanonicalEvent;
  /** Its delivery attempts, in delivery order. */
  readonly attempts: readonly Attempt[];
  /** Delivery position of its first attempt that reached the target; null when it never did. */
  readonly firstDeliverySequence: number | null;
  /** Later events of the aggregate that reached the target before it. */
  readonly overtakenBy: readonly string[];
  readonly flags: EventFlags;
}

export interface Timeline {
  /** The canonical side: events in version order. */
  readonly events: readonly TimelineEvent[];
  /** The delivery side: every attempt in delivery order. */
  readonly deliveries: readonly Attempt[];
  readonly outOfOrderEvents: number;
  readonly inversionPairs: number;
}

interface FirstDelivery {
  readonly eventId: string;
  readonly aggregateVersion: number;
  readonly deliverySequence: number;
}

/**
 * For each event, the later events of its aggregate that reached the target first. Input: the first
 * delivered attempt of every event of ONE aggregate. This is exactly how the planner counts
 * `ordering.outOfOrderEvents` and `inversionPairs`, so the UI and the delivery summary agree.
 */
function overtakersWithin(firsts: readonly FirstDelivery[]): Map<string, string[]> {
  const ordered = [...firsts].sort((a, b) => a.aggregateVersion - b.aggregateVersion);
  const result = new Map<string, string[]>();
  ordered.forEach((earlier, index) => {
    const overtakers = ordered.slice(index + 1).filter((later) => later.deliverySequence < earlier.deliverySequence);
    if (overtakers.length > 0) result.set(earlier.eventId, overtakers.map((later) => later.eventId));
  });
  return result;
}

function firstDeliveries(attempts: readonly Attempt[]): FirstDelivery[] {
  const first = new Map<string, FirstDelivery>();
  for (const attempt of attempts) {
    if (attempt.plannedOutcome !== 'delivered') continue;
    const known = first.get(attempt.eventId);
    if (known === undefined || attempt.deliverySequence < known.deliverySequence) {
      first.set(attempt.eventId, { eventId: attempt.eventId, aggregateVersion: attempt.aggregateVersion, deliverySequence: attempt.deliverySequence });
    }
  }
  return [...first.values()];
}

/** The delivery summary's `ordering`, recomputed from attempts of any number of aggregates. */
export function orderingOf(attempts: readonly Attempt[]): { outOfOrderEvents: number; inversionPairs: number; aggregatesAffected: number } {
  const byAggregate = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const list = byAggregate.get(attempt.aggregateId) ?? [];
    list.push(attempt);
    byAggregate.set(attempt.aggregateId, list);
  }
  let outOfOrderEvents = 0;
  let inversionPairs = 0;
  let aggregatesAffected = 0;
  for (const list of byAggregate.values()) {
    const overtaken = overtakersWithin(firstDeliveries(list));
    outOfOrderEvents += overtaken.size;
    for (const overtakers of overtaken.values()) inversionPairs += overtakers.length;
    if (overtaken.size > 0) aggregatesAffected += 1;
  }
  return { outOfOrderEvents, inversionPairs, aggregatesAffected };
}

/** Joins one aggregate's canonical events with its delivery attempts by `eventId`. */
export function buildTimeline(events: readonly CanonicalEvent[], attempts: readonly Attempt[]): Timeline {
  const deliveries = [...attempts].sort((a, b) => a.deliverySequence - b.deliverySequence);
  const attemptsOf = new Map<string, Attempt[]>();
  for (const attempt of deliveries) {
    const list = attemptsOf.get(attempt.eventId) ?? [];
    list.push(attempt);
    attemptsOf.set(attempt.eventId, list);
  }
  const overtaken = overtakersWithin(firstDeliveries(deliveries));
  const first = new Map(firstDeliveries(deliveries).map((entry) => [entry.eventId, entry.deliverySequence]));

  const timelineEvents = [...events]
    .sort((a, b) => a.aggregateVersion - b.aggregateVersion)
    .map((event): TimelineEvent => {
      const own = attemptsOf.get(event.eventId) ?? [];
      const original = own.find((attempt) => attempt.kind === 'original');
      const faultTypes = new Set(own.flatMap((attempt) => attempt.faults.map((fault) => fault.type)));
      const firstDeliverySequence = first.get(event.eventId) ?? null;
      return {
        event,
        attempts: own,
        firstDeliverySequence,
        overtakenBy: overtaken.get(event.eventId) ?? [],
        flags: {
          outOfOrder: overtaken.has(event.eventId),
          lost: firstDeliverySequence === null,
          duplicated: own.some((attempt) => attempt.kind === 'duplicate'),
          retried: own.some((attempt) => attempt.kind === 'retry'),
          delayed: original?.faults.some((fault) => fault.type === 'delay') ?? false,
          late: faultTypes.has('late'),
          reordered: faultTypes.has('reorder'),
        },
      };
    });

  let inversionPairs = 0;
  for (const overtakers of overtaken.values()) inversionPairs += overtakers.length;
  return { events: timelineEvents, deliveries, outOfOrderEvents: overtaken.size, inversionPairs };
}

const LABELS: Readonly<Record<keyof EventFlags, string>> = {
  outOfOrder: 'out of order',
  lost: 'lost',
  duplicated: 'duplicated',
  retried: 'retried',
  delayed: 'delayed',
  late: 'late',
  reordered: 'reordered',
};

/** The flags that are set, as the labels the UI shows, in a stable order. */
export function activeFlags(flags: EventFlags): { key: keyof EventFlags; label: string }[] {
  return (Object.keys(LABELS) as (keyof EventFlags)[]).filter((key) => flags[key]).map((key) => ({ key, label: LABELS[key] }));
}

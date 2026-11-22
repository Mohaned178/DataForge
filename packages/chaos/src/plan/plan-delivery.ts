import {
  RandomStream,
  normalizeSeed,
  serializeEventLog,
  sha256Hex,
  windowCloseOf,
  windowStartOf,
  type CanonicalEvent,
  type WindowingSpec,
} from '@dataforge/core';
import { chaosProfileHash, type ChaosProfile, type FaultType } from '../profile/chaos-profile';
import { PLANNER_VERSION } from '../version';
import { attemptId, type DeliveryAttempt, type FaultRecord } from './delivery-attempt';
import { summarizeDeliveryPlan, type DeliverySummary } from './summary';

export interface DeliveryPlanInput {
  /** A canonical log, in canonical order. It is read, never modified. */
  readonly events: readonly CanonicalEvent[];
  readonly profile: ChaosProfile;
  readonly chaosSeed: string | number;
}

export interface DeliveryPlan {
  readonly plannerVersion: string;
  readonly chaosSeed: string;
  readonly profileHash: string;
  /** SHA-256 of the canonical log (serialized as events.jsonl) the plan was made for. */
  readonly eventsSha256: string;
  /** Every attempt, in delivery order. */
  readonly attempts: readonly DeliveryAttempt[];
  readonly summary: DeliverySummary;
}

/** The random choices made for one event. Each fault type draws only from its own stream. */
interface FaultDecisions {
  readonly delayMs: number | undefined;
  /** How far past its window's close (in stream time) a late event arrives. */
  readonly lateByMs: number | undefined;
  readonly reorderDistance: number | undefined;
  readonly failures: number;
  readonly retryBackoffsMs: readonly number[];
  readonly duplicateOffsetsMs: readonly number[] | undefined;
}

type MutableAttempt = { -readonly [Key in keyof DeliveryAttempt]: DeliveryAttempt[Key] };

/**
 * Plans how a canonical log is delivered under a chaos profile.
 *
 * For each event, every fault type decides independently, from the stream
 * (chaos seed, "chaos.<fault type>", eventId), whether it applies and with which parameters. The
 * selection is always the first draw, so raising a rate only adds faulted events, and enabling one
 * fault type never changes which events another selects. The decisions then compose into a schedule:
 *
 *   1. delay:     original attempt at eventTimeMs + delayMs
 *   2. late:      moved to 1 ms after the first delivery of an event whose event time is at least
 *                 lateByMs past the close of this event's window, so it arrives after the close
 *   3. reorder:   moved to 1 ms after the first delivery of the k-th later event of its aggregate
 *   4. transient: the first `failures` attempts fail, each retried after a backoff; with more
 *                 failures than maxRetries the event is lost (only when the profile allows loss)
 *   5. duplicate: extra copies of the first delivered attempt, after a redelivery offset
 *
 * Late and reorder anchors always have a larger event time than the event they hold back, so
 * planning from the last canonical event to the first makes every anchor final before it is used.
 *
 * Attempts are delivered in (scheduledDeliveryTimeMs, eventSequence, attemptNumber) order, so a
 * profile without faults delivers exactly the canonical order at event time.
 */
export function planDelivery(input: DeliveryPlanInput): DeliveryPlan {
  const chaosSeed = normalizeSeed(input.chaosSeed);
  const { events, profile } = input;
  const aggregates = indexAggregates(events);
  const lateAnchors = new LateAnchors(events);

  const attemptsByEvent = new Map<string, MutableAttempt[]>();
  const anchorTimeByEvent = new Map<string, number>();

  for (let position = events.length - 1; position >= 0; position--) {
    const event = events[position] as CanonicalEvent;
    const aggregate = aggregates.get(event.aggregateId) as CanonicalEvent[];
    const index = event.aggregateVersion - 1;
    const decisions = decideFaults(chaosSeed, profile, event);
    const attempts = scheduleEvent(event, decisions, profile, {
      laterEventsInAggregate: aggregate.length - 1 - index,
      reorderTarget: (distance) => {
        const target = aggregate[index + distance] as CanonicalEvent;
        return { eventId: target.eventId, anchorTimeMs: anchorTimeByEvent.get(target.eventId) as number };
      },
      lateTarget: (lateByMs, windowing) => lateAnchors.after(event, lateByMs, windowing),
    });
    attemptsByEvent.set(event.eventId, attempts);
    anchorTimeByEvent.set(event.eventId, anchorTime(attempts));
    lateAnchors.record(position, attempts.find((attempt) => attempt.plannedOutcome === 'delivered'));
  }

  const ordered = [...attemptsByEvent.values()].flat().sort(compareDeliveryOrder);
  ordered.forEach((attempt, index) => {
    attempt.deliverySequence = index + 1;
  });
  const attempts: readonly DeliveryAttempt[] = ordered;

  return {
    plannerVersion: PLANNER_VERSION,
    chaosSeed,
    profileHash: chaosProfileHash(profile),
    eventsSha256: sha256Hex(serializeEventLog(events)),
    attempts,
    summary: summarizeDeliveryPlan(events, attempts, profile),
  };
}

export function compareDeliveryOrder(a: DeliveryAttempt, b: DeliveryAttempt): number {
  return a.scheduledDeliveryTimeMs - b.scheduledDeliveryTimeMs || a.eventSequence - b.eventSequence || a.attemptNumber - b.attemptNumber;
}

function faultStream(chaosSeed: string, faultType: FaultType, eventId: string): RandomStream {
  return RandomStream.derive(chaosSeed, `chaos.${faultType}`, eventId);
}

function decideFaults(chaosSeed: string, profile: ChaosProfile, event: CanonicalEvent): FaultDecisions {
  const { delay, late, reorder, duplicate, transientFailure } = profile.faults;

  const delayStream = faultStream(chaosSeed, 'delay', event.eventId);
  const delayMs = delayStream.chance(delay.rate) ? delayStream.intInRange(delay.delayMs) : undefined;

  let lateByMs: number | undefined;
  if (late !== undefined) {
    const lateStream = faultStream(chaosSeed, 'late', event.eventId);
    lateByMs = lateStream.chance(late.rate) ? lateStream.intInRange(late.lateByMs) : undefined;
  }

  const reorderStream = faultStream(chaosSeed, 'reorder', event.eventId);
  const reorderDistance = reorderStream.chance(reorder.rate) ? reorderStream.intInRange(reorder.distance) : undefined;

  const failureStream = faultStream(chaosSeed, 'transientFailure', event.eventId);
  let failures = 0;
  const retryBackoffsMs: number[] = [];
  if (failureStream.chance(transientFailure.rate)) {
    failures = failureStream.intInRange(transientFailure.failures);
    const retries = Math.min(failures, transientFailure.maxRetries);
    for (let retry = 0; retry < retries; retry++) {
      retryBackoffsMs.push(failureStream.intInRange(transientFailure.retryBackoffMs));
    }
  }

  const duplicateStream = faultStream(chaosSeed, 'duplicate', event.eventId);
  let duplicateOffsetsMs: number[] | undefined;
  if (duplicateStream.chance(duplicate.rate)) {
    const copies = duplicateStream.intInRange(duplicate.copies);
    duplicateOffsetsMs = [];
    for (let copy = 0; copy < copies; copy++) {
      duplicateOffsetsMs.push(duplicateStream.intInRange(duplicate.redeliveryOffsetMs));
    }
    duplicateOffsetsMs.sort((a, b) => a - b);
  }

  return { delayMs, lateByMs, reorderDistance, failures, retryBackoffsMs, duplicateOffsetsMs };
}

interface Anchors {
  readonly laterEventsInAggregate: number;
  readonly reorderTarget: (distance: number) => { eventId: string; anchorTimeMs: number };
  readonly lateTarget: (lateByMs: number, windowing: WindowingSpec) => LateAnchor | undefined;
}

function scheduleEvent(event: CanonicalEvent, decisions: FaultDecisions, profile: ChaosProfile, anchors: Anchors): MutableAttempt[] {
  const { laterEventsInAggregate, reorderTarget } = anchors;
  const originalFaults: FaultRecord[] = [];
  let timeMs = event.eventTimeMs;

  if (decisions.delayMs !== undefined) {
    timeMs += decisions.delayMs;
    originalFaults.push({ type: 'delay', delayMs: decisions.delayMs });
  }

  const late =
    decisions.lateByMs === undefined || profile.windowing === undefined ? undefined : anchors.lateTarget(decisions.lateByMs, profile.windowing);
  if (late !== undefined) {
    const lateMs = Math.max(timeMs, late.anchorTimeMs + 1);
    originalFaults.push({ type: 'late', windowCloseMs: late.windowCloseMs, behindEventId: late.eventId, shiftMs: lateMs - timeMs });
    timeMs = lateMs;
  }

  if (decisions.reorderDistance !== undefined && laterEventsInAggregate > 0) {
    const distance = Math.min(decisions.reorderDistance, laterEventsInAggregate);
    const target = reorderTarget(distance);
    const reorderedMs = Math.max(timeMs, target.anchorTimeMs + 1);
    originalFaults.push({ type: 'reorder', behindEventId: target.eventId, distance, shiftMs: reorderedMs - timeMs });
    timeMs = reorderedMs;
  }

  const { failures } = decisions;
  const failedAttempts = Math.min(failures, profile.faults.transientFailure.maxRetries + 1);
  const attempts: MutableAttempt[] = [];
  const addAttempt = (
    kind: DeliveryAttempt['kind'],
    scheduledDeliveryTimeMs: number,
    derivedFrom: DeliveryAttempt['derivedFrom'],
    faults: FaultRecord[],
  ): MutableAttempt => {
    const attemptNumber = attempts.length + 1;
    const failed = kind !== 'duplicate' && attemptNumber <= failedAttempts;
    const attempt: MutableAttempt = {
      attemptId: attemptId(event.aggregateId, event.aggregateVersion, attemptNumber),
      deliverySequence: 0,
      attemptNumber,
      kind,
      plannedOutcome: failed ? 'failed' : 'delivered',
      scheduledDeliveryTimeMs,
      eventId: event.eventId,
      eventSequence: event.sequence,
      eventType: event.type,
      eventTimeMs: event.eventTimeMs,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      derivedFrom,
      faults: failed ? [...faults, { type: 'transientFailure', failure: attemptNumber, failures }] : faults,
    };
    attempts.push(attempt);
    return attempt;
  };

  let previous = addAttempt('original', timeMs, null, originalFaults);
  for (const backoffMs of decisions.retryBackoffsMs) {
    timeMs += backoffMs;
    previous = addAttempt('retry', timeMs, { attemptId: previous.attemptId, offsetMs: backoffMs }, []);
  }

  const delivered = attempts.find((attempt) => attempt.plannedOutcome === 'delivered');
  if (delivered !== undefined && decisions.duplicateOffsetsMs !== undefined) {
    const copies = decisions.duplicateOffsetsMs.length;
    decisions.duplicateOffsetsMs.forEach((offsetMs, index) => {
      addAttempt('duplicate', delivered.scheduledDeliveryTimeMs + offsetMs, { attemptId: delivered.attemptId, offsetMs }, [
        { type: 'duplicate', copy: index + 1, copies },
      ]);
    });
  }
  return attempts;
}

/** When the event first reached the target, or, if it never did, when the sender gave up. */
function anchorTime(attempts: readonly DeliveryAttempt[]): number {
  const anchor = attempts.find((attempt) => attempt.plannedOutcome === 'delivered') ?? attempts[attempts.length - 1];
  if (anchor === undefined) {
    throw new RangeError('Every event has at least one delivery attempt');
  }
  return anchor.scheduledDeliveryTimeMs;
}

interface LateAnchor {
  readonly eventId: string;
  readonly anchorTimeMs: number;
  readonly windowCloseMs: number;
}

/**
 * Finds where a late event must wait: just after the first delivery of an event whose event time is
 * at least `lateByMs` past the close of its window. Once that event has reached the target, so has a
 * stream time past the close. Filled from the last canonical event to the first, so every candidate
 * (always later in canonical order) is final when it is looked up.
 */
class LateAnchors {
  /** Per canonical position: the earliest first delivery among the events from there to the end. */
  private readonly earliestFrom: ({ readonly eventId: string; readonly timeMs: number } | undefined)[];
  /** Position of the last event that is delivered at all (a lost event never advances stream time). */
  private lastDelivered: number | undefined;

  constructor(private readonly events: readonly CanonicalEvent[]) {
    this.earliestFrom = new Array<undefined>(events.length + 1).fill(undefined);
  }

  record(position: number, firstDelivered: DeliveryAttempt | undefined): void {
    const next = this.earliestFrom[position + 1];
    const own = firstDelivered === undefined ? undefined : { eventId: firstDelivered.eventId, timeMs: firstDelivered.scheduledDeliveryTimeMs };
    // On equal times the earlier canonical position is delivered first.
    this.earliestFrom[position] = own !== undefined && (next === undefined || own.timeMs <= next.timeMs) ? own : next;
    if (own !== undefined && this.lastDelivered === undefined) {
      this.lastDelivered = position;
    }
  }

  /**
   * The anchor for a late event, or undefined when no delivered event lies past the close (the
   * window closes after the log ends). When the log ends sooner than `lateByMs` past the close, the
   * last delivered event's time is the target instead.
   */
  after(event: CanonicalEvent, lateByMs: number, windowing: WindowingSpec): LateAnchor | undefined {
    const windowCloseMs = windowCloseOf(windowStartOf(event.eventTimeMs, windowing.sizeMs), windowing);
    if (this.lastDelivered === undefined) {
      return undefined;
    }
    const latestDeliveredTimeMs = (this.events[this.lastDelivered] as CanonicalEvent).eventTimeMs;
    if (latestDeliveredTimeMs < windowCloseMs) {
      return undefined;
    }
    const streamTimeMs = Math.min(windowCloseMs + lateByMs, latestDeliveredTimeMs);
    const anchor = this.earliestFrom[this.firstPositionAtOrAfter(streamTimeMs)];
    if (anchor === undefined) {
      throw new RangeError(`No delivered event at or after ${streamTimeMs} ms, although one was found at ${latestDeliveredTimeMs} ms`);
    }
    return { eventId: anchor.eventId, anchorTimeMs: anchor.timeMs, windowCloseMs };
  }

  /** Canonical order is sorted by event time, so the first event at or after an instant is found by bisection. */
  private firstPositionAtOrAfter(timeMs: number): number {
    let low = 0;
    let high = this.events.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.events[middle] as CanonicalEvent).eventTimeMs < timeMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/** Groups a canonical log by aggregate, checking the invariants the planner relies on. */
function indexAggregates(events: readonly CanonicalEvent[]): Map<string, CanonicalEvent[]> {
  const aggregates = new Map<string, CanonicalEvent[]>();
  const eventIds = new Set<string>();
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      throw new RangeError(`Not a canonical log: event ${event.eventId} has sequence ${event.sequence}, expected ${index + 1}`);
    }
    if (eventIds.has(event.eventId)) {
      throw new RangeError(`Not a canonical log: event ID ${event.eventId} appears twice`);
    }
    eventIds.add(event.eventId);
    const aggregate = aggregates.get(event.aggregateId) ?? [];
    if (event.aggregateVersion !== aggregate.length + 1) {
      throw new RangeError(
        `Not a canonical log: ${event.eventId} is version ${event.aggregateVersion} of ${event.aggregateId}, expected ${aggregate.length + 1}`,
      );
    }
    aggregate.push(event);
    aggregates.set(event.aggregateId, aggregate);
  });
  return aggregates;
}

import { HOUR_MS, MINUTE_MS, canonicalJson, sha256Hex, windowCloseOf, windowStartOf, type CanonicalEvent } from '@dataforge/core';
import {
  ChaosProfileValidationError,
  classifyArrivals,
  explainEvent,
  parseChaosProfile,
  planDelivery,
  serializeDeliveryPlan,
  type DeliveryAttempt,
  type DeliveryPlan,
} from '../src';
import { attemptsByEvent, canonicalLog, eventsWithFault, exampleProfile } from './support/fixtures';

const WINDOWING = { sizeMs: HOUR_MS, allowedLatenessMs: 10 * MINUTE_MS };

function windowedProfile(faults: Record<string, unknown>, windowing = WINDOWING) {
  return parseChaosProfile({ formatVersion: 1, name: 'test', windowing, faults });
}

function firstDeliveries(attempts: readonly DeliveryAttempt[]): Map<string, DeliveryAttempt> {
  const first = new Map<string, DeliveryAttempt>();
  for (const attempt of [...attempts].sort((a, b) => a.deliverySequence - b.deliverySequence)) {
    if (attempt.plannedOutcome === 'delivered' && !first.has(attempt.eventId)) {
      first.set(attempt.eventId, attempt);
    }
  }
  return first;
}

/** The largest event time delivered strictly before each delivery sequence. */
function streamTimeBefore(attempts: readonly DeliveryAttempt[]): Map<number, number | null> {
  const before = new Map<number, number | null>();
  let stream: number | null = null;
  for (const attempt of [...attempts].sort((a, b) => a.deliverySequence - b.deliverySequence)) {
    before.set(attempt.deliverySequence, stream);
    if (attempt.plannedOutcome === 'delivered') {
      stream = stream === null ? attempt.eventTimeMs : Math.max(stream, attempt.eventTimeMs);
    }
  }
  return before;
}

describe('windowing and late faults in a chaos profile', () => {
  it('keeps every existing example profile exactly as it resolved before: no windowing, no late fault', () => {
    for (const name of ['none', 'spec-example', 'flaky-network', 'lossy'] as const) {
      const resolved = exampleProfile(name);
      expect(Object.keys(resolved).sort()).toEqual(['description', 'faults', 'formatVersion', 'name']);
      expect(Object.keys(resolved.faults).sort()).toEqual(['delay', 'duplicate', 'reorder', 'transientFailure']);
    }
  });

  it('fills in the late fault defaults and the allowed lateness default', () => {
    const resolved = parseChaosProfile({ formatVersion: 1, name: 'x', windowing: { sizeMs: HOUR_MS }, faults: { late: { rate: 0.1 } } });
    expect(resolved.windowing).toEqual({ sizeMs: HOUR_MS, allowedLatenessMs: 0 });
    expect(resolved.faults.late).toEqual({ rate: 0.1, lateByMs: { min: MINUTE_MS, max: 30 * MINUTE_MS } });
  });

  it('rejects a late fault without a windowing contract, and invalid windowing, with the path of each problem', () => {
    expect(() => parseChaosProfile({ formatVersion: 1, name: 'x', faults: { late: { rate: 0.1 } } })).toThrow(
      /faults\.late: needs a "windowing" section/,
    );
    let error: unknown;
    try {
      parseChaosProfile({ formatVersion: 1, name: 'x', windowing: { sizeMs: 10, allowedLatenessMs: -1, slide: 1 }, faults: {} });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChaosProfileValidationError);
    const issues = (error as ChaosProfileValidationError).issues.join('\n');
    expect(issues).toMatch(/windowing\.sizeMs/);
    expect(issues).toMatch(/windowing\.allowedLatenessMs/);
    expect(issues).toMatch(/windowing: Unrecognized key/);
  });
});

describe('late faults', () => {
  const events = canonicalLog('ecommerce-small');
  const lateProfile = windowedProfile({ late: { rate: 0.2, lateByMs: { min: MINUTE_MS, max: 30 * MINUTE_MS } }, delay: { rate: 0.2 }, reorder: { rate: 0.1 } });
  const plan = planDelivery({ events, profile: lateProfile, chaosSeed: '7' });
  const late = eventsWithFault(plan.attempts, 'late');
  const arrivals = classifyArrivals(plan.attempts, WINDOWING);
  const latestEventTimeMs = (events[events.length - 1] as CanonicalEvent).eventTimeMs;

  it('are planned for a sizeable share of the events', () => {
    expect(late.length).toBeGreaterThan(60);
    expect(plan.summary.faults.late?.faultedEvents).toBe(late.length);
  });

  it('always deliver the event after its window has closed, at least lateByMs past the close in stream time', () => {
    const first = firstDeliveries(plan.attempts);
    const before = streamTimeBefore(plan.attempts);
    for (const eventId of late) {
      const attempt = first.get(eventId) as DeliveryAttempt;
      const close = windowCloseOf(windowStartOf(attempt.eventTimeMs, HOUR_MS), WINDOWING);
      const stream = before.get(attempt.deliverySequence) as number;
      expect(stream).toBeGreaterThanOrEqual(Math.min(close + MINUTE_MS, latestEventTimeMs));
      expect(arrivals.get(eventId)?.arrival).toBe('after-close');
    }
  });

  it('record a close and an anchor that explain the attempt time exactly', () => {
    const first = firstDeliveries(plan.attempts);
    const eventsById = new Map(events.map((event) => [event.eventId, event]));
    for (const attempt of plan.attempts.filter((a) => a.kind === 'original')) {
      let expected = attempt.eventTimeMs;
      for (const fault of attempt.faults) {
        if (fault.type === 'delay') {
          expected += fault.delayMs;
        } else if (fault.type === 'late') {
          const anchor = first.get(fault.behindEventId) as DeliveryAttempt;
          expect((eventsById.get(fault.behindEventId) as CanonicalEvent).eventTimeMs).toBeGreaterThanOrEqual(fault.windowCloseMs);
          expect(fault.windowCloseMs).toBe(windowCloseOf(windowStartOf(attempt.eventTimeMs, HOUR_MS), WINDOWING));
          expect(Math.max(expected, anchor.scheduledDeliveryTimeMs + 1) - expected).toBe(fault.shiftMs);
          expected += fault.shiftMs;
        } else if (fault.type === 'reorder') {
          expected += fault.shiftMs;
        }
      }
      expect(attempt.scheduledDeliveryTimeMs).toBe(expected);
    }
  });

  it('only apply to events whose window closes before the last delivered event', () => {
    for (const eventId of late) {
      const event = events.find((candidate) => candidate.eventId === eventId) as CanonicalEvent;
      expect(windowCloseOf(windowStartOf(event.eventTimeMs, HOUR_MS), WINDOWING)).toBeLessThanOrEqual(latestEventTimeMs);
    }
    const eligible = events.filter((event) => windowCloseOf(windowStartOf(event.eventTimeMs, HOUR_MS), WINDOWING) <= latestEventTimeMs);
    expect(plan.summary.faults.late?.eligibleEvents).toBe(eligible.length);
  });

  it('do not change which events the other fault types select, or their parameters', () => {
    const without = planDelivery({ events, profile: windowedProfile({ delay: { rate: 0.2 }, reorder: { rate: 0.1 } }), chaosSeed: '7' });
    for (const type of ['delay', 'reorder'] as const) {
      expect(eventsWithFault(plan.attempts, type)).toEqual(eventsWithFault(without.attempts, type));
    }
    const delays = (attempts: readonly DeliveryAttempt[]) =>
      attempts
        .flatMap((attempt) => attempt.faults.filter((fault) => fault.type === 'delay').map((fault) => `${attempt.eventId}:${canonicalJson(fault)}`))
        .sort();
    expect(delays(plan.attempts)).toEqual(delays(without.attempts));
  });

  it('only add late events when the rate is raised', () => {
    const lower = planDelivery({ events, profile: windowedProfile({ late: { rate: 0.05 }, delay: { rate: 0.2 }, reorder: { rate: 0.1 } }), chaosSeed: '7' });
    const fewer = eventsWithFault(lower.attempts, 'late');
    expect(fewer.length).toBeLessThan(late.length);
    expect(late).toEqual(expect.arrayContaining(fewer));
  });

  it('keep the event identity: retries and duplicates follow the late original', () => {
    const lateWithAll = planDelivery({
      events,
      profile: windowedProfile({ late: { rate: 0.3 }, duplicate: { rate: 0.3 }, transientFailure: { rate: 0.3, failures: { min: 1, max: 2 } } }),
      chaosSeed: '11',
    });
    const byEvent = attemptsByEvent(lateWithAll.attempts);
    for (const eventId of eventsWithFault(lateWithAll.attempts, 'late')) {
      const own = byEvent.get(eventId) as DeliveryAttempt[];
      const original = own[0] as DeliveryAttempt;
      expect(original.kind).toBe('original');
      for (const later of own.slice(1)) {
        expect(later.scheduledDeliveryTimeMs).toBeGreaterThanOrEqual(original.scheduledDeliveryTimeMs);
      }
    }
  });
});

describe('arrivals of a windowed plan', () => {
  const events = canonicalLog('ecommerce-small');

  it('are all on time without faults', () => {
    const plan = planDelivery({ events, profile: windowedProfile({}), chaosSeed: '7' });
    const arrivals = classifyArrivals(plan.attempts, WINDOWING);
    expect([...arrivals.values()].every((arrival) => arrival.arrival === 'on-time')).toBe(true);
    const counted = events.filter((event) => event.type === 'OrderCreated' || event.type === 'PaymentCompleted').length;
    expect(plan.summary.windowing).toEqual({ ...WINDOWING, arrivals: { onTime: counted, withinLateness: 0, afterClose: 0, lost: 0 } });
    expect(plan.summary.faults.late).toBeUndefined();
  });

  it('never close a window on an event delayed by less than the allowed lateness (windowed-delays)', () => {
    for (const log of [events, canonicalLog('ecommerce-standard')]) {
      const plan = planDelivery({ events: log, profile: exampleProfile('windowed-delays'), chaosSeed: '7' });
      const { arrivals } = plan.summary.windowing as NonNullable<DeliveryPlan['summary']['windowing']>;
      expect(arrivals.afterClose).toBe(0);
      expect(arrivals.lost).toBe(0);
    }
    // A busy stream passes the end of an hour before an event delayed across it arrives.
    const busy = planDelivery({ events: canonicalLog('ecommerce-standard'), profile: exampleProfile('windowed-delays'), chaosSeed: '7' });
    expect(busy.summary.windowing?.arrivals.withinLateness).toBeGreaterThan(20);
  });

  it('classify by stream time: on time before the window ends, within lateness until the close, after close from then on', () => {
    const plan = planDelivery({ events, profile: exampleProfile('late-data'), chaosSeed: '7' });
    const before = streamTimeBefore(plan.attempts);
    for (const arrival of classifyArrivals(plan.attempts, WINDOWING).values()) {
      if (arrival.arrival === 'lost') {
        continue;
      }
      const stream = before.get(arrival.firstDeliverySequence as number) ?? null;
      expect(arrival.streamTimeMs).toBe(stream);
      const expected = stream === null || stream < arrival.windowEndMs ? 'on-time' : stream < arrival.windowCloseMs ? 'within-lateness' : 'after-close';
      expect(arrival.arrival).toBe(expected);
    }
  });

  it('report lost events as lost', () => {
    const plan = planDelivery({
      events,
      profile: windowedProfile({ transientFailure: { rate: 0.2, failures: { min: 3, max: 3 }, maxRetries: 1, allowLoss: true } }),
      chaosSeed: '7',
    });
    const arrivals = classifyArrivals(plan.attempts, WINDOWING);
    const lost = [...arrivals.values()].filter((arrival) => arrival.arrival === 'lost');
    expect(lost.length).toBe(plan.summary.eventsLost);
    expect(lost.every((arrival) => arrival.firstDeliverySequence === null)).toBe(true);
  });

  it('are shown by explain for a windowed plan only', () => {
    const plan = planDelivery({ events, profile: exampleProfile('late-data'), chaosSeed: '7' });
    const eventId = eventsWithFault(plan.attempts, 'late')[0] as string;
    expect(explainEvent(events, plan.attempts, eventId, WINDOWING).window?.arrival).toBe('after-close');
    expect(explainEvent(events, plan.attempts, eventId).window).toBeUndefined();
  });
});

describe('observed late rate on the specification-sized scenario', () => {
  it('is within 0.5 percentage points of the configured rate', () => {
    const events = canonicalLog('ecommerce-standard');
    const plan = planDelivery({ events, profile: windowedProfile({ late: { rate: 0.05 } }), chaosSeed: '7' });
    const tally = plan.summary.faults.late as { eligibleEvents: number; faultedEvents: number };
    expect(tally.eligibleEvents).toBeGreaterThan(10_000);
    expect(Math.abs(tally.faultedEvents / tally.eligibleEvents - 0.05)).toBeLessThan(0.005);
  });
});

describe('golden windowed plan', () => {
  /**
   * Pins the plan for scenarios/ecommerce-small.json (seed 42) under chaos-profiles/late-data.json
   * with chaos seed 7. Regression guard, like test/golden.test.ts: a change needs a PLANNER_VERSION bump.
   */
  const plan = planDelivery({ events: canonicalLog('ecommerce-small'), profile: exampleProfile('late-data'), chaosSeed: '7' });

  it('reproduces the pinned plan and summary', () => {
    expect(sha256Hex(serializeDeliveryPlan(plan.attempts))).toBe('ddb558b944f9ae3dd952cd6db36599b01140a967b344fbea12161f6d39e197e5');
    expect(sha256Hex(canonicalJson(plan.summary))).toBe('337bdc0574a1ebda29979a08fdc5a02f9ea1e86a29c4c6e350561c141fcb16b0');
  });
});

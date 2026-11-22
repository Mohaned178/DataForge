import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOUR_MS,
  MINUTE_MS,
  WindowAccumulator,
  computeExpectedWindows,
  parseScenario,
  serializeActualWindows,
  sha256Hex,
  simulate,
  windowContribution,
  windowStartOf,
  type CanonicalEvent,
  type WindowAggregate,
} from '@dataforge/core';
import { classifyArrivals, parseChaosProfile, planDelivery, type ChaosProfile, type DeliveryAttempt } from '@dataforge/chaos';
import { CorrectTarget, NaiveTarget, createReferenceTarget, deliverInMemory, type DeliveryMessage } from '../src';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const scenario = parseScenario(JSON.parse(readFileSync(join(REPO_ROOT, 'scenarios', 'ecommerce-small.json'), 'utf8')));
const world = simulate({ scenario, seed: '42' });
const WINDOWING = { sizeMs: HOUR_MS, allowedLatenessMs: 10 * MINUTE_MS };
const expectedWindows = computeExpectedWindows(world.events, HOUR_MS);
const eventsById = new Map(world.events.map((event) => [event.eventId, event]));

function exampleProfile(name: string): ChaosProfile {
  return parseChaosProfile(JSON.parse(readFileSync(join(REPO_ROOT, 'chaos-profiles', `${name}.json`), 'utf8')));
}

function windowedPlan(profile: string | ChaosProfile, chaosSeed = '7'): readonly DeliveryAttempt[] {
  const parsed = typeof profile === 'string' ? exampleProfile(profile) : profile;
  return planDelivery({ events: world.events, profile: parsed, chaosSeed }).attempts;
}

function deliver(target: 'correct' | 'naive', attempts: readonly DeliveryAttempt[], windowing = WINDOWING) {
  return deliverInMemory({ events: world.events, attempts, target: createReferenceTarget(target, { windowing }) });
}

/** Windows recomputed from a plan: each delivered attempt chosen by `keep`, counted in the window `windowOf` gives it. */
function recompute(attempts: readonly DeliveryAttempt[], keep: (attempt: DeliveryAttempt) => boolean, windowOf: (attempt: DeliveryAttempt) => number): WindowAggregate[] {
  const accumulator = new WindowAccumulator(HOUR_MS);
  for (const attempt of [...attempts].sort((a, b) => a.deliverySequence - b.deliverySequence)) {
    const contribution = windowContribution(eventsById.get(attempt.eventId) as CanonicalEvent);
    if (attempt.plannedOutcome === 'delivered' && contribution !== undefined && keep(attempt)) {
      accumulator.add(windowOf(attempt), contribution);
    }
  }
  return accumulator.list();
}

function message(event: CanonicalEvent, deliverySequence: number, scheduledDeliveryTimeMs = event.eventTimeMs): DeliveryMessage {
  return { key: event.aggregateId, event, headers: { attemptId: `att_${deliverySequence}`, attemptNumber: 1, deliverySequence, scheduledDeliveryTimeMs } };
}

describe('reference targets without a windowing contract', () => {
  it('report no windows and keep their Milestone 3 counters and descriptions', () => {
    const attempts = windowedPlan(exampleProfile('spec-example'));
    const correct = deliverInMemory({ events: world.events, attempts, target: new CorrectTarget() });
    const naive = deliverInMemory({ events: world.events, attempts, target: new NaiveTarget() });
    expect(correct.windows).toBeUndefined();
    expect(naive.windows).toBeUndefined();
    expect(Object.keys(correct.counters).sort()).toEqual(['duplicatesIgnored', 'eventsParked']);
    expect(new CorrectTarget().description).toBe('idempotent by eventId, applies each aggregate in version order, waits for referenced entities');
    expect(new NaiveTarget().description).toBe('applies every message as it arrives: upserts, last arrival wins, not idempotent');
  });
});

describe('windowed reference targets', () => {
  it('both report exactly the expected windows when nothing goes wrong', () => {
    const attempts = windowedPlan(parseChaosProfile({ formatVersion: 1, name: 'none', windowing: WINDOWING, faults: {} }));
    for (const target of ['correct', 'naive'] as const) {
      expect(deliver(target, attempts).windows?.windows).toEqual(expectedWindows);
    }
  });

  it('correct gets every window right when delays stay within the allowed lateness and events are duplicated', () => {
    const result = deliver('correct', windowedPlan('windowed-delays'));
    expect(result.windows?.windows).toEqual(expectedWindows);
    expect(result.counters.windowEventsDropped).toBe(0);
    expect(result.counters.duplicatesIgnored).toBeGreaterThan(0);
  });

  it('naive counts every copy in the window it arrives in, which under delays and duplicates is wrong', () => {
    const attempts = windowedPlan('windowed-delays');
    const result = deliver('naive', attempts);
    const byArrival = recompute(attempts, () => true, (attempt) => windowStartOf(attempt.scheduledDeliveryTimeMs, HOUR_MS));
    expect(result.windows?.windows).toEqual(byArrival);
    expect(result.windows?.windows).not.toEqual(expectedWindows);
    const revenue = (windows: readonly WindowAggregate[]) => windows.reduce((total, window) => total + window.revenueMinor, 0);
    expect(revenue(byArrival)).toBeGreaterThan(revenue(expectedWindows));
  });

  it('correct drops exactly the events that the plan says arrive after their window closed', () => {
    const attempts = windowedPlan('late-data');
    const arrivals = classifyArrivals(attempts, WINDOWING);
    const afterClose = new Set([...arrivals.values()].filter((arrival) => arrival.arrival === 'after-close').map((arrival) => arrival.eventId));
    const result = deliver('correct', attempts);
    const counted = [...afterClose].filter((eventId) => windowContribution(eventsById.get(eventId) as CanonicalEvent) !== undefined);
    expect(counted.length).toBeGreaterThan(3);
    expect(result.counters.windowEventsDropped).toBe(counted.length);
    const firsts = new Set<string>();
    const keptFirst = (attempt: DeliveryAttempt) => {
      if (firsts.has(attempt.eventId)) {
        return false;
      }
      firsts.add(attempt.eventId);
      return !afterClose.has(attempt.eventId);
    };
    expect(result.windows?.windows).toEqual(recompute(attempts, keptFirst, (attempt) => windowStartOf(attempt.eventTimeMs, HOUR_MS)));
  });

  it('correct closes a window by stream time and ignores a copy of an event it already received', () => {
    const order = world.events.find((event) => event.type === 'OrderCreated') as CanonicalEvent;
    const muchLater = world.events.find((event) => event.eventTimeMs >= windowStartOf(order.eventTimeMs, HOUR_MS) + HOUR_MS + 10 * MINUTE_MS) as CanonicalEvent;
    const target = new CorrectTarget({ windowing: WINDOWING });
    target.handle(message(muchLater, 1));
    target.handle(message(order, 2));
    target.handle(message(order, 3));
    const result = target.finish();
    expect(result.counters.windowEventsDropped).toBe(1);
    expect(result.counters.duplicatesIgnored).toBe(1);
    expect(result.windows?.windows.some((window) => window.windowStartMs === windowStartOf(order.eventTimeMs, HOUR_MS))).toBe(
      windowContribution(muchLater) !== undefined && windowStartOf(muchLater.eventTimeMs, HOUR_MS) === windowStartOf(order.eventTimeMs, HOUR_MS),
    );
  });

  it('correct still counts an event that arrives after its window ended but before it closed', () => {
    const pair = world.events
      .filter((event) => event.type === 'OrderCreated')
      .map((order) => {
        const end = windowStartOf(order.eventTimeMs, HOUR_MS) + HOUR_MS;
        return { order, end, afterEnd: world.events.find((event) => event.eventTimeMs >= end && event.eventTimeMs < end + 10 * MINUTE_MS) };
      })
      .find((candidate) => candidate.afterEnd !== undefined);
    if (pair?.afterEnd === undefined) {
      throw new Error('the small world has no event within 10 minutes after the end of an order window');
    }
    const target = new CorrectTarget({ windowing: WINDOWING });
    target.handle(message(pair.afterEnd, 1));
    target.handle(message(pair.order, 2));
    const result = target.finish();
    expect(result.counters.windowEventsDropped).toBe(0);
    expect(result.windows?.windows.find((window) => window.windowStartMs === pair.end - HOUR_MS)?.ordersCreated).toBe(1);
  });

  it('give byte-identical windows for the same plan (golden, late-data, chaos seed 7)', () => {
    const attempts = windowedPlan('late-data');
    expect(sha256Hex(serializeActualWindows(deliver('correct', attempts).windows!))).toBe('c4972ff9eba16ac9d9d006f340b2a9d239d556d537b5816e9cba863b7f4b5957');
    expect(sha256Hex(serializeActualWindows(deliver('naive', attempts).windows!))).toBe('18e9d094842572a3635b3f02c30f2ce9902c02529666254a51834c3cd3273a47');
  });
});

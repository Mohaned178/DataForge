import { canonicalJson, serializeEventLog, sha256Hex, type CanonicalEvent } from '@dataforge/core';
import { compareDeliveryOrder, planDelivery, serializeDeliveryPlan, type DeliveryAttempt, type DeliveryPlan } from '../src';
import { attemptsByEvent, canonicalLog, eventsWithFault, exampleProfile, profile } from './support/fixtures';

const fingerprint = (plan: DeliveryPlan) => sha256Hex(serializeDeliveryPlan(plan.attempts) + canonicalJson(plan.summary));

function firstDeliveryPosition(attempts: readonly DeliveryAttempt[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.plannedOutcome === 'delivered' && !positions.has(attempt.eventId)) {
      positions.set(attempt.eventId, attempt.deliverySequence);
    }
  }
  return positions;
}

describe('delivery plan determinism', () => {
  const events = canonicalLog('ecommerce-small');

  it('produces a byte-identical plan for the same log, profile and chaos seed', () => {
    const first = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: '7' });
    const second = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: '7' });
    expect(fingerprint(second)).toBe(fingerprint(first));
  });

  it('treats the chaos seed as an opaque string, so 7 and "7" plan the same delivery', () => {
    const fromNumber = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: 7 });
    const fromString = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: '7' });
    expect(fingerprint(fromNumber)).toBe(fingerprint(fromString));
  });

  it('changes the plan, never the canonical log, when the chaos seed changes', () => {
    const logBefore = sha256Hex(serializeEventLog(events));
    const seven = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: '7' });
    const eight = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: '8' });
    expect(fingerprint(eight)).not.toBe(fingerprint(seven));
    expect(sha256Hex(serializeEventLog(events))).toBe(logBefore);
    expect(seven.eventsSha256).toBe(logBefore);
    expect(eight.eventsSha256).toBe(logBefore);
  });

  it('plans from frozen events without modifying them', () => {
    expect(events.every((event) => Object.isFrozen(event) && Object.isFrozen(event.payload))).toBe(true);
    const snapshot = serializeEventLog(events);
    planDelivery({ events, profile: exampleProfile('lossy'), chaosSeed: 'frozen' });
    expect(serializeEventLog(events)).toBe(snapshot);
  });

  it('rejects an input that is not a canonical log', () => {
    const shuffled = [events[1], events[0], ...events.slice(2)] as CanonicalEvent[];
    expect(() => planDelivery({ events: shuffled, profile: profile(), chaosSeed: '1' })).toThrow(/Not a canonical log/);
    const duplicated = [...events, events[events.length - 1]] as CanonicalEvent[];
    expect(() => planDelivery({ events: duplicated, profile: profile(), chaosSeed: '1' })).toThrow(/Not a canonical log/);
  });

  it('rejects an invalid chaos seed', () => {
    expect(() => planDelivery({ events, profile: profile(), chaosSeed: 'has space' })).toThrow(/Invalid seed/);
  });
});

describe('delivery plan structure', () => {
  const events = canonicalLog('ecommerce-small');
  const plan = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: '7' });

  it('lists attempts in delivery order with contiguous delivery sequence numbers', () => {
    plan.attempts.forEach((attempt, index) => {
      expect(attempt.deliverySequence).toBe(index + 1);
      if (index > 0) {
        expect(compareDeliveryOrder(plan.attempts[index - 1] as DeliveryAttempt, attempt)).toBeLessThan(0);
      }
    });
  });

  it('gives every attempt a unique attemptId and every event an original attempt', () => {
    expect(new Set(plan.attempts.map((attempt) => attempt.attemptId)).size).toBe(plan.attempts.length);
    const byEvent = attemptsByEvent(plan.attempts);
    expect(byEvent.size).toBe(events.length);
    for (const event of events) {
      const own = byEvent.get(event.eventId) as DeliveryAttempt[];
      expect(own[0]).toMatchObject({ kind: 'original', attemptNumber: 1, derivedFrom: null });
      own.forEach((attempt, index) => {
        expect(attempt).toMatchObject({
          attemptNumber: index + 1,
          eventSequence: event.sequence,
          eventType: event.type,
          eventTimeMs: event.eventTimeMs,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
        });
        expect(attempt.scheduledDeliveryTimeMs).toBeGreaterThanOrEqual(event.eventTimeMs);
      });
    }
  });

  it('explains the scheduled time of every attempt from its recorded faults', () => {
    const byId = new Map(plan.attempts.map((attempt) => [attempt.attemptId, attempt]));
    for (const attempt of plan.attempts) {
      if (attempt.derivedFrom === null) {
        let expected = attempt.eventTimeMs;
        for (const fault of attempt.faults) {
          if (fault.type === 'delay') {
            expected += fault.delayMs;
          } else if (fault.type === 'reorder') {
            expected += fault.shiftMs;
          }
        }
        expect(attempt.kind).toBe('original');
        expect(attempt.scheduledDeliveryTimeMs).toBe(expected);
      } else {
        const source = byId.get(attempt.derivedFrom.attemptId) as DeliveryAttempt;
        expect(source.eventId).toBe(attempt.eventId);
        expect(attempt.scheduledDeliveryTimeMs).toBe(source.scheduledDeliveryTimeMs + attempt.derivedFrom.offsetMs);
        expect(source.plannedOutcome).toBe(attempt.kind === 'retry' ? 'failed' : 'delivered');
      }
    }
  });

  it('summarizes exactly what the attempts contain', () => {
    const { summary } = plan;
    expect(summary.events).toBe(events.length);
    expect(summary.attempts).toBe(plan.attempts.length);
    expect(summary.attemptsByKind.original).toBe(events.length);
    expect(summary.attemptsByKind.retry).toBe(plan.attempts.filter((a) => a.kind === 'retry').length);
    expect(summary.attemptsByKind.duplicate).toBe(plan.attempts.filter((a) => a.kind === 'duplicate').length);
    expect(summary.attemptsByOutcome.failed).toBe(plan.attempts.filter((a) => a.plannedOutcome === 'failed').length);
    expect(summary.faults.delay.faultedEvents).toBe(eventsWithFault(plan.attempts, 'delay').length);
    expect(summary.faults.reorder.faultedEvents).toBe(eventsWithFault(plan.attempts, 'reorder').length);
    expect(summary.faults.duplicate.faultedEvents).toBe(eventsWithFault(plan.attempts, 'duplicate').length);
    expect(summary.faults.transientFailure.faultedEvents).toBe(eventsWithFault(plan.attempts, 'transientFailure').length);
    expect(summary.eventsLost).toBe(0);
    expect(summary.lastScheduledDeliveryTimeMs).toBe(Math.max(...plan.attempts.map((a) => a.scheduledDeliveryTimeMs)));
  });
});

describe('a profile without faults', () => {
  const events = canonicalLog('ecommerce-small');
  const plan = planDelivery({ events, profile: exampleProfile('none'), chaosSeed: '7' });

  it('delivers every event exactly once, in canonical order, at its event time', () => {
    expect(plan.attempts).toHaveLength(events.length);
    plan.attempts.forEach((attempt, index) => {
      const event = events[index] as CanonicalEvent;
      expect(attempt).toEqual({
        attemptId: `att_${event.aggregateId}_${event.aggregateVersion}_1`,
        deliverySequence: event.sequence,
        attemptNumber: 1,
        kind: 'original',
        plannedOutcome: 'delivered',
        scheduledDeliveryTimeMs: event.eventTimeMs,
        eventId: event.eventId,
        eventSequence: event.sequence,
        eventType: event.type,
        eventTimeMs: event.eventTimeMs,
        aggregateId: event.aggregateId,
        aggregateVersion: event.aggregateVersion,
        derivedFrom: null,
        faults: [],
      });
    });
    expect(plan.summary.ordering).toEqual({ outOfOrderEvents: 0, inversionPairs: 0, aggregatesAffected: 0 });
  });

  it('does not depend on the chaos seed', () => {
    const other = planDelivery({ events, profile: exampleProfile('none'), chaosSeed: 'another-seed' });
    expect(serializeDeliveryPlan(other.attempts)).toBe(serializeDeliveryPlan(plan.attempts));
  });
});

describe('observed fault rates on the specification-sized scenario', () => {
  const events = canonicalLog('ecommerce-standard');
  const rates = { delay: 0.05, duplicate: 0.03, reorder: 0.02, transientFailure: 0.04 };
  const plan = planDelivery({
    events,
    profile: profile({
      delay: { rate: rates.delay },
      duplicate: { rate: rates.duplicate },
      reorder: { rate: rates.reorder },
      transientFailure: { rate: rates.transientFailure },
    }),
    chaosSeed: '7',
  });

  it.each(Object.entries(rates))('%s is within 0.5 percentage points of its configured rate', (type, rate) => {
    const tally = plan.summary.faults[type as keyof typeof rates];
    expect(tally.eligibleEvents).toBeGreaterThan(10_000);
    expect(Math.abs(tally.faultedEvents / tally.eligibleEvents - rate)).toBeLessThan(0.005);
  });
});

describe('fault selection', () => {
  const events = canonicalLog('ecommerce-small');
  const all = exampleProfile('flaky-network');
  const allPlan = planDelivery({ events, profile: all, chaosSeed: '7' });

  it.each(['delay', 'reorder', 'duplicate', 'transientFailure'] as const)(
    'selects the same events for %s whether or not the other fault types are enabled',
    (type) => {
      const alone = profile({ [type]: all.faults[type] });
      const alonePlan = planDelivery({ events, profile: alone, chaosSeed: '7' });
      expect(eventsWithFault(alonePlan.attempts, type)).toEqual(eventsWithFault(allPlan.attempts, type));
      expect(eventsWithFault(alonePlan.attempts, type).length).toBeGreaterThan(0);
    },
  );

  it('draws the same parameters for a fault regardless of the other fault types', () => {
    const delayOnly = planDelivery({ events, profile: profile({ delay: all.faults.delay }), chaosSeed: '7' });
    const delays = (plan: DeliveryPlan) =>
      plan.attempts.flatMap((attempt) => attempt.faults.filter((fault) => fault.type === 'delay').map((fault) => `${attempt.eventId}:${fault.delayMs}`)).sort();
    expect(delays(delayOnly)).toEqual(delays(allPlan));
  });

  it('only adds faulted events when a rate is raised', () => {
    const low = planDelivery({ events, profile: profile({ duplicate: { rate: 0.03 } }), chaosSeed: '7' });
    const high = planDelivery({ events, profile: profile({ duplicate: { rate: 0.2 } }), chaosSeed: '7' });
    const lowIds = eventsWithFault(low.attempts, 'duplicate');
    const highIds = new Set(eventsWithFault(high.attempts, 'duplicate'));
    expect(highIds.size).toBeGreaterThan(lowIds.length);
    expect(lowIds.every((id) => highIds.has(id))).toBe(true);
  });
});

describe('duplicates', () => {
  const events = canonicalLog('ecommerce-small');
  const plan = planDelivery({
    events,
    profile: profile({ duplicate: { rate: 0.2, copies: { min: 1, max: 3 }, redeliveryOffsetMs: { min: 0, max: 120_000 } } }),
    chaosSeed: '7',
  });
  const duplicates = plan.attempts.filter((attempt) => attempt.kind === 'duplicate');

  it('keep the eventId of the original and get their own attemptId', () => {
    expect(duplicates.length).toBeGreaterThan(20);
    const byId = new Map(plan.attempts.map((attempt) => [attempt.attemptId, attempt]));
    for (const duplicate of duplicates) {
      const source = byId.get(duplicate.derivedFrom?.attemptId ?? '') as DeliveryAttempt;
      expect(duplicate.eventId).toBe(source.eventId);
      expect(duplicate.attemptId).not.toBe(source.attemptId);
      expect(duplicate.plannedOutcome).toBe('delivered');
      expect(duplicate.deliverySequence).toBeGreaterThan(source.deliverySequence);
    }
  });

  it('number their copies in delivery order', () => {
    for (const own of attemptsByEvent(plan.attempts).values()) {
      const copies = own.filter((attempt) => attempt.kind === 'duplicate');
      copies.forEach((copy, index) => {
        expect(copy.faults).toEqual([{ type: 'duplicate', copy: index + 1, copies: copies.length }]);
      });
    }
    expect(plan.summary.faults.duplicate.extraDeliveries).toBe(duplicates.length);
  });
});

describe('reordering', () => {
  const events = canonicalLog('ecommerce-small');
  const plan = planDelivery({ events, profile: profile({ reorder: { rate: 0.3, distance: { min: 1, max: 3 } } }), chaosSeed: '7' });
  const reordered = plan.attempts.flatMap((attempt) =>
    attempt.faults.flatMap((fault) => (fault.type === 'reorder' ? [{ attempt, fault }] : [])),
  );

  it('delivers every reordered event after the later event of its aggregate it was moved behind', () => {
    expect(reordered.length).toBeGreaterThan(50);
    const positions = firstDeliveryPosition(plan.attempts);
    for (const { attempt, fault } of reordered) {
      expect(fault.behindEventId).toBe(`evt_${attempt.aggregateId}_${attempt.aggregateVersion + fault.distance}`);
      expect(positions.get(attempt.eventId)).toBeGreaterThan(positions.get(fault.behindEventId) as number);
    }
    expect(plan.summary.ordering.outOfOrderEvents).toBeGreaterThanOrEqual(reordered.length);
  });

  it('only applies to events that have a later event in their aggregate', () => {
    const latest = new Map<string, number>();
    for (const event of events) {
      latest.set(event.aggregateId, event.aggregateVersion);
    }
    for (const { attempt } of reordered) {
      expect(attempt.aggregateVersion).toBeLessThan(latest.get(attempt.aggregateId) as number);
    }
    expect(plan.summary.faults.reorder.eligibleEvents).toBe(events.filter((e) => e.aggregateVersion < (latest.get(e.aggregateId) as number)).length);
  });
});

describe('transient delivery failures', () => {
  const events = canonicalLog('ecommerce-small');

  it('retry each failed attempt after its backoff until one is delivered, when loss is not allowed', () => {
    const plan = planDelivery({
      events,
      profile: profile({ transientFailure: { rate: 0.2, failures: { min: 1, max: 3 }, maxRetries: 3, retryBackoffMs: { min: 500, max: 5_000 } } }),
      chaosSeed: '7',
    });
    let faultedEvents = 0;
    for (const own of attemptsByEvent(plan.attempts).values()) {
      const failed = own.filter((attempt) => attempt.plannedOutcome === 'failed');
      const delivered = own.filter((attempt) => attempt.plannedOutcome === 'delivered');
      expect(delivered).toHaveLength(1);
      if (failed.length === 0) {
        continue;
      }
      faultedEvents += 1;
      expect(own.map((attempt) => attempt.plannedOutcome)).toEqual([...failed.map(() => 'failed'), 'delivered']);
      own.slice(1).forEach((retry, index) => {
        const previous = own[index] as DeliveryAttempt;
        expect(retry.kind).toBe('retry');
        expect(retry.derivedFrom?.attemptId).toBe(previous.attemptId);
        expect(retry.derivedFrom?.offsetMs).toBeGreaterThanOrEqual(500);
        expect(retry.derivedFrom?.offsetMs).toBeLessThanOrEqual(5_000);
      });
      failed.forEach((attempt, index) => {
        expect(attempt.faults).toContainEqual({ type: 'transientFailure', failure: index + 1, failures: failed.length });
      });
    }
    expect(faultedEvents).toBeGreaterThan(50);
    expect(plan.summary.eventsLost).toBe(0);
  });

  it('lose an event that fails more often than it is retried, only when the profile allows loss', () => {
    const plan = planDelivery({ events, profile: exampleProfile('lossy'), chaosSeed: '7' });
    const lost = [...attemptsByEvent(plan.attempts).values()].filter((own) => own.every((attempt) => attempt.plannedOutcome === 'failed'));
    expect(lost.length).toBeGreaterThan(0);
    for (const own of lost) {
      expect(own).toHaveLength(3);
      expect(own.some((attempt) => attempt.kind === 'duplicate')).toBe(false);
      const failures = own[0]?.faults.find((fault) => fault.type === 'transientFailure');
      expect(failures).toMatchObject({ failure: 1 });
      expect((failures as { failures: number }).failures).toBeGreaterThan(2);
    }
    expect(plan.summary.eventsLost).toBe(lost.length);
    expect(plan.summary.faults.transientFailure.lostEvents).toBe(lost.length);
    expect(plan.summary.eventsDelivered).toBe(events.length - lost.length);
    expect(plan.summary.faults.duplicate.eligibleEvents).toBe(events.length - lost.length);
  });
});

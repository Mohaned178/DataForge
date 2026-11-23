import { describe, expect, test } from 'vitest';
import { attemptsSchema, findingsSchema, runEventsSchema } from '../api/schemas';
import { fixtures, type AggregateFixture } from '../test/fixtures';
import { activeFlags, buildTimeline, orderingOf } from './timeline';

function timelineOf(fixture: AggregateFixture) {
  return buildTimeline(runEventsSchema.parse(fixture.runEvents).events, attemptsSchema.parse(fixture.attempts).attempts);
}

function flagsByVersion(fixture: AggregateFixture): Record<number, string[]> {
  return Object.fromEntries(timelineOf(fixture).events.map((entry) => [entry.event.aggregateVersion, activeFlags(entry.flags).map((flag) => flag.label)]));
}

describe('the timeline of one aggregate', () => {
  test('a reordered event is out of order, overtaken by the event that reached the target first', () => {
    const timeline = timelineOf(fixtures.aggregate.reorder);
    expect(flagsByVersion(fixtures.aggregate.reorder)).toEqual({ 1: [], 2: ['out of order', 'reordered'], 3: [], 4: [] });
    expect(timeline.events[1]?.overtakenBy).toEqual(['evt_ord_000088_3']);
    expect(timeline.outOfOrderEvents).toBe(1);
    expect(timeline.inversionPairs).toBe(1);
  });

  test('the canonical side is in version order and the delivery side in delivery order', () => {
    const timeline = timelineOf(fixtures.aggregate.reorder);
    expect(timeline.events.map((entry) => entry.event.aggregateVersion)).toEqual([1, 2, 3, 4]);
    expect(timeline.deliveries.map((attempt) => attempt.aggregateVersion)).toEqual([1, 3, 2, 4]);
  });

  test('each event carries its own attempts, joined by event ID', () => {
    const timeline = timelineOf(fixtures.aggregate.duplicate);
    const payment = timeline.events.find((entry) => entry.event.eventId === 'evt_ord_000018_3');
    expect(payment?.attempts.map((attempt) => [attempt.attemptNumber, attempt.kind])).toEqual([
      [1, 'original'],
      [2, 'duplicate'],
    ]);
    expect(payment?.firstDeliverySequence).toBe(112);
  });

  test('a duplicate and a delay are flagged without making anything out of order', () => {
    expect(flagsByVersion(fixtures.aggregate.duplicate)).toEqual({ 1: [], 2: [], 3: ['duplicated'], 4: ['delayed'], 5: [] });
    expect(timelineOf(fixtures.aggregate.duplicate).outOfOrderEvents).toBe(0);
  });

  test('a lost event is flagged lost and retried, and is not counted out of order', () => {
    const timeline = timelineOf(fixtures.aggregate.lost);
    expect(flagsByVersion(fixtures.aggregate.lost)).toEqual({ 1: [], 2: [], 3: ['lost', 'retried'], 4: [] });
    expect(timeline.events[2]?.firstDeliverySequence).toBeNull();
    expect(timeline.events[2]?.attempts.map((attempt) => attempt.plannedOutcome)).toEqual(['failed', 'failed', 'failed']);
    expect(timeline.outOfOrderEvents).toBe(0);
  });

  test('a late event is both late and out of order', () => {
    expect(flagsByVersion(fixtures.aggregate.late)).toEqual({ 1: [], 2: ['out of order', 'late'], 3: [], 4: [] });
  });

  test('an aggregate with no abnormal delivery has no flags', () => {
    const calm = buildTimeline(
      runEventsSchema.parse(fixtures.aggregate.reorder.runEvents).events.slice(0, 1),
      attemptsSchema.parse(fixtures.aggregate.reorder.attempts).attempts.slice(0, 1),
    );
    expect(activeFlags(calm.events[0]?.flags ?? ({} as never))).toEqual([]);
  });
});

describe('agreement with the validator and the delivery summary', () => {
  test('the events the timeline finds overtaken are the ones the report names in overtakenBy', () => {
    const causes = findingsSchema.parse(fixtures.findings.fail).findings.flatMap((finding) => finding.causes);
    for (const name of ['reorder', 'duplicate'] as const) {
      const fixture = fixtures.aggregate[name];
      const reported = new Map<string, string[]>();
      for (const cause of causes) if (cause.aggregateId === fixture.aggregateId) reported.set(cause.eventId, cause.overtakenBy);
      for (const entry of timelineOf(fixture).events) {
        const fromReport = reported.get(entry.event.eventId);
        if (fromReport !== undefined) expect(entry.overtakenBy, entry.event.eventId).toEqual(fromReport);
      }
    }
  });

  test('over a set of attempts, the ordering is counted as the delivery summary counts it', () => {
    const attempts = [fixtures.aggregate.reorder, fixtures.aggregate.duplicate, fixtures.aggregate.late, fixtures.aggregate.lost].flatMap(
      (fixture) => attemptsSchema.parse(fixture.attempts).attempts,
    );
    expect(orderingOf(attempts)).toEqual({ outOfOrderEvents: 2, inversionPairs: 2, aggregatesAffected: 2 });
  });
});

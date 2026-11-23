import { deliveryMessageFor, type DeliveryMessage } from '@dataforge/targets';
import { DELIVERY_RECORD_HEADERS, DeliveryRecordError, decodeDeliveryRecord, encodeDeliveryRecord, type ReceivedRecord } from '../src';
import { EPOCH_UNIX_MS, plan, world } from './support/world';

const simulation = world();
const eventsById = new Map(simulation.events.map((event) => [event.eventId, event]));
const attempts = plan(simulation, 'flaky-network');

function messageFor(index: number): DeliveryMessage {
  const attempt = attempts[index];
  if (attempt === undefined) {
    throw new Error(`no attempt ${index}`);
  }
  return deliveryMessageFor(eventsById.get(attempt.eventId)!, attempt);
}

function problemsOf(record: ReceivedRecord): readonly string[] {
  try {
    decodeDeliveryRecord(record);
  } catch (error) {
    if (error instanceof DeliveryRecordError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error('expected the record to be rejected');
}

describe('delivery record contract', () => {
  it('round-trips every delivered attempt of a plan to the same message', () => {
    const delivered = attempts.filter((attempt) => attempt.plannedOutcome === 'delivered');
    expect(delivered.length).toBeGreaterThan(400);
    for (const attempt of delivered) {
      const message = deliveryMessageFor(eventsById.get(attempt.eventId)!, attempt);
      expect(decodeDeliveryRecord(encodeDeliveryRecord(message, EPOCH_UNIX_MS))).toEqual(message);
    }
  });

  it('keys by aggregate, carries the event and its ISO event time in the value, and the attempt in the headers', () => {
    const message = messageFor(10);
    const record = encodeDeliveryRecord(message, EPOCH_UNIX_MS);
    expect(record.key).toBe(message.event.aggregateId);
    const value = JSON.parse(record.value) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['event', 'eventTime', 'format', 'formatVersion']);
    expect(value).toMatchObject({ format: 'dataforge.delivery-record', formatVersion: 1, event: message.event });
    expect(value.eventTime).toBe(new Date(EPOCH_UNIX_MS + message.event.eventTimeMs).toISOString());
    expect(Object.keys(record.headers).sort()).toEqual([...DELIVERY_RECORD_HEADERS].sort());
    expect(record.headers).toEqual({
      attemptId: message.headers.attemptId,
      attemptNumber: String(message.headers.attemptNumber),
      deliverySequence: String(message.headers.deliverySequence),
      scheduledDeliveryTimeMs: String(message.headers.scheduledDeliveryTimeMs),
      scheduledDeliveryTime: new Date(EPOCH_UNIX_MS + message.headers.scheduledDeliveryTimeMs).toISOString(),
    });
  });

  it('gives redeliveries of one event the same value and different attempt headers', () => {
    const duplicated = attempts.find((attempt) => attempt.kind === 'duplicate')!;
    const original = attempts.find((attempt) => attempt.eventId === duplicated.eventId && attempt.kind !== 'duplicate' && attempt.plannedOutcome === 'delivered')!;
    const event = eventsById.get(duplicated.eventId)!;
    const [a, b] = [original, duplicated].map((attempt) => encodeDeliveryRecord(deliveryMessageFor(event, attempt), EPOCH_UNIX_MS));
    expect(a!.value).toBe(b!.value);
    expect(a!.headers.attemptId).not.toBe(b!.headers.attemptId);
  });

  describe('rejects a record that breaks the contract, with the path of each problem', () => {
    const valid = encodeDeliveryRecord(messageFor(3), EPOCH_UNIX_MS);
    const value = JSON.parse(valid.value) as Record<string, unknown>;
    const withValue = (changed: unknown): ReceivedRecord => ({ ...valid, value: JSON.stringify(changed) });

    it('missing or unreadable parts', () => {
      expect(problemsOf({ ...valid, value: null })).toEqual(['value: missing']);
      expect(problemsOf({ ...valid, value: '{not json' })[0]).toMatch(/^value: not valid JSON/);
      expect(problemsOf({ ...valid, key: null })).toEqual(['key: missing']);
    });

    it('a value with an unknown field, another format, or an invalid event', () => {
      expect(problemsOf(withValue({ ...value, extra: 1 }))[0]).toMatch(/^value: /);
      expect(problemsOf(withValue({ ...value, formatVersion: 2 }))).toEqual([expect.stringMatching(/^value\.formatVersion: /)]);
      expect(problemsOf(withValue({ ...value, eventTime: '2026-01-01' }))).toEqual([expect.stringMatching(/^value\.eventTime: expected an ISO-8601/)]);
      const event = value.event as { payload: Record<string, unknown> };
      expect(problemsOf(withValue({ ...value, event: { ...event, payload: { ...event.payload, customerId: 7 } } }))[0]).toMatch(/^value\.event\.payload/);
    });

    it('an event written at a schema version this engine cannot read', () => {
      const event = value.event as Record<string, unknown>;
      expect(problemsOf(withValue({ ...value, event: { ...event, schemaVersion: 2 } }))).toEqual([
        expect.stringMatching(/^value\.event\.schemaVersion: schemaVersion 2 is newer than the version this engine reads \(1\)/),
      ]);
    });

    it('missing or malformed headers', () => {
      const headers = { ...valid.headers } as Record<string, string | undefined>;
      expect(problemsOf({ ...valid, headers: { ...headers, attemptId: undefined } })).toEqual([expect.stringMatching(/^headers\.attemptId: /)]);
      expect(problemsOf({ ...valid, headers: { ...headers, attemptNumber: 'two' } })).toEqual(['headers.attemptNumber: expected a whole number']);
      expect(problemsOf({ ...valid, headers: { ...headers, deliverySequence: '0' } })).toEqual(['headers.deliverySequence: expected at least 1']);
    });

    it('a key that is not the event aggregate, together with every other problem', () => {
      const problems = problemsOf({ ...valid, key: 'ord_999999', headers: { ...valid.headers, attemptNumber: '-1' } });
      expect(problems).toEqual(['headers.attemptNumber: expected a whole number', `key: "ord_999999" is not the event's aggregateId "${String((value.event as { aggregateId: string }).aggregateId)}"`]);
    });
  });
});

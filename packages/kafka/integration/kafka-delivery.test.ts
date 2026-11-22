import { serializeActualState } from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import { CorrectTarget, deliverInMemory, deliveryMessageFor, type DeliveryMessage, type Target, type TargetResult } from '@dataforge/targets';
import {
  ConsumerRunner,
  KafkaRecordSender,
  createIdempotentProducer,
  executePlan,
  fetchGroupLag,
  systemClock,
  waitForZeroLag,
  type ConsumerOutcome,
  type KafkaAdmin,
  type KafkaClient,
} from '../src';
import { EPOCH_UNIX_MS, plan, world } from '../test/support/world';
import { admin, freshTopic, testClient } from './support';

/** Wraps a target and keeps every message it was handed, in order. */
class RecordingTarget implements Target {
  readonly received: DeliveryMessage[] = [];
  readonly name: string;
  readonly description: string;
  constructor(private readonly inner: Target = new CorrectTarget()) {
    this.name = inner.name;
    this.description = inner.description;
  }
  handle(message: DeliveryMessage): void {
    this.received.push(message);
    this.inner.handle(message);
  }
  finish(): TargetResult {
    return this.inner.finish();
  }
}

const simulation = world();
const eventsById = new Map(simulation.events.map((event) => [event.eventId, event]));
let kafka: KafkaClient;
let kafkaAdmin: KafkaAdmin;

beforeAll(async () => {
  kafka = testClient('delivery').kafka;
  kafkaAdmin = await admin(kafka);
});
afterAll(async () => {
  await kafkaAdmin.disconnect();
});

/** Executes a plan into a fresh topic and lets a consumer runner consume it until the group's lag is zero. */
async function deliverThroughKafka(
  attempts: readonly DeliveryAttempt[],
  options: { label: string; partitions: number; target?: RecordingTarget },
): Promise<{ target: RecordingTarget; outcome: ConsumerOutcome; partitionOf: Map<string, number> }> {
  const { topic, groupId } = await freshTopic(kafkaAdmin, options.label, options.partitions);
  const target = options.target ?? new RecordingTarget();
  const runner = new ConsumerRunner({ kafka, topic, groupId, target });
  await runner.start();
  const producer = createIdempotentProducer(kafka);
  await producer.connect();
  try {
    const execution = await executePlan({
      events: simulation.events,
      attempts,
      epochUnixMs: EPOCH_UNIX_MS,
      speed: 'max',
      sender: new KafkaRecordSender(producer, topic),
      clock: systemClock,
    });
    await waitForZeroLag(kafkaAdmin, { groupId, topic, timeoutMs: 60_000 });
    const partitionOf = new Map(execution.log.filter((entry) => entry.partition !== null).map((entry) => [entry.attemptId, entry.partition as number]));
    return { target, outcome: await runner.finish(), partitionOf };
  } finally {
    await producer.disconnect();
  }
}

const delivered = (attempts: readonly DeliveryAttempt[]) => attempts.filter((attempt) => attempt.plannedOutcome === 'delivered');

describe('Kafka delivery (real broker)', () => {
  it('hands the consumer exactly the planned messages, in delivery order, with one partition', async () => {
    const attempts = plan(simulation, 'spec-example');
    const { target, outcome } = await deliverThroughKafka(attempts, { label: 'order', partitions: 1 });
    const expected = delivered(attempts).map((attempt) => deliveryMessageFor(eventsById.get(attempt.eventId)!, attempt));
    expect(target.received).toEqual(expected);
    expect(outcome).toMatchObject({ messages: expected.length, kafkaRedeliveries: 0, partitions: [0] });
    expect(outcome.processingLog.map((entry) => entry.offset)).toEqual(expected.map((_, index) => String(index)));
  });

  it('delivers duplicates with the same eventId and distinct attemptId headers', async () => {
    const attempts = plan(simulation, 'duplicates-only');
    const { outcome } = await deliverThroughKafka(attempts, { label: 'duplicates', partitions: 1 });
    const byEvent = new Map<string, string[]>();
    for (const entry of outcome.processingLog) {
      byEvent.set(entry.eventId, [...(byEvent.get(entry.eventId) ?? []), entry.attemptId]);
    }
    const duplicated = [...byEvent.entries()].filter(([, attemptIds]) => attemptIds.length > 1);
    const planned = new Set(attempts.filter((attempt) => attempt.kind === 'duplicate').map((attempt) => attempt.eventId));
    expect(duplicated.map(([eventId]) => eventId).sort()).toEqual([...planned].sort());
    expect(planned.size).toBeGreaterThan(10);
    for (const [, attemptIds] of duplicated) {
      expect(new Set(attemptIds).size).toBe(attemptIds.length);
    }
    expect(outcome.redeliveries).toBe(outcome.messages - outcome.distinctEvents);
    expect(outcome.redeliveries).toBe(attempts.filter((attempt) => attempt.kind === 'duplicate').length);
  });

  it('keeps per-key order with three partitions: each aggregate arrives in its planned order, unfaulted events in version order', async () => {
    const attempts = plan(simulation, 'flaky-network');
    const { target, outcome, partitionOf } = await deliverThroughKafka(attempts, { label: 'partitions', partitions: 3 });
    expect(outcome.partitions).toEqual([0, 1, 2]);
    expect(new Set(partitionOf.values()).size).toBe(3);

    const plannedByAggregate = new Map<string, string[]>();
    for (const attempt of delivered(attempts)) {
      plannedByAggregate.set(attempt.aggregateId, [...(plannedByAggregate.get(attempt.aggregateId) ?? []), attempt.attemptId]);
    }
    const receivedByAggregate = new Map<string, string[]>();
    for (const message of target.received) {
      receivedByAggregate.set(message.key, [...(receivedByAggregate.get(message.key) ?? []), message.headers.attemptId]);
    }
    expect(receivedByAggregate).toEqual(plannedByAggregate);
    for (const attemptIds of plannedByAggregate.values()) {
      expect(new Set(attemptIds.map((id) => partitionOf.get(id))).size).toBe(1);
    }

    const faulted = new Set(attempts.filter((attempt) => attempt.faults.length > 0).map((attempt) => attempt.eventId));
    for (const [aggregateId] of receivedByAggregate) {
      const versions = target.received
        .filter((message) => message.key === aggregateId && !faulted.has(message.event.eventId))
        .map((message) => message.event.aggregateVersion);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    }
    const interleaved = target.received.some(
      (message, index) => index > 0 && message.headers.deliverySequence < target.received[index - 1]!.headers.deliverySequence,
    );
    expect(interleaved).toBe(true);
  });

  it('lets the correct target reach the same state through three partitions as in process', async () => {
    const attempts = plan(simulation, 'spec-example', '11');
    const { outcome } = await deliverThroughKafka(attempts, { label: 'correct', partitions: 3 });
    const inMemory = deliverInMemory({ events: simulation.events, attempts, target: new CorrectTarget() });
    expect(serializeActualState(outcome.result.actualState)).toBe(serializeActualState(inMemory.actualState));
    expect(outcome.result.parkedEventIds).toEqual([]);
  });

  it('reports lag for records not yet handled, and zero once the consumer has committed them', async () => {
    const attempts = plan(simulation, 'none').slice(0, 25);
    const { topic, groupId } = await freshTopic(kafkaAdmin, 'lag', 2);
    const producer = createIdempotentProducer(kafka);
    await producer.connect();
    await executePlan({ events: simulation.events, attempts, epochUnixMs: EPOCH_UNIX_MS, speed: 'max', sender: new KafkaRecordSender(producer, topic), clock: systemClock });
    await producer.disconnect();
    const before = await fetchGroupLag(kafkaAdmin, groupId, topic);
    expect(before.total).toBe(25);
    expect(before.partitions.every((partition) => partition.committedOffset === null)).toBe(true);

    const runner = new ConsumerRunner({ kafka, topic, groupId, target: new RecordingTarget() });
    await runner.start();
    const completion = await waitForZeroLag(kafkaAdmin, { groupId, topic, timeoutMs: 30_000 });
    const outcome = await runner.finish();
    expect(outcome.messages).toBe(25);
    expect(completion.polls).toBeGreaterThanOrEqual(1);
    const after = await fetchGroupLag(kafkaAdmin, groupId, topic);
    expect(after.total).toBe(0);
    const written = after.partitions.filter((partition) => partition.endOffset !== '0');
    expect(written.map((partition) => partition.committedOffset)).toEqual(written.map((partition) => partition.endOffset));
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_STATE_FORMAT,
  ACTUAL_STATE_FORMAT_VERSION,
  parseScenario,
  serializeActualState,
  sha256Hex,
  simulate,
  type ActualState,
  type CanonicalEvent,
  type ExpectedState,
} from '@dataforge/core';
import { parseChaosProfile, planDelivery, type ChaosProfileInput, type DeliveryAttempt } from '@dataforge/chaos';
import {
  CorrectTarget,
  NaiveTarget,
  PlanDoesNotMatchLogError,
  REFERENCE_TARGETS,
  createReferenceTarget,
  deliverInMemory,
  type DeliveryMessage,
  type Target,
} from '../src';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const scenario = parseScenario(JSON.parse(readFileSync(join(REPO_ROOT, 'scenarios', 'ecommerce-small.json'), 'utf8')));
const world = simulate({ scenario, seed: '42' });

function exampleProfile(name: string) {
  return parseChaosProfile(JSON.parse(readFileSync(join(REPO_ROOT, 'chaos-profiles', `${name}.json`), 'utf8')));
}

function plan(faults: ChaosProfileInput['faults'] | string, chaosSeed = '7'): readonly DeliveryAttempt[] {
  const profile = typeof faults === 'string' ? exampleProfile(faults) : parseChaosProfile({ formatVersion: 1, name: 'test', faults });
  return planDelivery({ events: world.events, profile, chaosSeed }).attempts;
}

function asActual(expected: ExpectedState): ActualState {
  const { products, customers, orders, payments, shipments } = expected;
  return { format: ACTUAL_STATE_FORMAT, formatVersion: ACTUAL_STATE_FORMAT_VERSION, products, customers, orders, payments, shipments };
}

const EXPECTED_TEXT = serializeActualState(asActual(world.expectedState));

function message(event: CanonicalEvent, deliverySequence: number): DeliveryMessage {
  return {
    key: event.aggregateId,
    event,
    headers: { attemptId: `att_${deliverySequence}`, attemptNumber: 1, deliverySequence, scheduledDeliveryTimeMs: event.eventTimeMs },
  };
}

const eventsOf = (aggregateId: string) => world.events.filter((event) => event.aggregateId === aggregateId);

describe('in-memory transport', () => {
  it('hands every delivered attempt to the target in delivery order, and no failed one', () => {
    const attempts = plan('flaky-network');
    const seen: DeliveryMessage[] = [];
    const recorder: Target = {
      name: 'recorder',
      description: 'records messages',
      handle: (received) => seen.push(received),
      finish: () => ({ actualState: asActual(world.expectedState), counters: {}, parkedEventIds: [] }),
    };
    const result = deliverInMemory({ events: world.events, attempts, target: recorder });
    const delivered = attempts.filter((attempt) => attempt.plannedOutcome === 'delivered');
    expect(seen.map((received) => received.headers.attemptId)).toEqual(delivered.map((attempt) => attempt.attemptId));
    expect(seen.map((received) => received.headers.deliverySequence)).toEqual([...seen.map((r) => r.headers.deliverySequence)].sort((a, b) => a - b));
    expect(seen.every((received) => received.key === received.event.aggregateId && received.event.eventId === attempts.find((a) => a.attemptId === received.headers.attemptId)?.eventId)).toBe(true);
    expect(result).toMatchObject({ messages: 509, distinctEvents: 472, redeliveries: 37, failedAttempts: 33 });
  });

  it('refuses a plan made for another canonical log', () => {
    const other = simulate({ scenario, seed: '43' });
    const foreign = planDelivery({ events: other.events, profile: exampleProfile('none'), chaosSeed: '7' }).attempts.filter((attempt) =>
      attempt.eventId.startsWith('evt_ord_000120'),
    );
    expect(() => deliverInMemory({ events: world.events.slice(0, 10), attempts: foreign, target: new NaiveTarget() })).toThrow(PlanDoesNotMatchLogError);
  });
});

describe('reference targets', () => {
  it.each(REFERENCE_TARGETS)('%s reproduces the expected state exactly when nothing goes wrong', (name) => {
    const result = deliverInMemory({ events: world.events, attempts: plan('none'), target: createReferenceTarget(name) });
    expect(serializeActualState(result.actualState)).toBe(EXPECTED_TEXT);
    expect(result.parkedEventIds).toEqual([]);
  });

  it.each(['spec-example', 'flaky-network', 'duplicates-only', 'reorders-only'])('correct reproduces the expected state under %s', (profile) => {
    const result = deliverInMemory({ events: world.events, attempts: plan(profile), target: new CorrectTarget() });
    expect(serializeActualState(result.actualState)).toBe(EXPECTED_TEXT);
  });

  it('naive does not, under the same faults', () => {
    for (const profile of ['spec-example', 'duplicates-only', 'reorders-only']) {
      const result = deliverInMemory({ events: world.events, attempts: plan(profile), target: new NaiveTarget() });
      expect(serializeActualState(result.actualState)).not.toBe(EXPECTED_TEXT);
    }
  });

  it('give a fresh instance per call (targets keep state)', () => {
    expect(createReferenceTarget('correct')).not.toBe(createReferenceTarget('correct'));
    expect(createReferenceTarget('naive')).toBeInstanceOf(NaiveTarget);
  });
});

describe('correct target', () => {
  it('applies a redelivered event once', () => {
    const target = new CorrectTarget();
    const [registered] = eventsOf('cus_000001');
    target.handle(message(registered!, 1));
    target.handle(message(registered!, 2));
    const result = target.finish();
    expect(result.counters).toEqual({ duplicatesIgnored: 1, eventsParked: 0 });
    expect(result.actualState.customers).toHaveLength(1);
  });

  it('parks an event that arrives before its predecessor, then applies both in version order', () => {
    const target = new CorrectTarget();
    world.events.filter((event) => event.aggregateType !== 'Order').forEach((event, index) => target.handle(message(event, index + 1)));
    const [created, second] = eventsOf('ord_000001');
    target.handle(message(second!, 1_000));
    expect(target.finish().parkedEventIds).toEqual([second!.eventId]);
    target.handle(message(created!, 1_001));
    const result = target.finish();
    expect(result.parkedEventIds).toEqual([]);
    expect(result.counters.eventsParked).toBe(1);
    const order = result.actualState.orders.find((record) => record.orderId === 'ord_000001')!;
    expect(order.updatedAtMs).toBe(second!.eventTimeMs);
  });

  it('parks an order until its customer and products exist', () => {
    const target = new CorrectTarget();
    const [created] = eventsOf('ord_000001');
    if (created?.type !== 'OrderCreated') {
      throw new Error('expected OrderCreated');
    }
    target.handle(message(created, 1));
    expect(target.finish().parkedEventIds).toEqual([created.eventId]);
    target.handle(message(eventsOf(created.payload.customerId)[0]!, 2));
    created.payload.lines.forEach((line, index) => target.handle(message(eventsOf(line.productId)[0]!, 3 + index)));
    const result = target.finish();
    expect(result.parkedEventIds).toEqual([]);
    expect(result.actualState.orders.map((order) => order.orderId)).toEqual(['ord_000001']);
    expect(result.actualState.customers[0]!.orderCount).toBe(1);
  });

  it('leaves the rest of an aggregate parked when an event is lost', () => {
    const attempts = plan('lossy');
    const result = deliverInMemory({ events: world.events, attempts, target: new CorrectTarget() });
    const lost = new Set(attempts.map((attempt) => attempt.eventId));
    attempts.filter((attempt) => attempt.plannedOutcome === 'delivered').forEach((attempt) => lost.delete(attempt.eventId));
    expect(lost.size).toBe(22);
    expect(result.parkedEventIds.length).toBeGreaterThan(0);
    for (const parkedId of result.parkedEventIds) {
      const parked = world.events.find((event) => event.eventId === parkedId)!;
      const blockedBySameAggregate = world.events.some(
        (event) => lost.has(event.eventId) && event.aggregateId === parked.aggregateId && event.aggregateVersion < parked.aggregateVersion,
      );
      const blockedByReference =
        parked.type === 'OrderCreated' &&
        [parked.payload.customerId, ...parked.payload.lines.map((line) => line.productId)].some((id) => lost.has(`evt_${id}_1`));
      expect({ parkedId, explained: blockedBySameAggregate || blockedByReference }).toEqual({ parkedId, explained: true });
    }
  });
});

describe('naive target', () => {
  const orderEvents = eventsOf('ord_000018');

  it('counts a redelivered payment twice: a double charge', () => {
    const target = new NaiveTarget();
    world.events.filter((event) => event.aggregateType !== 'Order').forEach((event, index) => target.handle(message(event, index + 1)));
    const payment = orderEvents.find((event) => event.type === 'PaymentCompleted')!;
    orderEvents.filter((event) => event.aggregateVersion <= payment.aggregateVersion).forEach((event, index) => target.handle(message(event, 100 + index)));
    target.handle(message(payment, 200));
    const { actualState } = target.finish();
    const order = actualState.orders[0]!;
    expect(order.amountPaidMinor).toBe(2 * order.totalMinor);
    expect(actualState.customers.find((customer) => customer.customerId === order.customerId)!.totalPaidMinor).toBe(2 * order.totalMinor);
  });

  it('takes the status of the last message to arrive, and loses updates of rows that do not exist yet', () => {
    const target = new NaiveTarget();
    world.events.filter((event) => event.aggregateType !== 'Order').forEach((event, index) => target.handle(message(event, index + 1)));
    const [created, ...rest] = orderEvents;
    [...rest].reverse().forEach((event, index) => target.handle(message(event, 100 + index)));
    target.handle(message(created!, 200));
    const result = target.finish();
    expect(result.actualState.orders[0]!.status).toBe('PENDING_PAYMENT');
    expect(result.counters.updatesLost).toBe(rest.length + 1);
  });
});

describe('golden actual states (small scenario, seed 42, spec-example, chaos seed 7)', () => {
  const attempts = plan('spec-example');
  it.each<[string, string]>([
    ['correct', sha256Hex(EXPECTED_TEXT)],
    ['naive', 'a47fbbb75451d59707b0e69cf2febdaf5d96bc845a94746285ae68da46a81877'],
  ])('%s', (name, hash) => {
    const result = deliverInMemory({ events: world.events, attempts, target: createReferenceTarget(name as 'correct' | 'naive') });
    expect(sha256Hex(serializeActualState(result.actualState))).toBe(hash);
  });
});

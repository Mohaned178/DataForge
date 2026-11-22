import {
  DAY_MS,
  parseScenario,
  serializeEventLog,
  serializeExpectedState,
  sha256Hex,
  simulate,
  type CanonicalEvent,
  type ScenarioInput,
} from '../src';

function scenario(overrides: Partial<ScenarioInput> = {}) {
  return parseScenario({
    formatVersion: 1,
    name: 'test-store',
    simulation: { durationMs: 3 * DAY_MS },
    catalog: { productCount: 15 },
    customers: { count: 30 },
    orders: { count: 150 },
    ...overrides,
  });
}

function fingerprint(seed: string | number, config = scenario()): string {
  const result = simulate({ scenario: config, seed });
  return sha256Hex(serializeEventLog(result.events) + serializeExpectedState(result.expectedState));
}

/** An aggregate's events with their global position removed, for comparing across runs. */
function eventsOf(events: readonly CanonicalEvent[], aggregateId: string): unknown[] {
  return events.filter((event) => event.aggregateId === aggregateId).map(({ sequence, ...rest }) => rest);
}

describe('determinism', () => {
  it('produces byte-identical output for the same scenario and seed', () => {
    expect(fingerprint('42')).toBe(fingerprint('42'));
  });

  it('is unaffected by other simulations running in between (no hidden shared state)', () => {
    const before = fingerprint('42');
    fingerprint('other-seed', scenario({ orders: { count: 7 } }));
    expect(fingerprint('42')).toBe(before);
  });

  it('produces different output for a different seed', () => {
    expect(fingerprint('42')).not.toBe(fingerprint('43'));
  });

  it('treats the numeric seed 42 and the string seed "42" as the same seed', () => {
    expect(fingerprint(42)).toBe(fingerprint('42'));
  });
});

describe('randomness isolation', () => {
  const seed = 'isolation';

  it('adding one more order leaves every existing order and customer unchanged', () => {
    const smaller = simulate({ scenario: scenario({ orders: { count: 80 } }), seed }).events;
    const larger = simulate({ scenario: scenario({ orders: { count: 81 } }), seed }).events;
    for (let n = 1; n <= 80; n++) {
      const id = `ord_${String(n).padStart(6, '0')}`;
      expect(eventsOf(larger, id)).toEqual(eventsOf(smaller, id));
    }
    expect(larger.filter((e) => e.type === 'CustomerRegistered')).toHaveLength(30);
    expect(eventsOf(larger, 'cus_000017')).toEqual(eventsOf(smaller, 'cus_000017'));
    expect(eventsOf(larger, 'ord_000081').length).toBeGreaterThan(0);
  });

  it('changing line quantities does not change when anything happens or how orders end', () => {
    const timing = (config: ReturnType<typeof scenario>) =>
      simulate({ scenario: config, seed }).events.map((event) => `${event.aggregateId} ${event.type} ${event.eventTimeMs}`);
    const fewer = timing(scenario({ orders: { count: 150, quantityPerItem: { min: 1, max: 1 } } }));
    const more = timing(scenario({ orders: { count: 150, quantityPerItem: { min: 2, max: 9 } } }));
    expect(more).toEqual(fewer);
  });

  it('changing the payment failure rate does not change where or when orders are placed', () => {
    const placements = (failureRate: number) =>
      simulate({ scenario: scenario({ payments: { failureRate } }), seed })
        .events.filter((event) => event.type === 'OrderCreated')
        .map((event) => [event.aggregateId, event.eventTimeMs, event.payload]);
    expect(placements(0.9)).toEqual(placements(0));
  });
});

describe('generated world invariants', () => {
  const seeds = Array.from({ length: 20 }, (_, index) => `invariant-${index}`);

  it.each(seeds)('seed %s: the canonical log is well-formed and causally consistent', (seed) => {
    const config = scenario();
    const { events, expectedState } = simulate({ scenario: config, seed });

    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    for (let index = 1; index < events.length; index++) {
      expect(events[index]!.eventTimeMs).toBeGreaterThanOrEqual(events[index - 1]!.eventTimeMs);
    }
    expect(events.every((event) => event.eventTimeMs >= 0 && event.eventTimeMs < config.simulation.durationMs)).toBe(true);

    const registeredAt = new Map(
      events.filter((event) => event.type === 'CustomerRegistered').map((event) => [event.aggregateId, event.eventTimeMs]),
    );
    for (const event of events) {
      if (event.type === 'OrderCreated') {
        expect(event.eventTimeMs).toBeGreaterThan(registeredAt.get(event.payload.customerId)!);
      }
    }

    const { summary } = expectedState;
    expect(Object.values(summary.ordersByStatus).reduce((a, b) => a + b, 0)).toBe(summary.orders);
    expect(summary.orders).toBe(config.orders.count);
    for (const order of expectedState.orders) {
      expect(Number.isSafeInteger(order.totalMinor) && order.totalMinor > 0).toBe(true);
      expect(order.amountPaidMinor).toBe(['PAID', 'SHIPPED', 'DELIVERED'].includes(order.status) ? order.totalMinor : 0);
      expect(order.shipmentId !== null).toBe(order.status === 'SHIPPED' || order.status === 'DELIVERED');
    }
    const paidByCustomer = new Map<string, number>();
    for (const order of expectedState.orders) {
      paidByCustomer.set(order.customerId, (paidByCustomer.get(order.customerId) ?? 0) + order.amountPaidMinor);
    }
    for (const customer of expectedState.customers) {
      expect(customer.totalPaidMinor).toBe(paidByCustomer.get(customer.customerId) ?? 0);
    }
  });

  it('never fails a payment when the failure rate is 0', () => {
    const { events } = simulate({ scenario: scenario({ payments: { failureRate: 0 } }), seed: 'no-failures' });
    expect(events.some((event) => event.type === 'PaymentFailed')).toBe(false);
  });

  it('cancels every order for PAYMENT_FAILED after maxAttempts when every payment fails', () => {
    const { events, expectedState } = simulate({
      scenario: scenario({ orders: { count: 50, customerCancellationRate: 0 }, payments: { failureRate: 1, maxAttempts: 2 } }),
      seed: 'all-failures',
    });
    expect(events.some((event) => event.type === 'PaymentCompleted')).toBe(false);
    const finished = expectedState.orders.filter((order) => order.status === 'CANCELLED');
    expect(finished.length).toBeGreaterThan(40);
    for (const order of finished) {
      expect(order.cancellationReason).toBe('PAYMENT_FAILED');
      expect(order.failedPaymentAttempts).toBe(2);
    }
  });

  it('cancels every order at the customer request, before any payment, when the cancellation rate is 1', () => {
    const { events, expectedState } = simulate({
      scenario: scenario({ orders: { count: 40, customerCancellationRate: 1 } }),
      seed: 'all-cancel',
    });
    expect(events.some((event) => event.type === 'PaymentCompleted' || event.type === 'PaymentFailed')).toBe(false);
    const cancelled = expectedState.orders.filter((order) => order.status === 'CANCELLED');
    expect(cancelled.length).toBeGreaterThan(35);
    expect(cancelled.every((order) => order.cancellationReason === 'CUSTOMER_REQUEST')).toBe(true);
  });

  it('produces only the catalog and customers when there are no orders', () => {
    const { events } = simulate({ scenario: scenario({ orders: { count: 0 } }), seed: 'empty' });
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(['ProductCreated', 'CustomerRegistered']));
  });

  it('leaves late orders mid-lifecycle at the simulation horizon instead of inventing future events', () => {
    const { expectedState } = simulate({ scenario: scenario({ simulation: { durationMs: 2 * 3_600_000 } }), seed: 'short' });
    expect(expectedState.summary.ordersByStatus.DELIVERED).toBe(0);
    expect(expectedState.summary.ordersByStatus.PENDING_PAYMENT + expectedState.summary.ordersByStatus.PAID).toBeGreaterThan(0);
  });

  it('returns frozen canonical events, so nothing downstream can rewrite history', () => {
    const { events } = simulate({ scenario: scenario({ orders: { count: 5 } }), seed: 'frozen' });
    const order = events.find((event) => event.type === 'OrderCreated')!;
    expect(() => {
      (order as unknown as { eventTimeMs: number }).eventTimeMs = 1;
    }).toThrow(TypeError);
    expect(() => {
      (order.payload.lines as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });
});

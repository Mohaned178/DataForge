import {
  ActualStateValidationError,
  DAY_MS,
  ECOMMERCE_INVARIANTS,
  PAID_ORDER_STATUSES,
  SHIPPED_ORDER_STATUSES,
  WorldState,
  buildActualState,
  parseActualState,
  parseScenario,
  serializeActualState,
  simulate,
  statusesReachableFrom,
  type ActualState,
  type WorldStateView,
} from '../src';

const scenario = parseScenario({
  formatVersion: 1,
  name: 'state-test',
  simulation: { durationMs: 3 * DAY_MS },
  catalog: { productCount: 10 },
  customers: { count: 20 },
  orders: { count: 80 },
});

function worldOf(seed: string): WorldState {
  const { expectedState } = simulate({ scenario, seed });
  const state = new WorldState();
  expectedState.products.forEach((record) => state.products.set(record.productId, record));
  expectedState.customers.forEach((record) => state.customers.set(record.customerId, record));
  expectedState.orders.forEach((record) => state.orders.set(record.orderId, record));
  expectedState.payments.forEach((record) => state.payments.set(record.paymentId, record));
  expectedState.shipments.forEach((record) => state.shipments.set(record.shipmentId, record));
  return state;
}

function violatedInvariants(state: WorldStateView): string[] {
  return ECOMMERCE_INVARIANTS.filter((invariant) => invariant.check(state).length > 0).map((invariant) => invariant.id);
}

describe('order lifecycle helpers', () => {
  it('derives the paid and shipped statuses from the state machine', () => {
    expect(PAID_ORDER_STATUSES).toEqual(['PAID', 'SHIPPED', 'DELIVERED']);
    expect(SHIPPED_ORDER_STATUSES).toEqual(['SHIPPED', 'DELIVERED']);
    expect(statusesReachableFrom('CANCELLED')).toEqual(['CANCELLED']);
    expect(statusesReachableFrom('PENDING_PAYMENT')).toEqual(['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
  });
});

describe('actual-state contract', () => {
  const actual = buildActualState(worldOf('contract'));

  it('round-trips through JSON, sorted by ID, byte for byte', () => {
    const text = serializeActualState(actual);
    const parsed = parseActualState(JSON.parse(text));
    expect(serializeActualState(parsed)).toBe(text);
    expect(parsed.orders.map((order) => order.orderId)).toEqual([...parsed.orders.map((order) => order.orderId)].sort());
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('accepts records in any order and lists a repeated ID as given', () => {
    const shuffled: ActualState = { ...actual, orders: [...actual.orders].reverse(), payments: [...actual.payments, actual.payments[0]!] };
    const parsed = parseActualState(JSON.parse(JSON.stringify(shuffled)));
    expect(parsed.orders[0]!.orderId).toBe(actual.orders[actual.orders.length - 1]!.orderId);
    expect(parsed.payments).toHaveLength(actual.payments.length + 1);
  });

  it('accepts business-wrong values (they are findings, not format errors)', () => {
    const odd = JSON.parse(JSON.stringify(actual)) as { orders: { amountPaidMinor: number }[]; customers: { orderCount: number }[] };
    odd.orders[0]!.amountPaidMinor = -5;
    odd.customers[0]!.orderCount = 999;
    expect(() => parseActualState(odd)).not.toThrow();
  });

  it('rejects format errors with the path of each problem', () => {
    const broken = JSON.parse(JSON.stringify(actual)) as Record<string, unknown> & {
      orders: Record<string, unknown>[];
      shipments: Record<string, unknown>[];
    };
    broken.format = 'dataforge.expected-state';
    broken.orders[2]!.status = 'SHIPPPED';
    broken.orders[3]!.colour = 'red';
    broken.shipments[0]!.deliveredAtMs = 1.5;
    delete broken.products;
    let error: unknown;
    try {
      parseActualState(broken);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ActualStateValidationError);
    const paths = (error as ActualStateValidationError).issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['format', 'products', 'orders.2.status', 'orders.3', 'shipments.0.deliveredAtMs']));
    expect((error as Error).message).toContain('format must be "dataforge.actual-state"');
    expect((error as Error).message).toContain('Unrecognized key: "colour"');
  });
});

describe('state invariants', () => {
  it.each(Array.from({ length: 20 }, (_, index) => `seed-${index + 1}`))('hold on the expected state of %s', (seed) => {
    const state = worldOf(seed);
    for (const invariant of ECOMMERCE_INVARIANTS) {
      expect({ id: invariant.id, violations: invariant.check(state) }).toEqual({ id: invariant.id, violations: [] });
    }
  });

  const base = worldOf('mutations');
  const find = <T>(map: Map<string, T>, predicate: (value: T) => boolean): T => [...map.values()].find(predicate)!;
  const order = (state: WorldState, status: string) => find(state.orders, (record) => record.status === status);

  it.each<[string, (state: WorldState) => void, string[]]>([
    ['an order of an unknown customer', (s) => {
        order(s, 'PAID').customerId = 'cus_999999';
      }, ['ref.order-customer', 'customer.order-count', 'customer.total-paid']],
    ['an order line of an unknown product', (s) => {
        (order(s, 'DELIVERED').lines[0] as { productId: string }).productId = 'prd_999999';
      }, ['ref.order-products']],
    ['a shipmentId with no shipment', (s) => s.shipments.delete(order(s, 'SHIPPED').shipmentId!), ['ref.order-shipment']],
    ['a payment of an unknown order', (s) => {
        find(s.payments, (p) => p.status === 'FAILED').orderId = 'ord_999999';
      }, ['ref.payment-order', 'order.payment-counters']],
    ['a shipment of an unknown order', (s) => {
        find(s.shipments, () => true).orderId = 'ord_999999';
      }, ['ref.order-shipment', 'ref.shipment-order']],
    ['an order paid twice', (s) => {
        order(s, 'PAID').amountPaidMinor *= 2;
      }, ['order.paid-within-total', 'customer.total-paid']],
    [
      'a second completed payment',
      (s) => {
        const failed = find(s.payments, (payment) => payment.status === 'FAILED' && s.orders.get(payment.orderId)?.status === 'PAID');
        failed.status = 'COMPLETED';
        failed.failureReason = null;
      },
      ['order.single-completed-payment', 'order.payment-counters'],
    ],
    ['a total that is not the sum of its lines', (s) => {
        order(s, 'CANCELLED').totalMinor += 1;
      }, ['order.total-matches-lines']],
    ['a paid status without a completed payment', (s) => {
        const cancelled = order(s, 'CANCELLED');
        cancelled.status = 'PAID';
        cancelled.cancellationReason = null;
      }, ['order.paid-status']],
    ['a pending order with a completed payment', (s) => {
        order(s, 'PAID').status = 'PENDING_PAYMENT';
      }, ['order.paid-status']],
    ['a shipped order without a shipment', (s) => {
        order(s, 'SHIPPED').shipmentId = null;
      }, ['order.shipment-status']],
    ['a delivered order whose shipment is not delivered', (s) => {
        order(s, 'SHIPPED').status = 'DELIVERED';
      }, ['order.shipment-status']],
    ['a payment counter out of step', (s) => {
        order(s, 'PAID').paymentAttempts += 1;
      }, ['order.payment-counters']],
    ['a cancelled order without a reason', (s) => {
        order(s, 'CANCELLED').cancellationReason = null;
      }, ['order.cancellation']],
    ['a payment of the wrong amount', (s) => {
        find(s.payments, () => true).amountMinor += 1;
      }, ['payment.amount-matches-order']],
    ['a delivered shipment without a delivery time', (s) => {
        find(s.shipments, (sh) => sh.status === 'DELIVERED').deliveredAtMs = null;
      }, ['shipment.delivered-time']],
    ['a customer order count out of step', (s) => {
        find(s.customers, () => true).orderCount += 1;
      }, ['customer.order-count']],
  ])('detect %s', (_name, mutate, expected) => {
    const state = structuredClone(base);
    mutate(state);
    expect(violatedInvariants(state)).toEqual(expected);
  });

  it('report each violation with its entity, in ID order', () => {
    const state = structuredClone(base);
    const [first, second] = [...state.orders.values()].filter((record) => record.status === 'CANCELLED');
    second!.cancellationReason = null;
    first!.cancellationReason = null;
    const violations = ECOMMERCE_INVARIANTS.find((invariant) => invariant.id === 'order.cancellation')!.check(state);
    expect(violations.map((violation) => violation.entityId)).toEqual([first!.orderId, second!.orderId].sort());
    expect(violations[0]).toMatchObject({ entityType: 'order', message: 'status is CANCELLED but cancellationReason is null' });
  });
});

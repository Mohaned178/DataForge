import {
  CanonicalLogViolationError,
  ECOMMERCE_RULES,
  defineRule,
  replayCanonicalLog,
  type BusinessRule,
  type CanonicalEvent,
} from '../src';
import { LogBuilder, happyPathLog } from './support/log-builder';

function violatedRules(events: readonly CanonicalEvent[], rules: readonly BusinessRule[] = ECOMMERCE_RULES): string[] {
  try {
    replayCanonicalLog(events, rules);
    return [];
  } catch (error) {
    if (error instanceof CanonicalLogViolationError) {
      return error.violations.map((violation) => violation.ruleId);
    }
    throw error;
  }
}

const store = () => new LogBuilder().product(1, 1_000).product(2, 500).customer(1, 10);
const paidOrder = () => store().order(1, 1, 100, [[1, 1]]).paymentCompleted(1, 1, 200);

describe('business rules accept a valid lifecycle', () => {
  it('replays the happy path and projects the right final state', () => {
    const { expectedState } = replayCanonicalLog(happyPathLog().build());
    const [order] = expectedState.orders;
    expect(order).toMatchObject({
      orderId: 'ord_000001',
      status: 'DELIVERED',
      totalMinor: 2_800,
      amountPaidMinor: 2_800,
      paymentAttempts: 2,
      failedPaymentAttempts: 1,
      shipmentId: 'shp_000001',
      createdAtMs: 100,
      updatedAtMs: 500,
    });
    expect(expectedState.customers[0]).toMatchObject({ customerId: 'cus_000001', orderCount: 1, totalPaidMinor: 2_800 });
    expect(expectedState.payments.map((payment) => [payment.paymentId, payment.status])).toEqual([
      ['pay_000001_1', 'FAILED'],
      ['pay_000001_2', 'COMPLETED'],
    ]);
    expect(expectedState.shipments[0]).toMatchObject({ status: 'DELIVERED', createdAtMs: 400, deliveredAtMs: 500 });
    expect(expectedState.summary.revenueMinor).toBe(2_800);
  });
});

describe('business rules reject impossible worlds', () => {
  it.each<[string, () => LogBuilder, string[]]>([
    ['an order from an unregistered customer', () => store().order(1, 9, 100, [[1, 1]]), ['order.customer-exists']],
    ['an order for a product that does not exist', () => store().order(1, 1, 100, [[7, 1]]), ['order.products-exist']],
    ['an order with no lines', () => store().order(1, 1, 100, []), ['order.has-lines']],
    ['an order listing a product twice', () => store().order(1, 1, 100, [[1, 1], [1, 2]]), ['order.has-lines']],
    ['a line priced differently from the catalog', () => store().order(1, 1, 100, [[1, 1]], { unitPriceMinor: 999 }), ['order.prices-match-catalog']],
    ['a total that is not the sum of the lines', () => store().order(1, 1, 100, [[1, 2]], { totalMinor: 1_999 }), ['order.total-matches-lines']],
    ['a payment for an order that does not exist yet', () => store().paymentCompleted(1, 1, 50, 1_000).order(1, 1, 100, [[1, 1]]), ['order.exists']],
    ['a payment for the wrong amount', () => store().order(1, 1, 100, [[1, 1]]).paymentCompleted(1, 1, 200, 1), ['payment.amount-matches-order']],
    ['a payment attempt that skips a number', () => store().order(1, 1, 100, [[1, 1]]).paymentCompleted(1, 2, 200), ['payment.attempts-sequential']],
    ['a second completed payment (a double charge)', () => paidOrder().paymentCompleted(1, 2, 300), ['order.valid-transition']],
    ['a shipment before the order is paid', () => store().order(1, 1, 100, [[1, 1]]).shipmentCreated(1, 200), ['order.valid-transition']],
    ['cancelling an order that is already paid', () => paidOrder().cancelled(1, 300, 'CUSTOMER_REQUEST'), ['order.valid-transition']],
    ['a delivery before the shipment exists', () => paidOrder().shipmentDelivered(1, 300), ['order.valid-transition', 'shipment.matches-order']],
    ['a PAYMENT_FAILED cancellation with no failed payment', () => store().order(1, 1, 100, [[1, 1]]).cancelled(1, 200, 'PAYMENT_FAILED'), ['order.cancellation-reason']],
    ['delivering the shipment of a different order', () => paidOrder().shipmentCreated(1, 300).shipmentDelivered(1, 400, 2), ['shipment.matches-order']],
    ['registering the same customer twice', () => store().customer(1, 20), ['customer.unique-id']],
  ])('rejects %s', (_description, build, expectedRules) => {
    expect(violatedRules(build().build())).toEqual(expectedRules);
  });

  it('names the offending event and every violated rule in the error', () => {
    const events = store().order(1, 9, 100, [[1, 1]], { totalMinor: 5 }).build();
    expect(() => replayCanonicalLog(events)).toThrow(/Event #4 evt_ord_000001_1 \(OrderCreated\)[\s\S]*order\.customer-exists[\s\S]*order\.total-matches-lines/);
  });
});

describe('log integrity checks', () => {
  const valid = () => happyPathLog().build();

  it('rejects a gap in sequence numbers', () => {
    const events = valid();
    events[3] = { ...events[3]!, sequence: 99 };
    expect(violatedRules(events)).toContain('log.sequence');
  });

  it('rejects events that are not in canonical order, even when they happened at the same time', () => {
    const events = valid();
    const reordered = [events[1]!, events[0]!, ...events.slice(2)].map((event, index) => ({ ...event, sequence: index + 1 }));
    expect(reordered[0]!.eventTimeMs).toBe(reordered[1]!.eventTimeMs);
    expect(violatedRules(reordered)).toEqual(['log.canonical-order']);
  });

  it('rejects a duplicated event ID', () => {
    const events = valid();
    const last = events[events.length - 1]!;
    events.push({ ...events[1]!, sequence: last.sequence + 1, eventTimeMs: last.eventTimeMs + 1 });
    expect(violatedRules(events)).toContain('log.unique-event-id');
  });

  it('rejects a skipped aggregate version', () => {
    const events = valid();
    events[4] = { ...events[4]!, aggregateVersion: 5 };
    expect(violatedRules(events)).toContain('log.aggregate-version');
  });

  it('rejects an envelope whose aggregateId disagrees with its payload', () => {
    const events = valid();
    const customer = events.find((event) => event.type === 'CustomerRegistered')!;
    const index = events.indexOf(customer);
    events[index] = { ...customer, payload: { ...customer.payload, customerId: 'cus_999999' } };
    expect(violatedRules(events)).toEqual(['log.aggregate-id']);
  });
});

describe('rule registry', () => {
  it('enforces a newly added rule without any engine change', () => {
    const maxOrderTotal = defineRule({
      id: 'order.max-total',
      description: 'Orders above 2,000 minor units need manual review.',
      eventTypes: ['OrderCreated'],
      check: (_state, event) => (event.payload.totalMinor > 2_000 ? `total ${event.payload.totalMinor} exceeds 2000` : undefined),
    });
    const events = store().order(1, 1, 100, [[1, 3]]).build();
    expect(violatedRules(events)).toEqual([]);
    expect(violatedRules(events, [...ECOMMERCE_RULES, maxOrderTotal])).toEqual(['order.max-total']);
  });

  it('gives every rule a unique, namespaced ID', () => {
    const ids = ECOMMERCE_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z]+\.[a-z-]+$/.test(id))).toBe(true);
  });
});

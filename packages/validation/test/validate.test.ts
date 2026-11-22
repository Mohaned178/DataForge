import { canonicalJson, type ActualState } from '@dataforge/core';
import { FINDING_CATEGORIES, validate, type Finding } from '../src';
import { asActual, plan, world } from './support/world';

const simulation = world();
const expected = simulation.expectedState;

function mutated(change: (state: ActualState) => void): ActualState {
  const state = asActual(expected);
  change(state);
  return state;
}

const summary = (findings: readonly Finding[]) => findings.map((finding) => `${finding.category} ${finding.entityType} ${finding.entityId} ${finding.check}`);

const deliveredOrder = expected.orders.find((order) => order.status === 'DELIVERED' && order.failedPaymentAttempts === 0)!;
const paidOrder = expected.orders.find((order) => order.status === 'PAID')!;
const customerOf = (customerId: string) => expected.customers.find((customer) => customer.customerId === customerId)!;
const paymentsOf = (orderId: string) => expected.payments.filter((payment) => payment.orderId === orderId);

describe('validate: a correct actual state', () => {
  it('passes with no finding, and counts what it checked', () => {
    const result = validate({ expected, actual: asActual(expected) });
    expect(result.verdict).toBe('PASS');
    expect(result.findings).toEqual([]);
    expect(result.counts.findings).toBe(0);
    expect(Object.keys(result.counts.byCategory)).toEqual([...FINDING_CATEGORIES]);
    expect(result.checked.entities.order).toEqual({ expected: 120, actual: 120 });
    expect(result.checked.invariants).toBe(16);
  });

  it('does not depend on the order of the records', () => {
    const shuffled = mutated((state) => {
      state.orders.reverse();
      state.payments.reverse();
    });
    expect(validate({ expected, actual: shuffled }).verdict).toBe('PASS');
  });
});

describe('validate: hand-mutated actual states', () => {
  it('a dropped order is a missing entity, and leaves its payments and shipment dangling', () => {
    const result = validate({ expected, actual: mutated((state) => void state.orders.splice(state.orders.findIndex((o) => o.orderId === deliveredOrder.orderId), 1)) });
    expect(result.verdict).toBe('FAIL');
    expect(summary(result.findings)).toEqual([
      `invariant-violation customer ${deliveredOrder.customerId} customer.order-count`,
      `invariant-violation customer ${deliveredOrder.customerId} customer.total-paid`,
      `missing-entity order ${deliveredOrder.orderId} compare`,
      ...paymentsOf(deliveredOrder.orderId).map((payment) => `referential-integrity payment ${payment.paymentId} ref.payment-order`),
      `referential-integrity shipment ${deliveredOrder.shipmentId} ref.shipment-order`,
    ]);
  });

  it('a doubled payment is double processing, on the order and on the customer', () => {
    const result = validate({
      expected,
      actual: mutated((state) => {
        const order = state.orders.find((o) => o.orderId === paidOrder.orderId)!;
        order.amountPaidMinor *= 2;
        order.paymentAttempts += 1;
        state.customers.find((c) => c.customerId === paidOrder.customerId)!.totalPaidMinor += paidOrder.totalMinor;
      }),
    });
    expect(summary(result.findings)).toEqual([
      `double-processing customer ${paidOrder.customerId} compare`,
      `double-processing order ${paidOrder.orderId} compare`,
      `double-processing order ${paidOrder.orderId} order.paid-within-total`,
      `invariant-violation order ${paidOrder.orderId} order.payment-counters`,
    ]);
    const orderFinding = result.findings[1]!;
    expect(orderFinding.differences).toEqual([
      { field: 'amountPaidMinor', expected: paidOrder.totalMinor, actual: 2 * paidOrder.totalMinor },
      { field: 'paymentAttempts', expected: paidOrder.paymentAttempts, actual: paidOrder.paymentAttempts + 1 },
    ]);
    expect(orderFinding.message).toBe(
      `amountPaidMinor is ${2 * paidOrder.totalMinor}, expected ${paidOrder.totalMinor} (2x); paymentAttempts is ${paidOrder.paymentAttempts + 1}, expected ${paidOrder.paymentAttempts}` +
        (paidOrder.paymentAttempts === 1 ? ' (2x)' : ''),
    );
  });

  it('a wrong status is a status mismatch', () => {
    const result = validate({ expected, actual: mutated((state) => void (state.orders.find((o) => o.orderId === deliveredOrder.orderId)!.status = 'SHIPPED')) });
    expect(summary(result.findings)).toEqual([
      `status-mismatch order ${deliveredOrder.orderId} compare`,
      `invariant-violation order ${deliveredOrder.orderId} order.shipment-status`,
    ]);
    expect(result.findings[0]!.message).toBe('status is SHIPPED, expected DELIVERED');
  });

  it('a dangling reference is a referential-integrity finding', () => {
    const result = validate({ expected, actual: mutated((state) => void (state.orders.find((o) => o.orderId === paidOrder.orderId)!.customerId = 'cus_999999')) });
    expect(summary(result.findings)).toEqual([
      `invariant-violation customer ${paidOrder.customerId} customer.order-count`,
      `invariant-violation customer ${paidOrder.customerId} customer.total-paid`,
      `field-mismatch order ${paidOrder.orderId} compare`,
      `referential-integrity order ${paidOrder.orderId} ref.order-customer`,
    ]);
    expect(result.findings[3]!.message).toBe('customer cus_999999 does not exist');
  });

  it('an entity that should not exist is unexpected', () => {
    const extra = { ...customerOf(paidOrder.customerId), customerId: 'cus_999999', orderCount: 0, totalPaidMinor: 0 };
    const result = validate({ expected, actual: mutated((state) => void state.customers.push(extra)) });
    expect(summary(result.findings)).toEqual(['unexpected-entity customer cus_999999 compare']);
  });

  it('a record listed twice is a duplicate record', () => {
    const result = validate({ expected, actual: mutated((state) => void state.shipments.push({ ...state.shipments[3]! })) });
    expect(summary(result.findings)).toEqual([`duplicate-record shipment ${expected.shipments[3]!.shipmentId} duplicate-record`]);
    expect(result.findings[0]!.message).toBe('listed 2 times in the actual state');
  });

  it('a changed field is a field mismatch, and a lower count is not double processing', () => {
    const customer = expected.customers[0]!;
    const result = validate({
      expected,
      actual: mutated((state) => {
        state.shipments[0]!.carrier = state.shipments[0]!.carrier === 'FREIGHT' ? 'STANDARD_POST' : 'FREIGHT';
        state.customers[0]!.orderCount -= 1;
      }),
    });
    expect(summary(result.findings)).toEqual([
      `field-mismatch customer ${customer.customerId} compare`,
      `invariant-violation customer ${customer.customerId} customer.order-count`,
      `field-mismatch shipment ${expected.shipments[0]!.shipmentId} compare`,
    ]);
  });
});

describe('validate: root-cause hints', () => {
  const dropped = mutated((state) => void (state.orders.find((o) => o.orderId === deliveredOrder.orderId)!.status = 'SHIPPED'));

  it('without a plan, there are no hints, and nothing is counted as explained', () => {
    const result = validate({ expected, actual: dropped });
    expect(result.hints).toBe(false);
    expect(result.counts).toMatchObject({ explained: null, unexplained: null });
    expect(result.rootCauses).toEqual([]);
    expect(result.findings.every((finding) => finding.causes.length === 0)).toBe(true);
  });

  it('with a plan that has no faults, every finding is unexplained by delivery', () => {
    const result = validate({ expected, actual: dropped, attempts: plan(simulation, 'none') });
    expect(result.hints).toBe(true);
    expect(result.counts).toMatchObject({ findings: 2, explained: 0, unexplained: 2 });
    expect(result.rootCauses).toEqual([{ cause: null, findings: 2 }]);
  });

  it('link a finding to the faulted events of its aggregate', () => {
    const attempts = plan(simulation, { duplicate: { rate: 1 } });
    const result = validate({ expected, actual: dropped, attempts });
    expect(result.counts).toMatchObject({ explained: 2, unexplained: 0 });
    const causes = result.findings[0]!.causes;
    expect(causes.map((cause) => cause.eventId)).toEqual(
      expect.arrayContaining(simulation.events.filter((event) => event.aggregateId === deliveredOrder.orderId).map((event) => event.eventId)),
    );
    expect(causes.every((cause) => cause.faults.includes('duplicate') && cause.deliveries === 2)).toBe(true);
  });

  it('is deterministic', () => {
    const attempts = plan(simulation, 'spec-example');
    expect(canonicalJson(validate({ expected, actual: dropped, attempts }))).toBe(canonicalJson(validate({ expected, actual: dropped, attempts })));
  });
});

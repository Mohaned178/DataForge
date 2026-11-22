import { PAID_ORDER_STATUSES, SHIPPED_ORDER_STATUSES, orderLinesTotalMinor, type OrderStatus } from '../domain/order-lifecycle';
import type { OrderRecord, PaymentRecord, WorldStateView } from '../projection/world-state';
import { compareCodeUnits } from '../serialization/canonical-json';

export const ENTITY_TYPES = ['product', 'customer', 'order', 'payment', 'shipment'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** What breaking an invariant usually means: a dangling link, a charge counted twice, or a state that contradicts itself. */
export const INVARIANT_CATEGORIES = ['referential-integrity', 'double-processing', 'invariant-violation'] as const;
export type InvariantCategory = (typeof INVARIANT_CATEGORIES)[number];

export interface InvariantViolation {
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly message: string;
}

/**
 * A property every consistent final state has, checked on a whole state rather than on one event.
 * The event rules (ECOMMERCE_RULES) keep a canonical log valid; these check any state, including one
 * a target reports. Every expected state satisfies all of them.
 */
export interface StateInvariant {
  readonly id: string;
  readonly description: string;
  readonly category: InvariantCategory;
  check(state: WorldStateView): InvariantViolation[];
}

const isPaid = (status: OrderStatus): boolean => PAID_ORDER_STATUSES.includes(status);
const isShipped = (status: OrderStatus): boolean => SHIPPED_ORDER_STATUSES.includes(status);

function sorted<T>(map: ReadonlyMap<string, Readonly<T>>): [string, Readonly<T>][] {
  return [...map.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
}

function forEachOrder(
  state: WorldStateView,
  check: (order: Readonly<OrderRecord>) => string | undefined,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const [orderId, order] of sorted(state.orders)) {
    const message = check(order);
    if (message !== undefined) {
      violations.push({ entityType: 'order', entityId: orderId, message });
    }
  }
  return violations;
}

function paymentsByOrder(state: WorldStateView): Map<string, Readonly<PaymentRecord>[]> {
  const byOrder = new Map<string, Readonly<PaymentRecord>[]>();
  for (const [, payment] of sorted(state.payments)) {
    const list = byOrder.get(payment.orderId) ?? [];
    list.push(payment);
    byOrder.set(payment.orderId, list);
  }
  return byOrder;
}

/** Add an invariant by appending an entry; the validator picks it up without changes. */
export const ECOMMERCE_INVARIANTS: readonly StateInvariant[] = [
  {
    id: 'ref.order-customer',
    description: 'An order references an existing customer.',
    category: 'referential-integrity',
    check: (state) =>
      forEachOrder(state, (order) => (state.customers.has(order.customerId) ? undefined : `customer ${order.customerId} does not exist`)),
  },
  {
    id: 'ref.order-products',
    description: 'Every order line references an existing product.',
    category: 'referential-integrity',
    check: (state) =>
      forEachOrder(state, (order) => {
        const missing = order.lines.filter((line) => !state.products.has(line.productId)).map((line) => line.productId);
        return missing.length === 0 ? undefined : `products ${missing.join(', ')} do not exist`;
      }),
  },
  {
    id: 'ref.order-shipment',
    description: "An order's shipmentId references an existing shipment of that order.",
    category: 'referential-integrity',
    check: (state) =>
      forEachOrder(state, (order) => {
        if (order.shipmentId === null) {
          return undefined;
        }
        const shipment = state.shipments.get(order.shipmentId);
        if (shipment === undefined) {
          return `shipment ${order.shipmentId} does not exist`;
        }
        return shipment.orderId === order.orderId ? undefined : `shipment ${order.shipmentId} belongs to order ${shipment.orderId}`;
      }),
  },
  {
    id: 'ref.payment-order',
    description: 'A payment references an existing order.',
    category: 'referential-integrity',
    check: (state) =>
      sorted(state.payments)
        .filter(([, payment]) => !state.orders.has(payment.orderId))
        .map(([paymentId, payment]) => ({ entityType: 'payment', entityId: paymentId, message: `order ${payment.orderId} does not exist` })),
  },
  {
    id: 'ref.shipment-order',
    description: 'A shipment references an existing order.',
    category: 'referential-integrity',
    check: (state) =>
      sorted(state.shipments)
        .filter(([, shipment]) => !state.orders.has(shipment.orderId))
        .map(([shipmentId, shipment]) => ({ entityType: 'shipment', entityId: shipmentId, message: `order ${shipment.orderId} does not exist` })),
  },
  {
    id: 'order.paid-within-total',
    description: 'An order is never paid more than its total.',
    category: 'double-processing',
    check: (state) =>
      forEachOrder(state, (order) =>
        order.amountPaidMinor <= order.totalMinor
          ? undefined
          : `amountPaidMinor ${order.amountPaidMinor} exceeds totalMinor ${order.totalMinor}`,
      ),
  },
  {
    id: 'order.single-completed-payment',
    description: 'An order has at most one completed payment.',
    category: 'double-processing',
    check: (state) => {
      const byOrder = paymentsByOrder(state);
      return forEachOrder(state, (order) => {
        const completed = (byOrder.get(order.orderId) ?? []).filter((payment) => payment.status === 'COMPLETED');
        return completed.length <= 1 ? undefined : `${completed.length} completed payments: ${completed.map((p) => p.paymentId).join(', ')}`;
      });
    },
  },
  {
    id: 'order.total-matches-lines',
    description: 'The order total equals the sum of quantity x unit price over its lines.',
    category: 'invariant-violation',
    check: (state) =>
      forEachOrder(state, (order) => {
        const expected = orderLinesTotalMinor(order.lines);
        return expected === order.totalMinor ? undefined : `totalMinor is ${order.totalMinor} but the lines sum to ${expected}`;
      }),
  },
  {
    id: 'order.paid-status',
    description: `An order is ${PAID_ORDER_STATUSES.join(', ')} exactly when it has a completed payment, and then it is paid in full.`,
    category: 'invariant-violation',
    check: (state) => {
      const byOrder = paymentsByOrder(state);
      return forEachOrder(state, (order) => {
        const hasCompleted = (byOrder.get(order.orderId) ?? []).some((payment) => payment.status === 'COMPLETED');
        if (isPaid(order.status) && !hasCompleted) {
          return `status is ${order.status} but no payment is completed`;
        }
        if (!isPaid(order.status) && hasCompleted) {
          return `status is ${order.status} but a payment is completed`;
        }
        if (isPaid(order.status) && order.amountPaidMinor < order.totalMinor) {
          return `status is ${order.status} but only ${order.amountPaidMinor} of ${order.totalMinor} is paid`;
        }
        if (!isPaid(order.status) && order.amountPaidMinor !== 0) {
          return `status is ${order.status} but amountPaidMinor is ${order.amountPaidMinor}`;
        }
        return undefined;
      });
    },
  },
  {
    id: 'order.shipment-status',
    description: `An order has a shipment exactly when it is ${SHIPPED_ORDER_STATUSES.join(' or ')}, and is DELIVERED exactly when its shipment is.`,
    category: 'invariant-violation',
    check: (state) =>
      forEachOrder(state, (order) => {
        if (isShipped(order.status) !== (order.shipmentId !== null)) {
          return `status is ${order.status} but shipmentId is ${order.shipmentId ?? 'null'}`;
        }
        const shipment = order.shipmentId === null ? undefined : state.shipments.get(order.shipmentId);
        if (shipment !== undefined && (order.status === 'DELIVERED') !== (shipment.status === 'DELIVERED')) {
          return `status is ${order.status} but shipment ${shipment.shipmentId} is ${shipment.status}`;
        }
        return undefined;
      }),
  },
  {
    id: 'order.payment-counters',
    description: "An order's paymentAttempts and failedPaymentAttempts count its payment records.",
    category: 'invariant-violation',
    check: (state) => {
      const byOrder = paymentsByOrder(state);
      return forEachOrder(state, (order) => {
        const payments = byOrder.get(order.orderId) ?? [];
        const failed = payments.filter((payment) => payment.status === 'FAILED').length;
        if (order.paymentAttempts !== payments.length) {
          return `paymentAttempts is ${order.paymentAttempts} but the order has ${payments.length} payment records`;
        }
        return order.failedPaymentAttempts === failed
          ? undefined
          : `failedPaymentAttempts is ${order.failedPaymentAttempts} but ${failed} payment records failed`;
      });
    },
  },
  {
    id: 'order.cancellation',
    description: 'An order has a cancellation reason exactly when it is CANCELLED.',
    category: 'invariant-violation',
    check: (state) =>
      forEachOrder(state, (order) =>
        (order.status === 'CANCELLED') === (order.cancellationReason !== null)
          ? undefined
          : `status is ${order.status} but cancellationReason is ${order.cancellationReason ?? 'null'}`,
      ),
  },
  {
    id: 'payment.amount-matches-order',
    description: 'Every payment attempt charges exactly the order total.',
    category: 'invariant-violation',
    check: (state) =>
      sorted(state.payments).flatMap(([paymentId, payment]) => {
        const order = state.orders.get(payment.orderId);
        return order === undefined || order.totalMinor === payment.amountMinor
          ? []
          : [{ entityType: 'payment' as const, entityId: paymentId, message: `amountMinor ${payment.amountMinor} differs from order total ${order.totalMinor}` }];
      }),
  },
  {
    id: 'shipment.delivered-time',
    description: 'A shipment has a delivery time exactly when it is DELIVERED.',
    category: 'invariant-violation',
    check: (state) =>
      sorted(state.shipments)
        .filter(([, shipment]) => (shipment.status === 'DELIVERED') !== (shipment.deliveredAtMs !== null))
        .map(([shipmentId, shipment]) => ({
          entityType: 'shipment',
          entityId: shipmentId,
          message: `status is ${shipment.status} but deliveredAtMs is ${shipment.deliveredAtMs ?? 'null'}`,
        })),
  },
  {
    id: 'customer.order-count',
    description: "A customer's orderCount is the number of their orders.",
    category: 'invariant-violation',
    check: (state) => checkCustomerTotals(state, 'orderCount', () => 1),
  },
  {
    id: 'customer.total-paid',
    description: "A customer's totalPaidMinor is the sum of what was paid on their orders.",
    category: 'invariant-violation',
    check: (state) => checkCustomerTotals(state, 'totalPaidMinor', (order) => order.amountPaidMinor),
  },
];

function checkCustomerTotals(
  state: WorldStateView,
  field: 'orderCount' | 'totalPaidMinor',
  contribution: (order: Readonly<OrderRecord>) => number,
): InvariantViolation[] {
  const totals = new Map<string, number>();
  for (const [, order] of sorted(state.orders)) {
    totals.set(order.customerId, (totals.get(order.customerId) ?? 0) + contribution(order));
  }
  return sorted(state.customers).flatMap(([customerId, customer]) => {
    const expected = totals.get(customerId) ?? 0;
    if (customer[field] === expected) {
      return [];
    }
    const message =
      field === 'orderCount'
        ? `orderCount is ${customer.orderCount} but the customer has ${expected} orders`
        : `totalPaidMinor is ${customer.totalPaidMinor} but their orders were paid ${expected} in total`;
    return [{ entityType: 'customer' as const, entityId: customerId, message }];
  });
}

export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['COMPLETED', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SHIPMENT_STATUSES = ['CREATED', 'DELIVERED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const PAYMENT_FAILURE_REASONS = ['CARD_DECLINED', 'INSUFFICIENT_FUNDS', 'PROCESSOR_TIMEOUT'] as const;
export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASONS)[number];

export const CANCELLATION_REASONS = ['CUSTOMER_REQUEST', 'PAYMENT_FAILED'] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const SHIPPING_CARRIERS = ['STANDARD_POST', 'EXPRESS_COURIER', 'FREIGHT'] as const;
export type ShippingCarrier = (typeof SHIPPING_CARRIERS)[number];

export const INITIAL_ORDER_STATUS: OrderStatus = 'PENDING_PAYMENT';

/**
 * The single definition of the order state machine. Generation, rule checking and projection all
 * read this table, so a lifecycle rule is never duplicated.
 */
export const ORDER_TRANSITIONS = {
  PaymentFailed: { from: ['PENDING_PAYMENT'], to: 'PENDING_PAYMENT' },
  PaymentCompleted: { from: ['PENDING_PAYMENT'], to: 'PAID' },
  OrderCancelled: { from: ['PENDING_PAYMENT'], to: 'CANCELLED' },
  ShipmentCreated: { from: ['PAID'], to: 'SHIPPED' },
  ShipmentDelivered: { from: ['SHIPPED'], to: 'DELIVERED' },
} as const satisfies Record<string, { readonly from: readonly OrderStatus[]; readonly to: OrderStatus }>;

export type OrderTransitionEventType = keyof typeof ORDER_TRANSITIONS;

export function isTransitionAllowed(eventType: OrderTransitionEventType, from: OrderStatus): boolean {
  const allowed: readonly OrderStatus[] = ORDER_TRANSITIONS[eventType].from;
  return allowed.includes(from);
}

/** `status` and every status the state machine can reach from it, in ORDER_STATUSES order. */
export function statusesReachableFrom(status: OrderStatus): readonly OrderStatus[] {
  const reached = new Set<OrderStatus>([status]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const transition of Object.values(ORDER_TRANSITIONS)) {
      const from: readonly OrderStatus[] = transition.from;
      if (!reached.has(transition.to) && from.some((candidate) => reached.has(candidate))) {
        reached.add(transition.to);
        grew = true;
      }
    }
  }
  return ORDER_STATUSES.filter((candidate) => reached.has(candidate));
}

/** Statuses of an order that has been paid: PaymentCompleted's target and everything after it. */
export const PAID_ORDER_STATUSES = statusesReachableFrom(ORDER_TRANSITIONS.PaymentCompleted.to);

/** Statuses of an order that has a shipment: ShipmentCreated's target and everything after it. */
export const SHIPPED_ORDER_STATUSES = statusesReachableFrom(ORDER_TRANSITIONS.ShipmentCreated.to);

/** The order total: the sum of quantity x unit price over its lines, in minor units. */
export function orderLinesTotalMinor(lines: readonly { readonly quantity: number; readonly unitPriceMinor: number }[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
}

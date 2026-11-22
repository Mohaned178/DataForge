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

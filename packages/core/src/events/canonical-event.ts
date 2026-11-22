import { z } from 'zod';
import {
  CANCELLATION_REASONS,
  PAYMENT_FAILURE_REASONS,
  SHIPPING_CARRIERS,
  type OrderTransitionEventType,
} from '../domain/order-lifecycle';
import { EVENT_SCHEMA_VERSION } from '../version';

const nonNegativeInt = z.number().int().min(0);
const positiveInt = z.number().int().min(1);
const id = z.string().min(1);
const currency = z.string().regex(/^[A-Z]{3}$/);

const envelope = {
  eventId: id,
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  sequence: positiveInt,
  eventTimeMs: nonNegativeInt,
  aggregateId: id,
  aggregateVersion: positiveInt,
};

const orderLine = z.strictObject({
  productId: id,
  quantity: positiveInt,
  unitPriceMinor: positiveInt,
});

export const productCreatedSchema = z.strictObject({
  ...envelope,
  type: z.literal('ProductCreated'),
  aggregateType: z.literal('Product'),
  payload: z.strictObject({ productId: id, sku: id, name: id, priceMinor: positiveInt, currency }),
});

export const customerRegisteredSchema = z.strictObject({
  ...envelope,
  type: z.literal('CustomerRegistered'),
  aggregateType: z.literal('Customer'),
  payload: z.strictObject({ customerId: id, name: id, email: id, country: id }),
});

export const orderCreatedSchema = z.strictObject({
  ...envelope,
  type: z.literal('OrderCreated'),
  aggregateType: z.literal('Order'),
  payload: z.strictObject({
    orderId: id,
    customerId: id,
    currency,
    lines: z.array(orderLine),
    totalMinor: positiveInt,
  }),
});

export const paymentFailedSchema = z.strictObject({
  ...envelope,
  type: z.literal('PaymentFailed'),
  aggregateType: z.literal('Order'),
  payload: z.strictObject({
    orderId: id,
    paymentId: id,
    attempt: positiveInt,
    amountMinor: positiveInt,
    reason: z.enum(PAYMENT_FAILURE_REASONS),
  }),
});

export const paymentCompletedSchema = z.strictObject({
  ...envelope,
  type: z.literal('PaymentCompleted'),
  aggregateType: z.literal('Order'),
  payload: z.strictObject({ orderId: id, paymentId: id, attempt: positiveInt, amountMinor: positiveInt }),
});

export const orderCancelledSchema = z.strictObject({
  ...envelope,
  type: z.literal('OrderCancelled'),
  aggregateType: z.literal('Order'),
  payload: z.strictObject({ orderId: id, reason: z.enum(CANCELLATION_REASONS) }),
});

export const shipmentCreatedSchema = z.strictObject({
  ...envelope,
  type: z.literal('ShipmentCreated'),
  aggregateType: z.literal('Order'),
  payload: z.strictObject({ orderId: id, shipmentId: id, carrier: z.enum(SHIPPING_CARRIERS) }),
});

export const shipmentDeliveredSchema = z.strictObject({
  ...envelope,
  type: z.literal('ShipmentDelivered'),
  aggregateType: z.literal('Order'),
  payload: z.strictObject({ orderId: id, shipmentId: id }),
});

export const canonicalEventSchema = z.discriminatedUnion('type', [
  productCreatedSchema,
  customerRegisteredSchema,
  orderCreatedSchema,
  paymentFailedSchema,
  paymentCompletedSchema,
  orderCancelledSchema,
  shipmentCreatedSchema,
  shipmentDeliveredSchema,
]);

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/** A business fact in the simulated world. Canonical events are immutable once generated. */
export type CanonicalEvent = DeepReadonly<z.output<typeof canonicalEventSchema>>;
export type EventType = CanonicalEvent['type'];
export type AggregateType = CanonicalEvent['aggregateType'];
export type EventOfType<T extends EventType> = Extract<CanonicalEvent, { type: T }>;
export type PayloadOf<T extends EventType> = EventOfType<T>['payload'];
export type OrderLine = PayloadOf<'OrderCreated'>['lines'][number];

/** Every event type in canonical-log order of introduction. */
export const EVENT_TYPES = [
  'ProductCreated',
  'CustomerRegistered',
  'OrderCreated',
  'PaymentFailed',
  'PaymentCompleted',
  'OrderCancelled',
  'ShipmentCreated',
  'ShipmentDelivered',
] as const satisfies readonly EventType[];

export const AGGREGATE_TYPE_BY_EVENT_TYPE = {
  ProductCreated: 'Product',
  CustomerRegistered: 'Customer',
  OrderCreated: 'Order',
  PaymentFailed: 'Order',
  PaymentCompleted: 'Order',
  OrderCancelled: 'Order',
  ShipmentCreated: 'Order',
  ShipmentDelivered: 'Order',
} as const satisfies Record<EventType, AggregateType>;

/** The payload field that must equal the envelope's aggregateId. */
export function aggregateIdInPayload(event: CanonicalEvent): string {
  switch (event.type) {
    case 'ProductCreated':
      return event.payload.productId;
    case 'CustomerRegistered':
      return event.payload.customerId;
    default:
      return event.payload.orderId;
  }
}

export function isOrderTransitionEvent(
  event: CanonicalEvent,
): event is EventOfType<OrderTransitionEventType> {
  return event.aggregateType === 'Order' && event.type !== 'OrderCreated';
}

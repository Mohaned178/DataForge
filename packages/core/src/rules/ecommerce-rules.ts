import { ORDER_TRANSITIONS, isTransitionAllowed, type OrderTransitionEventType } from '../domain/order-lifecycle';
import type { BusinessRule } from './business-rule';
import { defineRule } from './business-rule';

const ORDER_TRANSITION_EVENTS = Object.keys(ORDER_TRANSITIONS) as OrderTransitionEventType[];
const PAYMENT_EVENTS = ['PaymentFailed', 'PaymentCompleted'] as const;

/**
 * The e-commerce business rules. Add a rule by appending a defineRule() entry; replay and
 * generation pick it up without engine changes.
 */
export const ECOMMERCE_RULES: readonly BusinessRule[] = [
  defineRule({
    id: 'product.unique-id',
    description: 'A product ID is created only once.',
    eventTypes: ['ProductCreated'],
    check: (state, event) =>
      state.products.has(event.payload.productId) ? `product ${event.payload.productId} already exists` : undefined,
  }),
  defineRule({
    id: 'customer.unique-id',
    description: 'A customer ID is registered only once.',
    eventTypes: ['CustomerRegistered'],
    check: (state, event) =>
      state.customers.has(event.payload.customerId) ? `customer ${event.payload.customerId} already exists` : undefined,
  }),
  defineRule({
    id: 'order.unique-id',
    description: 'An order ID is created only once.',
    eventTypes: ['OrderCreated'],
    check: (state, event) =>
      state.orders.has(event.payload.orderId) ? `order ${event.payload.orderId} already exists` : undefined,
  }),
  defineRule({
    id: 'order.customer-exists',
    description: 'An order must reference a customer who registered before the order was placed.',
    eventTypes: ['OrderCreated'],
    check: (state, event) =>
      state.customers.has(event.payload.customerId)
        ? undefined
        : `customer ${event.payload.customerId} is not registered`,
  }),
  defineRule({
    id: 'order.has-lines',
    description: 'An order has at least one line and each product appears on at most one line.',
    eventTypes: ['OrderCreated'],
    check: (_state, event) => {
      const { lines } = event.payload;
      if (lines.length === 0) {
        return 'order has no lines';
      }
      const productIds = new Set(lines.map((line) => line.productId));
      return productIds.size === lines.length ? undefined : 'order lists the same product on more than one line';
    },
  }),
  defineRule({
    id: 'order.products-exist',
    description: 'Every order line must reference an existing product.',
    eventTypes: ['OrderCreated'],
    check: (state, event) => {
      const missing = event.payload.lines.filter((line) => !state.products.has(line.productId));
      return missing.length === 0 ? undefined : `unknown products: ${missing.map((line) => line.productId).join(', ')}`;
    },
  }),
  defineRule({
    id: 'order.prices-match-catalog',
    description: 'Order lines are priced at the catalog price, in the catalog currency.',
    eventTypes: ['OrderCreated'],
    check: (state, event) => {
      for (const line of event.payload.lines) {
        const product = state.products.get(line.productId);
        if (product === undefined) {
          continue;
        }
        if (product.priceMinor !== line.unitPriceMinor) {
          return `${line.productId} is priced ${line.unitPriceMinor} but the catalog price is ${product.priceMinor}`;
        }
        if (product.currency !== event.payload.currency) {
          return `order currency ${event.payload.currency} differs from ${line.productId} currency ${product.currency}`;
        }
      }
      return undefined;
    },
  }),
  defineRule({
    id: 'order.total-matches-lines',
    description: 'The order total equals the sum of quantity x unit price over its lines.',
    eventTypes: ['OrderCreated'],
    check: (_state, event) => {
      const expected = event.payload.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
      return expected === event.payload.totalMinor
        ? undefined
        : `totalMinor is ${event.payload.totalMinor} but the lines sum to ${expected}`;
    },
  }),
  defineRule({
    id: 'order.exists',
    description: 'Payments, cancellations and shipments must reference an existing order.',
    eventTypes: ORDER_TRANSITION_EVENTS,
    check: (state, event) =>
      state.orders.has(event.payload.orderId) ? undefined : `order ${event.payload.orderId} does not exist`,
  }),
  defineRule({
    id: 'order.valid-transition',
    description: 'Orders move only along the order state machine (see ORDER_TRANSITIONS).',
    eventTypes: ORDER_TRANSITION_EVENTS,
    check: (state, event) => {
      const order = state.orders.get(event.payload.orderId);
      if (order === undefined || isTransitionAllowed(event.type, order.status)) {
        return undefined;
      }
      const allowedFrom = ORDER_TRANSITIONS[event.type].from.join(', ');
      return `${event.type} is not allowed while order ${order.orderId} is ${order.status} (allowed from: ${allowedFrom})`;
    },
  }),
  defineRule({
    id: 'payment.unique-id',
    description: 'A payment ID is used only once.',
    eventTypes: PAYMENT_EVENTS,
    check: (state, event) =>
      state.payments.has(event.payload.paymentId) ? `payment ${event.payload.paymentId} already exists` : undefined,
  }),
  defineRule({
    id: 'payment.amount-matches-order',
    description: 'Every payment attempt charges exactly the order total.',
    eventTypes: PAYMENT_EVENTS,
    check: (state, event) => {
      const order = state.orders.get(event.payload.orderId);
      if (order === undefined || order.totalMinor === event.payload.amountMinor) {
        return undefined;
      }
      return `payment amount ${event.payload.amountMinor} differs from order total ${order.totalMinor}`;
    },
  }),
  defineRule({
    id: 'payment.attempts-sequential',
    description: 'Payment attempts for an order are numbered 1, 2, 3, ... without gaps.',
    eventTypes: PAYMENT_EVENTS,
    check: (state, event) => {
      const order = state.orders.get(event.payload.orderId);
      if (order === undefined || event.payload.attempt === order.paymentAttempts + 1) {
        return undefined;
      }
      return `expected payment attempt ${order.paymentAttempts + 1}, got ${event.payload.attempt}`;
    },
  }),
  defineRule({
    id: 'order.cancellation-reason',
    description: 'An order is cancelled for PAYMENT_FAILED only after at least one failed payment.',
    eventTypes: ['OrderCancelled'],
    check: (state, event) => {
      const order = state.orders.get(event.payload.orderId);
      if (order === undefined || event.payload.reason !== 'PAYMENT_FAILED' || order.failedPaymentAttempts > 0) {
        return undefined;
      }
      return 'cancelled for PAYMENT_FAILED but no payment attempt has failed';
    },
  }),
  defineRule({
    id: 'shipment.unique-id',
    description: 'A shipment ID is created only once.',
    eventTypes: ['ShipmentCreated'],
    check: (state, event) =>
      state.shipments.has(event.payload.shipmentId) ? `shipment ${event.payload.shipmentId} already exists` : undefined,
  }),
  defineRule({
    id: 'shipment.matches-order',
    description: 'A delivery confirms the shipment that was created for that order.',
    eventTypes: ['ShipmentDelivered'],
    check: (state, event) => {
      const order = state.orders.get(event.payload.orderId);
      if (order === undefined || order.shipmentId === event.payload.shipmentId) {
        return undefined;
      }
      return `order ${order.orderId} has shipment ${order.shipmentId ?? 'none'}, not ${event.payload.shipmentId}`;
    },
  }),
];

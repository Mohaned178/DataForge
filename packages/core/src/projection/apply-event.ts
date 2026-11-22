import { INITIAL_ORDER_STATUS, ORDER_TRANSITIONS } from '../domain/order-lifecycle';
import type { CanonicalEvent } from '../events/canonical-event';
import type { CustomerRecord, OrderRecord, ShipmentRecord, WorldState } from './world-state';

export class ProjectionError extends Error {
  constructor(event: CanonicalEvent, detail: string) {
    super(`Cannot apply ${event.type} ${event.eventId}: ${detail}`);
    this.name = 'ProjectionError';
  }
}

/**
 * The deterministic projection from one canonical event to the next world state. It assumes the
 * event already passed the business rules; it only refuses events it cannot apply at all.
 */
export function applyEvent(state: WorldState, event: CanonicalEvent): void {
  switch (event.type) {
    case 'ProductCreated': {
      const { productId, sku, name, priceMinor, currency } = event.payload;
      state.products.set(productId, { productId, sku, name, priceMinor, currency, createdAtMs: event.eventTimeMs });
      return;
    }
    case 'CustomerRegistered': {
      const { customerId, name, email, country } = event.payload;
      state.customers.set(customerId, {
        customerId,
        name,
        email,
        country,
        registeredAtMs: event.eventTimeMs,
        orderCount: 0,
        totalPaidMinor: 0,
      });
      return;
    }
    case 'OrderCreated': {
      const { orderId, customerId, currency, lines, totalMinor } = event.payload;
      state.orders.set(orderId, {
        orderId,
        customerId,
        status: INITIAL_ORDER_STATUS,
        currency,
        lines: lines.map((line) => ({ ...line })),
        totalMinor,
        amountPaidMinor: 0,
        paymentAttempts: 0,
        failedPaymentAttempts: 0,
        cancellationReason: null,
        shipmentId: null,
        createdAtMs: event.eventTimeMs,
        updatedAtMs: event.eventTimeMs,
      });
      requireCustomer(state, event, customerId).orderCount += 1;
      return;
    }
    case 'PaymentFailed': {
      const { orderId, paymentId, attempt, amountMinor, reason } = event.payload;
      const order = transitionOrder(state, event, orderId);
      order.paymentAttempts += 1;
      order.failedPaymentAttempts += 1;
      state.payments.set(paymentId, {
        paymentId,
        orderId,
        attempt,
        status: 'FAILED',
        amountMinor,
        failureReason: reason,
        occurredAtMs: event.eventTimeMs,
      });
      return;
    }
    case 'PaymentCompleted': {
      const { orderId, paymentId, attempt, amountMinor } = event.payload;
      const order = transitionOrder(state, event, orderId);
      order.paymentAttempts += 1;
      order.amountPaidMinor += amountMinor;
      requireCustomer(state, event, order.customerId).totalPaidMinor += amountMinor;
      state.payments.set(paymentId, {
        paymentId,
        orderId,
        attempt,
        status: 'COMPLETED',
        amountMinor,
        failureReason: null,
        occurredAtMs: event.eventTimeMs,
      });
      return;
    }
    case 'OrderCancelled': {
      transitionOrder(state, event, event.payload.orderId).cancellationReason = event.payload.reason;
      return;
    }
    case 'ShipmentCreated': {
      const { orderId, shipmentId, carrier } = event.payload;
      transitionOrder(state, event, orderId).shipmentId = shipmentId;
      state.shipments.set(shipmentId, {
        shipmentId,
        orderId,
        carrier,
        status: 'CREATED',
        createdAtMs: event.eventTimeMs,
        deliveredAtMs: null,
      });
      return;
    }
    case 'ShipmentDelivered': {
      const { orderId, shipmentId } = event.payload;
      transitionOrder(state, event, orderId);
      const shipment = requireShipment(state, event, shipmentId);
      shipment.status = 'DELIVERED';
      shipment.deliveredAtMs = event.eventTimeMs;
      return;
    }
  }
}

type TransitionEvent = Extract<CanonicalEvent, { type: keyof typeof ORDER_TRANSITIONS }>;

function transitionOrder(state: WorldState, event: TransitionEvent, orderId: string): OrderRecord {
  const order = state.orders.get(orderId);
  if (order === undefined) {
    throw new ProjectionError(event, `order ${orderId} does not exist`);
  }
  order.status = ORDER_TRANSITIONS[event.type].to;
  order.updatedAtMs = event.eventTimeMs;
  return order;
}

function requireCustomer(state: WorldState, event: CanonicalEvent, customerId: string): CustomerRecord {
  const customer = state.customers.get(customerId);
  if (customer === undefined) {
    throw new ProjectionError(event, `customer ${customerId} does not exist`);
  }
  return customer;
}

function requireShipment(state: WorldState, event: CanonicalEvent, shipmentId: string): ShipmentRecord {
  const shipment = state.shipments.get(shipmentId);
  if (shipment === undefined) {
    throw new ProjectionError(event, `shipment ${shipmentId} does not exist`);
  }
  return shipment;
}

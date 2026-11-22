import {
  INITIAL_ORDER_STATUS,
  ORDER_TRANSITIONS,
  WindowAccumulator,
  WorldState,
  buildActualState,
  buildActualWindows,
  windowContribution,
  windowStartOf,
  type CanonicalEvent,
  type OrderRecord,
} from '@dataforge/core';
import type { DeliveryMessage } from '../message';
import type { Target, TargetOptions, TargetResult } from '../target';

/**
 * A pipeline written as if delivery were perfect, the way many first versions are:
 *
 * - creates are upserts: a redelivered create overwrites the row with its initial values;
 * - the order status is whatever the last message to arrive says (last arrival wins);
 * - counters and amounts are incremented for every message, including redeliveries;
 * - an update of a row that does not exist yet affects nothing and is silently lost;
 * - with a windowing contract, windows are processing-time windows: every message, copies included,
 *   is counted in the window of the moment it arrives (the delivery clock), not of its event time.
 *
 * With perfect delivery it produces exactly the expected state; every difference it shows under
 * chaos is a real class of pipeline bug.
 */
export class NaiveTarget implements Target {
  readonly name = 'naive';
  readonly description: string;

  private readonly state = new WorldState();
  private updatesLost = 0;
  private readonly windowSizeMs: number | undefined;
  private readonly windows: WindowAccumulator | undefined;

  constructor(options: TargetOptions = {}) {
    this.windowSizeMs = options.windowing?.sizeMs;
    this.windows = options.windowing === undefined ? undefined : new WindowAccumulator(options.windowing.sizeMs);
    this.description =
      'applies every message as it arrives: upserts, last arrival wins, not idempotent' +
      (options.windowing === undefined ? '' : '; processing-time windows, every copy counted where it arrives');
  }

  handle(message: DeliveryMessage): void {
    const { event } = message;
    const { state } = this;
    const contribution = windowContribution(event);
    if (this.windows !== undefined && this.windowSizeMs !== undefined && contribution !== undefined) {
      this.windows.add(windowStartOf(message.headers.scheduledDeliveryTimeMs, this.windowSizeMs), contribution);
    }
    switch (event.type) {
      case 'ProductCreated': {
        const { productId, sku, name, priceMinor, currency } = event.payload;
        state.products.set(productId, { productId, sku, name, priceMinor, currency, createdAtMs: event.eventTimeMs });
        return;
      }
      case 'CustomerRegistered': {
        const { customerId, name, email, country } = event.payload;
        state.customers.set(customerId, { customerId, name, email, country, registeredAtMs: event.eventTimeMs, orderCount: 0, totalPaidMinor: 0 });
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
        const customer = state.customers.get(customerId);
        if (customer === undefined) {
          this.updatesLost += 1;
        } else {
          customer.orderCount += 1;
        }
        return;
      }
      case 'PaymentFailed': {
        const { orderId, paymentId, attempt, amountMinor, reason } = event.payload;
        state.payments.set(paymentId, { paymentId, orderId, attempt, status: 'FAILED', amountMinor, failureReason: reason, occurredAtMs: event.eventTimeMs });
        this.updateOrder(event, orderId, (order) => {
          order.paymentAttempts += 1;
          order.failedPaymentAttempts += 1;
        });
        return;
      }
      case 'PaymentCompleted': {
        const { orderId, paymentId, attempt, amountMinor } = event.payload;
        state.payments.set(paymentId, { paymentId, orderId, attempt, status: 'COMPLETED', amountMinor, failureReason: null, occurredAtMs: event.eventTimeMs });
        this.updateOrder(event, orderId, (order) => {
          order.paymentAttempts += 1;
          order.amountPaidMinor += amountMinor;
          const customer = state.customers.get(order.customerId);
          if (customer === undefined) {
            this.updatesLost += 1;
          } else {
            customer.totalPaidMinor += amountMinor;
          }
        });
        return;
      }
      case 'OrderCancelled': {
        this.updateOrder(event, event.payload.orderId, (order) => {
          order.cancellationReason = event.payload.reason;
        });
        return;
      }
      case 'ShipmentCreated': {
        const { orderId, shipmentId, carrier } = event.payload;
        state.shipments.set(shipmentId, { shipmentId, orderId, carrier, status: 'CREATED', createdAtMs: event.eventTimeMs, deliveredAtMs: null });
        this.updateOrder(event, orderId, (order) => {
          order.shipmentId = shipmentId;
        });
        return;
      }
      case 'ShipmentDelivered': {
        const { orderId, shipmentId } = event.payload;
        const shipment = state.shipments.get(shipmentId);
        if (shipment === undefined) {
          this.updatesLost += 1;
        } else {
          shipment.status = 'DELIVERED';
          shipment.deliveredAtMs = event.eventTimeMs;
        }
        this.updateOrder(event, orderId, () => undefined);
        return;
      }
    }
  }

  finish(): TargetResult {
    const result: TargetResult = { actualState: buildActualState(this.state), counters: { updatesLost: this.updatesLost }, parkedEventIds: [] };
    return this.windows === undefined ? result : { ...result, windows: buildActualWindows(this.windows.list()) };
  }

  /** UPDATE orders SET status = <the event's target status>, ... WHERE orderId = ?: zero rows when the order is not there yet. */
  private updateOrder(
    event: Extract<CanonicalEvent, { type: keyof typeof ORDER_TRANSITIONS }>,
    orderId: string,
    change: (order: OrderRecord) => void,
  ): void {
    const order = this.state.orders.get(orderId);
    if (order === undefined) {
      this.updatesLost += 1;
      return;
    }
    order.status = ORDER_TRANSITIONS[event.type].to;
    order.updatedAtMs = event.eventTimeMs;
    change(order);
  }
}

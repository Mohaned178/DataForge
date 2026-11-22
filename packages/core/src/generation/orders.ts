import { orderId, paymentId, shipmentId } from '../domain/ids';
import { PAYMENT_FAILURE_REASONS, SHIPPING_CARRIERS } from '../domain/order-lifecycle';
import type { EventType, OrderLine, PayloadOf } from '../events/canonical-event';
import { draftEvent, type EventDraft } from '../events/event-draft';
import { RandomStream } from '../random/random-stream';
import type { ScenarioConfig } from '../scenario/scenario-schema';
import type { GeneratedProduct } from './catalog';
import type { GeneratedCustomer } from './customers';

/**
 * Collects one order's events in lifecycle order. Events at or after the simulation horizon are
 * not emitted, which leaves the order in whatever state it reached by the end of the window.
 */
class OrderTimeline {
  readonly events: EventDraft[] = [];
  private version = 0;

  constructor(
    private readonly aggregateId: string,
    private readonly horizonMs: number,
  ) {}

  emit<T extends EventType>(type: T, eventTimeMs: number, payload: PayloadOf<T>): boolean {
    if (eventTimeMs >= this.horizonMs) {
      return false;
    }
    this.version += 1;
    this.events.push(draftEvent(type, { aggregateId: this.aggregateId, aggregateVersion: this.version, eventTimeMs }, payload));
    return true;
  }
}

export interface OrderGenerationContext {
  readonly scenario: ScenarioConfig;
  readonly seed: string;
  readonly products: readonly GeneratedProduct[];
  readonly customersByRegistration: readonly GeneratedCustomer[];
}

export function generateOrders(context: OrderGenerationContext): EventDraft[] {
  const events: EventDraft[] = [];
  for (let orderNumber = 1; orderNumber <= context.scenario.orders.count; orderNumber++) {
    events.push(...generateOrder(context, orderNumber));
  }
  return events;
}

/**
 * Each order draws from three independent streams (placement, lines, lifecycle), so changing how
 * lines are chosen never changes when an order is placed or whether its payment fails.
 */
export function generateOrder(context: OrderGenerationContext, orderNumber: number): EventDraft[] {
  const { scenario, seed } = context;
  const key = String(orderNumber);
  const id = orderId(orderNumber);
  const timeline = new OrderTimeline(id, scenario.simulation.durationMs);

  const placement = RandomStream.derive(seed, 'order.placement', key);
  const { createdAtMs, customerId } = placeOrder(context, placement);

  const lines = chooseLines(context, RandomStream.derive(seed, 'order.lines', key));
  const totalMinor = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
  const currency = scenario.catalog.currency;
  timeline.emit('OrderCreated', createdAtMs, { orderId: id, customerId, currency, lines, totalMinor });

  const lifecycle = RandomStream.derive(seed, 'order.lifecycle', key);
  const { orders, payments, shipments } = scenario;

  if (lifecycle.chance(orders.customerCancellationRate)) {
    const cancelledAtMs = createdAtMs + lifecycle.intInRange(orders.customerCancellationDelayMs);
    timeline.emit('OrderCancelled', cancelledAtMs, { orderId: id, reason: 'CUSTOMER_REQUEST' });
    return timeline.events;
  }

  let attemptAtMs = createdAtMs + lifecycle.intInRange(orders.paymentDelayMs);
  for (let attempt = 1; attempt <= payments.maxAttempts; attempt++) {
    const payment = { orderId: id, paymentId: paymentId(orderNumber, attempt), attempt, amountMinor: totalMinor };

    if (!lifecycle.chance(payments.failureRate)) {
      if (!timeline.emit('PaymentCompleted', attemptAtMs, payment)) {
        return timeline.events;
      }
      const shippedAtMs = attemptAtMs + lifecycle.intInRange(shipments.fulfillmentDelayMs);
      const shipment = { orderId: id, shipmentId: shipmentId(orderNumber) };
      if (timeline.emit('ShipmentCreated', shippedAtMs, { ...shipment, carrier: lifecycle.pick(SHIPPING_CARRIERS) })) {
        timeline.emit('ShipmentDelivered', shippedAtMs + lifecycle.intInRange(shipments.deliveryDelayMs), shipment);
      }
      return timeline.events;
    }

    const reason = lifecycle.pick(PAYMENT_FAILURE_REASONS);
    if (!timeline.emit('PaymentFailed', attemptAtMs, { ...payment, reason })) {
      return timeline.events;
    }
    if (attempt === payments.maxAttempts) {
      const cancelledAtMs = attemptAtMs + lifecycle.intInRange(payments.cancellationDelayMs);
      timeline.emit('OrderCancelled', cancelledAtMs, { orderId: id, reason: 'PAYMENT_FAILED' });
      return timeline.events;
    }
    attemptAtMs += lifecycle.intInRange(payments.retryDelayMs);
  }
  return timeline.events;
}

/**
 * An order is placed at a uniformly random time after the first registration, by a customer
 * chosen uniformly among those already registered at that moment.
 */
function placeOrder(context: OrderGenerationContext, random: RandomStream): { createdAtMs: number; customerId: string } {
  const customers = context.customersByRegistration;
  const first = customers[0];
  if (first === undefined) {
    throw new Error('Orders require at least one customer');
  }
  const createdAtMs = random.int(first.registeredAtMs + 1, context.scenario.simulation.durationMs - 1);
  const eligibleCount = countRegisteredBefore(customers, createdAtMs);
  const customer = customers[random.int(0, eligibleCount - 1)] as GeneratedCustomer;
  return { createdAtMs, customerId: customer.customerId };
}

/** Number of customers whose registration time is strictly before `timeMs` (binary search). */
function countRegisteredBefore(customers: readonly GeneratedCustomer[], timeMs: number): number {
  let low = 0;
  let high = customers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((customers[middle] as GeneratedCustomer).registeredAtMs < timeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function chooseLines(context: OrderGenerationContext, random: RandomStream): OrderLine[] {
  const { itemsPerOrder, quantityPerItem } = context.scenario.orders;
  const lineCount = random.intInRange(itemsPerOrder);
  return random.sampleDistinctIndices(context.products.length, lineCount).map((productIndex) => {
    const product = context.products[productIndex] as GeneratedProduct;
    return {
      productId: product.productId,
      quantity: random.intInRange(quantityPerItem),
      unitPriceMinor: product.priceMinor,
    };
  });
}

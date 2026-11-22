import {
  customerId,
  draftEvent,
  orderId,
  paymentId,
  productId,
  sequenceDrafts,
  shipmentId,
  type CancellationReason,
  type CanonicalEvent,
  type EventDraft,
  type EventType,
  type PayloadOf,
} from '../../src';

/**
 * Builds small canonical logs by hand for rule tests. Each call appends the next version of its
 * aggregate; build() sorts by canonical order and assigns sequence numbers. No rule is checked here.
 */
export class LogBuilder {
  private readonly drafts: EventDraft[] = [];
  private readonly versions = new Map<string, number>();
  private readonly prices = new Map<number, number>();
  private readonly totals = new Map<number, number>();

  product(productNumber: number, priceMinor = 1_000, currency = 'USD'): this {
    this.prices.set(productNumber, priceMinor);
    const id = productId(productNumber);
    return this.add('ProductCreated', id, 0, {
      productId: id,
      sku: `SKU-${productNumber}`,
      name: `Product ${productNumber}`,
      priceMinor,
      currency,
    });
  }

  customer(customerNumber: number, atMs: number): this {
    const id = customerId(customerNumber);
    return this.add('CustomerRegistered', id, atMs, {
      customerId: id,
      name: `Customer ${customerNumber}`,
      email: `customer.${customerNumber}@example.com`,
      country: 'US',
    });
  }

  order(
    orderNumber: number,
    customerNumber: number,
    atMs: number,
    lines: readonly (readonly [productNumber: number, quantity: number])[],
    overrides: { totalMinor?: number; unitPriceMinor?: number } = {},
  ): this {
    const orderLines = lines.map(([productNumber, quantity]) => ({
      productId: productId(productNumber),
      quantity,
      unitPriceMinor: overrides.unitPriceMinor ?? this.prices.get(productNumber) ?? 1_000,
    }));
    const totalMinor = overrides.totalMinor ?? orderLines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
    this.totals.set(orderNumber, totalMinor);
    const id = orderId(orderNumber);
    return this.add('OrderCreated', id, atMs, {
      orderId: id,
      customerId: customerId(customerNumber),
      currency: 'USD',
      lines: orderLines,
      totalMinor,
    });
  }

  paymentFailed(orderNumber: number, attempt: number, atMs: number): this {
    return this.add('PaymentFailed', orderId(orderNumber), atMs, {
      ...this.payment(orderNumber, attempt),
      reason: 'CARD_DECLINED',
    });
  }

  paymentCompleted(orderNumber: number, attempt: number, atMs: number, amountMinor?: number): this {
    return this.add('PaymentCompleted', orderId(orderNumber), atMs, this.payment(orderNumber, attempt, amountMinor));
  }

  cancelled(orderNumber: number, atMs: number, reason: CancellationReason): this {
    return this.add('OrderCancelled', orderId(orderNumber), atMs, { orderId: orderId(orderNumber), reason });
  }

  shipmentCreated(orderNumber: number, atMs: number): this {
    return this.add('ShipmentCreated', orderId(orderNumber), atMs, {
      orderId: orderId(orderNumber),
      shipmentId: shipmentId(orderNumber),
      carrier: 'STANDARD_POST',
    });
  }

  shipmentDelivered(orderNumber: number, atMs: number, shipmentOfOrder = orderNumber): this {
    return this.add('ShipmentDelivered', orderId(orderNumber), atMs, {
      orderId: orderId(orderNumber),
      shipmentId: shipmentId(shipmentOfOrder),
    });
  }

  build(): CanonicalEvent[] {
    return sequenceDrafts(this.drafts);
  }

  private payment(orderNumber: number, attempt: number, amountMinor?: number) {
    return {
      orderId: orderId(orderNumber),
      paymentId: paymentId(orderNumber, attempt),
      attempt,
      amountMinor: amountMinor ?? this.totals.get(orderNumber) ?? 1_000,
    };
  }

  private add<T extends EventType>(type: T, aggregateId: string, eventTimeMs: number, payload: PayloadOf<T>): this {
    const aggregateVersion = (this.versions.get(aggregateId) ?? 0) + 1;
    this.versions.set(aggregateId, aggregateVersion);
    this.drafts.push(draftEvent(type, { aggregateId, aggregateVersion, eventTimeMs }, payload));
    return this;
  }
}

/** A complete, valid store: two products, one customer, one order that is paid on the second try and delivered. */
export function happyPathLog(): LogBuilder {
  return new LogBuilder()
    .product(1, 1_250)
    .product(2, 300)
    .customer(1, 10)
    .order(1, 1, 100, [[1, 2], [2, 1]])
    .paymentFailed(1, 1, 200)
    .paymentCompleted(1, 2, 300)
    .shipmentCreated(1, 400)
    .shipmentDelivered(1, 500);
}

/**
 * Entity and event IDs are derived from the entity's position in the scenario, never from random UUIDs.
 * They are readable on purpose: failure reports refer to them constantly.
 */
const ID_DIGITS = 6;

function entityNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`Entity numbers are 1-based positive integers, got ${n}`);
  }
  return String(n).padStart(ID_DIGITS, '0');
}

export function productId(productNumber: number): string {
  return `prd_${entityNumber(productNumber)}`;
}

export function productSku(productNumber: number): string {
  return `SKU-${entityNumber(productNumber)}`;
}

export function customerId(customerNumber: number): string {
  return `cus_${entityNumber(customerNumber)}`;
}

export function orderId(orderNumber: number): string {
  return `ord_${entityNumber(orderNumber)}`;
}

export function paymentId(orderNumber: number, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`Payment attempts are 1-based positive integers, got ${attempt}`);
  }
  return `pay_${entityNumber(orderNumber)}_${attempt}`;
}

export function shipmentId(orderNumber: number): string {
  return `shp_${entityNumber(orderNumber)}`;
}

/** A business event is identified by its aggregate and its position within that aggregate. */
export function eventId(aggregateId: string, aggregateVersion: number): string {
  return `evt_${aggregateId}_${aggregateVersion}`;
}

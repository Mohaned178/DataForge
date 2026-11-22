import { ORDER_STATUSES, type OrderStatus } from '../domain/order-lifecycle';
import { canonicalJson, compareCodeUnits } from '../serialization/canonical-json';
import type { CustomerRecord, OrderRecord, PaymentRecord, ProductRecord, ShipmentRecord, WorldState } from './world-state';

export const EXPECTED_STATE_FORMAT = 'dataforge.expected-state';
export const EXPECTED_STATE_FORMAT_VERSION = 1;

export interface ExpectedStateSummary {
  products: number;
  customers: number;
  orders: number;
  payments: number;
  shipments: number;
  ordersByStatus: Record<OrderStatus, number>;
  revenueMinor: number;
}

/** The final business state a correct pipeline must reach after processing the canonical log. */
export interface ExpectedState {
  format: typeof EXPECTED_STATE_FORMAT;
  formatVersion: typeof EXPECTED_STATE_FORMAT_VERSION;
  lastSequence: number;
  lastEventTimeMs: number;
  summary: ExpectedStateSummary;
  products: ProductRecord[];
  customers: CustomerRecord[];
  orders: OrderRecord[];
  payments: PaymentRecord[];
  shipments: ShipmentRecord[];
}

export interface LogPosition {
  readonly lastSequence: number;
  readonly lastEventTimeMs: number;
}

export function buildExpectedState(state: WorldState, position: LogPosition): ExpectedState {
  const orders = sortedValues(state.orders, (order) => order.orderId);
  const payments = sortedValues(state.payments, (payment) => payment.paymentId);
  const ordersByStatus = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<OrderStatus, number>;
  for (const order of orders) {
    ordersByStatus[order.status] += 1;
  }
  const revenueMinor = payments
    .filter((payment) => payment.status === 'COMPLETED')
    .reduce((sum, payment) => sum + payment.amountMinor, 0);

  return {
    format: EXPECTED_STATE_FORMAT,
    formatVersion: EXPECTED_STATE_FORMAT_VERSION,
    lastSequence: position.lastSequence,
    lastEventTimeMs: position.lastEventTimeMs,
    summary: {
      products: state.products.size,
      customers: state.customers.size,
      orders: orders.length,
      payments: payments.length,
      shipments: state.shipments.size,
      ordersByStatus,
      revenueMinor,
    },
    products: sortedValues(state.products, (product) => product.productId),
    customers: sortedValues(state.customers, (customer) => customer.customerId),
    orders,
    payments,
    shipments: sortedValues(state.shipments, (shipment) => shipment.shipmentId),
  };
}

/** Pretty-printed canonical JSON with a trailing newline, so identical states are identical bytes. */
export function serializeExpectedState(expectedState: ExpectedState): string {
  return `${canonicalJson(expectedState, 2)}\n`;
}

function sortedValues<T>(map: ReadonlyMap<string, T>, idOf: (value: T) => string): T[] {
  return [...map.values()].map((value) => structuredClone(value)).sort((a, b) => compareCodeUnits(idOf(a), idOf(b)));
}

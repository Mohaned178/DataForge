import type {
  CancellationReason,
  OrderStatus,
  PaymentFailureReason,
  PaymentStatus,
  ShipmentStatus,
  ShippingCarrier,
} from '../domain/order-lifecycle';
import type { OrderLine } from '../events/canonical-event';

export interface ProductRecord {
  productId: string;
  sku: string;
  name: string;
  priceMinor: number;
  currency: string;
  createdAtMs: number;
}

export interface CustomerRecord {
  customerId: string;
  name: string;
  email: string;
  country: string;
  registeredAtMs: number;
  orderCount: number;
  totalPaidMinor: number;
}

export interface OrderRecord {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  currency: string;
  lines: readonly OrderLine[];
  totalMinor: number;
  amountPaidMinor: number;
  paymentAttempts: number;
  failedPaymentAttempts: number;
  cancellationReason: CancellationReason | null;
  shipmentId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PaymentRecord {
  paymentId: string;
  orderId: string;
  attempt: number;
  status: PaymentStatus;
  amountMinor: number;
  failureReason: PaymentFailureReason | null;
  occurredAtMs: number;
}

export interface ShipmentRecord {
  shipmentId: string;
  orderId: string;
  carrier: ShippingCarrier;
  status: ShipmentStatus;
  createdAtMs: number;
  deliveredAtMs: number | null;
}

/** The read-only view of the simulated world that business rules evaluate events against. */
export interface WorldStateView {
  readonly products: ReadonlyMap<string, Readonly<ProductRecord>>;
  readonly customers: ReadonlyMap<string, Readonly<CustomerRecord>>;
  readonly orders: ReadonlyMap<string, Readonly<OrderRecord>>;
  readonly payments: ReadonlyMap<string, Readonly<PaymentRecord>>;
  readonly shipments: ReadonlyMap<string, Readonly<ShipmentRecord>>;
}

export class WorldState implements WorldStateView {
  readonly products = new Map<string, ProductRecord>();
  readonly customers = new Map<string, CustomerRecord>();
  readonly orders = new Map<string, OrderRecord>();
  readonly payments = new Map<string, PaymentRecord>();
  readonly shipments = new Map<string, ShipmentRecord>();
}

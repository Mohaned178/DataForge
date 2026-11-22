import { z } from 'zod';
import {
  CANCELLATION_REASONS,
  ORDER_STATUSES,
  PAYMENT_FAILURE_REASONS,
  PAYMENT_STATUSES,
  SHIPMENT_STATUSES,
  SHIPPING_CARRIERS,
} from '../domain/order-lifecycle';
import { canonicalJson, compareCodeUnits } from '../serialization/canonical-json';
import type { CustomerRecord, OrderRecord, PaymentRecord, ProductRecord, ShipmentRecord, WorldStateView } from './world-state';

export const ACTUAL_STATE_FORMAT = 'dataforge.actual-state';
export const ACTUAL_STATE_FORMAT_VERSION = 1;

/*
 * The schema checks the shape and vocabulary of what a target reports, not its business
 * correctness: a wrong amount or a negative counter is a finding for the validator, not a format
 * error. Unknown fields are rejected, so a misspelt column is caught instead of being ignored.
 */
const id = z.string().min(1);
const int = z.number().int().refine(Number.isSafeInteger, { error: 'must be a safe integer' });

const productRecordSchema = z.strictObject({
  productId: id,
  sku: z.string(),
  name: z.string(),
  priceMinor: int,
  currency: z.string(),
  createdAtMs: int,
});

const customerRecordSchema = z.strictObject({
  customerId: id,
  name: z.string(),
  email: z.string(),
  country: z.string(),
  registeredAtMs: int,
  orderCount: int,
  totalPaidMinor: int,
});

const orderRecordSchema = z.strictObject({
  orderId: id,
  customerId: id,
  status: z.enum(ORDER_STATUSES),
  currency: z.string(),
  lines: z.array(z.strictObject({ productId: id, quantity: int, unitPriceMinor: int })),
  totalMinor: int,
  amountPaidMinor: int,
  paymentAttempts: int,
  failedPaymentAttempts: int,
  cancellationReason: z.enum(CANCELLATION_REASONS).nullable(),
  shipmentId: id.nullable(),
  createdAtMs: int,
  updatedAtMs: int,
});

const paymentRecordSchema = z.strictObject({
  paymentId: id,
  orderId: id,
  attempt: int,
  status: z.enum(PAYMENT_STATUSES),
  amountMinor: int,
  failureReason: z.enum(PAYMENT_FAILURE_REASONS).nullable(),
  occurredAtMs: int,
});

const shipmentRecordSchema = z.strictObject({
  shipmentId: id,
  orderId: id,
  carrier: z.enum(SHIPPING_CARRIERS),
  status: z.enum(SHIPMENT_STATUSES),
  createdAtMs: int,
  deliveredAtMs: int.nullable(),
});

/**
 * What a target reports back: the five entity collections of the expected state, with the same
 * record shapes, in any order. A target that stores a record twice lists it twice; the validator
 * reports that rather than the parser.
 */
export const actualStateSchema = z.strictObject({
  format: z.literal(ACTUAL_STATE_FORMAT, { error: `format must be "${ACTUAL_STATE_FORMAT}"` }),
  formatVersion: z.literal(ACTUAL_STATE_FORMAT_VERSION, { error: `formatVersion must be ${ACTUAL_STATE_FORMAT_VERSION}` }),
  products: z.array(productRecordSchema),
  customers: z.array(customerRecordSchema),
  orders: z.array(orderRecordSchema),
  payments: z.array(paymentRecordSchema),
  shipments: z.array(shipmentRecordSchema),
});

export interface ActualState {
  format: typeof ACTUAL_STATE_FORMAT;
  formatVersion: typeof ACTUAL_STATE_FORMAT_VERSION;
  products: ProductRecord[];
  customers: CustomerRecord[];
  orders: OrderRecord[];
  payments: PaymentRecord[];
  shipments: ShipmentRecord[];
}

export class ActualStateValidationError extends Error {
  constructor(readonly issues: readonly { readonly path: string; readonly message: string }[]) {
    super(`Invalid actual state:\n${issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'ActualStateValidationError';
  }
}

const MAX_REPORTED_ISSUES = 20;

/** Validates a target's reported state, listing the path of each problem (at most 20). */
export function parseActualState(input: unknown): ActualState {
  const result = actualStateSchema.safeParse(input);
  if (!result.success) {
    throw new ActualStateValidationError(
      result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** A world state as an actual-state document, every collection sorted by ID. */
export function buildActualState(state: WorldStateView): ActualState {
  return {
    format: ACTUAL_STATE_FORMAT,
    formatVersion: ACTUAL_STATE_FORMAT_VERSION,
    products: sortedById(state.products),
    customers: sortedById(state.customers),
    orders: sortedById(state.orders),
    payments: sortedById(state.payments),
    shipments: sortedById(state.shipments),
  };
}

/** Pretty-printed canonical JSON with a trailing newline, like expected-state.json. */
export function serializeActualState(actualState: ActualState): string {
  return `${canonicalJson(actualState, 2)}\n`;
}

function sortedById<T>(map: ReadonlyMap<string, Readonly<T>>): T[] {
  return [...map.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, value]) => structuredClone(value) as T);
}

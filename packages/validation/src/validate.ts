import {
  ECOMMERCE_INVARIANTS,
  ENTITY_TYPES,
  WorldState,
  canonicalJson,
  compareCodeUnits,
  type ActualState,
  type EntityType,
  type EventType,
  type ExpectedState,
  type StateInvariant,
  type WorldStateView,
} from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import { DeliveryIndex } from './delivery-index';
import { FINDING_CATEGORIES, type DeliveryCause, type FieldDifference, type Finding, type FindingCategory, type JsonValue } from './finding';

export interface ValidationInput {
  readonly expected: ExpectedState;
  readonly actual: ActualState;
  /** The delivery plan the target consumed. With it, every finding gets root-cause hints. */
  readonly attempts?: readonly DeliveryAttempt[];
  readonly invariants?: readonly StateInvariant[];
}

/** The findings that share one most likely cause; `cause` is null for findings no delivery fault explains. */
export interface RootCause {
  readonly cause: DeliveryCause | null;
  readonly findings: number;
}

export interface ValidationResult {
  readonly verdict: 'PASS' | 'FAIL';
  /** Whether a delivery plan was given, so that findings carry root-cause hints. */
  readonly hints: boolean;
  readonly checked: {
    readonly entities: Record<EntityType, { readonly expected: number; readonly actual: number }>;
    readonly invariants: number;
  };
  readonly counts: {
    readonly findings: number;
    readonly byCategory: Record<FindingCategory, number>;
    /** Findings with at least one cause; null without a plan. */
    readonly explained: number | null;
    readonly unexplained: number | null;
  };
  /** Findings grouped by their most likely cause, largest group first. Empty without a plan. */
  readonly rootCauses: readonly RootCause[];
  /** Sorted by entity type, entity ID, category and check. */
  readonly findings: readonly Finding[];
}

type AnyRecord = Readonly<Record<string, JsonValue>>;

interface CollectionSpec {
  readonly entityType: EntityType;
  readonly key: 'products' | 'customers' | 'orders' | 'payments' | 'shipments';
  readonly idField: string;
  /** Fields that count or sum what was processed. Above the expected value means processed more than once. */
  readonly accumulators: readonly string[];
}

const COLLECTIONS: readonly CollectionSpec[] = [
  { entityType: 'product', key: 'products', idField: 'productId', accumulators: [] },
  { entityType: 'customer', key: 'customers', idField: 'customerId', accumulators: ['orderCount', 'totalPaidMinor'] },
  { entityType: 'order', key: 'orders', idField: 'orderId', accumulators: ['amountPaidMinor', 'paymentAttempts', 'failedPaymentAttempts'] },
  { entityType: 'payment', key: 'payments', idField: 'paymentId', accumulators: [] },
  { entityType: 'shipment', key: 'shipments', idField: 'shipmentId', accumulators: [] },
];

const STATUS_FIELD = 'status';

type UnrankedFinding = Omit<Finding, 'causes'>;

/**
 * Compares a target's actual state with the expected state, entity by entity, and checks the
 * state invariants on the actual state. With the delivery plan, each finding is linked to the
 * abnormal deliveries on the aggregates its entity depends on.
 */
export function validate(input: ValidationInput): ValidationResult {
  const invariants = input.invariants ?? ECOMMERCE_INVARIANTS;
  const raw: UnrankedFinding[] = [];
  const entities = {} as Record<EntityType, { expected: number; actual: number }>;

  for (const spec of COLLECTIONS) {
    const expectedRecords = input.expected[spec.key] as unknown as readonly AnyRecord[];
    const actualRecords = input.actual[spec.key] as unknown as readonly AnyRecord[];
    entities[spec.entityType] = { expected: expectedRecords.length, actual: actualRecords.length };
    raw.push(...compareCollection(spec, expectedRecords, actualRecords));
  }

  const actualView = toWorldState(input.actual);
  for (const invariant of invariants) {
    for (const violation of invariant.check(actualView)) {
      raw.push({
        category: invariant.category,
        entityType: violation.entityType,
        entityId: violation.entityId,
        check: invariant.id,
        message: violation.message,
        differences: [],
      });
    }
  }

  const relations = new Relations(input.expected, actualView);
  const index = input.attempts === undefined ? undefined : new DeliveryIndex(input.attempts);
  const findings: Finding[] = raw
    .map((finding) => ({ ...finding, causes: index === undefined ? [] : rankCauses(finding, relations, index) }))
    .sort(compareFindings);

  const byCategory = Object.fromEntries(FINDING_CATEGORIES.map((category) => [category, 0])) as Record<FindingCategory, number>;
  for (const finding of findings) {
    byCategory[finding.category] += 1;
  }
  const explained = findings.filter((finding) => finding.causes.length > 0).length;

  return {
    verdict: findings.length === 0 ? 'PASS' : 'FAIL',
    hints: index !== undefined,
    checked: { entities, invariants: invariants.length },
    counts: {
      findings: findings.length,
      byCategory,
      explained: index === undefined ? null : explained,
      unexplained: index === undefined ? null : findings.length - explained,
    },
    rootCauses: index === undefined ? [] : groupRootCauses(findings),
    findings,
  };
}

function compareCollection(spec: CollectionSpec, expected: readonly AnyRecord[], actual: readonly AnyRecord[]): UnrankedFinding[] {
  const findings: UnrankedFinding[] = [];
  const base = (category: FindingCategory, entityId: string, check: string, message: string, differences: FieldDifference[] = []) =>
    findings.push({ category, entityType: spec.entityType, entityId, check, message, differences });

  const actualById = new Map<string, AnyRecord>();
  const occurrences = new Map<string, number>();
  for (const record of actual) {
    const id = idOf(spec, record);
    occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    if (!actualById.has(id)) {
      actualById.set(id, record);
    }
  }
  for (const [id, count] of occurrences) {
    if (count > 1) {
      base('duplicate-record', id, 'duplicate-record', `listed ${count} times in the actual state`);
    }
  }

  const expectedIds = new Set<string>();
  for (const expectedRecord of expected) {
    const id = idOf(spec, expectedRecord);
    expectedIds.add(id);
    const actualRecord = actualById.get(id);
    if (actualRecord === undefined) {
      base('missing-entity', id, 'compare', 'expected, but missing from the actual state');
      continue;
    }
    const byCategory = new Map<FindingCategory, FieldDifference[]>();
    const fields = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort(compareCodeUnits);
    for (const field of fields) {
      const expectedValue = expectedRecord[field] ?? null;
      const actualValue = actualRecord[field] ?? null;
      if (canonicalJson(expectedValue) === canonicalJson(actualValue)) {
        continue;
      }
      const category = categorizeDifference(spec, field, expectedValue, actualValue);
      const list = byCategory.get(category) ?? [];
      list.push({ field, expected: expectedValue, actual: actualValue });
      byCategory.set(category, list);
    }
    for (const [category, differences] of byCategory) {
      base(category, id, 'compare', differences.map(describeDifference).join('; '), differences);
    }
  }

  for (const id of actualById.keys()) {
    if (!expectedIds.has(id)) {
      base('unexpected-entity', id, 'compare', 'in the actual state, but not expected');
    }
  }
  return findings;
}

/** Records are schema-validated, so the ID field is always a non-empty string. */
function idOf(spec: CollectionSpec, record: AnyRecord): string {
  return record[spec.idField] as string;
}

function categorizeDifference(spec: CollectionSpec, field: string, expected: JsonValue, actual: JsonValue): FindingCategory {
  if (field === STATUS_FIELD) {
    return 'status-mismatch';
  }
  if (spec.accumulators.includes(field) && typeof expected === 'number' && typeof actual === 'number' && actual > expected) {
    return 'double-processing';
  }
  return 'field-mismatch';
}

function describeDifference(difference: FieldDifference): string {
  const { field, expected, actual } = difference;
  const ratio =
    typeof expected === 'number' && typeof actual === 'number' && expected > 0 && actual > expected && actual % expected === 0
      ? ` (${actual / expected}x)`
      : '';
  return `${field} is ${formatValue(actual)}, expected ${formatValue(expected)}${ratio}`;
}

function formatValue(value: JsonValue): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

/** The actual state as a world-state view for the invariants; the first record wins when an ID is listed twice. */
function toWorldState(actual: ActualState): WorldStateView {
  const state = new WorldState();
  const fill = <T>(map: Map<string, T>, records: readonly T[], idOf: (record: T) => string) => {
    for (const record of records) {
      if (!map.has(idOf(record))) {
        map.set(idOf(record), record);
      }
    }
  };
  fill(state.products, actual.products, (record) => record.productId);
  fill(state.customers, actual.customers, (record) => record.customerId);
  fill(state.orders, actual.orders, (record) => record.orderId);
  fill(state.payments, actual.payments, (record) => record.paymentId);
  fill(state.shipments, actual.shipments, (record) => record.shipmentId);
  return state;
}

/**
 * Which aggregates' events an entity's state depends on. An order depends on its own events, and
 * on its customer and products existing; a payment or shipment on its order; a customer on its own
 * registration and on its orders. Both states are consulted, so a wrong reference still finds the
 * aggregates it should have pointed to.
 */
class Relations {
  private readonly ordersByCustomer = new Map<string, Set<string>>();
  private readonly expectedOrders: ReadonlyMap<string, ExpectedState['orders'][number]>;
  private readonly expectedPayments: ReadonlyMap<string, string>;
  private readonly expectedShipments: ReadonlyMap<string, string>;

  constructor(
    expected: ExpectedState,
    private readonly actual: WorldStateView,
  ) {
    this.expectedOrders = new Map(expected.orders.map((order) => [order.orderId, order]));
    this.expectedPayments = new Map(expected.payments.map((payment) => [payment.paymentId, payment.orderId]));
    this.expectedShipments = new Map(expected.shipments.map((shipment) => [shipment.shipmentId, shipment.orderId]));
    for (const order of [...expected.orders, ...actual.orders.values()]) {
      const set = this.ordersByCustomer.get(order.customerId) ?? new Set<string>();
      set.add(order.orderId);
      this.ordersByCustomer.set(order.customerId, set);
    }
  }

  /** The aggregate the entity belongs to: itself, or its order for payments and shipments. */
  primaryAggregate(entityType: EntityType, entityId: string): string | undefined {
    switch (entityType) {
      case 'payment':
        return this.expectedPayments.get(entityId) ?? this.actual.payments.get(entityId)?.orderId;
      case 'shipment':
        return this.expectedShipments.get(entityId) ?? this.actual.shipments.get(entityId)?.orderId;
      default:
        return entityId;
    }
  }

  /**
   * The abnormal deliveries that can have changed an entity:
   * - its own aggregate's events (a payment's or shipment's: its order's);
   * - for a customer, also the OrderCreated and PaymentCompleted events of its orders (the only
   *   order events that touch a customer record), and any lost event of those orders;
   * - for an order (and its payments and shipment), a lost customer or product, which leaves the
   *   order waiting forever in a consumer that waits for references.
   */
  causesOf(entityType: EntityType, entityId: string, index: DeliveryIndex): DeliveryCause[] {
    const causes = new Map<string, DeliveryCause>();
    const add = (aggregateId: string, accept: (cause: DeliveryCause) => boolean) => {
      for (const cause of index.abnormalEventsOf(aggregateId)) {
        if (accept(cause)) {
          causes.set(cause.eventId, cause);
        }
      }
    };
    const addOrder = (orderId: string, accept: (cause: DeliveryCause) => boolean) => {
      add(orderId, accept);
      for (const order of [this.expectedOrders.get(orderId), this.actual.orders.get(orderId)]) {
        if (order !== undefined) {
          add(order.customerId, isLost);
          order.lines.forEach((line) => add(line.productId, isLost));
        }
      }
    };
    switch (entityType) {
      case 'product':
        add(entityId, always);
        break;
      case 'customer':
        add(entityId, always);
        for (const orderId of this.ordersByCustomer.get(entityId) ?? []) {
          addOrder(orderId, (cause) => cause.lost || CUSTOMER_UPDATING_EVENTS.has(cause.eventType));
        }
        break;
      case 'order':
        addOrder(entityId, always);
        break;
      case 'payment':
      case 'shipment': {
        const orderId = this.primaryAggregate(entityType, entityId);
        if (orderId !== undefined) {
          addOrder(orderId, always);
        }
        break;
      }
    }
    return [...causes.values()];
  }
}

const always = (): boolean => true;
const isLost = (cause: DeliveryCause): boolean => cause.lost;
/** Order-aggregate events that change a customer record (orderCount, totalPaidMinor). */
const CUSTOMER_UPDATING_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['OrderCreated', 'PaymentCompleted']);

/** Lower is more likely to explain a finding of this category. */
function relevance(category: FindingCategory, cause: DeliveryCause): number {
  const overtaken = cause.overtakenBy.length > 0;
  switch (category) {
    case 'double-processing':
    case 'duplicate-record':
      return cause.deliveries > 1 ? 0 : 1;
    case 'missing-entity':
    case 'referential-integrity':
      return cause.lost ? 0 : overtaken ? 1 : 2;
    default:
      return cause.lost || overtaken ? 0 : cause.deliveries > 1 ? 1 : 2;
  }
}

/** The event types that add to a counter or amount: the only ones a redelivery can push above the expected value. */
const INCREMENTED_BY: Readonly<Record<string, readonly EventType[]>> = {
  orderCount: ['OrderCreated'],
  totalPaidMinor: ['PaymentCompleted'],
  amountPaidMinor: ['PaymentCompleted'],
  paymentAttempts: ['PaymentFailed', 'PaymentCompleted'],
  failedPaymentAttempts: ['PaymentFailed'],
};

/** The create events that start a counter at zero: a late or repeated create can pull it below the expected value. */
const RESET_BY: Readonly<Record<string, readonly EventType[]>> = {
  orderCount: ['CustomerRegistered'],
  totalPaidMinor: ['CustomerRegistered', 'OrderCreated'],
  amountPaidMinor: ['OrderCreated'],
  paymentAttempts: ['OrderCreated'],
  failedPaymentAttempts: ['OrderCreated'],
};

/** The fields an invariant reads, for ranking its causes like a comparison of those fields. */
const INVARIANT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'customer.order-count': ['orderCount'],
  'customer.total-paid': ['totalPaidMinor'],
  'order.paid-within-total': ['amountPaidMinor'],
  'order.payment-counters': ['paymentAttempts', 'failedPaymentAttempts'],
};

function rankCauses(finding: UnrankedFinding, relations: Relations, index: DeliveryIndex): DeliveryCause[] {
  const primary = relations.primaryAggregate(finding.entityType, finding.entityId);
  const fields = finding.differences.length > 0 ? finding.differences.map((difference) => difference.field) : (INVARIANT_FIELDS[finding.check] ?? []);
  const overCounted = finding.category === 'double-processing';
  const writers = new Set(fields.flatMap((field) => [...(INCREMENTED_BY[field] ?? []), ...(overCounted ? [] : (RESET_BY[field] ?? []))]));
  const key = (cause: DeliveryCause) =>
    [relevance(finding.category, cause), writers.size === 0 || writers.has(cause.eventType) ? 0 : 1, cause.aggregateId === primary ? 0 : 1] as const;
  return relations.causesOf(finding.entityType, finding.entityId, index).sort((a, b) => {
    const [ra, wa, pa] = key(a);
    const [rb, wb, pb] = key(b);
    return ra - rb || wa - wb || pa - pb || compareCodeUnits(a.aggregateId, b.aggregateId) || a.aggregateVersion - b.aggregateVersion;
  });
}

const ENTITY_ORDER = new Map(ENTITY_TYPES.map((type, position) => [type, position]));
const CATEGORY_ORDER = new Map(FINDING_CATEGORIES.map((category, position) => [category, position]));

function compareFindings(a: Finding, b: Finding): number {
  return (
    (ENTITY_ORDER.get(a.entityType) ?? 0) - (ENTITY_ORDER.get(b.entityType) ?? 0) ||
    compareCodeUnits(a.entityId, b.entityId) ||
    (CATEGORY_ORDER.get(a.category) ?? 0) - (CATEGORY_ORDER.get(b.category) ?? 0) ||
    compareCodeUnits(a.check, b.check) ||
    compareCodeUnits(a.message, b.message)
  );
}

function groupRootCauses(findings: readonly Finding[]): RootCause[] {
  const groups = new Map<string, { cause: DeliveryCause | null; findings: number }>();
  for (const finding of findings) {
    const cause = finding.causes[0] ?? null;
    const key = cause?.eventId ?? '';
    const group = groups.get(key) ?? { cause, findings: 0 };
    group.findings += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.findings - a.findings ||
      (a.cause === null ? 1 : 0) - (b.cause === null ? 1 : 0) ||
      compareCodeUnits(a.cause?.eventId ?? '', b.cause?.eventId ?? ''),
  );
}

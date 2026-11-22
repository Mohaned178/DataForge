import type { EntityType, EventType } from '@dataforge/core';
import type { FaultType } from '@dataforge/chaos';

/** Finding categories, in the order reports list them. */
export const FINDING_CATEGORIES = [
  'missing-entity',
  'unexpected-entity',
  'duplicate-record',
  'status-mismatch',
  'field-mismatch',
  'double-processing',
  'referential-integrity',
  'invariant-violation',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface FieldDifference {
  readonly field: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

/**
 * A canonical event whose delivery was abnormal, on an aggregate the finding's entity depends on.
 * It is a hint, not a proof: it says which delivery faults could have produced the difference.
 */
export interface DeliveryCause {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  /** Fault types recorded on the event's attempts, in FAULT_TYPES order. */
  readonly faults: readonly FaultType[];
  /** How many times the target received the event (0 when it was lost). */
  readonly deliveries: number;
  readonly failedAttempts: number;
  readonly lost: boolean;
  readonly delayMs: number | null;
  /** Later events of the same aggregate that the target received before this one. */
  readonly overtakenBy: readonly string[];
}

export interface Finding {
  readonly category: FindingCategory;
  readonly entityType: EntityType;
  readonly entityId: string;
  /** `compare` (expected versus actual), `duplicate-record`, or the ID of the broken invariant. */
  readonly check: string;
  readonly message: string;
  /** The differing fields, for comparison findings; empty otherwise. */
  readonly differences: readonly FieldDifference[];
  /** Most likely first. Empty when no delivery fault touched the entity's aggregates, or when no plan was given. */
  readonly causes: readonly DeliveryCause[];
}

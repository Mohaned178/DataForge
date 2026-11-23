import { deliveryAttemptSchema, type DeliveryAttempt } from '@dataforge/chaos';
import type { DeliveryLogEntry } from '@dataforge/kafka';
import { ExecutionIntegrityError } from './execution-integrity';

/**
 * Delivery attempts as column arrays, one entry per attempt, for one INSERT ... SELECT FROM
 * unnest(...) per chunk (as canonical events, ADR-0011). JSON columns are JSON text; the Kafka
 * columns are null for an in-memory execution.
 */
export interface AttemptColumns {
  readonly deliverySequences: number[];
  readonly attemptIds: string[];
  readonly attemptNumbers: number[];
  readonly kinds: string[];
  readonly plannedOutcomes: string[];
  readonly scheduledDeliveryTimesMs: number[];
  readonly eventIds: string[];
  readonly eventSequences: number[];
  readonly eventTypes: string[];
  readonly eventTimesMs: number[];
  readonly aggregateIds: string[];
  readonly aggregateVersions: number[];
  readonly derivedFroms: (string | null)[];
  readonly faults: string[];
  readonly kafkaOutcomes: (string | null)[];
  readonly kafkaPartitions: (number | null)[];
  readonly kafkaOffsets: (string | null)[];
  readonly dueAtMs: (number | null)[];
  readonly startedAtMs: (number | null)[];
  readonly ackedAtMs: (number | null)[];
  readonly driftMs: (number | null)[];
}

/** A stored delivery_attempt row as Prisma returns it. */
export interface StoredAttemptRow {
  readonly deliverySequence: number;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly kind: string;
  readonly plannedOutcome: string;
  readonly scheduledDeliveryTimeMs: bigint;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly eventType: string;
  readonly eventTimeMs: bigint;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly derivedFrom: unknown;
  readonly faults: unknown;
  readonly kafkaOutcome: string | null;
  readonly kafkaPartition: number | null;
  readonly kafkaOffset: string | null;
  readonly dueAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly ackedAtMs: number | null;
  readonly driftMs: number | null;
}

/** The plan's attempts with, for a Kafka execution, the delivery-log entry of each (same delivery sequence). */
export function toAttemptColumns(attempts: readonly DeliveryAttempt[], deliveryLog: readonly DeliveryLogEntry[] | undefined): AttemptColumns {
  const logBySequence = new Map((deliveryLog ?? []).map((entry) => [entry.deliverySequence, entry]));
  if (deliveryLog !== undefined && logBySequence.size !== attempts.length) {
    throw new Error(`the delivery log has ${logBySequence.size} entries for ${attempts.length} planned attempts`);
  }
  const columns: AttemptColumns = {
    deliverySequences: [],
    attemptIds: [],
    attemptNumbers: [],
    kinds: [],
    plannedOutcomes: [],
    scheduledDeliveryTimesMs: [],
    eventIds: [],
    eventSequences: [],
    eventTypes: [],
    eventTimesMs: [],
    aggregateIds: [],
    aggregateVersions: [],
    derivedFroms: [],
    faults: [],
    kafkaOutcomes: [],
    kafkaPartitions: [],
    kafkaOffsets: [],
    dueAtMs: [],
    startedAtMs: [],
    ackedAtMs: [],
    driftMs: [],
  };
  for (const attempt of attempts) {
    const log = logBySequence.get(attempt.deliverySequence);
    if (deliveryLog !== undefined && log?.attemptId !== attempt.attemptId) {
      throw new Error(`the delivery log does not match the plan at delivery ${attempt.deliverySequence}`);
    }
    columns.deliverySequences.push(attempt.deliverySequence);
    columns.attemptIds.push(attempt.attemptId);
    columns.attemptNumbers.push(attempt.attemptNumber);
    columns.kinds.push(attempt.kind);
    columns.plannedOutcomes.push(attempt.plannedOutcome);
    columns.scheduledDeliveryTimesMs.push(attempt.scheduledDeliveryTimeMs);
    columns.eventIds.push(attempt.eventId);
    columns.eventSequences.push(attempt.eventSequence);
    columns.eventTypes.push(attempt.eventType);
    columns.eventTimesMs.push(attempt.eventTimeMs);
    columns.aggregateIds.push(attempt.aggregateId);
    columns.aggregateVersions.push(attempt.aggregateVersion);
    columns.derivedFroms.push(attempt.derivedFrom === null ? null : JSON.stringify(attempt.derivedFrom));
    columns.faults.push(JSON.stringify(attempt.faults));
    columns.kafkaOutcomes.push(log?.outcome ?? null);
    columns.kafkaPartitions.push(log?.partition ?? null);
    columns.kafkaOffsets.push(log?.offset ?? null);
    columns.dueAtMs.push(log?.dueAtMs ?? null);
    columns.startedAtMs.push(log === undefined ? null : log.startedAtMs);
    columns.ackedAtMs.push(log?.ackedAtMs ?? null);
    columns.driftMs.push(log?.driftMs ?? null);
  }
  return columns;
}

/** Splits column arrays into chunks of at most `size` rows, so no statement grows with the plan. */
export function chunkColumns<T extends { readonly [K in keyof T]: unknown[] }>(columns: T, size: number): T[] {
  const keys = Object.keys(columns) as (keyof T)[];
  const first = keys[0];
  const length = first === undefined ? 0 : columns[first].length;
  const chunks: T[] = [];
  for (let start = 0; start < length; start += size) {
    const chunk = {} as { [K in keyof T]: unknown[] };
    for (const key of keys) {
      chunk[key] = columns[key].slice(start, start + size);
    }
    chunks.push(chunk as T);
  }
  return chunks;
}

/**
 * Rebuilds a planned attempt from its row and validates it against the attempt schema, so a row
 * modified into something that is not a delivery attempt is reported, never served.
 */
export function fromAttemptRow(row: StoredAttemptRow, executionId: string): DeliveryAttempt {
  const candidate = {
    attemptId: row.attemptId,
    deliverySequence: row.deliverySequence,
    attemptNumber: row.attemptNumber,
    kind: row.kind,
    plannedOutcome: row.plannedOutcome,
    scheduledDeliveryTimeMs: Number(row.scheduledDeliveryTimeMs),
    eventId: row.eventId,
    eventSequence: row.eventSequence,
    eventType: row.eventType,
    eventTimeMs: Number(row.eventTimeMs),
    aggregateId: row.aggregateId,
    aggregateVersion: row.aggregateVersion,
    derivedFrom: row.derivedFrom ?? null,
    faults: row.faults,
  };
  const result = deliveryAttemptSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? '(attempt)' : issue.path.map(String).join('.');
    throw new ExecutionIntegrityError(
      `Stored attempt ${row.deliverySequence} of execution ${executionId} is not a valid delivery attempt: ${path}: ${issue?.message ?? 'invalid attempt'}`,
    );
  }
  return result.data;
}

/** The delivery-log.jsonl entry of a Kafka execution's attempt, or undefined for an in-memory execution. */
export function deliveryLogEntryOf(row: StoredAttemptRow): DeliveryLogEntry | undefined {
  if (row.kafkaOutcome !== 'sent' && row.kafkaOutcome !== 'planned-failure') {
    return undefined;
  }
  return {
    deliverySequence: row.deliverySequence,
    attemptId: row.attemptId,
    eventId: row.eventId,
    aggregateId: row.aggregateId,
    scheduledDeliveryTimeMs: Number(row.scheduledDeliveryTimeMs),
    outcome: row.kafkaOutcome,
    dueAtMs: row.dueAtMs,
    startedAtMs: row.startedAtMs ?? 0,
    ackedAtMs: row.ackedAtMs,
    driftMs: row.driftMs,
    partition: row.kafkaPartition,
    offset: row.kafkaOffset,
  };
}

import { versionedEventSchema, type CanonicalEvent } from '@dataforge/core';
import { RunIntegrityError } from './run-integrity';

/**
 * The canonical events of a run as column arrays, one entry per event, for a single
 * INSERT ... SELECT FROM unnest(...) statement (ADR-0011). The payload is canonical JSON text.
 */
export interface EventColumns {
  readonly sequences: number[];
  readonly eventIds: string[];
  readonly types: string[];
  readonly aggregateTypes: string[];
  readonly aggregateIds: string[];
  readonly aggregateVersions: number[];
  readonly eventTimesMs: number[];
  readonly schemaVersions: number[];
  readonly payloads: string[];
}

/** A stored canonical_event row as Prisma returns it. */
export interface StoredEventRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventTimeMs: bigint;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

export function toEventColumns(events: readonly CanonicalEvent[]): EventColumns {
  const columns: EventColumns = {
    sequences: [],
    eventIds: [],
    types: [],
    aggregateTypes: [],
    aggregateIds: [],
    aggregateVersions: [],
    eventTimesMs: [],
    schemaVersions: [],
    payloads: [],
  };
  for (const event of events) {
    columns.sequences.push(event.sequence);
    columns.eventIds.push(event.eventId);
    columns.types.push(event.type);
    columns.aggregateTypes.push(event.aggregateType);
    columns.aggregateIds.push(event.aggregateId);
    columns.aggregateVersions.push(event.aggregateVersion);
    columns.eventTimesMs.push(event.eventTimeMs);
    columns.schemaVersions.push(event.schemaVersion);
    columns.payloads.push(JSON.stringify(event.payload));
  }
  return columns;
}

/** Splits event columns into chunks of at most `size` events, so no statement grows with the run. */
export function chunkEventColumns(columns: EventColumns, size: number): EventColumns[] {
  const chunks: EventColumns[] = [];
  for (let start = 0; start < columns.sequences.length; start += size) {
    const end = start + size;
    chunks.push({
      sequences: columns.sequences.slice(start, end),
      eventIds: columns.eventIds.slice(start, end),
      types: columns.types.slice(start, end),
      aggregateTypes: columns.aggregateTypes.slice(start, end),
      aggregateIds: columns.aggregateIds.slice(start, end),
      aggregateVersions: columns.aggregateVersions.slice(start, end),
      eventTimesMs: columns.eventTimesMs.slice(start, end),
      schemaVersions: columns.schemaVersions.slice(start, end),
      payloads: columns.payloads.slice(start, end),
    });
  }
  return chunks;
}

/**
 * Rebuilds a canonical event from its row and validates it against the event schema, so a row that
 * was modified into something that is not a canonical event is reported, never served.
 */
export function fromEventRow(row: StoredEventRow, runId: string): CanonicalEvent {
  const candidate = {
    eventId: row.eventId,
    schemaVersion: row.schemaVersion,
    sequence: row.sequence,
    eventTimeMs: Number(row.eventTimeMs),
    aggregateId: row.aggregateId,
    aggregateVersion: row.aggregateVersion,
    type: row.type,
    aggregateType: row.aggregateType,
    payload: row.payload,
  };
  const result = versionedEventSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? '(event)' : issue.path.map(String).join('.');
    throw new RunIntegrityError(`Stored event ${row.sequence} of run ${runId} is not a valid canonical event: ${path}: ${issue?.message ?? 'invalid event'}`);
  }
  return result.data;
}

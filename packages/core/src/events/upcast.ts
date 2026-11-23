import { z } from 'zod';
import { EVENT_SCHEMA_VERSION } from '../version';
import { canonicalEventSchema } from './canonical-event';

/**
 * Turns an event written at schema version N into one at version N + 1. It receives the raw record
 * (an object read from JSON or a database row) and returns a new one; it never mutates its input.
 */
export type EventUpcaster = (record: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** Upcasters by the version they read: the entry under `1` turns a version 1 record into version 2. */
export type EventUpcasters = Readonly<Record<number, EventUpcaster>>;

/**
 * The upcasters of this engine. Version 1 is the only schema that has existed, so there are none; the
 * first schema change adds the entry that reads the previous version, and the golden tests keep the
 * bytes of every generated run unchanged.
 */
export const EVENT_UPCASTERS: EventUpcasters = {};

/** A record whose schema version this engine cannot read, with a message that names both versions. */
export class EventVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventVersionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Brings a raw event record to `target` (the engine's schema version unless a test says otherwise) by
 * applying one upcaster per version step. A value that is not an object, or has no integer
 * `schemaVersion`, is returned unchanged for the event schema to describe. A newer version than the
 * engine reads, and a version with no upcaster, are errors that name the versions involved.
 */
export function upcastEventRecord(
  record: unknown,
  upcasters: EventUpcasters = EVENT_UPCASTERS,
  target: number = EVENT_SCHEMA_VERSION,
): unknown {
  if (!isRecord(record) || !Number.isInteger(record.schemaVersion)) {
    return record;
  }
  let current: Record<string, unknown> = record;
  let version = record.schemaVersion as number;
  if (version > target) {
    throw new EventVersionError(
      `schemaVersion ${version} is newer than the version this engine reads (${target}); upgrade DataForge to read this event`,
    );
  }
  while (version < target) {
    const upcast = upcasters[version];
    if (upcast === undefined) {
      throw new EventVersionError(
        `schemaVersion ${version} is older than the version this engine reads (${target}), and no upcaster reads version ${version}`,
      );
    }
    current = upcast(current);
    if (current.schemaVersion !== version + 1) {
      throw new EventVersionError(`the upcaster of schemaVersion ${version} must return schemaVersion ${version + 1}, not ${String(current.schemaVersion)}`);
    }
    version += 1;
  }
  return current;
}

/** The canonical event schema, preceded by the upcasting of older records: what every reader of stored events uses. */
export const versionedEventSchema = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return upcastEventRecord(value);
    } catch (error) {
      if (error instanceof EventVersionError) {
        ctx.addIssue({ code: 'custom', message: error.message, path: ['schemaVersion'] });
        return z.NEVER;
      }
      throw error;
    }
  })
  .pipe(canonicalEventSchema);

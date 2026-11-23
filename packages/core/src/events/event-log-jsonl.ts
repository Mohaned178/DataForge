import { canonicalJson } from '../serialization/canonical-json';
import { canonicalEventSchema, type CanonicalEvent } from './canonical-event';
import { EVENT_UPCASTERS, EventVersionError, upcastEventRecord, type EventUpcasters } from './upcast';

export const BYTE_ORDER_MARK_CODE = 0xfeff;

/** Removes a leading UTF-8 byte order mark, which Windows tools such as PowerShell 5 add. */
export function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === BYTE_ORDER_MARK_CODE ? text.slice(1) : text;
}

export class EventLogParseError extends Error {
  constructor(
    readonly lineNumber: number,
    detail: string,
  ) {
    super(`events.jsonl line ${lineNumber}: ${detail}`);
    this.name = 'EventLogParseError';
  }
}

/** One canonical-JSON event per line, "\n" line endings, trailing newline, UTF-8 without BOM. */
export function serializeEventLog(events: readonly CanonicalEvent[]): string {
  return events.map((event) => `${canonicalJson(event)}\n`).join('');
}

/**
 * Parses and schema-validates a JSONL event log. A UTF-8 BOM and CRLF line endings are tolerated
 * on input; blank lines in the middle of the file are not. Events written at an older schema version
 * are upcast to the current one (see upcast.ts); a newer version is refused with both versions named.
 */
export function parseEventLog(text: string, upcasters: EventUpcasters = EVENT_UPCASTERS): CanonicalEvent[] {
  const body = stripByteOrderMark(text);
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') {
      throw new EventLogParseError(lineNumber, 'blank line');
    }
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new EventLogParseError(lineNumber, `invalid JSON (${(error as Error).message})`);
    }
    let upcast: unknown;
    try {
      upcast = upcastEventRecord(json, upcasters);
    } catch (error) {
      if (error instanceof EventVersionError) {
        throw new EventLogParseError(lineNumber, `schemaVersion: ${error.message}`);
      }
      throw error;
    }
    const result = canonicalEventSchema.safeParse(upcast);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue === undefined || issue.path.length === 0 ? '(event)' : issue.path.map(String).join('.');
      throw new EventLogParseError(lineNumber, `${path}: ${issue?.message ?? 'invalid event'}`);
    }
    return result.data;
  });
}

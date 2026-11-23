import { parseScenario, serializeEventLog, simulate, type CanonicalEvent } from '@dataforge/core';
import { chunkEventColumns, fromEventRow, toEventColumns, type EventColumns, type StoredEventRow } from '../src/runs/event-rows';
import { RunIntegrityError } from '../src/runs/run-integrity';
import { generateRun } from '../src/runs/run-generation';

const scenario = parseScenario({ formatVersion: 1, name: 'rows', customers: { count: 10 }, orders: { count: 30 }, catalog: { productCount: 8 } });
const { events } = simulate({ scenario, seed: 'rows' });

/** What the database returns for the columns written by the unnest insert: bigint times, parsed JSONB. */
function rowsFrom(columns: EventColumns): StoredEventRow[] {
  return columns.sequences.map((sequence, index) => ({
    sequence,
    eventId: columns.eventIds[index] ?? '',
    type: columns.types[index] ?? '',
    aggregateType: columns.aggregateTypes[index] ?? '',
    aggregateId: columns.aggregateIds[index] ?? '',
    aggregateVersion: columns.aggregateVersions[index] ?? 0,
    eventTimeMs: BigInt(columns.eventTimesMs[index] ?? 0),
    schemaVersion: columns.schemaVersions[index] ?? 0,
    payload: JSON.parse(columns.payloads[index] ?? 'null') as unknown,
  }));
}

describe('canonical event rows', () => {
  it('round-trip: the rebuilt log has exactly the bytes of the generated one', () => {
    const rows = rowsFrom(toEventColumns(events));
    const rebuilt: CanonicalEvent[] = rows.map((row) => fromEventRow(row, 'run'));
    expect(serializeEventLog(rebuilt)).toBe(serializeEventLog(events));
  });

  it('chunks columns without losing or reordering an event', () => {
    const columns = toEventColumns(events);
    const chunks = chunkEventColumns(columns, 7);
    expect(chunks.map((chunk) => chunk.sequences.length)).toEqual([...Array<number>(Math.floor(events.length / 7)).fill(7), events.length % 7].filter((size) => size > 0));
    expect(chunks.flatMap((chunk) => chunk.eventIds)).toEqual(columns.eventIds);
    expect(chunks.flatMap((chunk) => chunk.payloads)).toEqual(columns.payloads);
  });

  it('refuses a row that is no longer a canonical event, naming its sequence and the field', () => {
    const [row] = rowsFrom(toEventColumns(events));
    if (row === undefined) {
      throw new Error('no events');
    }
    expect(() => fromEventRow({ ...row, type: 'ProductDeleted' }, 'run-1')).toThrow(RunIntegrityError);
    expect(() => fromEventRow({ ...row, payload: { ...(row.payload as object), unexpected: 1 } }, 'run-1')).toThrow(
      /Stored event 1 of run run-1 is not a valid canonical event: payload: Unrecognized key: "unexpected"/,
    );
  });

  it('refuses a row stored at a schema version this engine cannot read, naming both versions', () => {
    const [row] = rowsFrom(toEventColumns(events));
    if (row === undefined) {
      throw new Error('no events');
    }
    expect(() => fromEventRow({ ...row, schemaVersion: 2 }, 'run-1')).toThrow(
      /Stored event 1 of run run-1 is not a valid canonical event: schemaVersion: schemaVersion 2 is newer than the version this engine reads \(1\)/,
    );
  });
});

describe('generateRun', () => {
  it('builds the same files as the CLI for the stored definition and seed', () => {
    const generated = generateRun({ definition: scenario, scenarioHash: simulate({ scenario, seed: 1 }).scenarioHash, seed: 'rows' });
    expect(generated.files.contents['events.jsonl']).toBe(serializeEventLog(events));
    expect(generated.files.manifest.seed).toBe('rows');
  });

  it('refuses a stored definition that does not hash to its recorded version hash', () => {
    expect(() => generateRun({ definition: scenario, scenarioHash: 'sha256:0000', seed: 'rows' })).toThrow(/hashes to sha256:[0-9a-f]{64}, but its version records sha256:0000/);
  });
});

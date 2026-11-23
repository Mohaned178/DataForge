import {
  EVENT_SCHEMA_VERSION,
  EVENT_UPCASTERS,
  EventLogParseError,
  EventVersionError,
  parseEventLog,
  parseScenario,
  serializeEventLog,
  simulate,
  upcastEventRecord,
  versionedEventSchema,
  type EventUpcasters,
} from '../src';

const result = simulate({
  scenario: parseScenario({ formatVersion: 1, name: 'upcast', catalog: { productCount: 6 }, customers: { count: 6 }, orders: { count: 20 } }),
  seed: 'upcast',
});
const current = serializeEventLog(result.events);

/** A pretend schema version 0 that called the event time "occurredAtMs"; the upcaster renames it. */
const upcastersFromZero: EventUpcasters = {
  0: (record) => {
    const { occurredAtMs, ...rest } = record;
    return { ...rest, eventTimeMs: occurredAtMs, schemaVersion: 1 };
  },
};

function asVersionZero(line: string): string {
  const { eventTimeMs, ...rest } = JSON.parse(line) as Record<string, unknown>;
  return JSON.stringify({ ...rest, occurredAtMs: eventTimeMs, schemaVersion: 0 });
}

describe('event schema versioning and upcasting', () => {
  it('has no upcasters yet: schema version 1 is the only one that has existed', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
    expect(Object.keys(EVENT_UPCASTERS)).toEqual([]);
  });

  it('leaves current-version records untouched, byte for byte', () => {
    expect(serializeEventLog(parseEventLog(current))).toBe(current);
  });

  it('reads a log written at an older version through the registered upcaster, to the same events as today', () => {
    const oldLog = current
      .split('\n')
      .filter((line) => line !== '')
      .map(asVersionZero)
      .join('\n');
    expect(parseEventLog(oldLog, upcastersFromZero)).toEqual(parseEventLog(current));
    expect(serializeEventLog(parseEventLog(oldLog, upcastersFromZero))).toBe(current);
  });

  it('reports an old version with no upcaster by naming both versions', () => {
    const line = asVersionZero(current.split('\n')[0] ?? '');
    expect(() => parseEventLog(line)).toThrow(EventLogParseError);
    expect(() => parseEventLog(line)).toThrow(/line 1: schemaVersion: schemaVersion 0 is older than the version this engine reads \(1\), and no upcaster reads version 0/);
  });

  it('refuses a newer version instead of guessing, naming both versions and the line', () => {
    const lines = current.split('\n');
    lines[2] = JSON.stringify({ ...(JSON.parse(lines[2] ?? '') as object), schemaVersion: 2 });
    expect(() => parseEventLog(lines.join('\n'))).toThrow(
      /line 3: schemaVersion: schemaVersion 2 is newer than the version this engine reads \(1\); upgrade DataForge/,
    );
  });

  it('chains one upcaster per version step and checks that each returns the next version', () => {
    const chain: EventUpcasters = {
      1: (record) => ({ ...record, schemaVersion: 2, step1: true }),
      2: (record) => ({ ...record, schemaVersion: 3, step2: true }),
    };
    expect(upcastEventRecord({ schemaVersion: 1 }, chain, 3)).toEqual({ schemaVersion: 3, step1: true, step2: true });
    const broken: EventUpcasters = { 1: (record) => ({ ...record, schemaVersion: 5 }) };
    expect(() => upcastEventRecord({ schemaVersion: 1 }, broken, 2)).toThrow(/must return schemaVersion 2, not 5/);
  });

  it('does not mutate the record it upcasts', () => {
    const original = Object.freeze({ schemaVersion: 1, name: 'x' });
    const upcasters: EventUpcasters = { 1: (record) => ({ ...record, schemaVersion: 2 }) };
    expect(upcastEventRecord(original, upcasters, 2)).toEqual({ schemaVersion: 2, name: 'x' });
    expect(original).toEqual({ schemaVersion: 1, name: 'x' });
  });

  it.each([null, 'text', 42, [], {}, { schemaVersion: 'one' }, { schemaVersion: 1.5 }])(
    'leaves %j for the event schema to describe',
    (value) => {
      expect(upcastEventRecord(value)).toBe(value);
    },
  );

  it('versionedEventSchema accepts a current event and reports an unsupported version as an issue on schemaVersion', () => {
    const [first] = result.events;
    expect(versionedEventSchema.safeParse(first).success).toBe(true);
    const parsed = versionedEventSchema.safeParse({ ...first, schemaVersion: 7 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['schemaVersion']);
      expect(parsed.error.issues[0]?.message).toMatch(/schemaVersion 7 is newer than the version this engine reads \(1\)/);
    }
    expect(new EventVersionError('x').name).toBe('EventVersionError');
  });
});

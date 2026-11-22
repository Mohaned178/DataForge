import {
  BYTE_ORDER_MARK_CODE,
  EventLogParseError,
  parseEventLog,
  parseScenario,
  replayCanonicalLog,
  serializeEventLog,
  serializeExpectedState,
  simulate,
} from '../src';

const result = simulate({
  scenario: parseScenario({ formatVersion: 1, name: 'jsonl', catalog: { productCount: 8 }, customers: { count: 10 }, orders: { count: 40 } }),
  seed: 'jsonl',
});
const jsonl = serializeEventLog(result.events);

describe('canonical event log (JSONL)', () => {
  it('writes one event per line with LF endings, a trailing newline and no BOM', () => {
    expect(jsonl.charCodeAt(0)).not.toBe(BYTE_ORDER_MARK_CODE);
    expect(jsonl.includes('\r')).toBe(false);
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(jsonl.split('\n')).toHaveLength(result.events.length + 1);
  });

  it('round-trips: parse(serialize(events)) reproduces the same bytes', () => {
    expect(serializeEventLog(parseEventLog(jsonl))).toBe(jsonl);
  });

  it('derives exactly the same expected state when replayed from the file', () => {
    const replayed = replayCanonicalLog(parseEventLog(jsonl)).expectedState;
    expect(serializeExpectedState(replayed)).toBe(serializeExpectedState(result.expectedState));
  });

  it('tolerates a BOM and CRLF line endings written by Windows editors', () => {
    const windowsStyle = String.fromCharCode(BYTE_ORDER_MARK_CODE) + jsonl.replaceAll('\n', '\r\n');
    expect(parseEventLog(windowsStyle)).toEqual(parseEventLog(jsonl));
  });

  it('reports the line number of invalid JSON', () => {
    const lines = jsonl.split('\n');
    lines[2] = '{"not json"';
    expect(() => parseEventLog(lines.join('\n'))).toThrow(EventLogParseError);
    expect(() => parseEventLog(lines.join('\n'))).toThrow(/line 3: invalid JSON/);
  });

  it('rejects unknown event types, unknown fields and unsupported schema versions', () => {
    const first = JSON.parse(jsonl.split('\n')[0]!) as Record<string, unknown>;
    const variants = [
      { ...first, type: 'ProductDiscontinued' },
      { ...first, unexpected: true },
      { ...first, schemaVersion: 2 },
      { ...first, eventTimeMs: 1.5 },
    ];
    for (const variant of variants) {
      expect(() => parseEventLog(`${JSON.stringify(variant)}\n`)).toThrow(/line 1:/);
    }
  });

  it('rejects blank lines inside the log', () => {
    const lines = jsonl.split('\n');
    lines.splice(5, 0, '');
    expect(() => parseEventLog(lines.join('\n'))).toThrow(/line 6: blank line/);
  });
});

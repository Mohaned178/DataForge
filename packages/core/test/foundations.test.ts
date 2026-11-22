import { canonicalJson, compareCodeUnits, normalizeSeed, normalizeUtcInstant, parseUtcInstant, simTimeToIso } from '../src';

describe('canonicalJson', () => {
  it('serializes objects identically regardless of property insertion order', () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'text' } };
    const b = { a: { c: 'text', d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"text","d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it('keeps array order, because array order is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined properties like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses values that have no stable JSON form', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson({ value: new Map() })).toThrow(TypeError);
    expect(() => canonicalJson({ value: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
  });

  it('compareCodeUnits() is a total order independent of locale', () => {
    const values = ['b', 'B', 'a', 'é', 'e', 'A', 'ord_000010', 'ord_000002'];
    expect([...values].sort(compareCodeUnits)).toEqual(['A', 'B', 'a', 'b', 'e', 'ord_000002', 'ord_000010', 'é']);
  });
});

describe('simulation time', () => {
  it('parses UTC instants with or without milliseconds', () => {
    expect(parseUtcInstant('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1));
    expect(parseUtcInstant('2026-01-01T00:00:00.250Z')).toBe(Date.UTC(2026, 0, 1) + 250);
    expect(normalizeUtcInstant('2026-03-04T05:06:07Z')).toBe('2026-03-04T05:06:07.000Z');
  });

  it('rejects local times, offsets, partial values and impossible dates', () => {
    for (const invalid of ['2026-01-01T00:00:00', '2026-01-01T02:00:00+02:00', '2026-01-01', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z']) {
      expect(() => parseUtcInstant(invalid)).toThrow(RangeError);
    }
  });

  it('converts simulation time to an absolute UTC timestamp', () => {
    const epoch = parseUtcInstant('2026-01-01T00:00:00Z');
    expect(simTimeToIso(epoch, 0)).toBe('2026-01-01T00:00:00.000Z');
    expect(simTimeToIso(epoch, 36 * 3_600_000 + 1)).toBe('2026-01-02T12:00:00.001Z');
  });
});

describe('seeds', () => {
  it('treats numeric and string seeds with the same digits as the same seed', () => {
    expect(normalizeSeed(42)).toBe('42');
    expect(normalizeSeed('42')).toBe('42');
    expect(normalizeSeed('checkout-bug:repro.1')).toBe('checkout-bug:repro.1');
  });

  it('rejects empty, oversized, fractional and unusual seeds', () => {
    for (const invalid of ['', 'has space', 'a'.repeat(129), 'semi;colon', 1.5]) {
      expect(() => normalizeSeed(invalid)).toThrow(/Invalid seed/);
    }
  });
});

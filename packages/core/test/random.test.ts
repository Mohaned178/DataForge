import { createHash } from 'node:crypto';
import { RandomStream, Xoshiro128StarStar, deriveStreamState } from '../src';

describe('xoshiro128**', () => {
  it('matches the reference algorithm for state [1, 2, 3, 4]', () => {
    // Computed by hand from the reference C implementation (prng.di.unimi.it/xoshiro128starstar.c).
    const generator = new Xoshiro128StarStar([1, 2, 3, 4]);
    expect([generator.nextUint32(), generator.nextUint32(), generator.nextUint32(), generator.nextUint32()]).toEqual([
      11520, 0, 5927040, 70819200,
    ]);
  });

  it('rejects the all-zero state, which would only ever produce zeros', () => {
    expect(() => new Xoshiro128StarStar([0, 0, 0, 0])).toThrow(RangeError);
  });

  it('produces unsigned 32-bit integers', () => {
    const generator = new Xoshiro128StarStar([0xffffffff, 0x12345678, 0x9abcdef0, 1]);
    for (let i = 0; i < 10_000; i++) {
      const value = generator.nextUint32();
      expect(Number.isInteger(value) && value >= 0 && value <= 0xffffffff).toBe(true);
    }
  });
});

describe('stream derivation', () => {
  it('seeds a stream from the first 128 bits of SHA-256(domain, seed, purpose, key)', () => {
    const digest = createHash('sha256').update('dataforge/random-stream/v1\u000042\u0000order.lifecycle\u00007').digest();
    expect(deriveStreamState('42', 'order.lifecycle', '7')).toEqual([
      digest.readUInt32BE(0),
      digest.readUInt32BE(4),
      digest.readUInt32BE(8),
      digest.readUInt32BE(12),
    ]);
  });

  it('gives the same sequence for the same (seed, purpose, key)', () => {
    const a = RandomStream.derive('seed-a', 'customer.profile', '1');
    const b = RandomStream.derive('seed-a', 'customer.profile', '1');
    expect(Array.from({ length: 100 }, () => a.uint32())).toEqual(Array.from({ length: 100 }, () => b.uint32()));
  });

  it('gives unrelated sequences when the seed, purpose or key changes', () => {
    const first = (seed: string, purpose: string, key: string) => RandomStream.derive(seed, purpose, key).uint32();
    const base = first('seed-a', 'customer.profile', '1');
    expect(first('seed-b', 'customer.profile', '1')).not.toBe(base);
    expect(first('seed-a', 'order.lines', '1')).not.toBe(base);
    expect(first('seed-a', 'customer.profile', '2')).not.toBe(base);
  });

  it('does not let drawing from one stream affect another', () => {
    const untouched = RandomStream.derive('s', 'p', 'b').uint32();
    const busy = RandomStream.derive('s', 'p', 'a');
    for (let i = 0; i < 1_000; i++) {
      busy.uint32();
    }
    expect(RandomStream.derive('s', 'p', 'b').uint32()).toBe(untouched);
  });

  it('rejects NUL characters, which would make derivation keys ambiguous', () => {
    expect(() => deriveStreamState('a\u0000b', 'p', 'k')).toThrow(RangeError);
  });
});

describe('RandomStream', () => {
  const stream = () => RandomStream.derive('unit-test', 'random', 'stream');

  it('int() stays within inclusive bounds and reaches both ends', () => {
    const random = stream();
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const value = random.int(-3, 3);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThanOrEqual(3);
      seen.add(value);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it('int() is uniform: chi-square over 10 buckets stays below the 99.9% critical value', () => {
    const random = stream();
    const buckets = new Array<number>(10).fill(0);
    const draws = 100_000;
    for (let i = 0; i < draws; i++) {
      buckets[random.int(0, 9)]! += 1;
    }
    const expected = draws / 10;
    const chiSquare = buckets.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
    expect(chiSquare).toBeLessThan(27.88);
  });

  it('int() supports ranges wider than 2^32 (long simulation windows)', () => {
    const random = stream();
    const max = 366 * 24 * 3_600_000;
    let sawAbove32Bits = false;
    for (let i = 0; i < 1_000; i++) {
      const value = random.int(0, max);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(max);
      sawAbove32Bits ||= value > 0xffffffff;
    }
    expect(sawAbove32Bits).toBe(true);
  });

  it('int() handles a single-value range and rejects invalid ranges', () => {
    expect(stream().int(5, 5)).toBe(5);
    expect(() => stream().int(2, 1)).toThrow(RangeError);
    expect(() => stream().int(0.5, 2)).toThrow(RangeError);
    expect(() => stream().int(0, 2 ** 54)).toThrow(RangeError);
  });

  it('float() is in [0, 1)', () => {
    const random = stream();
    for (let i = 0; i < 10_000; i++) {
      const value = random.float();
      expect(value >= 0 && value < 1).toBe(true);
    }
  });

  it('chance() never fires at 0, always fires at 1, and tracks the probability in between', () => {
    const random = stream();
    let hits = 0;
    for (let i = 0; i < 10_000; i++) {
      expect(random.chance(0)).toBe(false);
      expect(random.chance(1)).toBe(true);
      hits += random.chance(0.25) ? 1 : 0;
    }
    expect(hits / 10_000).toBeCloseTo(0.25, 1);
    expect(() => random.chance(1.5)).toThrow(RangeError);
    expect(() => random.chance(Number.NaN)).toThrow(RangeError);
  });

  it('weightedPick() follows the weights', () => {
    const random = stream();
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 20_000; i++) {
      counts[random.weightedPick([{ value: 'a' as const, weight: 3 }, { value: 'b' as const, weight: 1 }])] += 1;
    }
    expect(counts.a / 20_000).toBeCloseTo(0.75, 1);
    expect(() => random.weightedPick([{ value: 'x', weight: 0 }])).toThrow(RangeError);
    expect(() => random.weightedPick([])).toThrow(RangeError);
  });

  it('sampleDistinctIndices() returns distinct, sorted, in-range indices', () => {
    const random = stream();
    for (let i = 0; i < 500; i++) {
      const sample = random.sampleDistinctIndices(12, 4);
      expect(sample).toHaveLength(4);
      expect(new Set(sample).size).toBe(4);
      expect([...sample].sort((a, b) => a - b)).toEqual(sample);
      expect(sample.every((index) => index >= 0 && index < 12)).toBe(true);
    }
    expect(random.sampleDistinctIndices(5, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(random.sampleDistinctIndices(5, 0)).toEqual([]);
    expect(() => random.sampleDistinctIndices(3, 4)).toThrow(RangeError);
  });
});

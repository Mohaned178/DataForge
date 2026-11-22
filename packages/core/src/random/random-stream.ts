import { sha256Bytes } from '../hashing';
import { Xoshiro128StarStar, type Xoshiro128State } from './xoshiro128';

const TWO_POW_32 = 0x1_0000_0000;
const TWO_POW_53 = 2 ** 53;
const STREAM_DERIVATION_DOMAIN = 'dataforge/random-stream/v1';
const SEPARATOR = '\u0000';

export interface WeightedChoice<T> {
  readonly value: T;
  readonly weight: number;
}

export interface IntRange {
  readonly min: number;
  readonly max: number;
}

/**
 * A deterministic source of randomness for exactly one purpose and one entity.
 *
 * Streams are derived from (seed, purpose, key) with SHA-256, so the values drawn for one entity
 * never depend on how many values were drawn for any other entity or in what order entities were
 * generated.
 */
export class RandomStream {
  private constructor(private readonly generator: Xoshiro128StarStar) {}

  static derive(seed: string, purpose: string, key: string): RandomStream {
    return new RandomStream(new Xoshiro128StarStar(deriveStreamState(seed, purpose, key)));
  }

  static fromState(state: Xoshiro128State): RandomStream {
    return new RandomStream(new Xoshiro128StarStar(state));
  }

  uint32(): number {
    return this.generator.nextUint32();
  }

  /** Uniform integer in [0, 2^53). */
  uint53(): number {
    const high21 = this.generator.nextUint32() >>> 11;
    const low32 = this.generator.nextUint32();
    return high21 * TWO_POW_32 + low32;
  }

  /** Uniform float in [0, 1) with 53 bits of precision, computed exactly from integers. */
  float(): number {
    return this.uint53() / TWO_POW_53;
  }

  /** Uniform integer in [min, max], both inclusive, without modulo bias. */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      throw new RangeError(`int() bounds must be safe integers, got [${min}, ${max}]`);
    }
    if (min > max) {
      throw new RangeError(`int() requires min <= max, got [${min}, ${max}]`);
    }
    const range = max - min + 1;
    if (range <= TWO_POW_32) {
      const limit = TWO_POW_32 - (TWO_POW_32 % range);
      let draw = this.uint32();
      while (draw >= limit) {
        draw = this.uint32();
      }
      return min + (draw % range);
    }
    if (range > TWO_POW_53) {
      throw new RangeError(`int() range is larger than 2^53: [${min}, ${max}]`);
    }
    const limit = TWO_POW_53 - (TWO_POW_53 % range);
    let draw = this.uint53();
    while (draw >= limit) {
      draw = this.uint53();
    }
    return min + (draw % range);
  }

  intInRange(range: IntRange): number {
    return this.int(range.min, range.max);
  }

  /** Returns true with the given probability. chance(0) is never true; chance(1) is always true. */
  chance(probability: number): boolean {
    if (!(probability >= 0 && probability <= 1)) {
      throw new RangeError(`chance() probability must be within [0, 1], got ${probability}`);
    }
    return this.float() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('pick() requires a non-empty array');
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Picks a value with probability proportional to its positive integer weight. */
  weightedPick<T>(choices: readonly WeightedChoice<T>[]): T {
    let total = 0;
    for (const choice of choices) {
      if (!Number.isSafeInteger(choice.weight) || choice.weight <= 0) {
        throw new RangeError(`weightedPick() weights must be positive integers, got ${choice.weight}`);
      }
      total += choice.weight;
    }
    if (total === 0) {
      throw new RangeError('weightedPick() requires at least one choice');
    }
    let target = this.int(0, total - 1);
    for (const choice of choices) {
      if (target < choice.weight) {
        return choice.value;
      }
      target -= choice.weight;
    }
    throw new Error('weightedPick() is unreachable when weights are valid');
  }

  /** Returns `count` distinct integers from [0, populationSize), sorted ascending (Floyd's algorithm). */
  sampleDistinctIndices(populationSize: number, count: number): number[] {
    if (!Number.isSafeInteger(populationSize) || !Number.isSafeInteger(count) || count < 0 || count > populationSize) {
      throw new RangeError(`sampleDistinctIndices() requires 0 <= count <= populationSize, got ${count} of ${populationSize}`);
    }
    const selected = new Set<number>();
    for (let candidate = populationSize - count; candidate < populationSize; candidate++) {
      const draw = this.int(0, candidate);
      selected.add(selected.has(draw) ? candidate : draw);
    }
    return [...selected].sort((a, b) => a - b);
  }
}

export function deriveStreamState(seed: string, purpose: string, key: string): Xoshiro128State {
  for (const [name, value] of [['seed', seed], ['purpose', purpose], ['key', key]] as const) {
    if (value.includes(SEPARATOR)) {
      throw new RangeError(`Random stream ${name} must not contain NUL characters`);
    }
  }
  const digest = sha256Bytes([STREAM_DERIVATION_DOMAIN, seed, purpose, key].join(SEPARATOR));
  const state: [number, number, number, number] = [
    digest.readUInt32BE(0),
    digest.readUInt32BE(4),
    digest.readUInt32BE(8),
    digest.readUInt32BE(12),
  ];
  if ((state[0] | state[1] | state[2] | state[3]) === 0) {
    state[0] = 1;
  }
  return state;
}

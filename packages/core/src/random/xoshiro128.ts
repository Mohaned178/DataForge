export type Xoshiro128State = readonly [number, number, number, number];

/**
 * xoshiro128** 1.1 (Blackman & Vigna). 128-bit state, 32-bit output, period 2^128 - 1.
 * Uses only 32-bit integer operations, so results are identical on every JavaScript engine.
 */
export class Xoshiro128StarStar {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: Xoshiro128State) {
    const [a, b, c, d] = state;
    for (const word of state) {
      if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
        throw new RangeError(`xoshiro128** state words must be unsigned 32-bit integers, got ${word}`);
      }
    }
    if ((a | b | c | d) === 0) {
      throw new RangeError('xoshiro128** state must not be all zero');
    }
    this.s0 = a | 0;
    this.s1 = b | 0;
    this.s2 = c | 0;
    this.s3 = d | 0;
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

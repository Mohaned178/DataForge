const SEED_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class InvalidSeedError extends Error {
  constructor(seed: string) {
    super(`Invalid seed "${seed}": use 1-128 characters from A-Z, a-z, 0-9, ".", "_", ":" and "-"`);
    this.name = 'InvalidSeedError';
  }
}

/** Seeds are opaque strings, so "42" and 42 name the same simulation. */
export function normalizeSeed(seed: string | number): string {
  const text = typeof seed === 'number' ? String(seed) : seed;
  if (typeof seed === 'number' && !Number.isSafeInteger(seed)) {
    throw new InvalidSeedError(text);
  }
  if (!SEED_PATTERN.test(text)) {
    throw new InvalidSeedError(text);
  }
  return text;
}

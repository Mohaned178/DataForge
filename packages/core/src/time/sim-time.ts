export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?Z$/;

/**
 * Parses a UTC ISO-8601 instant ("2026-01-01T00:00:00Z" or "...00.000Z") into Unix milliseconds.
 * Offsets other than "Z", missing seconds, and impossible dates such as February 30 are rejected.
 */
export function parseUtcInstant(iso: string): number {
  const match = ISO_UTC_PATTERN.exec(iso);
  if (match === null) {
    throw new RangeError(`Expected a UTC instant like 2026-01-01T00:00:00.000Z, got "${iso}"`);
  }
  const normalized = match[7] === undefined ? `${iso.slice(0, -1)}.000Z` : iso;
  const unixMs = Date.parse(normalized);
  if (Number.isNaN(unixMs) || new Date(unixMs).toISOString() !== normalized) {
    throw new RangeError(`"${iso}" is not a valid calendar instant`);
  }
  return unixMs;
}

/** Canonical form of a UTC instant: always millisecond precision with a "Z" suffix. */
export function normalizeUtcInstant(iso: string): string {
  return new Date(parseUtcInstant(iso)).toISOString();
}

/** Converts simulation time (ms since the scenario epoch) into an absolute UTC ISO-8601 string. */
export function simTimeToIso(epochUnixMs: number, simTimeMs: number): string {
  return new Date(epochUnixMs + simTimeMs).toISOString();
}

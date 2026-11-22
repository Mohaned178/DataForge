import { z } from 'zod';
import { DAY_MS, MINUTE_MS, SECOND_MS, canonicalJson, sha256Hex } from '@dataforge/core';

export const CHAOS_PROFILE_FORMAT_VERSION = 1;

export const CHAOS_PROFILE_LIMITS = {
  maxDelayMs: 30 * DAY_MS,
  maxReorderDistance: 50,
  maxDuplicateCopies: 10,
  maxFailures: 20,
  maxRetries: 20,
} as const;

export const FAULT_TYPES = ['delay', 'reorder', 'duplicate', 'transientFailure'] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

function boundedInt(min: number, max: number) {
  return z.number().int().min(min).max(max);
}

function intRange(min: number, max: number, defaults: { min: number; max: number }) {
  return z
    .strictObject({ min: boundedInt(min, max), max: boundedInt(min, max) })
    .refine((range) => range.min <= range.max, { error: '"min" must be less than or equal to "max"', path: ['max'] })
    .prefault(defaults);
}

const rate = z.number().min(0).max(1).default(0);

export const chaosProfileSchema = z
  .strictObject({
    formatVersion: z.literal(CHAOS_PROFILE_FORMAT_VERSION, {
      error: `formatVersion must be ${CHAOS_PROFILE_FORMAT_VERSION}`,
    }),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1_000).optional(),
    faults: z
      .strictObject({
        delay: z
          .strictObject({
            rate,
            delayMs: intRange(1, CHAOS_PROFILE_LIMITS.maxDelayMs, { min: SECOND_MS, max: 5 * MINUTE_MS }),
          })
          .prefault({}),
        reorder: z
          .strictObject({
            rate,
            distance: intRange(1, CHAOS_PROFILE_LIMITS.maxReorderDistance, { min: 1, max: 1 }),
          })
          .prefault({}),
        duplicate: z
          .strictObject({
            rate,
            copies: intRange(1, CHAOS_PROFILE_LIMITS.maxDuplicateCopies, { min: 1, max: 1 }),
            redeliveryOffsetMs: intRange(0, CHAOS_PROFILE_LIMITS.maxDelayMs, { min: 0, max: MINUTE_MS }),
          })
          .prefault({}),
        transientFailure: z
          .strictObject({
            rate,
            failures: intRange(1, CHAOS_PROFILE_LIMITS.maxFailures, { min: 1, max: 1 }),
            maxRetries: boundedInt(0, CHAOS_PROFILE_LIMITS.maxRetries).default(3),
            retryBackoffMs: intRange(1, CHAOS_PROFILE_LIMITS.maxDelayMs, { min: SECOND_MS, max: 30 * SECOND_MS }),
            allowLoss: z.boolean().default(false),
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .superRefine((profile, ctx) => {
    const failure = profile.faults.transientFailure;
    if (failure.rate > 0 && !failure.allowLoss && failure.failures.max > failure.maxRetries) {
      ctx.addIssue({
        code: 'custom',
        path: ['faults', 'transientFailure', 'failures', 'max'],
        message:
          `cannot exceed maxRetries (${failure.maxRetries}) unless allowLoss is true: ` +
          `an event that fails more often than it is retried is lost`,
      });
    }
  });

export type ChaosProfileInput = z.input<typeof chaosProfileSchema>;
export type ChaosProfile = z.output<typeof chaosProfileSchema>;

export class ChaosProfileValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid chaos profile:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ChaosProfileValidationError';
  }
}

/** Validates a chaos profile document and fills in defaults. Every fault type is off unless its rate is above 0. */
export function parseChaosProfile(input: unknown): ChaosProfile {
  const result = chaosProfileSchema.safeParse(input);
  if (!result.success) {
    throw new ChaosProfileValidationError(result.error.issues.map(formatIssue));
  }
  return result.data;
}

/** Fingerprint of a resolved profile. Two documents that resolve to the same settings share a hash. */
export function chaosProfileHash(profile: ChaosProfile): string {
  return `sha256:${sha256Hex(canonicalJson(profile))}`;
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
  return `${path}: ${issue.message}`;
}

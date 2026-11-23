import { EVENT_TYPES, normalizeSeed } from '@dataforge/core';
import { z } from 'zod';

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type RunStatusName = (typeof RUN_STATUSES)[number];

const seedSchema = z.union([z.string(), z.number()], { error: 'must be a string or a whole number' }).transform((seed, ctx) => {
  try {
    return normalizeSeed(seed);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

/** POST /runs. The version defaults to the scenario's latest; the seed follows the CLI's rules (42 and "42" are one seed). */
export const startRunSchema = z.strictObject({
  scenarioId: z.uuid({ error: 'must be a scenario id (a UUID)' }),
  version: z.number().int().min(1).optional(),
  seed: seedSchema,
});
export type StartRunRequest = z.output<typeof startRunSchema>;

const queryInt = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

/** GET /runs: newest first. */
export const listRunsQuerySchema = z.strictObject({
  scenarioId: z.uuid({ error: 'must be a scenario id (a UUID)' }).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: queryInt(1, 200, 50),
  offset: queryInt(0, Number.MAX_SAFE_INTEGER, 0),
});
export type ListRunsQuery = z.output<typeof listRunsQuerySchema>;

/** GET /runs/:id/events: a page of stored events in sequence order, from fromSequence on. */
export const runEventsQuerySchema = z.strictObject({
  type: z.enum(EVENT_TYPES).optional(),
  aggregateId: z.string().min(1).optional(),
  fromSequence: queryInt(1, Number.MAX_SAFE_INTEGER, 1),
  limit: queryInt(1, 1_000, 100),
});
export type RunEventsQuery = z.output<typeof runEventsQuerySchema>;

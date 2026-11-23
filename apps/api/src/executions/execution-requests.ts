import { ATTEMPT_KINDS, FAULT_TYPES, PLANNED_OUTCOMES } from '@dataforge/chaos';
import { ENTITY_TYPES } from '@dataforge/core';
import { REFERENCE_TARGETS } from '@dataforge/targets';
import { FINDING_CATEGORIES, WINDOW_FINDING_CATEGORIES } from '@dataforge/validation';
import { z } from 'zod';
import { seedSchema } from '../runs/run-requests';

export const EXECUTION_STATUSES = ['queued', 'running', 'awaiting_actual_state', 'completed', 'failed'] as const;
export type ExecutionStatusName = (typeof EXECUTION_STATUSES)[number];
export const VERDICTS = ['PASS', 'FAIL'] as const;
export const TRANSPORTS = ['memory', 'kafka'] as const;

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_PARTITIONS = 64;

/** `max` (no waiting, order only) or simulated milliseconds per real millisecond, as `dataforge deliver --speed`. */
const speedSchema = z.union([z.literal('max'), z.number().positive().max(10_000_000_000)], {
  error: 'must be "max" or a positive number of simulated milliseconds per real millisecond',
});
const timeoutSchema = z.number().int().min(1).max(3600);

/** Kafka's own rules: 1-249 characters of letters, digits, ".", "_" and "-", and not "." or "..". */
const topicSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,249}$/, { error: 'must be a Kafka topic name: 1-249 letters, digits, ".", "_" or "-"' })
  .refine((topic) => topic !== '.' && topic !== '..', { error: 'must not be "." or ".."' });
const groupIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]*$/, { error: 'must be printable ASCII without spaces' });

const referenceTargetInput = z.strictObject({
  type: z.literal('reference'),
  name: z.enum(REFERENCE_TARGETS),
  transport: z.enum(TRANSPORTS).default('memory'),
  partitions: z.number().int().min(1).max(MAX_PARTITIONS).optional(),
  speed: speedSchema.optional(),
  timeoutSeconds: timeoutSchema.optional(),
});

const externalTargetInput = z.strictObject({
  type: z.literal('external'),
  topic: topicSchema,
  groupId: groupIdSchema,
  speed: speedSchema.optional(),
  timeoutSeconds: timeoutSchema.optional(),
});

/** The target of an execution, with every default filled in, as stored (test_execution.target). */
export const executionTargetSchema = z.union([
  z.strictObject({ type: z.literal('reference'), name: z.enum(REFERENCE_TARGETS), transport: z.literal('memory') }),
  z.strictObject({
    type: z.literal('reference'),
    name: z.enum(REFERENCE_TARGETS),
    transport: z.literal('kafka'),
    partitions: z.number().int().min(1).max(MAX_PARTITIONS),
    speed: speedSchema,
    timeoutSeconds: timeoutSchema,
  }),
  z.strictObject({ type: z.literal('external'), topic: topicSchema, groupId: groupIdSchema, speed: speedSchema, timeoutSeconds: timeoutSchema }),
]);
export type ExecutionTarget = z.output<typeof executionTargetSchema>;

const targetInput = z
  .discriminatedUnion('type', [referenceTargetInput, externalTargetInput], {
    error: 'must be {"type": "reference", "name": ...} or {"type": "external", "topic": ..., "groupId": ...}',
  })
  .superRefine((target, ctx) => {
    if (target.type === 'reference' && target.transport === 'memory') {
      for (const option of ['partitions', 'speed', 'timeoutSeconds'] as const) {
        if (target[option] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [option], message: 'applies only to "transport": "kafka"' });
        }
      }
    }
  })
  .transform((target): ExecutionTarget => {
    const kafka = { speed: target.speed ?? 'max', timeoutSeconds: target.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS };
    if (target.type === 'external') {
      return { type: 'external', topic: target.topic, groupId: target.groupId, ...kafka };
    }
    return target.transport === 'memory'
      ? { type: 'reference', name: target.name, transport: 'memory' }
      : { type: 'reference', name: target.name, transport: 'kafka', partitions: target.partitions ?? 1, ...kafka };
  });

/** POST /executions. The profile version defaults to the latest; the chaos seed follows the CLI's seed rules. */
export const startExecutionSchema = z.strictObject({
  runId: z.uuid({ error: 'must be a run id (a UUID)' }),
  chaosProfileId: z.uuid({ error: 'must be a chaos profile id (a UUID)' }),
  chaosProfileVersion: z.number().int().min(1).optional(),
  chaosSeed: seedSchema,
  target: targetInput,
});
export type StartExecutionRequest = z.output<typeof startExecutionSchema>;

/**
 * POST /executions/:id/actual-state: the files an external pipeline writes, as JSON values. They are
 * validated against the actual-state and actual-windows contracts by the service, which reports the
 * problems by path.
 */
export const submitActualStateSchema = z.strictObject({
  actualState: z.unknown().refine((value) => value !== undefined, { error: 'is required' }),
  actualWindows: z.unknown().optional(),
});
export type SubmitActualStateRequest = z.output<typeof submitActualStateSchema>;

const queryInt = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

/** GET /executions: newest first. */
export const listExecutionsQuerySchema = z.strictObject({
  runId: z.uuid({ error: 'must be a run id (a UUID)' }).optional(),
  chaosProfileId: z.uuid({ error: 'must be a chaos profile id (a UUID)' }).optional(),
  status: z.enum(EXECUTION_STATUSES).optional(),
  verdict: z.enum(VERDICTS).optional(),
  limit: queryInt(1, 200, 50),
  offset: queryInt(0, Number.MAX_SAFE_INTEGER, 0),
});
export type ListExecutionsQuery = z.output<typeof listExecutionsQuerySchema>;

/** GET /executions/:id/attempts: a page of the delivery plan in delivery order, from fromSequence on. */
export const attemptsQuerySchema = z.strictObject({
  eventId: z.string().min(1).optional(),
  aggregateId: z.string().min(1).optional(),
  kind: z.enum(ATTEMPT_KINDS).optional(),
  fault: z.enum(FAULT_TYPES).optional(),
  plannedOutcome: z.enum(PLANNED_OUTCOMES).optional(),
  fromSequence: queryInt(1, Number.MAX_SAFE_INTEGER, 1),
  limit: queryInt(1, 1_000, 100),
});
export type AttemptsQuery = z.output<typeof attemptsQuerySchema>;

/** GET /executions/:id/findings: in report order. */
export const findingsQuerySchema = z.strictObject({
  category: z.enum(FINDING_CATEGORIES).optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: z.string().min(1).optional(),
  limit: queryInt(1, 1_000, 100),
  offset: queryInt(0, Number.MAX_SAFE_INTEGER, 0),
});
export type FindingsQuery = z.output<typeof findingsQuerySchema>;

/** GET /executions/:id/window-findings: in report order. */
export const windowFindingsQuerySchema = z.strictObject({
  category: z.enum(WINDOW_FINDING_CATEGORIES).optional(),
  limit: queryInt(1, 1_000, 100),
  offset: queryInt(0, Number.MAX_SAFE_INTEGER, 0),
});
export type WindowFindingsQuery = z.output<typeof windowFindingsQuerySchema>;

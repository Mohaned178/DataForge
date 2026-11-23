import { z } from 'zod';

/*
 * What the pages read from the HTTP API, and nothing more. Objects are lenient on purpose: a field
 * the API adds is ignored, while a field the UI reads that disappears or changes type is reported
 * with its path (ResponseShapeError). The integration suite parses real responses with these
 * schemas, so they cannot drift from the API unnoticed. This file imports only Zod, so the Jest
 * integration run can load it too.
 */

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const EXECUTION_STATUSES = ['queued', 'running', 'awaiting_actual_state', 'completed', 'failed'] as const;
export const VERDICTS = ['PASS', 'FAIL'] as const;
export const FINDING_CATEGORIES = [
  'missing-entity',
  'unexpected-entity',
  'duplicate-record',
  'status-mismatch',
  'field-mismatch',
  'double-processing',
  'referential-integrity',
  'invariant-violation',
] as const;
export const WINDOW_FINDING_CATEGORIES = ['window-undercount', 'window-overcount', 'duplicate-window', 'misaligned-window'] as const;
export const ENTITY_TYPES = ['customer', 'product', 'order', 'payment', 'shipment'] as const;
export const FAULT_TYPES = ['delay', 'late', 'reorder', 'duplicate', 'transientFailure'] as const;

const timestamp = z.string();
const count = z.number();
const fileEntry = z.object({ sha256: z.string(), bytes: z.number() });
const files = z.record(z.string(), fileEntry);

// ---- runs ----------------------------------------------------------------------------------------

export const runSchema = z.object({
  id: z.string(),
  status: z.enum(RUN_STATUSES),
  scenario: z.object({ id: z.string(), name: z.string(), version: z.number(), scenarioHash: z.string() }),
  seed: z.string(),
  engineVersion: z.string(),
  requestedAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  error: z.string().nullable(),
  eventCount: count.nullable(),
  eventsByType: z.record(z.string(), count).nullable(),
  files: files.nullable(),
  summary: z
    .object({
      orders: count,
      payments: count,
      products: count,
      customers: count,
      shipments: count,
      revenueMinor: count,
      ordersByStatus: z.record(z.string(), count),
    })
    .nullable(),
});
export type Run = z.output<typeof runSchema>;

export const runListSchema = z.object({ runs: z.array(runSchema), total: count, limit: count, offset: count });
export type RunList = z.output<typeof runListSchema>;

export const canonicalEventSchema = z.object({
  eventId: z.string(),
  sequence: count,
  eventTimeMs: count,
  aggregateId: z.string(),
  aggregateVersion: count,
  type: z.string(),
  aggregateType: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type CanonicalEvent = z.output<typeof canonicalEventSchema>;

export const runEventsSchema = z.object({
  runId: z.string(),
  events: z.array(canonicalEventSchema),
  nextSequence: count.nullable(),
});
export type RunEvents = z.output<typeof runEventsSchema>;

// ---- executions ----------------------------------------------------------------------------------

const speed = z.union([z.literal('max'), z.number()]);

export const targetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reference'),
    name: z.enum(['correct', 'naive']),
    transport: z.enum(['memory', 'kafka']),
    partitions: count.optional(),
    speed: speed.optional(),
    timeoutSeconds: count.optional(),
  }),
  z.object({ type: z.literal('external'), topic: z.string(), groupId: z.string(), speed: speed.optional(), timeoutSeconds: count.optional() }),
]);
export type Target = z.output<typeof targetSchema>;

const faultStatistics = z.object({
  rate: z.number(),
  eligibleEvents: count,
  faultedEvents: count,
  extraDeliveries: count.optional(),
  failedAttempts: count.optional(),
  lostEvents: count.optional(),
});

export const deliverySummarySchema = z.object({
  events: count,
  attempts: count,
  attemptsByKind: z.object({ original: count, retry: count, duplicate: count }),
  attemptsByOutcome: z.object({ delivered: count, failed: count }),
  eventsDelivered: count,
  eventsLost: count,
  faults: z.record(z.string(), faultStatistics),
  ordering: z.object({ outOfOrderEvents: count, inversionPairs: count, aggregatesAffected: count }),
  lastScheduledDeliveryTimeMs: count,
  windowing: z
    .object({
      sizeMs: count,
      allowedLatenessMs: count,
      arrivals: z.object({ onTime: count, withinLateness: count, afterClose: count, lost: count }),
    })
    .optional(),
});
export type DeliverySummary = z.output<typeof deliverySummarySchema>;

const executionSummaryShape = {
  id: z.string(),
  status: z.enum(EXECUTION_STATUSES),
  verdict: z.enum(VERDICTS).nullable(),
  error: z.string().nullable(),
  run: z.object({ id: z.string(), seed: z.string(), scenario: z.object({ id: z.string(), name: z.string(), version: z.number() }) }),
  chaosProfile: z.object({ id: z.string(), name: z.string(), version: z.number(), profileHash: z.string() }),
  chaosSeed: z.string(),
  plannerVersion: z.string(),
  target: targetSchema,
  requestedAt: timestamp,
  startedAt: timestamp.nullable(),
  deliveredAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  attemptCount: count.nullable(),
  findingCount: count.nullable(),
  windowFindingCount: count.nullable(),
};

export const executionSummarySchema = z.object(executionSummaryShape);
export type ExecutionSummary = z.output<typeof executionSummarySchema>;

export const executionListSchema = z.object({ executions: z.array(executionSummarySchema), total: count, limit: count, offset: count });
export type ExecutionList = z.output<typeof executionListSchema>;

export const executionSchema = z.object({
  ...executionSummaryShape,
  delivery: deliverySummarySchema.nullable(),
  targetResult: z
    .object({
      delivery: z.object({ messages: count, distinctEvents: count, redeliveries: count, failedAttempts: count }),
      counters: z.record(z.string(), count),
      parkedEvents: count,
    })
    .nullable(),
  kafka: z
    .object({
      topic: z.string(),
      groupId: z.string(),
      partitions: count,
      sent: count,
      plannedFailures: count,
      durationMs: count,
      lagZeroAfterMs: count,
    })
    .nullable(),
  workDirectory: z.string().nullable(),
  files,
});
export type Execution = z.output<typeof executionSchema>;

// ---- delivery attempts ---------------------------------------------------------------------------

export const faultRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delay'), delayMs: count }),
  z.object({ type: z.literal('reorder'), behindEventId: z.string(), distance: count, shiftMs: count }),
  z.object({ type: z.literal('late'), windowCloseMs: count, behindEventId: z.string(), shiftMs: count }),
  z.object({ type: z.literal('transientFailure'), failure: count, failures: count }),
  z.object({ type: z.literal('duplicate'), copy: count, copies: count }),
]);
export type FaultRecord = z.output<typeof faultRecordSchema>;

export const attemptSchema = z.object({
  attemptId: z.string(),
  deliverySequence: count,
  attemptNumber: count,
  kind: z.enum(['original', 'retry', 'duplicate']),
  plannedOutcome: z.enum(['delivered', 'failed']),
  scheduledDeliveryTimeMs: count,
  eventId: z.string(),
  eventSequence: count,
  eventType: z.string(),
  eventTimeMs: count,
  aggregateId: z.string(),
  aggregateVersion: count,
  derivedFrom: z.object({ attemptId: z.string(), offsetMs: count }).nullable(),
  faults: z.array(faultRecordSchema),
  kafka: z
    .object({
      outcome: z.enum(['sent', 'planned-failure']),
      partition: count.nullable(),
      offset: z.string().nullable(),
      dueAtMs: count.nullable(),
      startedAtMs: count,
      ackedAtMs: count.nullable(),
      driftMs: count.nullable(),
    })
    .nullable(),
});
export type Attempt = z.output<typeof attemptSchema>;

export const attemptsSchema = z.object({
  executionId: z.string(),
  attempts: z.array(attemptSchema),
  nextSequence: count.nullable(),
});
export type Attempts = z.output<typeof attemptsSchema>;

// ---- report and findings -------------------------------------------------------------------------

export const deliveryCauseSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  aggregateId: z.string(),
  aggregateVersion: count,
  faults: z.array(z.string()),
  deliveries: count,
  failedAttempts: count,
  lost: z.boolean(),
  delayMs: count.nullable(),
  overtakenBy: z.array(z.string()),
});
export type DeliveryCause = z.output<typeof deliveryCauseSchema>;

const findingCounts = z.object({
  findings: count,
  explained: count,
  unexplained: count,
  byCategory: z.record(z.string(), count),
});

export const reportSchema = z.object({
  verdict: z.enum(VERDICTS),
  hints: z.boolean(),
  source: z.object({ seed: z.string(), scenarioName: z.string(), eventsSha256: z.string() }),
  target: z.object({ name: z.string(), editedAfterDelivery: z.boolean() }).nullable(),
  plan: z.object({ chaosSeed: z.string(), planSha256: z.string(), profile: z.object({ name: z.string(), hash: z.string() }) }).nullable(),
  checked: z.object({ entities: z.record(z.string(), z.object({ expected: count, actual: count })), invariants: count }),
  counts: findingCounts,
  rootCauses: z.array(z.object({ cause: deliveryCauseSchema.nullable(), findings: count })),
  windows: z
    .object({
      windowing: z.object({ sizeMs: count, allowedLatenessMs: count }),
      hints: z.boolean(),
      checked: z.object({ expected: count, actual: count }),
      counts: findingCounts,
    })
    .optional(),
});
export type Report = z.output<typeof reportSchema>;

const difference = z.object({ field: z.string(), expected: z.unknown(), actual: z.unknown() });

export const findingSchema = z.object({
  ordinal: count,
  category: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  check: z.string(),
  message: z.string(),
  differences: z.array(difference),
  causes: z.array(deliveryCauseSchema),
});
export type Finding = z.output<typeof findingSchema>;

export const findingsSchema = z.object({
  executionId: z.string(),
  findings: z.array(findingSchema),
  total: count,
  limit: count,
  offset: count,
});
export type Findings = z.output<typeof findingsSchema>;

export const windowCauseSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  eventTimeMs: count,
  windowStartMs: count,
  windowCloseMs: count,
  arrival: z.enum(['on-time', 'within-lateness', 'after-close', 'lost']),
  firstDeliveryTimeMs: count.nullable(),
  streamTimeMs: count.nullable(),
  deliveries: count,
  arrivalWindowStartsMs: z.array(count),
  faults: z.array(z.string()),
});
export type WindowCause = z.output<typeof windowCauseSchema>;

export const windowFindingSchema = z.object({
  ordinal: count,
  category: z.string(),
  windowStartMs: count,
  windowEndMs: count,
  message: z.string(),
  differences: z.array(difference),
  causes: z.array(windowCauseSchema),
});
export type WindowFinding = z.output<typeof windowFindingSchema>;

export const windowFindingsSchema = z.object({
  executionId: z.string(),
  findings: z.array(windowFindingSchema),
  total: count,
  limit: count,
  offset: count,
});
export type WindowFindings = z.output<typeof windowFindingsSchema>;

// ---- scenarios and chaos profiles (Milestone 9) ----------------------------------------------------

/** The part of a stored version both kinds of document share: the hash that names its content. */
const versionSummaryShape = { version: z.number(), createdAt: timestamp };

const scenarioSummaryShape = { id: z.string(), name: z.string(), createdAt: timestamp, latestVersion: count };
const chaosProfileSummaryShape = scenarioSummaryShape;

export const scenarioListSchema = z.object({ scenarios: z.array(z.object(scenarioSummaryShape)) });
export type ScenarioList = z.output<typeof scenarioListSchema>;

export const scenarioViewSchema = z.object({
  ...scenarioSummaryShape,
  versions: z.array(z.object({ ...versionSummaryShape, scenarioHash: z.string() })),
});
export type ScenarioView = z.output<typeof scenarioViewSchema>;

/** A stored version: `definition` is the resolved document, every default filled in. */
export const scenarioVersionSchema = z.object({
  ...versionSummaryShape,
  scenarioId: z.string(),
  scenarioName: z.string(),
  scenarioHash: z.string(),
  definition: z.record(z.string(), z.unknown()),
});
export type ScenarioVersion = z.output<typeof scenarioVersionSchema>;

export const chaosProfileListSchema = z.object({ chaosProfiles: z.array(z.object(chaosProfileSummaryShape)) });
export type ChaosProfileList = z.output<typeof chaosProfileListSchema>;

export const chaosProfileViewSchema = z.object({
  ...chaosProfileSummaryShape,
  versions: z.array(z.object({ ...versionSummaryShape, profileHash: z.string() })),
});
export type ChaosProfileView = z.output<typeof chaosProfileViewSchema>;

export const chaosProfileVersionSchema = z.object({
  ...versionSummaryShape,
  chaosProfileId: z.string(),
  chaosProfileName: z.string(),
  profileHash: z.string(),
  definition: z.record(z.string(), z.unknown()),
});
export type ChaosProfileVersion = z.output<typeof chaosProfileVersionSchema>;

/** The answers of the dry-run endpoints: the document is valid, and this is what a stored version would hold. */
export const scenarioValidationSchema = z.object({
  valid: z.literal(true),
  name: z.string(),
  scenarioHash: z.string(),
  definition: z.record(z.string(), z.unknown()),
});
export type ScenarioValidation = z.output<typeof scenarioValidationSchema>;

export const chaosProfileValidationSchema = z.object({
  valid: z.literal(true),
  name: z.string(),
  profileHash: z.string(),
  definition: z.record(z.string(), z.unknown()),
});
export type ChaosProfileValidation = z.output<typeof chaosProfileValidationSchema>;

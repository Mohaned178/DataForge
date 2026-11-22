import { z } from 'zod';
import { EVENT_TYPES, canonicalJson, stripByteOrderMark } from '@dataforge/core';

export const ATTEMPT_KINDS = ['original', 'retry', 'duplicate'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const PLANNED_OUTCOMES = ['delivered', 'failed'] as const;
export type PlannedOutcome = (typeof PLANNED_OUTCOMES)[number];

const nonNegativeInt = z.number().int().min(0);
const positiveInt = z.number().int().min(1);
const id = z.string().min(1);

/** A fault that shaped one attempt. Each record carries what is needed to recompute the attempt's time. */
export const faultRecordSchema = z.discriminatedUnion('type', [
  /** The original attempt was held back by `delayMs`. */
  z.strictObject({ type: z.literal('delay'), delayMs: positiveInt }),
  /**
   * The original attempt was moved behind the delivery of `behindEventId`, the `distance`-th later
   * event of the same aggregate. `shiftMs` is how much later that made it (0 when a delay already had).
   */
  z.strictObject({ type: z.literal('reorder'), behindEventId: id, distance: positiveInt, shiftMs: nonNegativeInt }),
  /**
   * The original attempt was held back until after its window closed: it is delivered just after
   * `behindEventId`, an event whose event time is past `windowCloseMs`, so the target's stream time
   * has passed the close when it arrives. `shiftMs` is how much later that made it.
   */
  z.strictObject({ type: z.literal('late'), windowCloseMs: nonNegativeInt, behindEventId: id, shiftMs: nonNegativeInt }),
  /** This attempt is failure `failure` of the `failures` consecutive failures planned for the event. */
  z.strictObject({ type: z.literal('transientFailure'), failure: positiveInt, failures: positiveInt }),
  /** This attempt is extra copy `copy` of `copies`. */
  z.strictObject({ type: z.literal('duplicate'), copy: positiveInt, copies: positiveInt }),
]);
export type FaultRecord = z.output<typeof faultRecordSchema>;

export const deliveryAttemptSchema = z.strictObject({
  attemptId: id,
  deliverySequence: positiveInt,
  attemptNumber: positiveInt,
  kind: z.enum(ATTEMPT_KINDS),
  plannedOutcome: z.enum(PLANNED_OUTCOMES),
  scheduledDeliveryTimeMs: nonNegativeInt,
  eventId: id,
  eventSequence: positiveInt,
  eventType: z.enum(EVENT_TYPES),
  eventTimeMs: nonNegativeInt,
  aggregateId: id,
  aggregateVersion: positiveInt,
  /** For a retry: the failed attempt it retries. For a duplicate: the delivered attempt it copies. */
  derivedFrom: z.strictObject({ attemptId: id, offsetMs: nonNegativeInt }).nullable(),
  faults: z.array(faultRecordSchema),
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/**
 * One planned delivery of one canonical event. A business event can have several attempts
 * (retries, duplicates); they all share its `eventId` and each has its own `attemptId`.
 */
export type DeliveryAttempt = DeepReadonly<z.output<typeof deliveryAttemptSchema>>;

/** `att_<aggregateId>_<aggregateVersion>_<attemptNumber>`: readable, and unique because event IDs are. */
export function attemptId(aggregateId: string, aggregateVersion: number, attemptNumber: number): string {
  return `att_${aggregateId}_${aggregateVersion}_${attemptNumber}`;
}

export class DeliveryPlanParseError extends Error {
  constructor(
    readonly lineNumber: number,
    detail: string,
  ) {
    super(`delivery-plan.jsonl line ${lineNumber}: ${detail}`);
    this.name = 'DeliveryPlanParseError';
  }
}

/** One canonical-JSON attempt per line, in delivery order, "\n" line endings, trailing newline. */
export function serializeDeliveryPlan(attempts: readonly DeliveryAttempt[]): string {
  return attempts.map((attempt) => `${canonicalJson(attempt)}\n`).join('');
}

/** Parses and schema-validates a delivery plan, and checks that it is in delivery order. */
export function parseDeliveryPlan(text: string): DeliveryAttempt[] {
  const lines = stripByteOrderMark(text).split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') {
      throw new DeliveryPlanParseError(lineNumber, 'blank line');
    }
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new DeliveryPlanParseError(lineNumber, `invalid JSON (${(error as Error).message})`);
    }
    const result = deliveryAttemptSchema.safeParse(json);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue === undefined || issue.path.length === 0 ? '(attempt)' : issue.path.map(String).join('.');
      throw new DeliveryPlanParseError(lineNumber, `${path}: ${issue?.message ?? 'invalid attempt'}`);
    }
    if (result.data.deliverySequence !== lineNumber) {
      throw new DeliveryPlanParseError(lineNumber, `deliverySequence is ${result.data.deliverySequence}, expected ${lineNumber}`);
    }
    return result.data;
  });
}

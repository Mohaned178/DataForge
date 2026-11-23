import type { CanonicalEvent } from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import { PlanDoesNotMatchLogError, deliveryMessageFor } from '@dataforge/targets';
import { encodeDeliveryRecord, type DeliveryRecord } from './record';

/** Simulation milliseconds played per wall-clock millisecond, or `max`: no waiting, order only. */
export type Speed = number | 'max';

/** Where the broker stored a record. Offsets are 64-bit in Kafka, so they stay decimal strings. */
export interface SentRecord {
  readonly partition: number;
  readonly offset: string;
}

/** Produces one record and resolves once the broker has acknowledged it. */
export interface RecordSender {
  send(record: DeliveryRecord): Promise<SentRecord>;
}

/** Wall-clock time, injected so that pacing is testable and the executor stays deterministic. */
export interface WallClock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const DELIVERY_OUTCOMES = ['sent', 'planned-failure'] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/**
 * What really happened to one planned attempt. Times are wall-clock milliseconds since the
 * execution started; `dueAtMs` and `driftMs` are null at speed `max`, where nothing is waited for.
 */
export interface DeliveryLogEntry {
  readonly deliverySequence: number;
  readonly attemptId: string;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly scheduledDeliveryTimeMs: number;
  readonly outcome: DeliveryOutcome;
  readonly dueAtMs: number | null;
  readonly startedAtMs: number;
  readonly ackedAtMs: number | null;
  readonly driftMs: number | null;
  readonly partition: number | null;
  readonly offset: string | null;
}

export interface ExecutePlanInput {
  readonly events: readonly CanonicalEvent[];
  /** The delivery plan, in delivery order. */
  readonly attempts: readonly DeliveryAttempt[];
  /** The scenario epoch, for the ISO timestamps in each record. */
  readonly epochUnixMs: number;
  readonly speed: Speed;
  readonly sender: RecordSender;
  readonly clock: WallClock;
  /** Stops the execution before the next attempt (it throws the signal's reason), for a process that is shutting down. */
  readonly signal?: AbortSignal;
}

export interface ExecutionResult {
  readonly startedAtUnixMs: number;
  readonly durationMs: number;
  readonly sent: number;
  readonly plannedFailures: number;
  /** The largest lateness of an attempt against its due time; null at speed `max`. */
  readonly maxDriftMs: number | null;
  readonly log: readonly DeliveryLogEntry[];
}

export class DeliveryExecutionError extends Error {
  constructor(
    readonly attempt: DeliveryAttempt,
    readonly log: readonly DeliveryLogEntry[],
    cause: unknown,
  ) {
    super(`Sending attempt ${attempt.attemptId} (delivery ${attempt.deliverySequence}) failed: ${(cause as Error).message ?? String(cause)}`, { cause });
    this.name = 'DeliveryExecutionError';
  }
}

/**
 * Plays a delivery plan, one attempt at a time, in delivery order. A delivered attempt is sent and
 * acknowledged before the next one starts, so the broker stores the attempts of each key in plan
 * order. A planned failure is never sent; it is only logged. With a numeric speed, each attempt
 * waits until its plan time (relative to the first attempt) divided by the speed.
 */
export async function executePlan(input: ExecutePlanInput): Promise<ExecutionResult> {
  const { speed, sender, clock } = input;
  if (speed !== 'max' && !(Number.isFinite(speed) && speed > 0)) {
    throw new RangeError(`speed must be a positive number or "max", got ${speed}`);
  }
  const eventsById = new Map(input.events.map((event) => [event.eventId, event]));
  const ordered = [...input.attempts].sort((a, b) => a.deliverySequence - b.deliverySequence);
  const baseTimeMs = ordered[0]?.scheduledDeliveryTimeMs ?? 0;
  const startedAtUnixMs = clock.now();
  const elapsed = () => clock.now() - startedAtUnixMs;
  const log: DeliveryLogEntry[] = [];
  let sent = 0;
  let maxDriftMs: number | null = null;

  for (const attempt of ordered) {
    input.signal?.throwIfAborted();
    const event = eventsById.get(attempt.eventId);
    if (event === undefined) {
      throw new PlanDoesNotMatchLogError(attempt);
    }
    const dueAtMs = speed === 'max' ? null : Math.floor((attempt.scheduledDeliveryTimeMs - baseTimeMs) / speed);
    if (dueAtMs !== null) {
      const wait = dueAtMs - elapsed();
      if (wait > 0) {
        await clock.sleep(wait);
      }
    }
    const startedAtMs = elapsed();
    const driftMs = dueAtMs === null ? null : startedAtMs - dueAtMs;
    if (driftMs !== null) {
      maxDriftMs = maxDriftMs === null ? driftMs : Math.max(maxDriftMs, driftMs);
    }
    const common = {
      deliverySequence: attempt.deliverySequence,
      attemptId: attempt.attemptId,
      eventId: attempt.eventId,
      aggregateId: attempt.aggregateId,
      scheduledDeliveryTimeMs: attempt.scheduledDeliveryTimeMs,
      dueAtMs,
      startedAtMs,
      driftMs,
    };
    if (attempt.plannedOutcome === 'failed') {
      log.push({ ...common, outcome: 'planned-failure', ackedAtMs: null, partition: null, offset: null });
      continue;
    }
    let stored: SentRecord;
    try {
      stored = await sender.send(encodeDeliveryRecord(deliveryMessageFor(event, attempt), input.epochUnixMs));
    } catch (error) {
      throw new DeliveryExecutionError(attempt, log, error);
    }
    log.push({ ...common, outcome: 'sent', ackedAtMs: elapsed(), partition: stored.partition, offset: stored.offset });
    sent += 1;
  }
  return { startedAtUnixMs, durationMs: elapsed(), sent, plannedFailures: log.length - sent, maxDriftMs, log };
}

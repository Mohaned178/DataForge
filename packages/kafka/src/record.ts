import { z } from 'zod';
import { canonicalEventSchema, canonicalJson, simTimeToIso } from '@dataforge/core';
import type { DeliveryMessage } from '@dataforge/targets';

export const DELIVERY_RECORD_FORMAT = 'dataforge.delivery-record';
export const DELIVERY_RECORD_FORMAT_VERSION = 1;

/** Header names of a delivery record: the attempt metadata, never the business event. */
export const DELIVERY_RECORD_HEADERS = [
  'attemptId',
  'attemptNumber',
  'deliverySequence',
  'scheduledDeliveryTimeMs',
  'scheduledDeliveryTime',
] as const;

/** A Kafka record as DataForge produces it: UTF-8 strings only. */
export interface DeliveryRecord {
  readonly key: string;
  readonly value: string;
  readonly headers: Readonly<Record<(typeof DELIVERY_RECORD_HEADERS)[number], string>>;
}

/** A record as a consumer receives it, before validation: anything may be missing. */
export interface ReceivedRecord {
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const recordValueSchema = z.strictObject({
  format: z.literal(DELIVERY_RECORD_FORMAT),
  formatVersion: z.literal(DELIVERY_RECORD_FORMAT_VERSION),
  event: canonicalEventSchema,
  eventTime: z.string().regex(ISO_INSTANT, 'expected an ISO-8601 UTC instant like 2026-01-01T00:00:00.000Z'),
});

const integerText = (minimum: number) =>
  z
    .string()
    .regex(/^\d{1,15}$/, 'expected a whole number')
    .transform(Number)
    .refine((value) => value >= minimum, `expected at least ${minimum}`);

const recordHeadersSchema = z.object({
  attemptId: z.string().min(1),
  attemptNumber: integerText(1),
  deliverySequence: integerText(1),
  scheduledDeliveryTimeMs: integerText(0),
  scheduledDeliveryTime: z.string().regex(ISO_INSTANT, 'expected an ISO-8601 UTC instant'),
});

export class DeliveryRecordError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid delivery record: ${problems.join('; ')}`);
    this.name = 'DeliveryRecordError';
  }
}

/**
 * The Kafka record for one delivered attempt. Key: the aggregate ID, so every event of an aggregate
 * goes to the same partition. Value: the canonical event and its event time as an ISO instant, in
 * canonical JSON. Headers: the attempt metadata, as decimal strings and ISO instants.
 */
export function encodeDeliveryRecord(message: DeliveryMessage, epochUnixMs: number): DeliveryRecord {
  const value = {
    format: DELIVERY_RECORD_FORMAT,
    formatVersion: DELIVERY_RECORD_FORMAT_VERSION,
    event: message.event,
    eventTime: simTimeToIso(epochUnixMs, message.event.eventTimeMs),
  };
  return {
    key: message.key,
    value: canonicalJson(value),
    headers: {
      attemptId: message.headers.attemptId,
      attemptNumber: String(message.headers.attemptNumber),
      deliverySequence: String(message.headers.deliverySequence),
      scheduledDeliveryTimeMs: String(message.headers.scheduledDeliveryTimeMs),
      scheduledDeliveryTime: simTimeToIso(epochUnixMs, message.headers.scheduledDeliveryTimeMs),
    },
  };
}

/**
 * Turns a received record back into the message a target handles, validating every part. Every
 * problem is reported with its path (`value.event.payload.orderId`, `headers.attemptNumber`), so a
 * record that does not follow the contract is an error, never a silent guess.
 */
export function decodeDeliveryRecord(record: ReceivedRecord): DeliveryMessage {
  const problems: string[] = [];
  let parsedValue: z.output<typeof recordValueSchema> | undefined;
  if (record.value === null) {
    problems.push('value: missing');
  } else {
    let json: unknown;
    try {
      json = JSON.parse(record.value);
    } catch (error) {
      problems.push(`value: not valid JSON (${(error as Error).message})`);
    }
    if (json !== undefined) {
      const result = recordValueSchema.safeParse(json);
      if (result.success) {
        parsedValue = result.data;
      } else {
        problems.push(...result.error.issues.map((issue) => `${['value', ...issue.path.map(String)].join('.')}: ${issue.message}`));
      }
    }
  }
  const headers = recordHeadersSchema.safeParse(record.headers);
  if (!headers.success) {
    problems.push(...headers.error.issues.map((issue) => `${['headers', ...issue.path.map(String)].join('.')}: ${issue.message}`));
  }
  if (record.key === null) {
    problems.push('key: missing');
  } else if (parsedValue !== undefined && record.key !== parsedValue.event.aggregateId) {
    problems.push(`key: "${record.key}" is not the event's aggregateId "${parsedValue.event.aggregateId}"`);
  }
  if (problems.length > 0 || parsedValue === undefined || !headers.success || record.key === null) {
    throw new DeliveryRecordError(problems);
  }
  const { attemptId, attemptNumber, deliverySequence, scheduledDeliveryTimeMs } = headers.data;
  return {
    key: record.key,
    event: parsedValue.event,
    headers: { attemptId, attemptNumber, deliverySequence, scheduledDeliveryTimeMs },
  };
}

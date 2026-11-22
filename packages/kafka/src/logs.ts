import { z } from 'zod';
import { canonicalJson } from '@dataforge/core';
import type { DeliveryLogEntry } from './executor';

/** delivery-log.jsonl: one canonical-JSON entry per planned attempt, in delivery order. */
export function serializeDeliveryLog(entries: readonly DeliveryLogEntry[]): string {
  return entries.map((entry) => `${canonicalJson(entry)}\n`).join('');
}

/** One record the consumer handled, in the order it handled them. */
export const processingLogEntrySchema = z.strictObject({
  processingSequence: z.number().int().min(1),
  partition: z.number().int().min(0),
  offset: z.string().regex(/^\d+$/),
  /** The record's Kafka timestamp (set by the producer when it sent the record). */
  kafkaTimestamp: z.string(),
  /** When the consumer handed the record to its target: processing time. */
  processedAt: z.string(),
  attemptId: z.string(),
  deliverySequence: z.number().int().min(1),
  eventId: z.string(),
  aggregateId: z.string(),
});
export type ProcessingLogEntry = z.output<typeof processingLogEntrySchema>;

export function serializeProcessingLog(entries: readonly ProcessingLogEntry[]): string {
  return entries.map((entry) => `${canonicalJson(entry)}\n`).join('');
}

export function parseProcessingLog(text: string): ProcessingLogEntry[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) => {
      const result = processingLogEntrySchema.safeParse(JSON.parse(line));
      if (!result.success) {
        throw new Error(`processing-log.jsonl line ${index + 1}: ${result.error.issues[0]?.message ?? 'invalid entry'}`);
      }
      return result.data;
    });
}

import { z } from 'zod';

export const CONSUMER_FILES = {
  actualState: 'actual-state.json',
  actualWindows: 'actual-windows.json',
  report: 'consumer-report.json',
  processingLog: 'processing-log.jsonl',
} as const;

const count = z.number().int().min(0);
const fileEntry = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: count });

/**
 * Written by the consumer process next to its actual state. It describes what the consumer saw on
 * Kafka; it knows nothing of runs or plans (the producing side binds it to those).
 */
export const consumerReportSchema = z.strictObject({
  format: z.literal('dataforge.consumer-report'),
  formatVersion: z.literal(1),
  target: z.strictObject({ name: z.string(), description: z.string() }),
  kafka: z.strictObject({ topic: z.string(), groupId: z.string(), partitions: z.array(z.number().int().min(0)) }),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** Records handed to the target. */
  messages: count,
  distinctEvents: count,
  /** Records for an eventId the target had already received (planned duplicates and retries that both arrived). */
  redeliveries: count,
  /** Records Kafka itself handed over more than once (same partition and offset), for example after a rebalance. */
  kafkaRedeliveries: count,
  counters: z.record(z.string(), count),
  parkedEventIds: z.array(z.string()),
  /** Only when the consumer was started with a windowing contract. */
  windowing: z.strictObject({ sizeMs: count, allowedLatenessMs: count }).optional(),
  files: z.strictObject({
    [CONSUMER_FILES.actualState]: fileEntry,
    [CONSUMER_FILES.actualWindows]: fileEntry.optional(),
    [CONSUMER_FILES.processingLog]: fileEntry,
  }),
});

export type ConsumerReport = z.output<typeof consumerReportSchema>;

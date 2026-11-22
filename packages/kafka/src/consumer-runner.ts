import type { Consumer, IHeaders, Kafka } from 'kafkajs';
import type { Target, TargetResult } from '@dataforge/targets';
import type { ProcessingLogEntry } from './logs';
import { decodeDeliveryRecord } from './record';

export interface ConsumerRunnerOptions {
  readonly kafka: Kafka;
  readonly topic: string;
  readonly groupId: string;
  readonly target: Target;
  /** Wall clock in Unix milliseconds, for processing times. */
  readonly now?: () => number;
}

export interface ConsumerOutcome {
  readonly result: TargetResult;
  readonly partitions: readonly number[];
  readonly startedAtUnixMs: number;
  readonly finishedAtUnixMs: number;
  readonly messages: number;
  readonly distinctEvents: number;
  readonly redeliveries: number;
  readonly kafkaRedeliveries: number;
  readonly processingLog: readonly ProcessingLogEntry[];
}

export class ConsumerRecordError extends Error {
  constructor(
    readonly partition: number,
    readonly offset: string,
    cause: unknown,
  ) {
    super(`Record at partition ${partition}, offset ${offset} could not be handled: ${(cause as Error).message ?? String(cause)}`, { cause });
    this.name = 'ConsumerRecordError';
  }
}

/** Header values arrive as bytes; a header given twice is not part of the contract and reads as missing. */
function textHeaders(headers: IHeaders | undefined): Record<string, string | undefined> {
  const text: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    text[name] = value === undefined || Array.isArray(value) ? undefined : value.toString();
  }
  return text;
}

/**
 * Runs a target as a Kafka consumer: joins the group, reads the topic from the beginning, decodes
 * every record into a delivery message, hands it to the target, and commits the batch's offsets
 * only after the whole batch was handled. A committed offset therefore always means "handled", which
 * is what makes zero consumer-group lag a completion signal. A record that breaks the contract, or a
 * target that throws, stops the runner: `failure` resolves with the error and nothing more is committed.
 */
export class ConsumerRunner {
  private readonly consumer: Consumer;
  private readonly now: () => number;
  private readonly processingLog: ProcessingLogEntry[] = [];
  private readonly seenRecords = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private kafkaRedeliveries = 0;
  private partitions: readonly number[] = [];
  private startedAtUnixMs = 0;
  private failed: Error | undefined;
  private reportFailure: (error: Error) => void = () => undefined;
  /** Resolves (never rejects) with the error that stopped the runner. */
  readonly failure: Promise<Error>;

  constructor(private readonly options: ConsumerRunnerOptions) {
    // A short fetch wait: the broker answers an empty fetch after 200 ms instead of 5 s, so new
    // records are picked up promptly and leaving the group does not wait for a long poll.
    this.consumer = options.kafka.consumer({ groupId: options.groupId, maxWaitTimeInMs: 200, retry: { retries: 4 } });
    this.now = options.now ?? (() => Date.now());
    this.failure = new Promise<Error>((resolve) => {
      this.reportFailure = resolve;
    });
    this.consumer.on(this.consumer.events.CRASH, (event) => {
      if (!event.payload.restart) {
        this.fail(event.payload.error);
      }
    });
  }

  /** Joins the group and starts consuming; resolves with the partitions assigned to this consumer. */
  async start(): Promise<readonly number[]> {
    this.startedAtUnixMs = this.now();
    const { consumer } = this;
    const { topic } = this.options;
    const joined = new Promise<readonly number[]>((resolve) => {
      consumer.on(consumer.events.GROUP_JOIN, (event) => resolve(event.payload.memberAssignment[topic] ?? []));
    });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachBatch: async (payload) => {
        const { batch } = payload;
        let handled: string | undefined;
        for (const message of batch.messages) {
          if (this.failed !== undefined || !payload.isRunning() || payload.isStale()) {
            return;
          }
          try {
            this.handle(batch.partition, message.offset, message.timestamp, message.key, message.value, message.headers);
          } catch (error) {
            this.fail(new ConsumerRecordError(batch.partition, message.offset, error));
            return;
          }
          handled = message.offset;
        }
        if (handled !== undefined) {
          await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: (BigInt(handled) + 1n).toString() }]);
        }
        await payload.heartbeat();
      },
    });
    this.partitions = [...(await joined)].sort((a, b) => a - b);
    return this.partitions;
  }

  /** Leaves the group and returns the target's final state with what was consumed. */
  async finish(): Promise<ConsumerOutcome> {
    await this.consumer.disconnect();
    if (this.failed !== undefined) {
      throw this.failed;
    }
    const messages = this.processingLog.length;
    return {
      result: this.options.target.finish(),
      partitions: this.partitions,
      startedAtUnixMs: this.startedAtUnixMs,
      finishedAtUnixMs: this.now(),
      messages,
      distinctEvents: this.seenEvents.size,
      redeliveries: messages - this.seenEvents.size,
      kafkaRedeliveries: this.kafkaRedeliveries,
      processingLog: this.processingLog,
    };
  }

  /** Leaves the group without reporting (after a failure, or when the parent went away). */
  async stop(): Promise<void> {
    await this.consumer.disconnect().catch(() => undefined);
  }

  private handle(partition: number, offset: string, timestamp: string, key: Buffer | null, value: Buffer | null, headers: IHeaders | undefined): void {
    const recordId = `${partition}:${offset}`;
    if (this.seenRecords.has(recordId)) {
      this.kafkaRedeliveries += 1;
    }
    this.seenRecords.add(recordId);
    const message = decodeDeliveryRecord({ key: key?.toString() ?? null, value: value?.toString() ?? null, headers: textHeaders(headers) });
    this.options.target.handle(message);
    this.seenEvents.add(message.event.eventId);
    this.processingLog.push({
      processingSequence: this.processingLog.length + 1,
      partition,
      offset,
      kafkaTimestamp: new Date(Number(timestamp)).toISOString(),
      processedAt: new Date(this.now()).toISOString(),
      attemptId: message.headers.attemptId,
      deliverySequence: message.headers.deliverySequence,
      eventId: message.event.eventId,
      aggregateId: message.key,
    });
  }

  private fail(error: Error): void {
    if (this.failed === undefined) {
      this.failed = error;
      this.reportFailure(error);
    }
  }
}

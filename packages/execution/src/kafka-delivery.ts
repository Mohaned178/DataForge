import { randomBytes } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, fileEntry, sha256Hex, type CanonicalEvent, type FileEntry, type WindowingSpec } from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import {
  CONSUMER_FILES,
  KAFKA_CLIENT,
  KafkaRecordSender,
  LagTimeoutError,
  connectAdmin,
  consumerReportSchema,
  createDeliveryTopic,
  createIdempotentProducer,
  createKafkaClient,
  describeConsumerGroup,
  describeTopicPartitions,
  executePlan,
  fetchGroupLag,
  serializeDeliveryLog,
  systemClock,
  waitForZeroLag,
  type ConsumerReport,
  type ExecutionResult,
  type KafkaAdmin,
  type KafkaProducer,
  type Speed,
} from '@dataforge/kafka';
import type { ReferenceTargetName } from '@dataforge/targets';
import { ConsumerProcess, ConsumerProcessError } from './consumer-process';
import { ExternalPipelineError, externalPipelineProblem } from './external-group';

export const KAFKA_DELIVERY_FILES = {
  deliveryLog: 'delivery-log.jsonl',
  kafkaRun: 'kafka-run.json',
  producerLog: 'producer.log',
  consumerLog: 'consumer.log',
} as const;

/** Who consumes the records: the reference consumer DataForge starts, or the user's own pipeline. */
export type KafkaConsumerSpec =
  | { readonly type: 'reference'; readonly target: ReferenceTargetName; readonly partitions: number }
  | { readonly type: 'external'; readonly topic: string; readonly groupId: string };

export interface KafkaDeliveryInput {
  readonly events: readonly CanonicalEvent[];
  readonly attempts: readonly DeliveryAttempt[];
  /** The scenario epoch, for the ISO timestamps in each record. */
  readonly epochUnixMs: number;
  /** The plan's windowing contract; the reference consumer computes windows under it. */
  readonly windowing: WindowingSpec | undefined;
  readonly brokers: readonly string[];
  readonly speed: Speed;
  /** How long to wait for zero consumer-group lag after the last record. */
  readonly timeoutMs: number;
  readonly consumer: KafkaConsumerSpec;
  /** Receives producer.log, and for the reference consumer its output files and consumer.log. */
  readonly workDirectory: string;
  /** Stops the delivery (it throws the signal's reason), for a process that is shutting down. */
  readonly signal?: AbortSignal;
}

/** kafka-run.json: what happened on Kafka. `consumer` and `consumed` are null for an external pipeline. */
export interface KafkaRunFile {
  readonly format: 'dataforge.kafka-run';
  readonly formatVersion: 1;
  readonly executionId: string;
  readonly client: string;
  readonly kafka: {
    readonly brokers: readonly string[];
    readonly clusterId: string;
    readonly topic: string;
    readonly partitions: number;
    readonly groupId: string;
  };
  readonly consumer: {
    readonly pid: number;
    readonly target: string;
    readonly joinedAfterMs: number;
    readonly assignedPartitions: readonly number[];
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly exitCode: 0;
  } | null;
  readonly execution: {
    readonly speed: Speed;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly sent: number;
    readonly plannedFailures: number;
    readonly maxDriftMs: number | null;
  };
  readonly completion: { readonly lagZeroAfterMs: number; readonly polls: number };
  readonly consumed: { readonly messages: number; readonly kafkaRedeliveries: number } | null;
  readonly files: { readonly [KAFKA_DELIVERY_FILES.deliveryLog]: FileEntry };
}

/** What the reference consumer process wrote, checked against its report. */
export interface ConsumedOutput {
  readonly report: ConsumerReport;
  readonly actualStateText: string;
  readonly actualWindowsText: string | undefined;
}

export interface KafkaDeliveryResult {
  readonly kafkaRun: KafkaRunFile;
  readonly kafkaRunText: string;
  readonly execution: ExecutionResult;
  readonly deliveryLogText: string;
  /** Only for the reference consumer: an external pipeline reports its state on its own. */
  readonly consumed: ConsumedOutput | undefined;
}

/** A new identity per Kafka delivery: the reference consumer gets its own empty topic and group. */
function newDeliveryId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function serializeKafkaRun(kafkaRun: KafkaRunFile): string {
  return `${canonicalJson(kafkaRun, 2)}\n`;
}

/**
 * Delivers a plan through Kafka. For the reference consumer: a new topic and group, the consumer
 * process started and joined, every delivered attempt produced in delivery order (paced by `speed`),
 * zero consumer-group lag awaited, then the consumer asked to finish and its files read back. For an
 * external pipeline: the user's topic and group are checked first (see externalPipelineProblem), the
 * records are produced the same way, and zero lag on the user's group means the pipeline handled them.
 */
export async function deliverThroughKafka(input: KafkaDeliveryInput): Promise<KafkaDeliveryResult> {
  const { workDirectory, consumer: spec } = input;
  const deliveryId = newDeliveryId();
  const topic = spec.type === 'reference' ? `dataforge.${deliveryId}` : spec.topic;
  const groupId = spec.type === 'reference' ? `dataforge-consumer.${deliveryId}` : spec.groupId;
  const producerLog = createWriteStream(join(workDirectory, KAFKA_DELIVERY_FILES.producerLog), { encoding: 'utf8' });
  const kafka = createKafkaClient({ brokers: input.brokers, clientId: 'dataforge-deliver', log: (line) => producerLog.write(`${line}\n`) });
  let admin: KafkaAdmin | undefined;
  let producer: KafkaProducer | undefined;
  let consumer: ConsumerProcess | undefined;
  const consumerLogPath = join(workDirectory, KAFKA_DELIVERY_FILES.consumerLog);
  try {
    const cluster = await connectAdmin(kafka, input.brokers);
    admin = cluster.admin;
    let partitions: number;
    if (spec.type === 'reference') {
      await createDeliveryTopic(admin, topic, spec.partitions);
      partitions = spec.partitions;
      consumer = await ConsumerProcess.start({
        brokers: input.brokers,
        topic,
        groupId,
        target: spec.target,
        outDirectory: workDirectory,
        logPath: consumerLogPath,
        windowing: input.windowing,
      });
    } else {
      partitions = await checkExternalPipeline(admin, topic, groupId);
    }

    producer = createIdempotentProducer(kafka);
    await producer.connect();
    const execution = await executePlan({
      events: input.events,
      attempts: input.attempts,
      epochUnixMs: input.epochUnixMs,
      speed: input.speed,
      sender: new KafkaRecordSender(producer, topic),
      clock: systemClock,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await producer.disconnect();
    producer = undefined;
    const runningConsumer = consumer;
    let completion: { waitedMs: number; polls: number };
    try {
      completion = await waitForZeroLag(admin, {
        groupId,
        topic,
        timeoutMs: input.timeoutMs,
        ...(runningConsumer === undefined ? {} : { isAborted: () => runningConsumer.hasExited }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (error instanceof LagTimeoutError && runningConsumer?.hasExited === true) {
        throw new ConsumerProcessError(runningConsumer.describeExit(), consumerLogPath);
      }
      if (error instanceof LagTimeoutError && spec.type === 'external') {
        throw new ExternalPipelineError(
          `${error.message} Is your pipeline consuming "${topic}" with group "${groupId}", and committing the offsets of what it has handled?`,
        );
      }
      throw error;
    }

    let consumed: ConsumedOutput | undefined;
    if (consumer !== undefined) {
      await consumer.finish();
      consumed = readConsumerOutput(workDirectory, input.windowing, consumerLogPath);
    }
    const deliveryLogText = serializeDeliveryLog(execution.log);
    const kafkaRun: KafkaRunFile = {
      format: 'dataforge.kafka-run',
      formatVersion: 1,
      executionId: deliveryId,
      client: KAFKA_CLIENT,
      kafka: { brokers: [...input.brokers], clusterId: cluster.clusterId, topic, partitions, groupId },
      consumer:
        consumer === undefined || consumed === undefined
          ? null
          : {
              pid: consumer.pid,
              target: consumed.report.target.name,
              joinedAfterMs: consumer.joinedAfterMs,
              assignedPartitions: [...consumer.partitions],
              startedAt: consumed.report.startedAt,
              finishedAt: consumed.report.finishedAt,
              exitCode: 0,
            },
      execution: {
        speed: input.speed,
        startedAt: new Date(execution.startedAtUnixMs).toISOString(),
        durationMs: execution.durationMs,
        sent: execution.sent,
        plannedFailures: execution.plannedFailures,
        maxDriftMs: execution.maxDriftMs,
      },
      completion: { lagZeroAfterMs: completion.waitedMs, polls: completion.polls },
      consumed: consumed === undefined ? null : { messages: consumed.report.messages, kafkaRedeliveries: consumed.report.kafkaRedeliveries },
      files: { [KAFKA_DELIVERY_FILES.deliveryLog]: fileEntry(deliveryLogText) },
    };
    return { kafkaRun, kafkaRunText: serializeKafkaRun(kafkaRun), execution, deliveryLogText, consumed };
  } finally {
    consumer?.kill();
    await producer?.disconnect().catch(() => undefined);
    await admin?.disconnect().catch(() => undefined);
    await new Promise<void>((resolve) => producerLog.end(resolve));
  }
}

/** The topic must exist, and the group must be active on it and caught up; returns the topic's partition count. */
async function checkExternalPipeline(admin: KafkaAdmin, topic: string, groupId: string): Promise<number> {
  const partitions = await describeTopicPartitions(admin, topic);
  const group = await describeConsumerGroup(admin, groupId);
  const lag = partitions === undefined ? undefined : await fetchGroupLag(admin, groupId, topic);
  const problem = externalPipelineProblem({ topic, groupId, partitions, group, lag });
  if (problem !== undefined || partitions === undefined) {
    throw new ExternalPipelineError(problem ?? `Topic "${topic}" does not exist.`);
  }
  return partitions;
}

/** The consumer's actual state (and windows), each checked against the checksum in its report. */
function readConsumerOutput(workDirectory: string, windowing: WindowingSpec | undefined, logPath: string): ConsumedOutput {
  const reportPath = join(workDirectory, CONSUMER_FILES.report);
  const parsed = consumerReportSchema.safeParse(JSON.parse(readFileSync(reportPath, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConsumerProcessError(`${reportPath} is invalid: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`, reportPath);
  }
  const report = parsed.data;
  const actualStateText = readFileSync(join(workDirectory, CONSUMER_FILES.actualState), 'utf8');
  if (sha256Hex(actualStateText) !== report.files[CONSUMER_FILES.actualState].sha256) {
    throw new ConsumerProcessError(`${CONSUMER_FILES.actualState} does not match the checksum in ${CONSUMER_FILES.report}.`, logPath);
  }
  if (windowing === undefined) {
    return { report, actualStateText, actualWindowsText: undefined };
  }
  const recorded = report.files[CONSUMER_FILES.actualWindows];
  if (recorded === undefined) {
    throw new ConsumerProcessError(`The plan has a windowing contract, but the consumer wrote no ${CONSUMER_FILES.actualWindows}.`, logPath);
  }
  const actualWindowsText = readFileSync(join(workDirectory, CONSUMER_FILES.actualWindows), 'utf8');
  if (sha256Hex(actualWindowsText) !== recorded.sha256) {
    throw new ConsumerProcessError(`${CONSUMER_FILES.actualWindows} does not match the checksum in ${CONSUMER_FILES.report}.`, logPath);
  }
  return { report, actualStateText, actualWindowsText };
}

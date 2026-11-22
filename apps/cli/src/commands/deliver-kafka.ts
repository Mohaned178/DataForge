import { randomBytes } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseUtcInstant, sha256Hex } from '@dataforge/core';
import {
  CONSUMER_FILES,
  DeliveryExecutionError,
  KAFKA_CLIENT,
  KafkaRecordSender,
  KafkaUnavailableError,
  LagTimeoutError,
  connectAdmin,
  consumerReportSchema,
  createDeliveryTopic,
  createIdempotentProducer,
  createKafkaClient,
  executePlan,
  serializeDeliveryLog,
  systemClock,
  waitForZeroLag,
  type ConsumerReport,
  type KafkaAdmin,
  type KafkaProducer,
} from '@dataforge/kafka';
import { EXIT_OK, UnavailableError, formatCount, type CliIo } from '../cli-io';
import { ConsumerProcess, ConsumerProcessError } from '../consumer-process';
import { buildTargetRun } from '../delivery-directory';
import { fileEntry, writeRunFile } from '../run-directory';
import { printDeliveryHeader, printDeliveryOutcome, writeTargetRun, type DeliveryInputs, type KafkaOptions } from '../delivery-output';

export const KAFKA_DELIVERY_FILES = {
  deliveryLog: 'delivery-log.jsonl',
  kafkaRun: 'kafka-run.json',
  producerLog: 'producer.log',
  consumerLog: 'consumer.log',
} as const;

const START_KAFKA = 'Start it with "docker compose up -d --wait" (see compose.yaml), or point --brokers or KAFKA_BROKERS at a running broker.';

/** A new identity per execution: every delivery gets its own empty topic and consumer group. */
function newExecutionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Delivers a plan through Kafka to the reference consumer running as its own process: a new topic and
 * group, the consumer started and joined, every delivered attempt produced in delivery order (paced by
 * --speed), zero consumer-group lag awaited, then the consumer asked to finish. Writes the same
 * actual-state.json and target-run.json as the in-memory transport, plus what really happened on Kafka.
 */
export async function deliverThroughKafka(inputs: DeliveryInputs, options: KafkaOptions, io: CliIo): Promise<number> {
  const { outDirectory } = inputs;
  const executionId = newExecutionId();
  const topic = `dataforge.${executionId}`;
  const groupId = `dataforge-consumer.${executionId}`;
  const producerLog = createWriteStream(join(outDirectory, KAFKA_DELIVERY_FILES.producerLog), { encoding: 'utf8' });
  const kafka = createKafkaClient({ brokers: options.brokers, clientId: 'dataforge-deliver', log: (line) => producerLog.write(`${line}\n`) });
  let admin: KafkaAdmin | undefined;
  let producer: KafkaProducer | undefined;
  let consumer: ConsumerProcess | undefined;
  const consumerLogPath = join(outDirectory, KAFKA_DELIVERY_FILES.consumerLog);
  try {
    const cluster = await connectAdmin(kafka, options.brokers);
    admin = cluster.admin;
    await createDeliveryTopic(admin, topic, options.partitions);
    consumer = await ConsumerProcess.start({
      brokers: options.brokers,
      topic,
      groupId,
      target: inputs.targetName,
      outDirectory,
      logPath: consumerLogPath,
      windowing: inputs.windowing,
    });

    producer = createIdempotentProducer(kafka);
    await producer.connect();
    const execution = await executePlan({
      events: inputs.events,
      attempts: inputs.attempts,
      epochUnixMs: parseUtcInstant(inputs.manifest.simulation.epoch),
      speed: options.speed,
      sender: new KafkaRecordSender(producer, topic),
      clock: systemClock,
    });
    await producer.disconnect();
    producer = undefined;
    const runningConsumer = consumer;
    let completion: { waitedMs: number; polls: number };
    try {
      completion = await waitForZeroLag(admin, { groupId, topic, timeoutMs: options.timeoutMs, isAborted: () => runningConsumer.hasExited });
    } catch (error) {
      if (error instanceof LagTimeoutError && runningConsumer.hasExited) {
        throw new ConsumerProcessError(runningConsumer.describeExit(), consumerLogPath);
      }
      throw error;
    }
    await consumer.finish();

    const report = readConsumerReport(outDirectory);
    const actualStateText = readFileSync(join(outDirectory, CONSUMER_FILES.actualState), 'utf8');
    if (sha256Hex(actualStateText) !== report.files[CONSUMER_FILES.actualState].sha256) {
      throw new ConsumerProcessError(`${CONSUMER_FILES.actualState} does not match the checksum in ${CONSUMER_FILES.report}.`, consumerLogPath);
    }
    const actualWindowsText = readConsumerWindows(outDirectory, report, inputs, consumerLogPath);
    const targetRun = buildTargetRun({
      target: report.target,
      manifest: inputs.manifest,
      summaryFile: inputs.summaryFile,
      delivery: {
        messages: report.messages,
        distinctEvents: report.distinctEvents,
        redeliveries: report.redeliveries,
        failedAttempts: execution.plannedFailures,
      },
      counters: report.counters,
      parkedEventIds: report.parkedEventIds,
      actualStateText,
      ...(inputs.windowing === undefined || actualWindowsText === undefined ? {} : { windows: { windowing: inputs.windowing, actualWindowsText } }),
    });
    writeTargetRun(outDirectory, targetRun);
    const deliveryLogText = serializeDeliveryLog(execution.log);
    writeRunFile(outDirectory, KAFKA_DELIVERY_FILES.deliveryLog, deliveryLogText);
    const kafkaRun = {
      format: 'dataforge.kafka-run',
      formatVersion: 1,
      executionId,
      client: KAFKA_CLIENT,
      kafka: { brokers: [...options.brokers], clusterId: cluster.clusterId, topic, partitions: options.partitions, groupId },
      consumer: {
        pid: consumer.pid,
        target: report.target.name,
        joinedAfterMs: consumer.joinedAfterMs,
        assignedPartitions: [...consumer.partitions],
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        exitCode: 0,
      },
      execution: {
        speed: options.speed,
        startedAt: new Date(execution.startedAtUnixMs).toISOString(),
        durationMs: execution.durationMs,
        sent: execution.sent,
        plannedFailures: execution.plannedFailures,
        maxDriftMs: execution.maxDriftMs,
      },
      completion: { lagZeroAfterMs: completion.waitedMs, polls: completion.polls },
      consumed: { messages: report.messages, kafkaRedeliveries: report.kafkaRedeliveries },
      files: { [KAFKA_DELIVERY_FILES.deliveryLog]: fileEntry(deliveryLogText) },
    };
    writeRunFile(outDirectory, KAFKA_DELIVERY_FILES.kafkaRun, `${canonicalJson(kafkaRun, 2)}\n`);

    printDeliveryHeader(io, inputs, `DataForge deliver: target ${report.target.name} (${report.target.description}), through Kafka`);
    io.out(
      `  kafka       ${options.brokers.join(',')} (cluster ${cluster.clusterId}), topic ${topic} ` +
        `(${options.partitions} partition${options.partitions === 1 ? '' : 's'})`,
    );
    io.out(`  consumer    process ${consumer.pid}, group ${groupId}, joined after ${seconds(consumer.joinedAfterMs)} (partitions ${consumer.partitions.join(', ')})`);
    io.out(
      `  sent        ${formatCount(execution.sent)} records, ${formatCount(execution.plannedFailures)} planned failures not sent; ` +
        (options.speed === 'max'
          ? `speed max, ${seconds(execution.durationMs)}`
          : `speed ${options.speed}x, ${seconds(execution.durationMs)}, largest drift ${formatCount(execution.maxDriftMs ?? 0)} ms`),
    );
    io.out(`  completion  consumer-group lag 0, ${seconds(completion.waitedMs)} after the last record`);
    if (report.kafkaRedeliveries > 0) {
      io.out(`  WARNING     Kafka handed ${formatCount(report.kafkaRedeliveries)} records to the consumer twice (at-least-once delivery after a rebalance)`);
    }
    printDeliveryOutcome(io, inputs, targetRun, [
      `${KAFKA_DELIVERY_FILES.deliveryLog}, ${KAFKA_DELIVERY_FILES.kafkaRun}, ${CONSUMER_FILES.report}, ${CONSUMER_FILES.processingLog}`,
      `${KAFKA_DELIVERY_FILES.producerLog}, ${KAFKA_DELIVERY_FILES.consumerLog} (the Kafka client logs of both processes)`,
    ]);
    return EXIT_OK;
  } catch (error) {
    throw asUnavailable(error, options);
  } finally {
    consumer?.kill();
    await producer?.disconnect().catch(() => undefined);
    await admin?.disconnect().catch(() => undefined);
    await new Promise<void>((resolve) => producerLog.end(resolve));
  }
}

/** The consumer's windows, checked against its report, when the plan has a windowing contract. */
function readConsumerWindows(outDirectory: string, report: ConsumerReport, inputs: DeliveryInputs, logPath: string): string | undefined {
  const recorded = report.files[CONSUMER_FILES.actualWindows];
  if (inputs.windowing === undefined) {
    return undefined;
  }
  if (recorded === undefined) {
    throw new ConsumerProcessError(`The plan has a windowing contract, but the consumer wrote no ${CONSUMER_FILES.actualWindows}.`, logPath);
  }
  const text = readFileSync(join(outDirectory, CONSUMER_FILES.actualWindows), 'utf8');
  if (sha256Hex(text) !== recorded.sha256) {
    throw new ConsumerProcessError(`${CONSUMER_FILES.actualWindows} does not match the checksum in ${CONSUMER_FILES.report}.`, logPath);
  }
  return text;
}

function readConsumerReport(outDirectory: string): ConsumerReport {
  const path = join(outDirectory, CONSUMER_FILES.report);
  const parsed = consumerReportSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConsumerProcessError(`${path} is invalid: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`, path);
  }
  return parsed.data;
}

/** Infrastructure failures become exit code 3 with what to do; anything else propagates. */
function asUnavailable(error: unknown, options: KafkaOptions): unknown {
  if (error instanceof KafkaUnavailableError) {
    return new UnavailableError(`${error.message}\n${START_KAFKA}`);
  }
  if (error instanceof ConsumerProcessError) {
    return new UnavailableError(error.message);
  }
  if (error instanceof LagTimeoutError) {
    return new UnavailableError(`${error.message} Raise --timeout (now ${options.timeoutMs / 1000} s), or see consumer.log.`);
  }
  if (error instanceof DeliveryExecutionError) {
    return new UnavailableError(`${error.message}\nSent ${error.log.length} of the planned attempts before the failure.`);
  }
  return error;
}

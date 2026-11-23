import { parseUtcInstant } from '@dataforge/core';
import { ConsumerProcessError, ExternalPipelineError, KAFKA_DELIVERY_FILES, deliverThroughKafka, deliveredStateFromConsumer } from '@dataforge/execution';
import { CONSUMER_FILES, DeliveryExecutionError, KafkaUnavailableError, LagTimeoutError } from '@dataforge/kafka';
import { EXIT_OK, UnavailableError, formatCount, type CliIo } from '../cli-io';
import { writeRunFile } from '../run-directory';
import { printDeliveryHeader, printDeliveryOutcome, writeTargetRun, type DeliveryInputs, type KafkaOptions } from '../delivery-output';

export { KAFKA_DELIVERY_FILES } from '@dataforge/execution';

const START_KAFKA = 'Start it with "docker compose up -d --wait" (see compose.yaml), or point --brokers or KAFKA_BROKERS at a running broker.';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Delivers a plan through Kafka to the reference consumer running as its own process (see
 * deliverThroughKafka in @dataforge/execution), and writes the same actual-state.json and
 * target-run.json as the in-memory transport, plus what really happened on Kafka.
 */
export async function deliverKafka(inputs: DeliveryInputs, options: KafkaOptions, io: CliIo): Promise<number> {
  const { outDirectory } = inputs;
  let delivery;
  try {
    delivery = await deliverThroughKafka({
      events: inputs.events,
      attempts: inputs.attempts,
      epochUnixMs: parseUtcInstant(inputs.manifest.simulation.epoch),
      windowing: inputs.windowing,
      brokers: options.brokers,
      speed: options.speed,
      timeoutMs: options.timeoutMs,
      consumer: { type: 'reference', target: inputs.targetName, partitions: options.partitions },
      workDirectory: outDirectory,
    });
  } catch (error) {
    throw asUnavailable(error, options);
  }
  const { kafkaRun, execution, consumed } = delivery;
  if (consumed === undefined || kafkaRun.consumer === null) {
    throw new UnavailableError('The reference consumer reported no state.');
  }
  const { report } = consumed;
  const { targetRun } = deliveredStateFromConsumer({
    manifest: inputs.manifest,
    summaryFile: inputs.summaryFile,
    windowing: inputs.windowing,
    consumed,
    plannedFailures: execution.plannedFailures,
  });
  writeTargetRun(outDirectory, targetRun);
  writeRunFile(outDirectory, KAFKA_DELIVERY_FILES.deliveryLog, delivery.deliveryLogText);
  writeRunFile(outDirectory, KAFKA_DELIVERY_FILES.kafkaRun, delivery.kafkaRunText);

  const { kafka, consumer } = kafkaRun;
  printDeliveryHeader(io, inputs, `DataForge deliver: target ${report.target.name} (${report.target.description}), through Kafka`);
  io.out(`  kafka       ${kafka.brokers.join(',')} (cluster ${kafka.clusterId}), topic ${kafka.topic} (${kafka.partitions} partition${kafka.partitions === 1 ? '' : 's'})`);
  io.out(`  consumer    process ${consumer.pid}, group ${kafka.groupId}, joined after ${seconds(consumer.joinedAfterMs)} (partitions ${consumer.assignedPartitions.join(', ')})`);
  io.out(
    `  sent        ${formatCount(execution.sent)} records, ${formatCount(execution.plannedFailures)} planned failures not sent; ` +
      (options.speed === 'max'
        ? `speed max, ${seconds(execution.durationMs)}`
        : `speed ${options.speed}x, ${seconds(execution.durationMs)}, largest drift ${formatCount(execution.maxDriftMs ?? 0)} ms`),
  );
  io.out(`  completion  consumer-group lag 0, ${seconds(kafkaRun.completion.lagZeroAfterMs)} after the last record`);
  if (report.kafkaRedeliveries > 0) {
    io.out(`  WARNING     Kafka handed ${formatCount(report.kafkaRedeliveries)} records to the consumer twice (at-least-once delivery after a rebalance)`);
  }
  printDeliveryOutcome(io, inputs, targetRun, [
    `${KAFKA_DELIVERY_FILES.deliveryLog}, ${KAFKA_DELIVERY_FILES.kafkaRun}, ${CONSUMER_FILES.report}, ${CONSUMER_FILES.processingLog}`,
    `${KAFKA_DELIVERY_FILES.producerLog}, ${KAFKA_DELIVERY_FILES.consumerLog} (the Kafka client logs of both processes)`,
  ]);
  return EXIT_OK;
}

/** Infrastructure failures become exit code 3 with what to do; anything else propagates. */
function asUnavailable(error: unknown, options: KafkaOptions): unknown {
  if (error instanceof KafkaUnavailableError) {
    return new UnavailableError(`${error.message}\n${START_KAFKA}`);
  }
  if (error instanceof ConsumerProcessError || error instanceof ExternalPipelineError) {
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

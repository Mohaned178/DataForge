import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serializeActualState } from '@dataforge/core';
import { BrokerListError, DEFAULT_BROKERS, parseBrokers, type Speed } from '@dataforge/kafka';
import { REFERENCE_TARGETS, createReferenceTarget, deliverInMemory, type ReferenceTargetName } from '@dataforge/targets';
import { EXIT_OK, UsageError, type CliIo } from '../cli-io';
import { DELIVERY_FILES, buildTargetRun } from '../delivery-directory';
import { printDeliveryHeader, printDeliveryOutcome, writeTargetRun, type DeliveryInputs, type KafkaOptions } from '../delivery-output';
import { readPlanForRun } from '../plan-directory';
import { prepareOutputDirectory, readIntactCanonicalLog, readManifest, samePath, writeRunFile } from '../run-directory';
import { deliverThroughKafka } from './deliver-kafka';

export const TRANSPORTS = ['memory', 'kafka'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const DELIVER_USAGE =
  `dataforge deliver --run <directory> --plan <directory> --target ${REFERENCE_TARGETS.join('|')} --out <directory> [--force]\n` +
  '                    [--transport memory|kafka] [--brokers <host:port,...>] [--speed <factor>|max] [--partitions <n>] [--timeout <seconds>]';

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_PARTITIONS = 64;


/** Plays a delivery plan into a reference target, in process or through Kafka, and writes the state the target ends in. */
export function runDeliver(args: readonly string[], io: CliIo): number | Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      run: { type: 'string' },
      plan: { type: 'string' },
      target: { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean', default: false },
      transport: { type: 'string', default: 'memory' },
      brokers: { type: 'string' },
      speed: { type: 'string' },
      partitions: { type: 'string' },
      timeout: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.run === undefined || values.plan === undefined || values.target === undefined || values.out === undefined) {
    throw new UsageError(`Missing required option.\nUsage: ${DELIVER_USAGE}`);
  }
  const targetName = values.target;
  if (!isReferenceTarget(targetName)) {
    throw new UsageError(`Unknown target "${targetName}". Reference targets: ${REFERENCE_TARGETS.join(', ')}.`);
  }
  const transport = values.transport;
  if (!(TRANSPORTS as readonly string[]).includes(transport)) {
    throw new UsageError(`Unknown transport "${transport}". Transports: ${TRANSPORTS.join(', ')}.`);
  }
  const kafkaOptions = transport === 'kafka' ? parseKafkaOptions(values) : undefined;
  if (kafkaOptions === undefined) {
    const given = (['brokers', 'speed', 'partitions', 'timeout'] as const).filter((name) => values[name] !== undefined);
    if (given.length > 0) {
      throw new UsageError(`${given.map((name) => `--${name}`).join(', ')} ${given.length === 1 ? 'applies' : 'apply'} only to --transport kafka.`);
    }
  }

  const runDirectory = resolve(values.run);
  const planDirectory = resolve(values.plan);
  const outDirectory = resolve(values.out);
  const manifest = readManifest(runDirectory);
  const { events } = readIntactCanonicalLog(runDirectory, manifest);
  const { summaryFile, attempts } = readPlanForRun(planDirectory, manifest);
  if (samePath(outDirectory, runDirectory) || samePath(outDirectory, planDirectory)) {
    throw new UsageError('--out must be its own directory: the run and the plan it consumed stay untouched.');
  }
  prepareOutputDirectory(outDirectory, values.force, 'delivery files');
  const inputs: DeliveryInputs = {
    targetName,
    runDirectory,
    planDirectory,
    outDirectory,
    manifest,
    events,
    summaryFile,
    attempts,
    typed: { run: values.run, plan: values.plan, out: values.out },
  };
  return kafkaOptions === undefined ? deliverInProcess(inputs, io) : deliverThroughKafka(inputs, kafkaOptions, io);
}

function deliverInProcess(inputs: DeliveryInputs, io: CliIo): number {
  const target = createReferenceTarget(inputs.targetName);
  const result = deliverInMemory({ events: inputs.events, attempts: inputs.attempts, target });
  const actualStateText = serializeActualState(result.actualState);
  const targetRun = buildTargetRun({
    target,
    manifest: inputs.manifest,
    summaryFile: inputs.summaryFile,
    delivery: { messages: result.messages, distinctEvents: result.distinctEvents, redeliveries: result.redeliveries, failedAttempts: result.failedAttempts },
    counters: result.counters,
    parkedEventIds: result.parkedEventIds,
    actualStateText,
  });
  writeRunFile(inputs.outDirectory, DELIVERY_FILES.actualState, actualStateText);
  writeTargetRun(inputs.outDirectory, targetRun);

  printDeliveryHeader(io, inputs, `DataForge deliver: target ${target.name} (${target.description})`);
  printDeliveryOutcome(io, inputs, targetRun, []);
  return EXIT_OK;
}

function parseKafkaOptions(values: { brokers?: string | undefined; speed?: string | undefined; partitions?: string | undefined; timeout?: string | undefined }): KafkaOptions {
  let brokers: string[];
  try {
    brokers = parseBrokers(values.brokers ?? process.env.KAFKA_BROKERS ?? DEFAULT_BROKERS);
  } catch (error) {
    if (error instanceof BrokerListError) {
      throw new UsageError(`${error.message}${values.brokers === undefined ? ' (from KAFKA_BROKERS)' : ''}`);
    }
    throw error;
  }
  return {
    brokers,
    speed: parseSpeed(values.speed),
    partitions: parseWholeNumber(values.partitions, 'partitions', 1, 1, MAX_PARTITIONS),
    timeoutMs: parseWholeNumber(values.timeout, 'timeout', DEFAULT_TIMEOUT_SECONDS, 1, 3600) * 1000,
  };
}

/** `max` (the default), or simulation milliseconds per wall-clock millisecond, for example 3600 (an hour a second). */
export function parseSpeed(text: string | undefined): Speed {
  if (text === undefined || text === 'max') {
    return 'max';
  }
  const speed = /^\d{1,10}(\.\d{1,6})?$/.test(text) ? Number(text) : NaN;
  if (!(speed > 0)) {
    throw new UsageError(`--speed must be "max" or a positive number of simulated milliseconds per real millisecond (for example 3600), got "${text}".`);
  }
  return speed;
}

function parseWholeNumber(text: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (text === undefined) {
    return fallback;
  }
  const value = /^\d{1,6}$/.test(text) ? Number(text) : NaN;
  if (!(value >= min && value <= max)) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}, got "${text}".`);
  }
  return value;
}

function isReferenceTarget(name: string): name is ReferenceTargetName {
  return (REFERENCE_TARGETS as readonly string[]).includes(name);
}

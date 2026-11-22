import { parseArgs } from 'node:util';
import { windowingSpecSchema, type WindowingSpec } from '@dataforge/core';
import { DEFAULT_BROKERS, parseBrokers } from '@dataforge/kafka';
import { REFERENCE_TARGETS, type ReferenceTargetName } from '@dataforge/targets';

export const CONSUMER_USAGE =
  `dataforge-consumer --topic <topic> --group <consumer group> --target ${REFERENCE_TARGETS.join('|')} --out <directory> ` +
  '[--brokers <host:port,...>] [--window-size-ms <ms> [--allowed-lateness-ms <ms>]] [--force]';

export interface ConsumerOptions {
  readonly brokers: readonly string[];
  readonly topic: string;
  readonly groupId: string;
  readonly target: ReferenceTargetName;
  readonly out: string;
  readonly force: boolean;
  /** With a windowing contract, the target also computes per-window metrics (actual-windows.json). */
  readonly windowing: WindowingSpec | undefined;
}

export class ConsumerUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerUsageError';
  }
}

const TOPIC_PATTERN = /^[A-Za-z0-9._-]{1,249}$/;

/** Parses the consumer's command line; brokers come from --brokers, then KAFKA_BROKERS, then localhost:9092. */
export function parseConsumerOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ConsumerOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        brokers: { type: 'string' },
        topic: { type: 'string' },
        group: { type: 'string' },
        target: { type: 'string' },
        out: { type: 'string' },
        force: { type: 'boolean', default: false },
        'window-size-ms': { type: 'string' },
        'allowed-lateness-ms': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ConsumerUsageError(`${(error as Error).message}\nUsage: ${CONSUMER_USAGE}`);
  }
  const { topic, group, target, out } = values;
  if (topic === undefined || group === undefined || target === undefined || out === undefined) {
    throw new ConsumerUsageError(`Missing required option.\nUsage: ${CONSUMER_USAGE}`);
  }
  if (!TOPIC_PATTERN.test(topic)) {
    throw new ConsumerUsageError(`Invalid topic "${topic}": use 1-249 characters from A-Z, a-z, 0-9, ".", "_" and "-".`);
  }
  if (!(REFERENCE_TARGETS as readonly string[]).includes(target)) {
    throw new ConsumerUsageError(`Unknown target "${target}". Reference targets: ${REFERENCE_TARGETS.join(', ')}.`);
  }
  let brokers: string[];
  try {
    brokers = parseBrokers(values.brokers ?? env.KAFKA_BROKERS ?? DEFAULT_BROKERS);
  } catch (error) {
    throw new ConsumerUsageError((error as Error).message);
  }
  return { brokers, topic, groupId: group, target: target as ReferenceTargetName, out, force: values.force, windowing: parseWindowing(values) };
}

function parseWindowing(values: { 'window-size-ms'?: string | undefined; 'allowed-lateness-ms'?: string | undefined }): WindowingSpec | undefined {
  const size = values['window-size-ms'];
  const lateness = values['allowed-lateness-ms'];
  if (size === undefined) {
    if (lateness !== undefined) {
      throw new ConsumerUsageError('--allowed-lateness-ms needs --window-size-ms.');
    }
    return undefined;
  }
  const number = (text: string) => (/^\d{1,12}$/.test(text) ? Number(text) : NaN);
  const parsed = windowingSpecSchema.safeParse({ sizeMs: number(size), allowedLatenessMs: lateness === undefined ? 0 : number(lateness) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConsumerUsageError(`Invalid windowing: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`);
  }
  return parsed.data;
}

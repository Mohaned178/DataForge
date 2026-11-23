import { readFileSync } from 'node:fs';
import { AssignerProtocol, Kafka, Partitioners, logLevel, type Admin, type LogEntry, type Producer } from 'kafkajs';
import type { RecordSender, SentRecord, WallClock } from './executor';
import { consumerGroupLag, type GroupLag } from './lag';
import type { DeliveryRecord } from './record';

export type { Admin as KafkaAdmin, Kafka as KafkaClient, Producer as KafkaProducer } from 'kafkajs';

/** The Kafka client library and its installed version, recorded with every Kafka delivery. */
export const KAFKA_CLIENT = `kafkajs ${(JSON.parse(readFileSync(require.resolve('kafkajs/package.json'), 'utf8')) as { version: string }).version}`;

const LEVEL_NAMES: Record<number, string> = {
  [logLevel.ERROR]: 'ERROR',
  [logLevel.WARN]: 'WARN',
  [logLevel.INFO]: 'INFO',
  [logLevel.DEBUG]: 'DEBUG',
};

/** A line-oriented sink for the Kafka client's own log (one JSON object per line). */
export type ClientLogSink = (line: string) => void;

export const systemClock: WallClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A KafkaJS client whose log goes to `log` instead of the console, so the CLI's own output stays
 * readable; the client retries on its own for a few seconds before an operation fails.
 */
export function createKafkaClient(options: { brokers: readonly string[]; clientId: string; log: ClientLogSink }): Kafka {
  return new Kafka({
    clientId: options.clientId,
    brokers: [...options.brokers],
    connectionTimeout: 3000,
    retry: { initialRetryTime: 250, retries: 4 },
    logLevel: logLevel.INFO,
    logCreator: () => (entry: LogEntry) => {
      const { timestamp, message, ...extra } = entry.log;
      options.log(JSON.stringify({ timestamp, level: LEVEL_NAMES[entry.level] ?? String(entry.level), logger: entry.namespace, message, ...extra }));
    },
  });
}

export class KafkaUnavailableError extends Error {
  constructor(
    readonly brokers: readonly string[],
    cause: unknown,
  ) {
    super(`Kafka is not reachable at ${brokers.join(', ')}: ${describeClientError(cause)}`, { cause });
    this.name = 'KafkaUnavailableError';
  }
}

/**
 * KafkaJS wraps socket errors (KafkaJSNumberOfRetriesExceeded > KafkaJSConnectionError > the socket
 * error), and on Node 24 a refused "localhost" is an AggregateError with an empty message. The
 * message of the outer error plus the first error code found inside (for example ECONNREFUSED)
 * says what happened.
 */
export function describeClientError(error: unknown): string {
  const top = (error instanceof Object && 'message' in error ? String(error.message) : String(error)).replace(/[:\s]+$/, '');
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!(current instanceof Object) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      return `${top || 'connection failed'} (${current.code})`;
    }
    for (const key of ['originalError', 'cause', 'errors'] as const) {
      if (key in current) {
        const inner = (current as Record<string, unknown>)[key];
        pending.push(...(Array.isArray(inner) ? (inner as unknown[]) : [inner]));
      }
    }
  }
  return top || 'connection failed';
}

/** Connects an admin client and asks the cluster to describe itself; any failure means Kafka is unavailable. */
export async function connectAdmin(kafka: Kafka, brokers: readonly string[]): Promise<{ admin: Admin; brokerCount: number; clusterId: string }> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    const cluster = await admin.describeCluster();
    return { admin, brokerCount: cluster.brokers.length, clusterId: cluster.clusterId };
  } catch (error) {
    await admin.disconnect().catch(() => undefined);
    throw new KafkaUnavailableError(brokers, error);
  }
}

/** Creates a new, empty topic and waits until every partition has a leader. */
export async function createDeliveryTopic(admin: Admin, topic: string, partitions: number): Promise<void> {
  const created = await admin.createTopics({ topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }], waitForLeaders: true });
  if (!created) {
    throw new Error(`Topic ${topic} already exists; every delivery needs a new, empty topic.`);
  }
}

/** The number of partitions of a topic, or undefined when the cluster has no such topic. */
export async function describeTopicPartitions(admin: Admin, topic: string): Promise<number | undefined> {
  const topics = await admin.listTopics();
  if (!topics.includes(topic)) {
    return undefined;
  }
  const { topics: metadata } = await admin.fetchTopicMetadata({ topics: [topic] });
  return metadata.find((entry) => entry.name === topic)?.partitions.length ?? 0;
}

/** A consumer group as the broker describes it: its state and the topics each member subscribes to. */
export interface ConsumerGroupDescription {
  readonly groupId: string;
  /** Kafka's group state, for example Stable, Empty, Dead (a group that does not exist), PreparingRebalance. */
  readonly state: string;
  /** One entry per active member; `topics` is undefined when its subscription could not be decoded. */
  readonly members: readonly { readonly clientId: string; readonly topics: readonly string[] | undefined }[];
}

export async function describeConsumerGroup(admin: Admin, groupId: string): Promise<ConsumerGroupDescription> {
  const { groups } = await admin.describeGroups([groupId]);
  const group = groups.find((entry) => entry.groupId === groupId);
  if (group === undefined) {
    return { groupId, state: 'Dead', members: [] };
  }
  return {
    groupId,
    state: group.state,
    members: group.members.map((member) => ({ clientId: member.clientId, topics: subscribedTopics(member.memberMetadata) })),
  };
}

/** The consumer protocol's member metadata names the subscribed topics (any client that speaks the consumer protocol). */
function subscribedTopics(metadata: Buffer): string[] | undefined {
  try {
    const decoded = AssignerProtocol.MemberMetadata.decode(metadata);
    return decoded === null ? undefined : [...decoded.topics];
  } catch {
    return undefined;
  }
}

export async function fetchGroupLag(admin: Admin, groupId: string, topic: string): Promise<GroupLag> {
  const [ends, committed] = await Promise.all([admin.fetchTopicOffsets(topic), admin.fetchOffsets({ groupId, topics: [topic] })]);
  const partitions = committed.find((entry) => entry.topic === topic)?.partitions ?? [];
  return consumerGroupLag(ends, partitions);
}

export class LagTimeoutError extends Error {
  constructor(
    readonly lag: GroupLag,
    timeoutMs: number,
  ) {
    const detail = lag.partitions.map((partition) => `partition ${partition.partition}: ${partition.lag}`).join(', ');
    super(`The consumer group still had a lag of ${lag.total} records after ${timeoutMs} ms (${detail}).`);
    this.name = 'LagTimeoutError';
  }
}

/**
 * Polls the consumer group's lag until it is zero: the group has committed, and so handled, every
 * record in the topic. Throws LagTimeoutError with the last lag when the timeout passes first.
 */
export async function waitForZeroLag(
  admin: Admin,
  options: { groupId: string; topic: string; timeoutMs: number; pollMs?: number; clock?: WallClock; isAborted?: () => boolean; signal?: AbortSignal },
): Promise<{ waitedMs: number; polls: number }> {
  const clock = options.clock ?? systemClock;
  const started = clock.now();
  let polls = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const lag = await fetchGroupLag(admin, options.groupId, options.topic);
    polls += 1;
    if (lag.total === 0) {
      return { waitedMs: clock.now() - started, polls };
    }
    if (clock.now() - started >= options.timeoutMs || options.isAborted?.() === true) {
      throw new LagTimeoutError(lag, options.timeoutMs);
    }
    await clock.sleep(options.pollMs ?? 100);
  }
}

/**
 * An idempotent producer with one request in flight: every record is acknowledged by the broker
 * before the next is sent, so the records of each key are stored exactly in send order, once.
 * Keys are partitioned with Kafka's default (murmur2) partitioner, as the Java client does.
 */
export function createIdempotentProducer(kafka: Kafka): Producer {
  return kafka.producer({ idempotent: true, maxInFlightRequests: 1, createPartitioner: Partitioners.DefaultPartitioner });
}

export class KafkaRecordSender implements RecordSender {
  constructor(
    private readonly producer: Producer,
    private readonly topic: string,
  ) {}

  async send(record: DeliveryRecord): Promise<SentRecord> {
    const [metadata] = await this.producer.send({
      topic: this.topic,
      acks: -1,
      messages: [{ key: record.key, value: record.value, headers: { ...record.headers } }],
    });
    const offset = metadata?.baseOffset ?? metadata?.offset;
    if (metadata === undefined || offset === undefined) {
      throw new Error(`The broker acknowledged a record for ${this.topic} without an offset.`);
    }
    return { partition: metadata.partition, offset };
  }
}

/**
 * KafkaJS 2.2.4 sometimes arms a timer with a negative delay, which Node 24 reports as a
 * TimeoutNegativeWarning (Node then uses 1 ms, which is what KafkaJS meant). Every other process
 * warning is still printed. Call once, from a process entry point, before using the client.
 */
export function silenceKafkaClientTimerWarning(): void {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name !== 'TimeoutNegativeWarning') {
      process.stderr.write(`${warning.name}: ${warning.message}\n`);
    }
  });
}

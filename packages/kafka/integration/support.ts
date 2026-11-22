import { randomBytes } from 'node:crypto';
import { DEFAULT_BROKERS, connectAdmin, createDeliveryTopic, createKafkaClient, parseBrokers, type KafkaAdmin, type KafkaClient } from '../src';

export const brokers = parseBrokers(process.env.KAFKA_BROKERS ?? DEFAULT_BROKERS);

/** A client whose log is kept in memory; printed only when a test needs to explain a failure. */
export function testClient(name: string): { kafka: KafkaClient; log: string[] } {
  const log: string[] = [];
  return { kafka: createKafkaClient({ brokers, clientId: `dataforge-it-${name}`, log: (line) => log.push(line) }), log };
}

export async function admin(kafka: KafkaClient): Promise<KafkaAdmin> {
  return (await connectAdmin(kafka, brokers)).admin;
}

/** A new topic and group name per test, so tests never see each other's records. */
export async function freshTopic(kafkaAdmin: KafkaAdmin, label: string, partitions: number): Promise<{ topic: string; groupId: string }> {
  const id = `${label}-${randomBytes(4).toString('hex')}`;
  const topic = `dataforge-it.${id}`;
  await createDeliveryTopic(kafkaAdmin, topic, partitions);
  return { topic, groupId: `dataforge-it-group.${id}` };
}

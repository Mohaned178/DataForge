export const DEFAULT_BROKERS = 'localhost:9092';

export class BrokerListError extends Error {
  constructor(text: string, detail: string) {
    super(`Invalid Kafka broker list "${text}": ${detail}. Use host:port, comma-separated (for example localhost:9092).`);
    this.name = 'BrokerListError';
  }
}

const BROKER_PATTERN = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/;

/** Parses "host:port,host:port" (from --brokers or KAFKA_BROKERS) into a validated list. */
export function parseBrokers(text: string): string[] {
  const brokers = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (brokers.length === 0) {
    throw new BrokerListError(text, 'no broker given');
  }
  for (const broker of brokers) {
    const match = BROKER_PATTERN.exec(broker);
    const port = match === null ? NaN : Number(match[2]);
    if (match === null || port < 1 || port > 65535) {
      throw new BrokerListError(text, `"${broker}" is not host:port`);
    }
  }
  return brokers;
}

import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BrokerListError, DEFAULT_BROKERS, parseBrokers } from '@dataforge/kafka';
import { z } from 'zod';

/** The Compose PostgreSQL service (compose.yaml), used when DATABASE_URL is not set. */
export const DEFAULT_DATABASE_URL = 'postgresql://dataforge:dataforge@localhost:5433/dataforge';

export const API_CONFIG = Symbol('API_CONFIG');

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  /** The Kafka cluster that Kafka executions deliver through; the API starts without it. */
  readonly kafkaBrokers: readonly string[];
  /** Where each Kafka execution keeps its consumer output and Kafka client logs, one directory per execution. */
  readonly executionWorkDirectory: string;
}

/** EXECUTION_WORK_DIR when it is not set. */
export const DEFAULT_EXECUTION_WORK_DIR = join(tmpdir(), 'dataforge-executions');

/** An empty variable counts as unset, as it does for the CLI's KAFKA_BROKERS. */
const unsetIfEmpty = (value: unknown) => (value === '' ? undefined : value);

const environmentSchema = z.object({
  DATABASE_URL: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .default(DEFAULT_DATABASE_URL)
      .refine((url) => /^postgres(ql)?:\/\/[^/\s]+\/[^/\s?]+/.test(url), {
        error: 'must be a PostgreSQL URL such as postgresql://user:password@localhost:5433/dataforge',
      }),
  ),
  API_HOST: z.preprocess(unsetIfEmpty, z.string().default('127.0.0.1')),
  API_PORT: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(0).max(65_535).default(3000)),
  KAFKA_BROKERS: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .default(DEFAULT_BROKERS)
      .transform((text, ctx) => {
        try {
          return parseBrokers(text);
        } catch (error) {
          ctx.addIssue({ code: 'custom', message: error instanceof BrokerListError ? error.message : String(error) });
          return z.NEVER;
        }
      }),
  ),
  EXECUTION_WORK_DIR: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .default(DEFAULT_EXECUTION_WORK_DIR)
      .refine((path) => isAbsolute(path), { error: 'must be an absolute directory path' }),
  ),
});

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid API configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Reads the API's configuration from environment variables (see .env.example). */
export function loadApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`));
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    host: result.data.API_HOST,
    port: result.data.API_PORT,
    kafkaBrokers: result.data.KAFKA_BROKERS,
    executionWorkDirectory: result.data.EXECUTION_WORK_DIR,
  };
}

/** host:port/database of a database URL, without its credentials, for messages and logs. */
export function describeDatabase(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

import { z } from 'zod';

/** The Compose PostgreSQL service (compose.yaml), used when DATABASE_URL is not set. */
export const DEFAULT_DATABASE_URL = 'postgresql://dataforge:dataforge@localhost:5433/dataforge';

export const API_CONFIG = Symbol('API_CONFIG');

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
}

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
  return { databaseUrl: result.data.DATABASE_URL, host: result.data.API_HOST, port: result.data.API_PORT };
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

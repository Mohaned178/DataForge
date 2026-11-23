import { resolve } from 'node:path';
import { ConfigError, DEFAULT_DATABASE_URL, DEFAULT_EXECUTION_WORK_DIR, describeDatabase, loadApiConfig } from '../src/config';
import { listRunsQuerySchema, runEventsQuerySchema, startRunSchema } from '../src/runs/run-requests';

const SCENARIO_ID = '01a2059d-1421-7651-8848-976194c3e863';

function issues(result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }): string[] {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
}

describe('API configuration', () => {
  it('defaults to the Compose database on 127.0.0.1:3000 and the Compose broker', () => {
    expect(loadApiConfig({})).toEqual({
      databaseUrl: DEFAULT_DATABASE_URL,
      host: '127.0.0.1',
      port: 3000,
      kafkaBrokers: ['localhost:9092'],
      executionWorkDirectory: DEFAULT_EXECUTION_WORK_DIR,
    });
    expect(loadApiConfig({ DATABASE_URL: '', API_PORT: '', KAFKA_BROKERS: '', EXECUTION_WORK_DIR: '' })).toEqual(loadApiConfig({}));
  });

  it('reads DATABASE_URL, API_HOST, API_PORT, KAFKA_BROKERS and EXECUTION_WORK_DIR', () => {
    const workDirectory = resolve('work', 'executions');
    expect(
      loadApiConfig({
        DATABASE_URL: 'postgres://u:p@db:6543/other',
        API_HOST: '0.0.0.0',
        API_PORT: '8080',
        KAFKA_BROKERS: 'broker-1:9092, broker-2:19092',
        EXECUTION_WORK_DIR: workDirectory,
      }),
    ).toEqual({
      databaseUrl: 'postgres://u:p@db:6543/other',
      host: '0.0.0.0',
      port: 8080,
      kafkaBrokers: ['broker-1:9092', 'broker-2:19092'],
      executionWorkDirectory: workDirectory,
    });
  });

  it('rejects a broker list that is not host:port and a relative work directory', () => {
    let caught: unknown;
    try {
      loadApiConfig({ KAFKA_BROKERS: 'localhost', EXECUTION_WORK_DIR: 'out/executions' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues).toEqual([
      'KAFKA_BROKERS: Invalid Kafka broker list "localhost": "localhost" is not host:port. Use host:port, comma-separated (for example localhost:9092).',
      'EXECUTION_WORK_DIR: must be an absolute directory path',
    ]);
  });

  it('rejects an invalid port and a database URL that is not PostgreSQL, naming each variable', () => {
    expect(() => loadApiConfig({ API_PORT: 'eighty', DATABASE_URL: 'mysql://localhost/x' })).toThrow(ConfigError);
    let caught: unknown;
    try {
      loadApiConfig({ API_PORT: '70000', DATABASE_URL: 'localhost:5433' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues).toEqual([
      'DATABASE_URL: must be a PostgreSQL URL such as postgresql://user:password@localhost:5433/dataforge',
      'API_PORT: Too big: expected number to be <=65535',
    ]);
  });

  it('describes a database without its credentials', () => {
    expect(describeDatabase('postgresql://dataforge:secret@localhost:5433/dataforge')).toBe('localhost:5433/dataforge');
  });
});

describe('POST /runs body', () => {
  it('normalises the seed like the CLI: 42 and "42" are the same seed', () => {
    expect(startRunSchema.parse({ scenarioId: SCENARIO_ID, seed: 42 })).toEqual({ scenarioId: SCENARIO_ID, seed: '42' });
    expect(startRunSchema.parse({ scenarioId: SCENARIO_ID, seed: '42', version: 2 })).toEqual({ scenarioId: SCENARIO_ID, seed: '42', version: 2 });
  });

  it('rejects a bad seed, id, version and unknown fields with their paths', () => {
    expect(issues(startRunSchema.safeParse({ scenarioId: 'x', seed: 'two words', version: 0, extra: true }))).toEqual([
      'scenarioId: must be a scenario id (a UUID)',
      'version: Too small: expected number to be >=1',
      'seed: Invalid seed "two words": use 1-128 characters from A-Z, a-z, 0-9, ".", "_", ":" and "-"',
      ': Unrecognized key: "extra"',
    ]);
    expect(issues(startRunSchema.safeParse({ scenarioId: SCENARIO_ID, seed: 1.5 }))).toEqual(['seed: Invalid seed "1.5": use 1-128 characters from A-Z, a-z, 0-9, ".", "_", ":" and "-"']);
    expect(issues(startRunSchema.safeParse({ scenarioId: SCENARIO_ID }))).toEqual(['seed: must be a string or a whole number']);
  });
});

describe('query strings', () => {
  it('pages run history 50 at a time by default, at most 200', () => {
    expect(listRunsQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(listRunsQuerySchema.parse({ status: 'failed', limit: '5', offset: '10' })).toEqual({ status: 'failed', limit: 5, offset: 10 });
    expect(issues(listRunsQuerySchema.safeParse({ limit: '201', status: 'done' }))).toEqual([
      'status: Invalid option: expected one of "queued"|"running"|"succeeded"|"failed"',
      'limit: Too big: expected number to be <=200',
    ]);
  });

  it('filters events by type, aggregate and sequence, 100 at a time by default, at most 1,000', () => {
    expect(runEventsQuerySchema.parse({})).toEqual({ fromSequence: 1, limit: 100 });
    expect(runEventsQuerySchema.parse({ type: 'OrderCreated', aggregateId: 'ord_000001', fromSequence: '7', limit: '1000' })).toEqual({
      type: 'OrderCreated',
      aggregateId: 'ord_000001',
      fromSequence: 7,
      limit: 1000,
    });
    expect(issues(runEventsQuerySchema.safeParse({ type: 'OrderShipped', fromSequence: '0', unknown: 'x' }))).toHaveLength(3);
  });
});

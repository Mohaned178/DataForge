import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BROKERS, parseBrokers } from '@dataforge/kafka';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApiApplication } from '../src/app';
import type { ApiConfig } from '../src/config';
import { PrismaService } from '../src/database/prisma.service';
import { ExecutionRunner } from '../src/executions/execution-runner';
import type { ExecutionView } from '../src/executions/execution-views';
import { RunRunner } from '../src/runs/run-runner';
import type { RunView } from '../src/runs/run-views';

export const REPOSITORY = join(__dirname, '..', '..', '..');
export const SCENARIOS = join(REPOSITORY, 'scenarios');
export const API_MAIN = join(REPOSITORY, 'apps', 'api', 'dist', 'main.js');
export const CLI_MAIN = join(REPOSITORY, 'apps', 'cli', 'dist', 'main.js');

/** Drops, recreates and (unless told not to) migrates a scratch database (apps/api/scripts/recreate-database.js). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const { recreateDatabase } = require('../scripts/recreate-database.js') as {
  recreateDatabase: (url: string, options?: { migrate?: boolean }) => Promise<void>;
};

/** Set by the global setup, which recreated and migrated it (apps/api/integration/global-setup.js). */
export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined) {
    throw new Error('TEST_DATABASE_URL is not set: run these tests with pnpm test:integration');
  }
  return url;
}

/** Kafka executions of the tests keep their consumer output and logs here (cleared by the global setup's caller, never the user's). */
export const TEST_EXECUTION_WORK_DIR = join(tmpdir(), 'dataforge-api-test-executions');

export function testConfig(databaseUrl = testDatabaseUrl(), overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    databaseUrl,
    host: '127.0.0.1',
    port: 0,
    kafkaBrokers: parseBrokers(process.env['KAFKA_BROKERS'] ?? DEFAULT_BROKERS),
    executionWorkDirectory: TEST_EXECUTION_WORK_DIR,
    ...overrides,
  };
}

export interface TestApi {
  readonly app: INestApplication;
  readonly http: ReturnType<typeof request>;
  readonly prisma: PrismaService;
  readonly runner: RunRunner;
  readonly executions: ExecutionRunner;
  close(): Promise<void>;
}

/** The real application (Nest, Prisma, PostgreSQL), initialised like main.ts does, without a port. */
export async function startApi(overrides: Partial<ApiConfig> = {}): Promise<TestApi> {
  const app = await createApiApplication(testConfig(testDatabaseUrl(), overrides), { logger: false, shutdownHooks: false });
  await app.init();
  const server = app.getHttpServer() as App;
  return {
    app,
    http: request(server),
    prisma: app.get(PrismaService),
    runner: app.get(RunRunner),
    executions: app.get(ExecutionRunner),
    close: () => app.close(),
  };
}

export async function clearDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE scenario, scenario_version, simulation_run, canonical_event, expected_state_snapshot, chaos_profile, chaos_profile_version, ' +
      'test_execution, delivery_attempt, execution_file, validation_report, validation_finding, window_finding CASCADE',
  );
}

export const CHAOS_PROFILES = join(REPOSITORY, 'chaos-profiles');

export function scenarioDocument(name: string): string {
  return readFileSync(join(SCENARIOS, `${name}.json`), 'utf8');
}

export function profileDocument(name: string): string {
  return readFileSync(join(CHAOS_PROFILES, `${name}.json`), 'utf8');
}

/** Registers an example scenario and generates a run of it, as a client would. */
export async function succeededRun(api: TestApi, scenario: string, seed: string): Promise<RunView> {
  const created = await api.http.post('/scenarios').set('Content-Type', 'application/json').send(scenarioDocument(scenario));
  const scenarioId = created.status === 201 ? (created.body as { id: string }).id : await existingId(api, '/scenarios', 'scenarios', scenario);
  const run = (await api.http.post('/runs').send({ scenarioId, seed }).expect(202)).body as RunView;
  const finished = await waitForRun(api, run.id, 120_000);
  expect(finished.status).toBe('succeeded');
  return finished;
}

/** Registers an example chaos profile (or finds it when it is registered already) and returns its id. */
export async function chaosProfileId(api: TestApi, name: string): Promise<string> {
  const created = await api.http.post('/chaos-profiles').set('Content-Type', 'application/json').send(profileDocument(name));
  const profileName = (JSON.parse(profileDocument(name)) as { name: string }).name;
  return created.status === 201 ? (created.body as { id: string }).id : existingId(api, '/chaos-profiles', 'chaosProfiles', profileName);
}

async function existingId(api: TestApi, path: string, key: string, name: string): Promise<string> {
  const list = (await api.http.get(path).expect(200)).body as Record<string, { id: string; name: string }[]>;
  const found = list[key]?.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`${name} is not registered at ${path}`);
  }
  return found.id;
}

/** Follows an execution through GET /executions/:id until it stops moving (completed, failed or awaiting its actual state). */
export async function waitForExecution(api: TestApi, executionId: string, timeoutMs = 120_000): Promise<ExecutionView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const execution = (await api.http.get(`/executions/${executionId}`).expect(200)).body as ExecutionView;
    if (execution.status !== 'queued' && execution.status !== 'running') {
      return execution;
    }
    if (Date.now() > deadline) {
      throw new Error(`execution ${executionId} is still ${execution.status} after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The exact bytes of a downloaded file. */
export async function downloadBytes(api: TestApi, path: string, status = 200): Promise<Buffer> {
  const response = await api.http
    .get(path)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    })
    .expect(status);
  return response.body as Buffer;
}

/** Follows a run through GET /runs/:id until it has finished, as a client of the API would. */
export async function waitForRun(api: TestApi, runId: string, timeoutMs = 60_000): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await api.http.get(`/runs/${runId}`).expect(200);
    const run = response.body as RunView;
    if (run.status === 'succeeded' || run.status === 'failed') {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} is still ${run.status} after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a built entry point (the API or the CLI) as its own process, from a directory without a .env. */
export function runNode(script: string, args: readonly string[], env: Record<string, string>, cwd: string, timeoutMs = 60_000): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} did not exit within ${timeoutMs} ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

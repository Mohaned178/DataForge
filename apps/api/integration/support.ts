import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApiApplication } from '../src/app';
import type { ApiConfig } from '../src/config';
import { PrismaService } from '../src/database/prisma.service';
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

export function testConfig(databaseUrl = testDatabaseUrl()): ApiConfig {
  return { databaseUrl, host: '127.0.0.1', port: 0 };
}

export interface TestApi {
  readonly app: INestApplication;
  readonly http: ReturnType<typeof request>;
  readonly prisma: PrismaService;
  readonly runner: RunRunner;
  close(): Promise<void>;
}

/** The real application (Nest, Prisma, PostgreSQL), initialised like main.ts does, without a port. */
export async function startApi(): Promise<TestApi> {
  const app = await createApiApplication(testConfig(), { logger: false, shutdownHooks: false });
  await app.init();
  const server = app.getHttpServer() as App;
  return {
    app,
    http: request(server),
    prisma: app.get(PrismaService),
    runner: app.get(RunRunner),
    close: () => app.close(),
  };
}

export async function clearDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE scenario, scenario_version, simulation_run, canonical_event, expected_state_snapshot CASCADE');
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

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_VERSION } from '@dataforge/core';
import { API_MAIN, recreateDatabase, runNode, testDatabaseUrl } from './support';

let workspace: string;
beforeAll(() => {
  // No .env here, so only the variables a test passes configure the process.
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-api-process-'));
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function withDatabase(name: string): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

describe('the API process (apps/api/dist/main.js)', () => {
  it('listens, answers /health and stops on request', async () => {
    const child = spawn(process.execPath, [API_MAIN], {
      cwd: workspace,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl(), API_PORT: '0', API_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`no "listening" line within 30 s:\n${output}`)), 30_000);
        const onData = (chunk: Buffer) => {
          output += chunk.toString('utf8');
          const match = /DataForge API listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (match?.[1] !== undefined) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => reject(new Error(`exited with ${String(code)}:\n${output}`)));
      });
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: 'ok', database: 'up', engineVersion: ENGINE_VERSION });
    } finally {
      child.kill();
    }
  });

  it('exits with code 3 and the command to run when PostgreSQL is unreachable', async () => {
    const url = new URL(testDatabaseUrl());
    url.port = '1';
    const result = await runNode(API_MAIN, [], { DATABASE_URL: url.toString(), API_PORT: '0' }, workspace);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`PostgreSQL is unavailable at ${url.hostname}:1/dataforge_test: connection refused (ECONNREFUSED)`);
    expect(result.stderr).toMatch(/Start it with "docker compose up -d --wait"/);
  });

  it('exits with code 3 and "pnpm db:migrate" when the database is not migrated', async () => {
    const empty = withDatabase('dataforge_test_unmigrated');
    await recreateDatabase(empty, { migrate: false });
    const result = await runNode(API_MAIN, [], { DATABASE_URL: empty, API_PORT: '0' }, workspace);
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/The database .*\/dataforge_test_unmigrated is not migrated \(pending: \d+_init\)/);
    expect(result.stderr).toMatch(/pnpm db:migrate/);
  });

  it('exits with code 2 and the variable at fault for an invalid configuration', async () => {
    const result = await runNode(API_MAIN, [], { DATABASE_URL: testDatabaseUrl(), API_PORT: 'eighty' }, workspace);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Invalid API configuration:\n {2}- API_PORT: /);
  });
});

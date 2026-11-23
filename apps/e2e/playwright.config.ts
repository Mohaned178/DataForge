import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, WEB_PORT, WEB_URL } from './support/constants';

/*
 * The end-to-end suite starts everything it tests, on its own: a scratch database (dataforge_e2e_test, dropped
 * and migrated every run), its own API and its own web server, on ports the other milestones' checks do not use.
 * Every setting is passed explicitly, so a developer's .env can never point the suite at real data, and no server
 * that is already running is ever reused. Needs PostgreSQL and Kafka (docker compose up -d --wait) and the
 * built applications (pnpm test:e2e builds first).
 */
const root = resolve(__dirname, '..', '..');
const databaseUrl = process.env['E2E_DATABASE_URL'] ?? 'postgresql://dataforge:dataforge@localhost:5433/dataforge_e2e_test';
const brokers = process.env['E2E_KAFKA_BROKERS'] ?? 'localhost:9092';

export default defineConfig({
  testDir: './tests',
  outputDir: resolve(root, 'out', 'e2e', 'test-results'),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // node directly, not through pnpm: stopping a pnpm wrapper on Windows can leave its child holding the port.
      command: 'node support/start-api.js',
      cwd: __dirname,
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        DATABASE_URL: databaseUrl,
        API_HOST: '127.0.0.1',
        API_PORT: String(API_PORT),
        KAFKA_BROKERS: brokers,
        EXECUTION_WORK_DIR: resolve(root, 'out', 'e2e', 'executions'),
      },
    },
    {
      command: `node ${JSON.stringify(resolve(root, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'))} preview`,
      cwd: resolve(root, 'apps', 'web'),
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        WEB_HOST: '127.0.0.1',
        WEB_PORT: String(WEB_PORT),
        WEB_API_URL: API_URL,
        API_HOST: '127.0.0.1',
        API_PORT: String(API_PORT),
      },
    },
  ],
});

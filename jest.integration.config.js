/**
 * Integration tests against real infrastructure (pnpm test:integration). They live in "integration"
 * folders, which the default `pnpm test` run does not match, and need the Compose services:
 * docker compose up -d --wait (Kafka and PostgreSQL). The global setup fails the whole run with that
 * instruction when either is unreachable, instead of skipping silently, and recreates the test
 * database (TEST_DATABASE_URL, by default dataforge_test).
 * @type {import('jest').Config}
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testMatch: ['**/integration/**/*.test.ts'],
  globalSetup: '<rootDir>/jest.integration.setup.js',
  testTimeout: 180000,
};

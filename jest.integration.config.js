/**
 * Integration tests against real infrastructure (pnpm test:integration). They live in "integration"
 * folders, which the default `pnpm test` run does not match, and need a Kafka broker:
 * docker compose up -d --wait. The global setup fails the whole run with that instruction when the
 * broker is unreachable, instead of skipping silently.
 * @type {import('jest').Config}
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testMatch: ['**/integration/**/*.test.ts'],
  globalSetup: '<rootDir>/packages/kafka/integration/global-setup.js',
  testTimeout: 180000,
};

// Runs once before the integration tests: recreates the test database (TEST_DATABASE_URL, by default
// dataforge_test on the Compose PostgreSQL) and applies the migrations, so every run starts empty and
// the development database is never touched.
const { recreateDatabase } = require('../scripts/recreate-database.js');

const DEFAULT_TEST_DATABASE_URL = 'postgresql://dataforge:dataforge@localhost:5433/dataforge_test';

function testDatabaseUrl() {
  return process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
}

module.exports = async function preparePostgres() {
  const url = testDatabaseUrl();
  try {
    await recreateDatabase(url);
  } catch (error) {
    const detail = error.errors?.map((inner) => inner.message).join('; ') || error.stderr?.toString().trim() || error.message;
    throw new Error(
      [
        '',
        'POSTGRESQL UNAVAILABLE: the integration tests need a running PostgreSQL and did not run.',
        `  ${new URL(url).host}: ${detail}`,
        '  Start it with:   docker compose up -d --wait',
        '  Then rerun:      pnpm test:integration',
        '',
      ].join('\n'),
      { cause: error },
    );
  }
  process.env.TEST_DATABASE_URL = url;
};

module.exports.testDatabaseUrl = testDatabaseUrl;

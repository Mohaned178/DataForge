// Starts the API for the end-to-end suite: first a clean, migrated scratch database (the name must end in
// "_test"; the recreate script refuses any other), then the API in this same process, so that stopping this
// process stops the API and leaves nothing holding the port. Configuration comes from the environment the
// Playwright configuration sets; the working directory is apps/e2e, which has no .env for the API to read.
const { recreateDatabase } = require('../../api/scripts/recreate-database.js');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('start-api: DATABASE_URL is not set (the Playwright configuration sets it).\n');
  process.exit(2);
}

recreateDatabase(databaseUrl).then(
  () => {
    require('../../api/dist/main.js');
  },
  (error) => {
    const detail = error && error.errors ? error.errors.map((inner) => inner.message).join('; ') : error && error.message;
    process.stderr.write(`start-api: could not prepare the database: ${detail}\nStart PostgreSQL with "docker compose up -d --wait".\n`);
    process.exit(3);
  },
);

// Drops and recreates a scratch database, then applies the migrations: a clean database for the
// integration tests (dataforge_test) and the Milestone 6 self-check (dataforge_selfcheck).
//   node apps/api/scripts/recreate-database.js <database-url> [--no-migrate]
// Only a database whose name ends in "_test" or "_selfcheck" (optionally followed by "_<suffix>") is
// ever dropped, so the development database "dataforge" cannot be wiped by mistake.
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { Client } = require('pg');

const API_DIRECTORY = resolve(__dirname, '..');
const SCRATCH_NAME = /^[a-z0-9_]+_(test|selfcheck)(_[a-z0-9]+)?$/;

/** The maintenance database on the same server, from which another database can be dropped and created. */
function maintenanceUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function databaseName(databaseUrl) {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

async function recreateDatabase(databaseUrl, { migrate = true } = {}) {
  const name = databaseName(databaseUrl);
  if (!SCRATCH_NAME.test(name)) {
    throw new Error(`Refusing to drop database "${name}": only scratch databases named like "dataforge_test" or "dataforge_selfcheck" are recreated.`);
  }
  const client = new Client({ connectionString: maintenanceUrl(databaseUrl) });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  if (migrate) {
    const prisma = require.resolve('prisma/build/index.js', { paths: [API_DIRECTORY] });
    execFileSync(process.execPath, [prisma, 'migrate', 'deploy'], {
      cwd: API_DIRECTORY,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
  }
}

module.exports = { recreateDatabase, databaseName };

if (require.main === module) {
  const [databaseUrl, ...flags] = process.argv.slice(2);
  if (databaseUrl === undefined) {
    process.stderr.write('Usage: node apps/api/scripts/recreate-database.js <database-url> [--no-migrate]\n');
    process.exit(2);
  }
  recreateDatabase(databaseUrl, { migrate: !flags.includes('--no-migrate') }).then(
    () => process.stdout.write(`Recreated ${databaseName(databaseUrl)}${flags.includes('--no-migrate') ? ' (empty)' : ' and applied the migrations'}.\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}

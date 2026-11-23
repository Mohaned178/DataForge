#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { ENGINE_VERSION } from '@dataforge/core';
import { silenceKafkaClientTimerWarning } from '@dataforge/kafka';
import { createApiApplication } from './app';
import { ConfigError, describeDatabase, loadApiConfig, type ApiConfig } from './config';
import { checkDatabase } from './database/database-status';
import { PrismaService } from './database/prisma.service';

/** Same exit codes as the CLI: 2 invalid configuration, 3 infrastructure unavailable. */
const EXIT_USAGE = 2;
const EXIT_UNAVAILABLE = 3;

const START_POSTGRES = 'Start it with "docker compose up -d --wait" (see compose.yaml), or point DATABASE_URL at a running PostgreSQL.';

async function main(): Promise<number> {
  // Optional configuration (see .env.example); variables already set in the environment win.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  let config: ApiConfig;
  try {
    config = loadApiConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const logger = new Logger('DataForgeApi');
  const database = describeDatabase(config.databaseUrl);
  const app = await createApiApplication(config);
  const status = await checkDatabase(app.get(PrismaService));
  if (status.state !== 'ready') {
    await app.close();
    if (status.state === 'unreachable') {
      process.stderr.write(`PostgreSQL is unavailable at ${database}: ${status.detail}\n${START_POSTGRES}\n`);
    } else {
      process.stderr.write(
        `The database ${database} is not migrated (pending: ${status.pending.join(', ')}).\nApply the migrations with "pnpm db:migrate".\n`,
      );
    }
    return EXIT_UNAVAILABLE;
  }

  try {
    await app.listen(config.port, config.host);
  } catch (error) {
    await app.close();
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      process.stderr.write(`Cannot listen on ${config.host}:${config.port} (${code}). Stop the process using it, or set API_PORT.\n`);
      return EXIT_UNAVAILABLE;
    }
    throw error;
  }
  logger.log(`DataForge API listening on ${await app.getUrl()} (engine ${ENGINE_VERSION}, database ${database}). Ctrl+C stops it.`);
  return 0;
}

// Kafka executions use KafkaJS, which arms negative timers on Node 24 (ADR-0009): that one warning is hidden, every other is printed.
silenceKafkaClientTimerWarning();
main().then(
  (code) => {
    if (code !== 0) {
      process.exit(code);
    }
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);

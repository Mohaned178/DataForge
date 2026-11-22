#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { silenceKafkaClientTimerWarning } from '@dataforge/kafka';
import { runCli } from './cli';
import { processIo } from './cli-io';

// Optional configuration (see .env.example); variables already set in the environment win.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
silenceKafkaClientTimerWarning();
const result = runCli(process.argv.slice(2), processIo);
if (typeof result === 'number') {
  process.exitCode = result;
} else {
  // Exit explicitly: a Kafka client can keep timers alive for a moment after it disconnected.
  void result.then((code) => process.exit(code));
}

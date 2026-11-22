import { ENGINE_VERSION } from '@dataforge/core';
import { EXIT_OK, EXIT_USAGE, UsageError, type CliIo } from './cli-io';
import { GENERATE_USAGE, runGenerate } from './commands/generate';
import { TIMELINE_USAGE, runTimeline } from './commands/timeline';
import { VERIFY_USAGE, runVerify } from './commands/verify';

const COMMANDS: Record<string, (args: readonly string[], io: CliIo) => number> = {
  generate: runGenerate,
  verify: runVerify,
  timeline: runTimeline,
};

const HELP = [
  `DataForge CLI (engine ${ENGINE_VERSION})`,
  '',
  'Commands:',
  `  ${GENERATE_USAGE}`,
  '      Simulate a scenario and write events.jsonl, expected-state.json, scenario.resolved.json, manifest.json.',
  `  ${VERIFY_USAGE}`,
  '      Re-check a run: checksums, event schema, business rules, expected state and reproducibility.',
  `  ${TIMELINE_USAGE}`,
  '      Print every event of one aggregate in canonical order.',
  '',
  'Exit codes: 0 success, 1 check failed, 2 invalid input.',
];

export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    HELP.forEach((line) => io.out(line));
    return EXIT_OK;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    io.err(`Unknown command "${command}".`);
    HELP.forEach((line) => io.err(line));
    return EXIT_USAGE;
  }
  try {
    return handler(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    if (isParseArgsError(error)) {
      io.err(`${error.message}\nRun "dataforge help" for usage.`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

/** node:util parseArgs errors are identified by their documented ERR_PARSE_ARGS_* code. */
function isParseArgsError(error: unknown): error is { code: string; message: string } {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) {
    return false;
  }
  return typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS') && typeof error.message === 'string';
}

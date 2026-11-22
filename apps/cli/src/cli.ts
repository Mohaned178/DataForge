import { ENGINE_VERSION } from '@dataforge/core';
import { PLANNER_VERSION } from '@dataforge/chaos';
import { EXIT_OK, EXIT_USAGE, UsageError, type CliIo } from './cli-io';
import { CHAOS_PLAN_USAGE, runChaos } from './commands/chaos-plan';
import { DELIVER_USAGE, runDeliver } from './commands/deliver';
import { EXPLAIN_USAGE, runExplain } from './commands/explain';
import { GENERATE_USAGE, runGenerate } from './commands/generate';
import { TIMELINE_USAGE, runTimeline } from './commands/timeline';
import { VALIDATE_USAGE, runValidate } from './commands/validate';
import { VERIFY_USAGE, runVerify } from './commands/verify';

const COMMANDS: Record<string, (args: readonly string[], io: CliIo) => number> = {
  generate: runGenerate,
  verify: runVerify,
  timeline: runTimeline,
  chaos: runChaos,
  explain: runExplain,
  deliver: runDeliver,
  validate: runValidate,
};

const HELP = [
  `DataForge CLI (engine ${ENGINE_VERSION}, planner ${PLANNER_VERSION})`,
  '',
  'Commands:',
  `  ${GENERATE_USAGE}`,
  '      Simulate a scenario and write events.jsonl, expected-state.json, scenario.resolved.json, manifest.json.',
  `  ${VERIFY_USAGE}`,
  '      Re-check a run: checksums, event schema, business rules, expected state and reproducibility.',
  `  ${TIMELINE_USAGE}`,
  '      Print every event of one aggregate in canonical order.',
  `  ${CHAOS_PLAN_USAGE}`,
  '      Plan how the events of a run are delivered under a chaos profile: delivery-plan.jsonl, delivery-summary.json.',
  `  ${EXPLAIN_USAGE}`,
  '      Show every delivery attempt of one event, the faults behind it and its order within its aggregate.',
  `  ${DELIVER_USAGE}`,
  '      Deliver a plan to a reference target in process and write the state it ends in: actual-state.json, target-run.json.',
  `  ${VALIDATE_USAGE}`,
  '      Compare an actual state with the expected state, check the invariants, and explain each finding by delivery faults.',
  '',
  'Exit codes: 0 success, 1 check failed (validate: findings), 2 invalid input.',
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

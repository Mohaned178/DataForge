import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ENGINE_VERSION,
  InvalidSeedError,
  ORDER_STATUSES,
  RUN_FILE_NAMES,
  ScenarioValidationError,
  buildRunFiles,
  normalizeSeed,
  parseScenario,
  simulate,
  type ScenarioConfig,
} from '@dataforge/core';
import { EXIT_OK, EXIT_USAGE, UsageError, formatCount, padRight, readJsonFile, type CliIo } from '../cli-io';
import { CHECKSUMMED_FILES, RUN_FILES, prepareOutputDirectory, writeRunFile } from '../run-directory';

export const GENERATE_USAGE = 'dataforge generate --scenario <file.json> --seed <seed> --out <directory> [--force]';

export function runGenerate(args: readonly string[], io: CliIo): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      scenario: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.scenario === undefined || values.seed === undefined || values.out === undefined) {
    throw new UsageError(`Missing required option.\nUsage: ${GENERATE_USAGE}`);
  }

  const scenarioPath = resolve(values.scenario);
  const outDirectory = resolve(values.out);
  let scenario: ScenarioConfig;
  let seed: string;
  try {
    scenario = parseScenario(readJsonFile(scenarioPath, 'scenario'));
    seed = normalizeSeed(values.seed);
  } catch (error) {
    if (error instanceof ScenarioValidationError || error instanceof InvalidSeedError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }
  prepareOutputDirectory(outDirectory, values.force);

  const startedAt = performance.now();
  const result = simulate({ scenario, seed });
  const { manifest, contents } = buildRunFiles(scenario, result);
  // manifest.json last: a run directory without it is visibly incomplete.
  for (const name of RUN_FILE_NAMES) {
    writeRunFile(outDirectory, name, contents[name]);
  }
  const elapsedMs = Math.round(performance.now() - startedAt);

  const summary = result.expectedState.summary;
  io.out(`DataForge generate (engine ${ENGINE_VERSION})`);
  io.out(`  scenario  ${scenario.name}  ${result.scenarioHash}`);
  io.out(`  seed      ${result.seed}`);
  io.out(`  window    ${scenario.simulation.epoch} + ${formatCount(scenario.simulation.durationMs)} ms`);
  io.out(`  events    ${formatCount(result.events.length)}`);
  for (const [type, count] of Object.entries(manifest.counts.eventsByType)) {
    io.out(`              ${padRight(type, 20)} ${formatCount(count)}`);
  }
  io.out(`  orders    ${ORDER_STATUSES.map((status) => `${status} ${formatCount(summary.ordersByStatus[status])}`).join(', ')}`);
  io.out(`  revenue   ${formatCount(summary.revenueMinor)} (minor units, ${scenario.catalog.currency})`);
  io.out(`  output    ${outDirectory}`);
  for (const name of CHECKSUMMED_FILES) {
    io.out(`              ${padRight(name, 24)} sha256 ${manifest.files[name].sha256}`);
  }
  io.out(`              ${RUN_FILES.manifest}`);
  io.out(`  done in ${elapsedMs} ms`);
  return EXIT_OK;
}

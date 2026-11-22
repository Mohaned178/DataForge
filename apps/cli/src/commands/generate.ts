import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ENGINE_VERSION,
  EVENT_SCHEMA_VERSION,
  InvalidSeedError,
  ORDER_STATUSES,
  ScenarioValidationError,
  canonicalJson,
  normalizeSeed,
  parseScenario,
  serializeEventLog,
  serializeExpectedState,
  simulate,
  type ScenarioConfig,
} from '@dataforge/core';
import { EXIT_OK, EXIT_USAGE, UsageError, formatCount, padRight, readJsonFile, type CliIo } from '../cli-io';
import {
  CHECKSUMMED_FILES,
  RUN_FILES,
  countEventsByType,
  fileEntry,
  prepareOutputDirectory,
  writeRunFile,
  type RunManifest,
} from '../run-directory';

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
  const contents = {
    [RUN_FILES.events]: serializeEventLog(result.events),
    [RUN_FILES.expectedState]: serializeExpectedState(result.expectedState),
    [RUN_FILES.scenario]: `${canonicalJson(scenario, 2)}\n`,
  };
  const manifest: RunManifest = {
    format: 'dataforge.simulation-run',
    formatVersion: 1,
    engineVersion: ENGINE_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    seed: result.seed,
    scenario: { name: scenario.name, hash: result.scenarioHash },
    simulation: { epoch: scenario.simulation.epoch, durationMs: scenario.simulation.durationMs },
    counts: { events: result.events.length, eventsByType: countEventsByType(result.events) },
    files: {
      [RUN_FILES.events]: fileEntry(contents[RUN_FILES.events]),
      [RUN_FILES.expectedState]: fileEntry(contents[RUN_FILES.expectedState]),
      [RUN_FILES.scenario]: fileEntry(contents[RUN_FILES.scenario]),
    },
  };
  for (const name of CHECKSUMMED_FILES) {
    writeRunFile(outDirectory, name, contents[name]);
  }
  writeRunFile(outDirectory, RUN_FILES.manifest, `${canonicalJson(manifest, 2)}\n`);
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

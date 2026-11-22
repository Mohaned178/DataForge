import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InvalidSeedError, canonicalJson, normalizeSeed, parseUtcInstant, simTimeToIso } from '@dataforge/core';
import {
  ChaosProfileValidationError,
  PLANNER_VERSION,
  parseChaosProfile,
  planDelivery,
  serializeDeliveryPlan,
  type ChaosProfile,
  type DeliverySummary,
} from '@dataforge/chaos';
import { EXIT_OK, EXIT_USAGE, UsageError, formatCount, padRight, readJsonFile, type CliIo } from '../cli-io';
import { PLAN_FILES, type DeliverySummaryFile } from '../plan-directory';
import { RUN_FILES, fileEntry, prepareOutputDirectory, readIntactCanonicalLog, readManifest, samePath, writeRunFile } from '../run-directory';
import { describeWindowing } from '../windows-output';
import { formatSimTime } from './timeline';

export const CHAOS_PLAN_USAGE =
  'dataforge chaos plan --run <directory> --profile <profile.json> --chaos-seed <seed> --out <directory> [--force]';

export function runChaos(args: readonly string[], io: CliIo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === 'plan') {
    return runChaosPlan(rest, io);
  }
  throw new UsageError(
    `${subcommand === undefined ? 'Missing' : `Unknown`} chaos subcommand${subcommand === undefined ? '' : ` "${subcommand}"`}.\nUsage: ${CHAOS_PLAN_USAGE}`,
  );
}

function runChaosPlan(args: readonly string[], io: CliIo): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      run: { type: 'string' },
      profile: { type: 'string' },
      'chaos-seed': { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const chaosSeedText = values['chaos-seed'];
  if (values.run === undefined || values.profile === undefined || chaosSeedText === undefined || values.out === undefined) {
    throw new UsageError(`Missing required option.\nUsage: ${CHAOS_PLAN_USAGE}`);
  }

  const runDirectory = resolve(values.run);
  const outDirectory = resolve(values.out);
  const manifest = readManifest(runDirectory);
  const { events } = readIntactCanonicalLog(runDirectory, manifest);

  let profile: ChaosProfile;
  let chaosSeed: string;
  try {
    profile = parseChaosProfile(readJsonFile(resolve(values.profile), 'chaos profile'));
    chaosSeed = normalizeSeed(chaosSeedText);
  } catch (error) {
    if (error instanceof ChaosProfileValidationError || error instanceof InvalidSeedError) {
      io.err(error.message.replace(/^Invalid seed/, 'Invalid chaos seed'));
      return EXIT_USAGE;
    }
    throw error;
  }
  if (samePath(outDirectory, runDirectory)) {
    throw new UsageError('--out must not be the run directory: a delivery plan is kept apart from the canonical run it belongs to.');
  }
  prepareOutputDirectory(outDirectory, values.force, 'plan files');

  const startedAt = performance.now();
  const plan = planDelivery({ events, profile, chaosSeed });
  const contents = {
    [PLAN_FILES.plan]: serializeDeliveryPlan(plan.attempts),
    [PLAN_FILES.profile]: `${canonicalJson(profile, 2)}\n`,
  };
  const summaryFile: DeliverySummaryFile = {
    format: 'dataforge.delivery-plan',
    formatVersion: 1,
    plannerVersion: plan.plannerVersion,
    chaosSeed: plan.chaosSeed,
    profile: { name: profile.name, hash: plan.profileHash },
    source: {
      engineVersion: manifest.engineVersion,
      seed: manifest.seed,
      scenarioName: manifest.scenario.name,
      scenarioHash: manifest.scenario.hash,
      eventsSha256: plan.eventsSha256,
    },
    summary: plan.summary,
    files: {
      [PLAN_FILES.plan]: fileEntry(contents[PLAN_FILES.plan]),
      [PLAN_FILES.profile]: fileEntry(contents[PLAN_FILES.profile]),
    },
  };
  writeRunFile(outDirectory, PLAN_FILES.plan, contents[PLAN_FILES.plan]);
  writeRunFile(outDirectory, PLAN_FILES.profile, contents[PLAN_FILES.profile]);
  writeRunFile(outDirectory, PLAN_FILES.summary, `${canonicalJson(summaryFile, 2)}\n`);
  const elapsedMs = Math.round(performance.now() - startedAt);

  const { summary } = plan;
  const epochUnixMs = parseUtcInstant(manifest.simulation.epoch);
  io.out(`DataForge chaos plan (planner ${PLANNER_VERSION})`);
  io.out(`  run         ${runDirectory}`);
  io.out(`              seed ${manifest.seed}, ${formatCount(events.length)} events, ${RUN_FILES.events} sha256 ${plan.eventsSha256}`);
  io.out(`  profile     ${profile.name}  ${plan.profileHash}`);
  io.out(`  chaos seed  ${plan.chaosSeed}`);
  io.out(
    `  attempts    ${formatCount(summary.attempts)}: original ${formatCount(summary.attemptsByKind.original)}, ` +
      `retry ${formatCount(summary.attemptsByKind.retry)}, duplicate ${formatCount(summary.attemptsByKind.duplicate)}; ` +
      `delivered ${formatCount(summary.attemptsByOutcome.delivered)}, failed ${formatCount(summary.attemptsByOutcome.failed)}`,
  );
  printFaults(summary, io);
  if (summary.windowing !== undefined) {
    const { arrivals } = summary.windowing;
    io.out(`  windowing   ${describeWindowing(summary.windowing)}`);
    io.out(
      `  arrivals    ${formatCount(arrivals.onTime + arrivals.withinLateness + arrivals.afterClose + arrivals.lost)} windowed events ` +
        `(OrderCreated, PaymentCompleted), by stream time: ${formatCount(arrivals.onTime)} on time, ` +
        `${formatCount(arrivals.withinLateness)} within the allowed lateness, ${formatCount(arrivals.afterClose)} after their window closed, ` +
        `${formatCount(arrivals.lost)} lost`,
    );
  }
  io.out(`  outcome     ${formatCount(summary.eventsDelivered)} of ${formatCount(summary.events)} events delivered, ${formatCount(summary.eventsLost)} lost`);
  io.out(
    `  ordering    ${formatCount(summary.ordering.outOfOrderEvents)} events delivered after a later event of their aggregate ` +
      `(${formatCount(summary.ordering.inversionPairs)} inverted pairs in ${formatCount(summary.ordering.aggregatesAffected)} aggregates)`,
  );
  io.out(
    `  last        delivery at ${simTimeToIso(epochUnixMs, summary.lastScheduledDeliveryTimeMs)} (${formatSimTime(summary.lastScheduledDeliveryTimeMs)})`,
  );
  io.out(`  output      ${outDirectory}`);
  for (const name of [PLAN_FILES.plan, PLAN_FILES.profile] as const) {
    io.out(`                ${padRight(name, 28)} sha256 ${summaryFile.files[name].sha256}`);
  }
  io.out(`                ${PLAN_FILES.summary}`);
  io.out(`  done in ${elapsedMs} ms`);
  return EXIT_OK;
}

function printFaults(summary: DeliverySummary, io: CliIo): void {
  const { delay, late, reorder, duplicate, transientFailure } = summary.faults;
  const rows: [string, typeof delay, string, string][] = [
    ['delay', delay, 'events', ''],
    ...(late === undefined ? [] : [['late', late, 'eligible', 'arrive after their window closed'] as [string, typeof delay, string, string]]),
    ['reorder', reorder, 'eligible', ''],
    ['duplicate', duplicate, 'delivered', `+${formatCount(duplicate.extraDeliveries)} extra deliveries`],
    ['transientFailure', transientFailure, 'events', `${formatCount(transientFailure.failedAttempts)} failed attempts, ${formatCount(transientFailure.lostEvents)} lost`],
  ];
  rows.forEach(([name, tally, population, extra], index) => {
    const observed = tally.eligibleEvents === 0 ? 0 : (100 * tally.faultedEvents) / tally.eligibleEvents;
    io.out(
      `  ${index === 0 ? 'faults' : '      '}      ${padRight(name, 17)} ${formatCount(tally.faultedEvents).padStart(6)} of ` +
        `${padRight(`${formatCount(tally.eligibleEvents)} ${population}`, 16)} ${observed.toFixed(2).padStart(6)}%  ` +
        `(configured ${(100 * tally.rate).toFixed(2)}%)${extra === '' ? '' : `  ${extra}`}`,
    );
  });
}

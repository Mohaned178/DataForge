import { join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalJson, serializeActualState } from '@dataforge/core';
import { REFERENCE_TARGETS, createReferenceTarget, deliverInMemory, type ReferenceTargetName } from '@dataforge/targets';
import { EXIT_OK, UsageError, formatCount, padRight, type CliIo } from '../cli-io';
import { DELIVERY_FILES, type TargetRunFile } from '../delivery-directory';
import { PLAN_FILES, readPlanForRun } from '../plan-directory';
import { fileEntry, prepareOutputDirectory, readIntactCanonicalLog, readManifest, samePath, writeRunFile } from '../run-directory';

export const DELIVER_USAGE = `dataforge deliver --run <directory> --plan <directory> --target ${REFERENCE_TARGETS.join('|')} --out <directory> [--force]`;

const COUNTER_LABELS: Record<string, string> = {
  duplicatesIgnored: 'redeliveries ignored (eventId already received)',
  eventsParked: 'events parked until their predecessor or referenced entities arrived',
  updatesLost: 'updates lost (the row did not exist yet when the message arrived)',
};

/** Plays a delivery plan into a reference target, in process, and writes the state the target ends in. */
export function runDeliver(args: readonly string[], io: CliIo): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      run: { type: 'string' },
      plan: { type: 'string' },
      target: { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.run === undefined || values.plan === undefined || values.target === undefined || values.out === undefined) {
    throw new UsageError(`Missing required option.\nUsage: ${DELIVER_USAGE}`);
  }
  const targetName = values.target;
  if (!isReferenceTarget(targetName)) {
    throw new UsageError(`Unknown target "${targetName}". Reference targets: ${REFERENCE_TARGETS.join(', ')}.`);
  }

  const runDirectory = resolve(values.run);
  const planDirectory = resolve(values.plan);
  const outDirectory = resolve(values.out);
  const manifest = readManifest(runDirectory);
  const { events } = readIntactCanonicalLog(runDirectory, manifest);
  const { summaryFile, attempts } = readPlanForRun(planDirectory, manifest);
  if (samePath(outDirectory, runDirectory) || samePath(outDirectory, planDirectory)) {
    throw new UsageError('--out must be its own directory: the run and the plan it consumed stay untouched.');
  }
  prepareOutputDirectory(outDirectory, values.force, 'delivery files');

  const target = createReferenceTarget(targetName);
  const result = deliverInMemory({ events, attempts, target });
  const actualStateText = serializeActualState(result.actualState);
  const targetRun: TargetRunFile = {
    format: 'dataforge.target-run',
    formatVersion: 1,
    target: { name: target.name, description: target.description },
    source: { seed: manifest.seed, scenarioName: manifest.scenario.name, eventsSha256: summaryFile.source.eventsSha256 },
    plan: {
      plannerVersion: summaryFile.plannerVersion,
      chaosSeed: summaryFile.chaosSeed,
      profile: summaryFile.profile,
      planSha256: summaryFile.files[PLAN_FILES.plan].sha256,
    },
    delivery: {
      messages: result.messages,
      distinctEvents: result.distinctEvents,
      redeliveries: result.redeliveries,
      failedAttempts: result.failedAttempts,
    },
    counters: { ...result.counters },
    parkedEventIds: [...result.parkedEventIds],
    files: { [DELIVERY_FILES.actualState]: fileEntry(actualStateText) },
  };
  writeRunFile(outDirectory, DELIVERY_FILES.actualState, actualStateText);
  writeRunFile(outDirectory, DELIVERY_FILES.targetRun, `${canonicalJson(targetRun, 2)}\n`);

  io.out(`DataForge deliver: target ${target.name} (${target.description})`);
  io.out(`  run         ${runDirectory}`);
  io.out(`              seed ${manifest.seed}, ${formatCount(events.length)} events`);
  io.out(`  plan        ${planDirectory}`);
  io.out(`              profile ${summaryFile.profile.name}, chaos seed ${summaryFile.chaosSeed}, ${formatCount(attempts.length)} attempts`);
  io.out(
    `  delivered   ${formatCount(result.messages)} messages: ${formatCount(result.distinctEvents)} distinct events, ` +
      `${formatCount(result.redeliveries)} redeliveries; ${formatCount(result.failedAttempts)} failed attempts never reached the target`,
  );
  Object.entries(result.counters).forEach(([name, value], position) => {
    io.out(`  ${position === 0 ? 'target   ' : '         '}   ${formatCount(value).padStart(5)} ${COUNTER_LABELS[name] ?? name}`);
  });
  io.out(
    result.parkedEventIds.length === 0
      ? '  parked      none: every received event was applied'
      : `  parked      ${formatCount(result.parkedEventIds.length)} events never applied (what they wait for never arrived): ` +
          `${result.parkedEventIds.slice(0, 5).join(', ')}${result.parkedEventIds.length > 5 ? ', ...' : ''}`,
  );
  io.out(`  output      ${outDirectory}`);
  io.out(`                ${padRight(DELIVERY_FILES.actualState, 28)} sha256 ${targetRun.files[DELIVERY_FILES.actualState].sha256}`);
  io.out(`                ${DELIVERY_FILES.targetRun}`);
  io.out(
    `  next        pnpm dataforge validate --run ${normalize(values.run)} --actual ${join(values.out, DELIVERY_FILES.actualState)} --plan ${normalize(values.plan)}`,
  );
  return EXIT_OK;
}

function isReferenceTarget(name: string): name is ReferenceTargetName {
  return (REFERENCE_TARGETS as readonly string[]).includes(name);
}

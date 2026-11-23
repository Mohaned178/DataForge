import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ActualStateValidationError,
  ActualWindowsValidationError,
  parseActualState,
  parseActualWindows,
  parseUtcInstant,
  sha256Hex,
  type ActualState,
  type ActualWindows,
  type WindowingSpec,
} from '@dataforge/core';
import { buildValidationReport, reportPlanOf, reportSourceOf, serializeValidationReport, validateExecution } from '@dataforge/execution';
import { FINDING_CATEGORIES, type DeliveryCause, type Finding, type ValidationResult } from '@dataforge/validation';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, UsageError, formatCount, padRight, readJsonFile, type CliIo } from '../cli-io';
import { DELIVERY_FILES, readTargetRun, type TargetRunFile } from '../delivery-directory';
import { PLAN_FILES, readPlanForRun, type LoadedPlan } from '../plan-directory';
import { RUN_FILES, readIntactCanonicalLog, readIntactExpectedState, readManifest, readRunFile, samePath } from '../run-directory';
import { describeWindowing, printWindowSection } from '../windows-output';

export const VALIDATE_USAGE =
  'dataforge validate --run <directory> --actual <actual-state.json> [--plan <directory>] [--windows <actual-windows.json>]\n' +
  '                    [--report <file.json>] [--limit <n>]';

const DEFAULT_LIMIT = 20;
const ROOT_CAUSE_LINES = 10;
const CAUSES_PER_FINDING = 2;

/** Compares a target's actual state with a run's expected state and explains each difference. */
export function runValidate(args: readonly string[], io: CliIo): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      run: { type: 'string' },
      actual: { type: 'string' },
      plan: { type: 'string' },
      report: { type: 'string' },
      limit: { type: 'string' },
      windows: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.run === undefined || values.actual === undefined) {
    throw new UsageError(`Missing required option.\nUsage: ${VALIDATE_USAGE}`);
  }
  const limit = parseLimit(values.limit);
  const runDirectory = resolve(values.run);
  const actualPath = resolve(values.actual);
  const reportPath = values.report === undefined ? undefined : resolve(values.report);
  if (reportPath !== undefined && samePath(reportPath, actualPath)) {
    throw new UsageError('--report must not be the actual state file.');
  }

  const manifest = readManifest(runDirectory);
  const { events } = readIntactCanonicalLog(runDirectory, manifest);
  const expected = readIntactExpectedState(runDirectory, manifest, events);
  const eventsSha256 = manifest.files[RUN_FILES.events].sha256;

  let actual: ActualState;
  try {
    actual = parseActualState(readJsonFile(actualPath, 'actual state'));
  } catch (error) {
    if (error instanceof ActualStateValidationError) {
      io.err(`${actualPath}: ${error.message}`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const targetRun = basename(actualPath) === DELIVERY_FILES.actualState ? readTargetRun(dirname(actualPath)) : undefined;
  if (targetRun !== undefined && targetRun.source.eventsSha256 !== eventsSha256) {
    throw new UsageError(
      `${actualPath} was produced from a different canonical log.\n` +
        `  target run: events.jsonl sha256 ${targetRun.source.eventsSha256} (seed ${targetRun.source.seed})\n` +
        `  run:        events.jsonl sha256 ${eventsSha256} (seed ${manifest.seed})`,
    );
  }
  const plan = values.plan === undefined ? undefined : readPlanForRun(resolve(values.plan), manifest);
  if (plan !== undefined && targetRun !== undefined && targetRun.plan.planSha256 !== plan.summaryFile.files[PLAN_FILES.plan].sha256) {
    throw new UsageError(
      `${actualPath} was produced from a different delivery plan, so its findings cannot be explained by this one.\n` +
        `  target run: profile ${targetRun.plan.profile.name}, chaos seed ${targetRun.plan.chaosSeed}, delivery-plan.jsonl sha256 ${targetRun.plan.planSha256}\n` +
        `  --plan:     profile ${plan.summaryFile.profile.name}, chaos seed ${plan.summaryFile.chaosSeed}, delivery-plan.jsonl sha256 ${plan.summaryFile.files[PLAN_FILES.plan].sha256}`,
    );
  }
  const edited =
    targetRun !== undefined &&
    sha256Hex(readRunFile(dirname(actualPath), DELIVERY_FILES.actualState) ?? '') !== targetRun.files[DELIVERY_FILES.actualState].sha256;

  let windows: LoadedWindows | undefined;
  try {
    windows = loadWindows({ actualPath, explicit: values.windows, targetRun, plan, reportPath });
  } catch (error) {
    if (error instanceof ActualWindowsValidationError) {
      io.err(`${resolve(values.windows ?? join(dirname(actualPath), DELIVERY_FILES.actualWindows))}: ${error.message}`);
      return EXIT_USAGE;
    }
    throw error;
  }
  const result = validateExecution({
    events,
    expected,
    actual,
    ...(windows === undefined ? {} : { windows: { windowing: windows.windowing, actual: windows.actual } }),
    ...(plan === undefined ? {} : { attempts: plan.attempts }),
  });

  if (reportPath !== undefined) {
    const report = buildValidationReport({
      source: reportSourceOf(manifest),
      target:
        targetRun === undefined
          ? null
          : { name: targetRun.target.name, editedAfterDelivery: edited, ...(windows === undefined ? {} : { windowsEditedAfterDelivery: windows.edited }) },
      plan: plan === undefined ? null : reportPlanOf(plan.summaryFile),
      result,
    });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, serializeValidationReport(report), { encoding: 'utf8' });
  }

  printHeader(io, { runDirectory, seed: manifest.seed, scenarioName: manifest.scenario.name, actualPath, targetRun, edited, plan, values });
  printSummary(io, result);
  printRootCauses(io, result);
  printFindings(io, result, limit, reportPath !== undefined);
  if (result.windows !== undefined && windows !== undefined) {
    printWindowSection(io, {
      result: result.windows,
      epochUnixMs: parseUtcInstant(manifest.simulation.epoch),
      windowsPath: windows.path,
      edited: windows.edited,
      limit,
      hasReport: reportPath !== undefined,
    });
  }
  if (reportPath !== undefined) {
    io.out(`Report: ${reportPath}`);
  }
  io.out(resultLine(result));
  return result.verdict === 'PASS' ? EXIT_OK : EXIT_FAILED;
}

function resultLine(result: ValidationResult): string {
  if (result.windows === undefined) {
    return result.verdict === 'PASS'
      ? 'Result: PASS (the actual state matches the expected state and satisfies every invariant)'
      : `Result: FAIL (${formatCount(result.counts.findings)} findings)`;
  }
  return result.verdict === 'PASS'
    ? 'Result: PASS (the actual state matches the expected state and satisfies every invariant; every window has its true values)'
    : `Result: FAIL (${formatCount(result.counts.findings)} findings, ${formatCount(result.windows.counts.findings)} window findings)`;
}

interface LoadedWindows {
  readonly path: string;
  readonly actual: ActualWindows;
  readonly windowing: WindowingSpec;
  readonly edited: boolean;
}

/**
 * The target's windows and the contract to check them against. The windows come from --windows, or
 * from actual-windows.json next to the actual state (listed in target-run.json when "dataforge deliver"
 * wrote it); the contract comes from the plan the target consumed. Either one without the other is
 * refused: windows cannot be judged without a contract, and a windowed plan must not pass unchecked.
 */
function loadWindows(input: {
  readonly actualPath: string;
  readonly explicit: string | undefined;
  readonly targetRun: TargetRunFile | undefined;
  readonly plan: LoadedPlan | undefined;
  readonly reportPath: string | undefined;
}): LoadedWindows | undefined {
  const { targetRun, plan } = input;
  const besideActual = join(dirname(input.actualPath), DELIVERY_FILES.actualWindows);
  const listed = targetRun?.files[DELIVERY_FILES.actualWindows] !== undefined;
  const path =
    input.explicit !== undefined
      ? resolve(input.explicit)
      : listed || (targetRun === undefined && existsSync(besideActual))
        ? besideActual
        : undefined;
  if (path !== undefined && (samePath(path, input.actualPath) || (input.reportPath !== undefined && samePath(path, input.reportPath)))) {
    throw new UsageError('--windows must be its own file, not the actual state or the report.');
  }
  const windowing = plan?.profile.windowing ?? (targetRun?.windowing === undefined ? undefined : { ...targetRun.windowing });

  if (path === undefined || (input.explicit === undefined && !existsSync(path))) {
    if (windowing !== undefined) {
      throw new UsageError(
        `The plan defines event-time windows (${describeWindowing(windowing)}), but no windows were found for this target.\n` +
          `Expected ${besideActual} (written by "dataforge deliver" for a windowed plan), or give --windows <file>.`,
      );
    }
    return undefined;
  }
  if (windowing === undefined) {
    throw new UsageError(
      `${path} holds per-window metrics, but there is no windowing contract to check them against.\n` +
        (plan === undefined
          ? 'Add --plan <directory> with the windowed plan the target consumed.'
          : `The plan (profile ${plan.summaryFile.profile.name}) has no "windowing" section.`),
    );
  }
  const actual = parseActualWindows(readJsonFile(path, 'actual windows'));
  const recorded = targetRun?.files[DELIVERY_FILES.actualWindows];
  const edited = recorded !== undefined && samePath(path, besideActual) && sha256Hex(readRunFile(dirname(path), DELIVERY_FILES.actualWindows) ?? '') !== recorded.sha256;
  return { path, actual, windowing, edited };
}

function parseLimit(text: string | undefined): number {
  if (text === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!/^\d{1,6}$/.test(text)) {
    throw new UsageError(`--limit must be a whole number of findings to print, got "${text}".`);
  }
  return Number(text);
}

interface HeaderInput {
  readonly runDirectory: string;
  readonly seed: string;
  readonly scenarioName: string;
  readonly actualPath: string;
  readonly targetRun: TargetRunFile | undefined;
  readonly edited: boolean;
  readonly plan: LoadedPlan | undefined;
  readonly values: { readonly plan?: string | undefined };
}

function printHeader(io: CliIo, input: HeaderInput): void {
  const { targetRun, plan } = input;
  io.out('DataForge validate');
  io.out(`  run         ${input.runDirectory}  (seed ${input.seed}, scenario ${input.scenarioName})`);
  io.out(`  actual      ${input.actualPath}`);
  if (targetRun === undefined) {
    io.out('              no target-run.json next to it: not written by "dataforge deliver"');
  } else {
    io.out(
      `              written by target ${targetRun.target.name} from profile ${targetRun.plan.profile.name}, chaos seed ${targetRun.plan.chaosSeed}` +
        (input.edited ? '; EDITED since (checksum differs from target-run.json)' : ''),
    );
  }
  io.out(
    plan === undefined
      ? '  plan        none given: findings have no root-cause hints (add --plan <directory>)'
      : `  plan        ${resolve(input.values.plan ?? '')}  (profile ${plan.summaryFile.profile.name}, chaos seed ${plan.summaryFile.chaosSeed})`,
  );
}

function printSummary(io: CliIo, result: ValidationResult): void {
  const { entities, invariants } = result.checked;
  const counted = (['product', 'customer', 'order', 'payment', 'shipment'] as const)
    .map((type) => `${formatCount(entities[type].actual)}/${formatCount(entities[type].expected)} ${type}s`)
    .join(', ');
  io.out(`  checked     ${counted} (actual/expected), ${invariants} invariants`);
  io.out(`  findings    ${formatCount(result.counts.findings)}`);
  for (const category of FINDING_CATEGORIES) {
    io.out(`                ${padRight(category, 22)} ${formatCount(result.counts.byCategory[category]).padStart(6)}`);
  }
  if (result.counts.explained !== null && result.counts.findings > 0) {
    io.out(
      `  explained   ${formatCount(result.counts.explained)} of ${formatCount(result.counts.findings)} findings are linked to abnormal deliveries; ` +
        `${formatCount(result.counts.unexplained ?? 0)} are not explained by any delivery fault`,
    );
  }
}

function printRootCauses(io: CliIo, result: ValidationResult): void {
  if (result.rootCauses.length === 0) {
    return;
  }
  io.out('');
  io.out('Most likely causes (each finding counted under its first cause):');
  for (const group of result.rootCauses.slice(0, ROOT_CAUSE_LINES)) {
    const findings = `${formatCount(group.findings)} finding${group.findings === 1 ? '' : 's'}`;
    io.out(
      group.cause === null
        ? `  ${padRight('(no delivery fault)', 20)} ${padRight('', 18)} ${padRight('not explained by delivery: a processing bug or an edited state', 62)} ${findings}`
        : `  ${padRight(group.cause.eventId, 20)} ${padRight(group.cause.eventType, 18)} ${padRight(describeCause(group.cause), 62)} ${findings}`,
    );
  }
  if (result.rootCauses.length > ROOT_CAUSE_LINES) {
    io.out(`  ... ${formatCount(result.rootCauses.length - ROOT_CAUSE_LINES)} more causes`);
  }
}

function printFindings(io: CliIo, result: ValidationResult, limit: number, hasReport: boolean): void {
  if (result.findings.length === 0 || limit === 0) {
    return;
  }
  const shown = result.findings.slice(0, limit);
  io.out('');
  io.out(
    shown.length === result.findings.length
      ? `Findings (${formatCount(result.findings.length)}):`
      : `Findings (first ${formatCount(shown.length)} of ${formatCount(result.findings.length)}; ${hasReport ? 'all of them are in the report' : 'add --report <file> for all of them'}):`,
  );
  for (const finding of shown) {
    io.out(`  ${padRight(finding.entityType, 8)} ${padRight(finding.entityId, 14)} ${padRight(finding.category, 21)} ${describeFinding(finding)}`);
    if (result.hints) {
      if (finding.causes.length === 0) {
        io.out(`  ${' '.repeat(45)}cause: none found; no delivery fault touched this entity's aggregates`);
      }
      for (const cause of finding.causes.slice(0, CAUSES_PER_FINDING)) {
        io.out(`  ${' '.repeat(45)}cause: ${cause.eventId} ${cause.eventType}, ${describeCause(cause)}`);
      }
      if (finding.causes.length > CAUSES_PER_FINDING) {
        io.out(`  ${' '.repeat(45)}       ... ${finding.causes.length - CAUSES_PER_FINDING} more`);
      }
    }
  }
}

function describeFinding(finding: Finding): string {
  return finding.check === 'compare' ? finding.message : `${finding.message} [${finding.check}]`;
}

/** One line on what delivery did to an event, for example "delivered 2 times [duplicate]". */
export function describeCause(cause: DeliveryCause): string {
  const parts: string[] = [];
  if (cause.lost) {
    parts.push(`LOST after ${cause.failedAttempts} failed attempts`);
  } else {
    if (cause.deliveries > 1) {
      parts.push(`delivered ${cause.deliveries} times`);
    }
    if (cause.failedAttempts > 0) {
      parts.push(`delivered after ${cause.failedAttempts} failed attempt${cause.failedAttempts === 1 ? '' : 's'}`);
    }
    if (cause.overtakenBy.length > 0) {
      parts.push(`arrived after ${cause.overtakenBy.join(', ')}`);
    }
    if (cause.delayMs !== null) {
      parts.push(`delayed ${formatCount(cause.delayMs)} ms`);
    }
  }
  return `${parts.length === 0 ? 'delivered once' : parts.join(', ')} [${cause.faults.join(', ')}]`;
}

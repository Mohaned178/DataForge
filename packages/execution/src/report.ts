import {
  RUN_FILES,
  canonicalJson,
  computeExpectedWindows,
  type ActualState,
  type ActualWindows,
  type CanonicalEvent,
  type ExpectedState,
  type RunManifest,
  type WindowingSpec,
} from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import { validate, type ValidationResult } from '@dataforge/validation';
import { PLAN_FILES, type DeliverySummaryFile } from './plan-files';

export const VALIDATION_REPORT_FILE = 'validation-report.json';

/** The run the report judges, by content. */
export interface ReportSource {
  readonly seed: string;
  readonly scenarioName: string;
  readonly eventsSha256: string;
}

/** The target that produced the actual state, when a delivery recorded it (target-run.json). */
export interface ReportTarget {
  readonly name: string;
  /** The actual state no longer matches the checksum the delivery recorded. */
  readonly editedAfterDelivery: boolean;
  /** Only when windows were validated. */
  readonly windowsEditedAfterDelivery?: boolean;
}

/** The delivery plan whose faults the hints come from. */
export interface ReportPlan {
  readonly chaosSeed: string;
  readonly profile: { readonly name: string; readonly hash: string };
  readonly planSha256: string;
}

/** validation-report.json: what was judged, and the validation result. */
export type ValidationReport = {
  readonly format: 'dataforge.validation-report';
  readonly formatVersion: 1;
  readonly source: ReportSource;
  readonly target: ReportTarget | null;
  readonly plan: ReportPlan | null;
} & ValidationResult;

export interface ValidateExecutionInput {
  /** The run's intact canonical log: the true windows are computed from it. */
  readonly events: readonly CanonicalEvent[];
  readonly expected: ExpectedState;
  readonly actual: ActualState;
  /** The target's windows and the contract they are checked against, for a windowed plan. */
  readonly windows?: { readonly windowing: WindowingSpec; readonly actual: ActualWindows };
  /** The plan the target consumed: with it, every finding gets root-cause hints. */
  readonly attempts?: readonly DeliveryAttempt[];
}

/** Compares an actual state (and windows) with the truth of the run. */
export function validateExecution(input: ValidateExecutionInput): ValidationResult {
  const { windows } = input;
  return validate({
    expected: input.expected,
    actual: input.actual,
    ...(windows === undefined
      ? {}
      : { windows: { windowing: windows.windowing, expected: computeExpectedWindows(input.events, windows.windowing.sizeMs), actual: windows.actual } }),
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
  });
}

/** The report's source block for a run. */
export function reportSourceOf(manifest: RunManifest): ReportSource {
  return { seed: manifest.seed, scenarioName: manifest.scenario.name, eventsSha256: manifest.files[RUN_FILES.events].sha256 };
}

/** The report's plan block for the plan a target consumed. */
export function reportPlanOf(summaryFile: DeliverySummaryFile): ReportPlan {
  return { chaosSeed: summaryFile.chaosSeed, profile: summaryFile.profile, planSha256: summaryFile.files[PLAN_FILES.plan].sha256 };
}

export function buildValidationReport(input: {
  readonly source: ReportSource;
  readonly target: ReportTarget | null;
  readonly plan: ReportPlan | null;
  readonly result: ValidationResult;
}): ValidationReport {
  return {
    format: 'dataforge.validation-report',
    formatVersion: 1,
    source: { seed: input.source.seed, scenarioName: input.source.scenarioName, eventsSha256: input.source.eventsSha256 },
    target: input.target,
    plan: input.plan,
    ...input.result,
  };
}

export function serializeValidationReport(report: ValidationReport): string {
  return `${canonicalJson(report, 2)}\n`;
}

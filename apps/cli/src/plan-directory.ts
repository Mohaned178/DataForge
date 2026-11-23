import { existsSync, statSync } from 'node:fs';
import { sha256Hex } from '@dataforge/core';
import {
  ChaosProfileValidationError,
  DeliveryPlanParseError,
  parseChaosProfile,
  parseDeliveryPlan,
  type ChaosProfile,
  type DeliveryAttempt,
} from '@dataforge/chaos';
import { PLAN_FILES, deliverySummaryFileSchema, type DeliverySummaryFile } from '@dataforge/execution';
import { UsageError } from './cli-io';
import { readRunFile, type RunManifest, RUN_FILES } from './run-directory';

// The plan-file format lives in @dataforge/execution, shared with the API.
export { PLAN_FILES, deliverySummaryFileSchema, type DeliverySummaryFile } from '@dataforge/execution';

export interface LoadedPlan {
  readonly summaryFile: DeliverySummaryFile;
  readonly profile: ChaosProfile;
  readonly attempts: DeliveryAttempt[];
}

/**
 * Loads a plan directory for a run, refusing it when any plan file was edited (checksums in
 * delivery-summary.json) or when it was planned from a different canonical log.
 */
export function readPlanForRun(directory: string, manifest: RunManifest): LoadedPlan {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new UsageError(`Plan directory not found: ${directory}`);
  }
  const summaryText = readRunFile(directory, PLAN_FILES.summary);
  if (summaryText === undefined) {
    throw new UsageError(`${PLAN_FILES.summary} not found in ${directory}. Is this a "dataforge chaos plan" output directory?`);
  }
  let json: unknown;
  try {
    json = JSON.parse(summaryText);
  } catch (error) {
    throw new UsageError(`${PLAN_FILES.summary} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = deliverySummaryFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(`${PLAN_FILES.summary} is invalid: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`);
  }
  const summaryFile = parsed.data;

  const contents = new Map<string, string>();
  for (const name of [PLAN_FILES.plan, PLAN_FILES.profile] as const) {
    const content = readRunFile(directory, name);
    if (content === undefined) {
      throw new UsageError(`${name} not found in ${directory}`);
    }
    if (sha256Hex(content) !== summaryFile.files[name].sha256) {
      throw new UsageError(`${name} in ${directory} does not match the checksum in ${PLAN_FILES.summary}: the plan was modified.`);
    }
    contents.set(name, content);
  }

  const runEventsSha256 = manifest.files[RUN_FILES.events].sha256;
  if (summaryFile.source.eventsSha256 !== runEventsSha256) {
    throw new UsageError(
      `The plan in ${directory} was made for a different canonical log.\n` +
        `  plan:  events.jsonl sha256 ${summaryFile.source.eventsSha256} (seed ${summaryFile.source.seed}, scenario ${summaryFile.source.scenarioName})\n` +
        `  run:   events.jsonl sha256 ${runEventsSha256} (seed ${manifest.seed}, scenario ${manifest.scenario.name})`,
    );
  }

  try {
    return {
      summaryFile,
      profile: parseChaosProfile(JSON.parse(contents.get(PLAN_FILES.profile) as string)),
      attempts: parseDeliveryPlan(contents.get(PLAN_FILES.plan) as string),
    };
  } catch (error) {
    if (error instanceof DeliveryPlanParseError || error instanceof ChaosProfileValidationError || error instanceof SyntaxError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

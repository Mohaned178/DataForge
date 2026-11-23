import { z } from 'zod';
import { canonicalJson, fileEntry, fileEntrySchema, type RunManifest, type WindowingSpec } from '@dataforge/core';
import { PLAN_FILES, type DeliverySummaryFile } from './plan-files';

export const DELIVERY_FILES = {
  actualState: 'actual-state.json',
  actualWindows: 'actual-windows.json',
  targetRun: 'target-run.json',
} as const;

const count = z.number().int().min(0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Written next to actual-state.json by a delivery: which target consumed which plan of which run. */
export const targetRunFileSchema = z.strictObject({
  format: z.literal('dataforge.target-run'),
  formatVersion: z.literal(1),
  target: z.strictObject({ name: z.string(), description: z.string() }),
  source: z.strictObject({ seed: z.string(), scenarioName: z.string(), eventsSha256: sha256 }),
  plan: z.strictObject({
    plannerVersion: z.string(),
    chaosSeed: z.string(),
    profile: z.strictObject({ name: z.string(), hash: z.string() }),
    planSha256: sha256,
  }),
  delivery: z.strictObject({ messages: count, distinctEvents: count, redeliveries: count, failedAttempts: count }),
  counters: z.record(z.string(), count),
  parkedEventIds: z.array(z.string()),
  /** Only for a plan with a windowing contract: the one the target computed its windows under. */
  windowing: z.strictObject({ sizeMs: count, allowedLatenessMs: count }).optional(),
  files: z.strictObject({
    [DELIVERY_FILES.actualState]: fileEntrySchema,
    [DELIVERY_FILES.actualWindows]: fileEntrySchema.optional(),
  }),
});

export type TargetRunFile = z.output<typeof targetRunFileSchema>;

export interface TargetRunInput {
  readonly target: { readonly name: string; readonly description: string };
  readonly manifest: RunManifest;
  readonly summaryFile: DeliverySummaryFile;
  readonly delivery: TargetRunFile['delivery'];
  readonly counters: Readonly<Record<string, number>>;
  readonly parkedEventIds: readonly string[];
  readonly actualStateText: string;
  /** For a windowed plan: the contract and the serialized actual-windows.json. */
  readonly windows?: { readonly windowing: WindowingSpec; readonly actualWindowsText: string };
}

/**
 * target-run.json for a delivery, whatever the transport. It holds nothing about how the messages
 * travelled, so the same run, plan and target give the same file in process and through Kafka.
 */
export function buildTargetRun(input: TargetRunInput): TargetRunFile {
  const { manifest, summaryFile } = input;
  const targetRun: TargetRunFile = {
    format: 'dataforge.target-run',
    formatVersion: 1,
    target: { name: input.target.name, description: input.target.description },
    source: { seed: manifest.seed, scenarioName: manifest.scenario.name, eventsSha256: summaryFile.source.eventsSha256 },
    plan: {
      plannerVersion: summaryFile.plannerVersion,
      chaosSeed: summaryFile.chaosSeed,
      profile: summaryFile.profile,
      planSha256: summaryFile.files[PLAN_FILES.plan].sha256,
    },
    delivery: { ...input.delivery },
    counters: { ...input.counters },
    parkedEventIds: [...input.parkedEventIds],
    files: { [DELIVERY_FILES.actualState]: fileEntry(input.actualStateText) },
  };
  if (input.windows === undefined) {
    return targetRun;
  }
  return {
    ...targetRun,
    windowing: { sizeMs: input.windows.windowing.sizeMs, allowedLatenessMs: input.windows.windowing.allowedLatenessMs },
    files: { ...targetRun.files, [DELIVERY_FILES.actualWindows]: fileEntry(input.windows.actualWindowsText) },
  };
}

export function serializeTargetRun(targetRun: TargetRunFile): string {
  return `${canonicalJson(targetRun, 2)}\n`;
}

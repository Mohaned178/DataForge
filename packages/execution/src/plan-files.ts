import { z } from 'zod';
import { canonicalJson, fileEntry, fileEntrySchema, type CanonicalEvent, type RunManifest } from '@dataforge/core';
import { deliverySummarySchema, planDelivery, serializeDeliveryPlan, type ChaosProfile, type DeliveryPlan } from '@dataforge/chaos';

export const PLAN_FILES = {
  plan: 'delivery-plan.jsonl',
  profile: 'chaos-profile.resolved.json',
  summary: 'delivery-summary.json',
} as const;

export const deliverySummaryFileSchema = z.strictObject({
  format: z.literal('dataforge.delivery-plan'),
  formatVersion: z.literal(1),
  plannerVersion: z.string(),
  chaosSeed: z.string(),
  profile: z.strictObject({ name: z.string(), hash: z.string() }),
  /** The simulation run the plan belongs to, identified by content, never by path. */
  source: z.strictObject({
    engineVersion: z.string(),
    seed: z.string(),
    scenarioName: z.string(),
    scenarioHash: z.string(),
    eventsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  summary: deliverySummarySchema,
  files: z.strictObject({
    [PLAN_FILES.plan]: fileEntrySchema,
    [PLAN_FILES.profile]: fileEntrySchema,
  }),
});

export type DeliverySummaryFile = z.output<typeof deliverySummaryFileSchema>;

export interface PlanExecutionInput {
  /** The run the plan is for: its manifest names the canonical log the plan is bound to. */
  readonly manifest: RunManifest;
  readonly events: readonly CanonicalEvent[];
  readonly profile: ChaosProfile;
  /** Normalized (normalizeSeed). */
  readonly chaosSeed: string;
}

export interface PlannedExecution {
  readonly plan: DeliveryPlan;
  readonly summaryFile: DeliverySummaryFile;
  /** The exact bytes of the three plan files, by file name. */
  readonly contents: Readonly<Record<(typeof PLAN_FILES)[keyof typeof PLAN_FILES], string>>;
}

/** The chaos profile as written to chaos-profile.resolved.json (every default filled in). */
export function serializeResolvedProfile(profile: ChaosProfile): string {
  return `${canonicalJson(profile, 2)}\n`;
}

export function serializeDeliverySummaryFile(summaryFile: DeliverySummaryFile): string {
  return `${canonicalJson(summaryFile, 2)}\n`;
}

/**
 * Plans the faulty delivery of a run and builds the three plan files ("dataforge chaos plan"): the
 * plan, the resolved profile and the summary, which binds both to the run's canonical log by checksum.
 */
export function planExecution(input: PlanExecutionInput): PlannedExecution {
  const { manifest, profile } = input;
  const plan = planDelivery({ events: input.events, profile, chaosSeed: input.chaosSeed });
  const planText = serializeDeliveryPlan(plan.attempts);
  const profileText = serializeResolvedProfile(profile);
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
      [PLAN_FILES.plan]: fileEntry(planText),
      [PLAN_FILES.profile]: fileEntry(profileText),
    },
  };
  return {
    plan,
    summaryFile,
    contents: {
      [PLAN_FILES.plan]: planText,
      [PLAN_FILES.profile]: profileText,
      [PLAN_FILES.summary]: serializeDeliverySummaryFile(summaryFile),
    },
  };
}

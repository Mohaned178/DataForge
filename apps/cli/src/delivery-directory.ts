import { existsSync } from 'node:fs';
import { z } from 'zod';
import { UsageError } from './cli-io';
import { fileEntrySchema, readRunFile } from './run-directory';

export const DELIVERY_FILES = {
  actualState: 'actual-state.json',
  targetRun: 'target-run.json',
} as const;

const count = z.number().int().min(0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Written by `dataforge deliver` next to actual-state.json: which target consumed which plan of which run. */
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
  files: z.strictObject({ [DELIVERY_FILES.actualState]: fileEntrySchema }),
});

export type TargetRunFile = z.output<typeof targetRunFileSchema>;

/** The target-run.json of a delivery directory, or undefined when the directory has none. */
export function readTargetRun(directory: string): TargetRunFile | undefined {
  if (!existsSync(directory)) {
    return undefined;
  }
  const text = readRunFile(directory, DELIVERY_FILES.targetRun);
  if (text === undefined) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${DELIVERY_FILES.targetRun} in ${directory} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = targetRunFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(`${DELIVERY_FILES.targetRun} in ${directory} is invalid: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`);
  }
  return parsed.data;
}

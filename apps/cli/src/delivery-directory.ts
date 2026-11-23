import { existsSync } from 'node:fs';
import { DELIVERY_FILES, targetRunFileSchema, type TargetRunFile } from '@dataforge/execution';
import { UsageError } from './cli-io';
import { readRunFile } from './run-directory';

// The delivery-file format lives in @dataforge/execution, shared with the API.
export { DELIVERY_FILES, buildTargetRun, targetRunFileSchema, type TargetRunFile, type TargetRunInput } from '@dataforge/execution';

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

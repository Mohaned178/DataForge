import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CanonicalLogViolationError,
  EventLogParseError,
  RUN_FILES,
  parseEventLog,
  replayCanonicalLog,
  runManifestSchema,
  serializeExpectedState,
  sha256Hex,
  type CanonicalEvent,
  type ExpectedState,
  type RunManifest,
} from '@dataforge/core';
import { UsageError } from './cli-io';

// The run-file format lives in @dataforge/core, shared with the API; the CLI's modules import it from here.
export {
  CHECKSUMMED_FILES,
  RUN_FILES,
  fileEntry,
  fileEntrySchema,
  runManifestSchema,
  type ChecksummedFile,
  type FileEntry,
  type RunManifest,
} from '@dataforge/core';

/** Creates the output directory, refusing to mix a new run into a non-empty directory unless forced. */
export function prepareOutputDirectory(directory: string, force: boolean, files = 'run files'): void {
  if (existsSync(directory)) {
    if (!statSync(directory).isDirectory()) {
      throw new UsageError(`Output path exists and is not a directory: ${directory}`);
    }
    if (readdirSync(directory).length > 0 && !force) {
      throw new UsageError(`Output directory is not empty: ${directory}\nUse --force to overwrite the ${files} in it.`);
    }
    return;
  }
  mkdirSync(directory, { recursive: true });
}

/** Windows paths are case-insensitive; elsewhere they are not. */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Writes exact bytes: UTF-8, no BOM, "\n" line endings, on every operating system. */
export function writeRunFile(directory: string, name: string, content: string): void {
  writeFileSync(join(directory, name), content, { encoding: 'utf8' });
}

export function readRunFile(directory: string, name: string): string | undefined {
  const path = join(directory, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export function readManifest(directory: string): RunManifest {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new UsageError(`Run directory not found: ${directory}`);
  }
  const text = readRunFile(directory, RUN_FILES.manifest);
  if (text === undefined) {
    throw new UsageError(`${RUN_FILES.manifest} not found in ${directory}. Is this a DataForge run directory?`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${RUN_FILES.manifest} is not valid JSON: ${(error as Error).message}`);
  }
  const result = runManifestSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new UsageError(`${RUN_FILES.manifest} is invalid: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`);
  }
  return result.data;
}

/**
 * Loads the canonical log of a run for a command that builds on it (chaos planning, explanations).
 * The log must match the checksum in manifest.json, so nothing is ever planned from an edited log.
 */
export function readIntactCanonicalLog(directory: string, manifest: RunManifest): { text: string; events: CanonicalEvent[] } {
  const text = readRunFile(directory, RUN_FILES.events);
  if (text === undefined) {
    throw new UsageError(`${RUN_FILES.events} not found in ${directory}`);
  }
  if (sha256Hex(text) !== manifest.files[RUN_FILES.events].sha256) {
    throw new UsageError(
      `${RUN_FILES.events} in ${directory} does not match the checksum in ${RUN_FILES.manifest}: the run was modified.
` +
        'Run "dataforge verify --run <directory>" for details, or regenerate it.',
    );
  }
  try {
    return { text, events: parseEventLog(text) };
  } catch (error) {
    if (error instanceof EventLogParseError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

/**
 * The expected state of a run, re-derived by replaying its intact canonical log. expected-state.json
 * must match its checksum and the replay, so validation never compares against an edited file.
 */
export function readIntactExpectedState(directory: string, manifest: RunManifest, events: readonly CanonicalEvent[]): ExpectedState {
  const text = readRunFile(directory, RUN_FILES.expectedState);
  if (text === undefined) {
    throw new UsageError(`${RUN_FILES.expectedState} not found in ${directory}`);
  }
  const modified = `${RUN_FILES.expectedState} in ${directory} does not match`;
  const advice = 'Run "dataforge verify --run <directory>" for details, or regenerate it.';
  if (sha256Hex(text) !== manifest.files[RUN_FILES.expectedState].sha256) {
    throw new UsageError(`${modified} the checksum in ${RUN_FILES.manifest}: the run was modified.\n${advice}`);
  }
  let expectedState: ExpectedState;
  try {
    expectedState = replayCanonicalLog(events).expectedState;
  } catch (error) {
    if (error instanceof CanonicalLogViolationError) {
      throw new UsageError(`${RUN_FILES.events} in ${directory} breaks the business rules: ${error.message}\n${advice}`);
    }
    throw error;
  }
  if (serializeExpectedState(expectedState) !== text) {
    throw new UsageError(`${modified} the replayed canonical log.\n${advice}`);
  }
  return expectedState;
}

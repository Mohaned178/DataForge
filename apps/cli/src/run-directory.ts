import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EVENT_TYPES, EventLogParseError, parseEventLog, sha256Hex, type CanonicalEvent, type EventType } from '@dataforge/core';
import { UsageError } from './cli-io';

export const RUN_FILES = {
  events: 'events.jsonl',
  expectedState: 'expected-state.json',
  scenario: 'scenario.resolved.json',
  manifest: 'manifest.json',
} as const;

export const CHECKSUMMED_FILES = [RUN_FILES.events, RUN_FILES.expectedState, RUN_FILES.scenario] as const;
export type ChecksummedFile = (typeof CHECKSUMMED_FILES)[number];

export const fileEntrySchema = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(0) });

export const runManifestSchema = z.strictObject({
  format: z.literal('dataforge.simulation-run'),
  formatVersion: z.literal(1),
  engineVersion: z.string(),
  eventSchemaVersion: z.number().int(),
  seed: z.string(),
  scenario: z.strictObject({ name: z.string(), hash: z.string() }),
  simulation: z.strictObject({ epoch: z.string(), durationMs: z.number().int() }),
  counts: z.strictObject({
    events: z.number().int(),
    eventsByType: z.record(z.enum(EVENT_TYPES), z.number().int()),
  }),
  files: z.strictObject({
    [RUN_FILES.events]: fileEntrySchema,
    [RUN_FILES.expectedState]: fileEntrySchema,
    [RUN_FILES.scenario]: fileEntrySchema,
  }),
});

export type RunManifest = z.output<typeof runManifestSchema>;
export type FileEntry = z.output<typeof fileEntrySchema>;

export function fileEntry(content: string): FileEntry {
  return { sha256: sha256Hex(content), bytes: Buffer.byteLength(content, 'utf8') };
}

export function countEventsByType(events: readonly CanonicalEvent[]): Record<EventType, number> {
  const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<EventType, number>;
  for (const event of events) {
    counts[event.type] += 1;
  }
  return counts;
}

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

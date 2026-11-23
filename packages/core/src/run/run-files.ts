import { z } from 'zod';
import { EVENT_TYPES, type CanonicalEvent, type EventType } from '../events/canonical-event';
import { serializeEventLog } from '../events/event-log-jsonl';
import type { SimulationResult } from '../generation/simulate';
import { sha256Hex } from '../hashing';
import { serializeExpectedState } from '../projection/expected-state';
import type { ScenarioConfig } from '../scenario/scenario-schema';
import { canonicalJson } from '../serialization/canonical-json';
import { EVENT_SCHEMA_VERSION } from '../version';

/** The four files of a simulation run, wherever it is stored: a run directory or the API's database. */
export const RUN_FILES = {
  events: 'events.jsonl',
  expectedState: 'expected-state.json',
  scenario: 'scenario.resolved.json',
  manifest: 'manifest.json',
} as const;

export const CHECKSUMMED_FILES = [RUN_FILES.events, RUN_FILES.expectedState, RUN_FILES.scenario] as const;
export type ChecksummedFile = (typeof CHECKSUMMED_FILES)[number];
export type RunFileName = (typeof RUN_FILES)[keyof typeof RUN_FILES];
export const RUN_FILE_NAMES = [...CHECKSUMMED_FILES, RUN_FILES.manifest] as const satisfies readonly RunFileName[];

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

export interface RunFiles {
  readonly manifest: RunManifest;
  /** The exact bytes of each file: UTF-8, "\n" line endings, trailing newline. */
  readonly contents: Readonly<Record<RunFileName, string>>;
}

const utf8 = new TextEncoder();

export function fileEntry(content: string): FileEntry {
  return { sha256: sha256Hex(content), bytes: utf8.encode(content).length };
}

export function countEventsByType(events: readonly CanonicalEvent[]): Record<EventType, number> {
  const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<EventType, number>;
  for (const event of events) {
    counts[event.type] += 1;
  }
  return counts;
}

export function serializeResolvedScenario(scenario: ScenarioConfig): string {
  return `${canonicalJson(scenario, 2)}\n`;
}

export function serializeRunManifest(manifest: RunManifest): string {
  return `${canonicalJson(manifest, 2)}\n`;
}

/**
 * Builds the files of a run from its scenario and simulation result. The CLI writes them to a run
 * directory; the API rebuilds them from its database and must arrive at the same bytes.
 */
export function buildRunFiles(scenario: ScenarioConfig, result: SimulationResult): RunFiles {
  const events = serializeEventLog(result.events);
  const expectedState = serializeExpectedState(result.expectedState);
  const resolvedScenario = serializeResolvedScenario(scenario);
  const manifest: RunManifest = {
    format: 'dataforge.simulation-run',
    formatVersion: 1,
    engineVersion: result.engineVersion,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    seed: result.seed,
    scenario: { name: scenario.name, hash: result.scenarioHash },
    simulation: { epoch: scenario.simulation.epoch, durationMs: scenario.simulation.durationMs },
    counts: { events: result.events.length, eventsByType: countEventsByType(result.events) },
    files: {
      [RUN_FILES.events]: fileEntry(events),
      [RUN_FILES.expectedState]: fileEntry(expectedState),
      [RUN_FILES.scenario]: fileEntry(resolvedScenario),
    },
  };
  return {
    manifest,
    contents: {
      [RUN_FILES.events]: events,
      [RUN_FILES.expectedState]: expectedState,
      [RUN_FILES.scenario]: resolvedScenario,
      [RUN_FILES.manifest]: serializeRunManifest(manifest),
    },
  };
}

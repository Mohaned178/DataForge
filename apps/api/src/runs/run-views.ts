import type { CanonicalEvent, ExpectedStateSummary, FileEntry, RunManifest } from '@dataforge/core';
import type { RunStatusName } from './run-requests';

export interface RunView {
  readonly id: string;
  readonly status: RunStatusName;
  readonly scenario: { readonly id: string; readonly name: string; readonly version: number; readonly scenarioHash: string };
  readonly seed: string;
  readonly engineVersion: string;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly error: string | null;
  readonly eventCount: number | null;
  readonly eventsByType: RunManifest['counts']['eventsByType'] | null;
  /** Checksum and size of each file of the run, as in its manifest.json. */
  readonly files: Readonly<Record<string, FileEntry>> | null;
  readonly summary: ExpectedStateSummary | null;
}

export interface RunListView {
  readonly runs: readonly RunView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface RunEventsView {
  readonly runId: string;
  readonly events: readonly CanonicalEvent[];
  /** The fromSequence of the next page, or null when this page reached the end. */
  readonly nextSequence: number | null;
}

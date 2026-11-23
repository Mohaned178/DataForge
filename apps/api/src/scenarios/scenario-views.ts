import type { ScenarioConfig } from '@dataforge/core';

export interface VersionSummaryView {
  readonly version: number;
  readonly scenarioHash: string;
  readonly createdAt: Date;
}

export interface ScenarioSummaryView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly latestVersion: number;
}

export interface ScenarioView extends ScenarioSummaryView {
  readonly versions: readonly VersionSummaryView[];
}

export interface ScenarioVersionView extends VersionSummaryView {
  readonly scenarioId: string;
  readonly scenarioName: string;
  /** The resolved scenario: the submitted document with every default filled in. */
  readonly definition: ScenarioConfig;
}

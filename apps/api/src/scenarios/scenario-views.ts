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

/** The answer of POST /scenarios/validate: the document is valid; nothing was stored. */
export interface ScenarioValidationView {
  readonly valid: true;
  readonly name: string;
  readonly scenarioHash: string;
  /** The resolved scenario: the submitted document with every default filled in, as a stored version would hold it. */
  readonly definition: ScenarioConfig;
}

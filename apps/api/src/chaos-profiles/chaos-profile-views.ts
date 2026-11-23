import type { ChaosProfile } from '@dataforge/chaos';

export interface ProfileVersionSummaryView {
  readonly version: number;
  readonly profileHash: string;
  readonly createdAt: Date;
}

export interface ChaosProfileSummaryView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly latestVersion: number;
}

export interface ChaosProfileView extends ChaosProfileSummaryView {
  readonly versions: readonly ProfileVersionSummaryView[];
}

export interface ChaosProfileVersionView extends ProfileVersionSummaryView {
  readonly chaosProfileId: string;
  readonly chaosProfileName: string;
  /** The resolved profile: the submitted document with every default filled in (chaos-profile.resolved.json). */
  readonly definition: ChaosProfile;
}

/** The answer of POST /chaos-profiles/validate: the profile is valid; nothing was stored. */
export interface ChaosProfileValidationView {
  readonly valid: true;
  readonly name: string;
  readonly profileHash: string;
  /** The resolved profile: the submitted document with every default filled in, as a stored version would hold it. */
  readonly definition: ChaosProfile;
}

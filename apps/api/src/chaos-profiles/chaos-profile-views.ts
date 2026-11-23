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

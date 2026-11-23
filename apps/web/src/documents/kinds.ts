import { api, writes } from '../api/endpoints';
import type { Written } from '../api/client';
import { CHAOS_PROFILE_TEMPLATES, SCENARIO_TEMPLATES, type Template } from '../templates';

/*
 * Scenarios and chaos profiles are the same kind of thing to the UI: a named document with immutable
 * versions, edited as JSON, checked by a dry run, saved as a new document or a new version. One
 * description per kind lets the list, detail and editor pages be written once; the two kinds differ only
 * in their words, their routes, their endpoints and their templates.
 */

export interface DocumentSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly latestVersion: number;
}

export interface DocumentVersionSummary {
  readonly version: number;
  readonly hash: string;
  readonly createdAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  readonly versions: readonly DocumentVersionSummary[];
}

export interface DocumentVersion {
  readonly version: number;
  readonly hash: string;
  /** The resolved document: every default filled in, as stored. */
  readonly definition: Record<string, unknown>;
}

export interface DocumentCheck {
  readonly name: string;
  readonly hash: string;
  readonly definition: Record<string, unknown>;
}

export interface DocumentKind {
  readonly id: 'scenario' | 'chaos-profile';
  /** "scenario", "chaos profile": for sentences. */
  readonly noun: string;
  readonly plural: string;
  /** The page title of the list. */
  readonly title: string;
  /** The route of the list ("/scenarios"); the pages below it are `${route}/new`, `${route}/:id`, `${route}/:id/versions/new`. */
  readonly route: string;
  /** The query parameter that carries this kind's id to a launch form ("scenarioId"). */
  readonly launchParam: string;
  /** The page a document leads to: where its runs or executions are started. */
  readonly launch: { readonly label: string; readonly route: string; readonly noun: string };
  readonly templates: readonly Template[];
  readonly list: (signal: AbortSignal) => Promise<readonly DocumentSummary[]>;
  readonly get: (id: string, signal: AbortSignal) => Promise<DocumentDetail>;
  readonly getVersion: (id: string, version: number, signal: AbortSignal) => Promise<DocumentVersion>;
  /** The dry run: stores nothing; refuses with the same problems as saving. */
  readonly check: (document: unknown, signal: AbortSignal) => Promise<DocumentCheck>;
  readonly create: (document: unknown) => Promise<{ id: string; name: string }>;
  /** `status` is 201 for a new version and 200 when the document was identical to an existing one. */
  readonly addVersion: (id: string, document: unknown) => Promise<Written<{ version: number; hash: string }>>;
}

export const SCENARIO_KIND: DocumentKind = {
  id: 'scenario',
  noun: 'scenario',
  plural: 'scenarios',
  title: 'Scenarios',
  route: '/scenarios',
  launchParam: 'scenarioId',
  launch: { label: 'New run', route: '/runs/new', noun: 'run' },
  templates: SCENARIO_TEMPLATES,
  list: async (signal) => (await api.scenarios(signal)).scenarios,
  get: async (id, signal) => {
    const scenario = await api.scenario(id, signal);
    return { ...scenario, versions: scenario.versions.map(({ version, scenarioHash, createdAt }) => ({ version, hash: scenarioHash, createdAt })) };
  },
  getVersion: async (id, version, signal) => {
    const found = await api.scenarioVersion(id, version, signal);
    return { version: found.version, hash: found.scenarioHash, definition: found.definition };
  },
  check: async (document, signal) => {
    const { data } = await writes.validateScenario(document, signal);
    return { name: data.name, hash: data.scenarioHash, definition: data.definition };
  },
  create: async (document) => {
    const { data } = await writes.createScenario(document);
    return { id: data.id, name: data.name };
  },
  addVersion: async (id, document) => {
    const { status, data } = await writes.addScenarioVersion(id, document);
    return { status, data: { version: data.version, hash: data.scenarioHash } };
  },
};

export const CHAOS_PROFILE_KIND: DocumentKind = {
  id: 'chaos-profile',
  noun: 'chaos profile',
  plural: 'chaos profiles',
  title: 'Chaos profiles',
  route: '/chaos-profiles',
  launchParam: 'chaosProfileId',
  launch: { label: 'New execution', route: '/executions/new', noun: 'execution' },
  templates: CHAOS_PROFILE_TEMPLATES,
  list: async (signal) => (await api.chaosProfiles(signal)).chaosProfiles,
  get: async (id, signal) => {
    const profile = await api.chaosProfile(id, signal);
    return { ...profile, versions: profile.versions.map(({ version, profileHash, createdAt }) => ({ version, hash: profileHash, createdAt })) };
  },
  getVersion: async (id, version, signal) => {
    const found = await api.chaosProfileVersion(id, version, signal);
    return { version: found.version, hash: found.profileHash, definition: found.definition };
  },
  check: async (document, signal) => {
    const { data } = await writes.validateChaosProfile(document, signal);
    return { name: data.name, hash: data.profileHash, definition: data.definition };
  },
  create: async (document) => {
    const { data } = await writes.createChaosProfile(document);
    return { id: data.id, name: data.name };
  },
  addVersion: async (id, document) => {
    const { status, data } = await writes.addChaosProfileVersion(id, document);
    return { status, data: { version: data.version, hash: data.profileHash } };
  },
};

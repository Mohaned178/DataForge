import { API_BASE, getJson, postJson, queryString } from './client';
import {
  attemptsSchema,
  chaosProfileListSchema,
  chaosProfileValidationSchema,
  chaosProfileVersionSchema,
  chaosProfileViewSchema,
  executionListSchema,
  executionSchema,
  findingsSchema,
  reportSchema,
  runEventsSchema,
  runListSchema,
  runSchema,
  scenarioListSchema,
  scenarioValidationSchema,
  scenarioVersionSchema,
  scenarioViewSchema,
  windowFindingsSchema,
  type Attempt,
  type CanonicalEvent,
} from './schemas';

export interface RunsQuery {
  readonly status?: string | undefined;
  readonly scenarioId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ExecutionsQuery {
  readonly status?: string | undefined;
  readonly verdict?: string | undefined;
  readonly runId?: string | undefined;
  readonly chaosProfileId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface RunEventsQuery {
  readonly type?: string | undefined;
  readonly aggregateId?: string | undefined;
  readonly fromSequence?: number | undefined;
  readonly limit?: number | undefined;
}

export interface AttemptsQuery {
  readonly eventId?: string | undefined;
  readonly aggregateId?: string | undefined;
  readonly kind?: string | undefined;
  readonly fault?: string | undefined;
  readonly plannedOutcome?: string | undefined;
  readonly fromSequence?: number | undefined;
  readonly limit?: number | undefined;
}

export interface FindingsQuery {
  readonly category?: string | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface WindowFindingsQuery {
  readonly category?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** POST /runs: the seed is the text the user typed (the API normalizes 42 and "42" to one seed). */
export interface StartRunRequest {
  readonly scenarioId: string;
  readonly version?: number;
  readonly seed: string;
}

export type TargetRequest =
  | {
      readonly type: 'reference';
      readonly name: 'correct' | 'naive';
      readonly transport: 'memory' | 'kafka';
      readonly partitions?: number;
      readonly speed?: 'max' | number;
      readonly timeoutSeconds?: number;
    }
  | { readonly type: 'external'; readonly topic: string; readonly groupId: string; readonly speed?: 'max' | number; readonly timeoutSeconds?: number };

/** POST /executions. Options the target does not take are absent, not null: the API rejects unknown and misplaced keys. */
export interface StartExecutionRequest {
  readonly runId: string;
  readonly chaosProfileId: string;
  readonly chaosProfileVersion?: number;
  readonly chaosSeed: string;
  readonly target: TargetRequest;
}

/** The files an external pipeline wrote, as parsed JSON. */
export interface ActualStateSubmission {
  readonly actualState: unknown;
  readonly actualWindows?: unknown;
}

const enc = encodeURIComponent;

/** Every call the pages make. The only module that knows the API's paths. */
export const api = {
  runs: (query: RunsQuery, signal?: AbortSignal) => getJson(`/runs${queryString({ ...query })}`, runListSchema, signal),
  run: (runId: string, signal?: AbortSignal) => getJson(`/runs/${enc(runId)}`, runSchema, signal),
  runEvents: (runId: string, query: RunEventsQuery, signal?: AbortSignal) =>
    getJson(`/runs/${enc(runId)}/events${queryString({ ...query })}`, runEventsSchema, signal),
  executions: (query: ExecutionsQuery, signal?: AbortSignal) => getJson(`/executions${queryString({ ...query })}`, executionListSchema, signal),
  execution: (executionId: string, signal?: AbortSignal) => getJson(`/executions/${enc(executionId)}`, executionSchema, signal),
  attempts: (executionId: string, query: AttemptsQuery, signal?: AbortSignal) =>
    getJson(`/executions/${enc(executionId)}/attempts${queryString({ ...query })}`, attemptsSchema, signal),
  report: (executionId: string, signal?: AbortSignal) => getJson(`/executions/${enc(executionId)}/report`, reportSchema, signal),
  findings: (executionId: string, query: FindingsQuery, signal?: AbortSignal) =>
    getJson(`/executions/${enc(executionId)}/findings${queryString({ ...query })}`, findingsSchema, signal),
  windowFindings: (executionId: string, query: WindowFindingsQuery, signal?: AbortSignal) =>
    getJson(`/executions/${enc(executionId)}/window-findings${queryString({ ...query })}`, windowFindingsSchema, signal),
  scenarios: (signal?: AbortSignal) => getJson('/scenarios', scenarioListSchema, signal),
  scenario: (scenarioId: string, signal?: AbortSignal) => getJson(`/scenarios/${enc(scenarioId)}`, scenarioViewSchema, signal),
  scenarioVersion: (scenarioId: string, version: number, signal?: AbortSignal) =>
    getJson(`/scenarios/${enc(scenarioId)}/versions/${version}`, scenarioVersionSchema, signal),
  chaosProfiles: (signal?: AbortSignal) => getJson('/chaos-profiles', chaosProfileListSchema, signal),
  chaosProfile: (profileId: string, signal?: AbortSignal) => getJson(`/chaos-profiles/${enc(profileId)}`, chaosProfileViewSchema, signal),
  chaosProfileVersion: (profileId: string, version: number, signal?: AbortSignal) =>
    getJson(`/chaos-profiles/${enc(profileId)}/versions/${version}`, chaosProfileVersionSchema, signal),
  executionFileUrl: (executionId: string, name: string) => `${API_BASE}/executions/${enc(executionId)}/files/${enc(name)}`,
  runFileUrl: (runId: string, name: string) => `${API_BASE}/runs/${enc(runId)}/files/${enc(name)}`,
};

/** The most pages a "load everything" helper follows: 100 pages of 1,000 is far beyond one aggregate. */
const MAX_PAGES = 100;

/** All stored events of one aggregate, following `nextSequence`. */
export async function loadAggregateEvents(runId: string, aggregateId: string, signal?: AbortSignal): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  let fromSequence: number | null = 1;
  for (let page = 0; fromSequence !== null && page < MAX_PAGES; page += 1) {
    const result = await api.runEvents(runId, { aggregateId, fromSequence, limit: 1000 }, signal);
    events.push(...result.events);
    fromSequence = result.nextSequence;
  }
  return events;
}

/** All delivery attempts of one aggregate, following `nextSequence`. */
export async function loadAggregateAttempts(executionId: string, aggregateId: string, signal?: AbortSignal): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let fromSequence: number | null = 1;
  for (let page = 0; fromSequence !== null && page < MAX_PAGES; page += 1) {
    const result = await api.attempts(executionId, { aggregateId, fromSequence, limit: 1000 }, signal);
    attempts.push(...result.attempts);
    fromSequence = result.nextSequence;
  }
  return attempts;
}

/** Everything the UI writes. Each call answers with the HTTP status as well, and refuses with an ApiError listing the API's problems. */
export const writes = {
  validateScenario: (document: unknown, signal?: AbortSignal) => postJson('/scenarios/validate', document, scenarioValidationSchema, signal),
  createScenario: (document: unknown) => postJson('/scenarios', document, scenarioViewSchema),
  addScenarioVersion: (scenarioId: string, document: unknown) => postJson(`/scenarios/${enc(scenarioId)}/versions`, document, scenarioVersionSchema),
  validateChaosProfile: (document: unknown, signal?: AbortSignal) => postJson('/chaos-profiles/validate', document, chaosProfileValidationSchema, signal),
  createChaosProfile: (document: unknown) => postJson('/chaos-profiles', document, chaosProfileViewSchema),
  addChaosProfileVersion: (profileId: string, document: unknown) =>
    postJson(`/chaos-profiles/${enc(profileId)}/versions`, document, chaosProfileVersionSchema),
  startRun: (request: StartRunRequest) => postJson('/runs', request, runSchema),
  startExecution: (request: StartExecutionRequest) => postJson('/executions', request, executionSchema),
  submitActualState: (executionId: string, submission: ActualStateSubmission) =>
    postJson(`/executions/${enc(executionId)}/actual-state`, submission, executionSchema),
};

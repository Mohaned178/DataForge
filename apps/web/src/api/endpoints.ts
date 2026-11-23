import { API_BASE, getJson, queryString } from './client';
import {
  attemptsSchema,
  executionListSchema,
  executionSchema,
  findingsSchema,
  reportSchema,
  runEventsSchema,
  runListSchema,
  runSchema,
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

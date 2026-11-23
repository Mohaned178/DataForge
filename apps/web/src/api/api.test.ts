import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtures } from '../test/fixtures';
import { apiErrorResponse, ok, proxyDownResponse, stubApi } from '../test/support';
import { ApiError, ApiUnreachable, ResponseShapeError, getJson, queryString } from './client';
import { api, loadAggregateAttempts, loadAggregateEvents } from './endpoints';
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
} from './schemas';
import { z } from 'zod';

afterEach(() => {
  vi.unstubAllGlobals();
});

const anything = z.object({ ok: z.boolean() });

describe('the client reports each kind of failure distinctly', () => {
  test('a network failure and the proxy answering 502 with no body mean the API is unreachable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    await expect(getJson('/health', anything)).rejects.toBeInstanceOf(ApiUnreachable);

    stubApi([{ path: '/health', respond: proxyDownResponse }]);
    await expect(getJson('/health', anything)).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining('502') as string });
  });

  test('an error in the API shape keeps its status, name and messages', async () => {
    stubApi([{ path: '/runs/x', respond: () => apiErrorResponse(404, 'Not Found', 'Run x does not exist') }]);
    const error = await getJson('/runs/x', anything).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 404, error: 'Not Found', messages: ['Run x does not exist'], isIntegrityError: false });
  });

  test('a validation error lists every message', async () => {
    stubApi([{ path: '/runs', respond: () => apiErrorResponse(400, 'Bad Request', ['limit: Too big', 'status: Invalid option']) }]);
    const error = await getJson('/runs', anything).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 400, messages: ['limit: Too big', 'status: Invalid option'] });
  });

  test('a stored resource that no longer matches its checksum is an integrity error, not just a 500', async () => {
    stubApi([{ path: '/runs/x/events', respond: () => apiErrorResponse(500, 'Run Integrity Error', 'Event 12 does not match') }]);
    const error = await getJson('/runs/x/events', anything).catch((caught: unknown) => caught);
    expect((error as ApiError).isIntegrityError).toBe(true);

    stubApi([{ path: '/runs/x', respond: () => apiErrorResponse(500, 'Internal Server Error', 'boom') }]);
    const other = await getJson('/runs/x', anything).catch((caught: unknown) => caught);
    expect((other as ApiError).isIntegrityError).toBe(false);
  });

  test('a 4xx without a JSON body is still an API error, not an unreachable API', async () => {
    stubApi([{ path: '/runs', respond: () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }) }]);
    await expect(getJson('/runs', anything)).rejects.toMatchObject({ kind: 'api', statusCode: 404 });
  });

  test('a successful answer that is not what the UI reads is reported by path', async () => {
    stubApi([{ path: '/runs', respond: ok({ runs: [{ id: 1 }], total: 'many', limit: 50, offset: 0 }) }]);
    const error = await getJson('/runs', runListSchema).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResponseShapeError);
    const issues = (error as ResponseShapeError).issues.join('\n');
    expect(issues).toContain('runs.0.id');
    expect(issues).toContain('total');
  });

  test('a body that is not JSON is a shape error', async () => {
    stubApi([{ path: '/runs', respond: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) }]);
    await expect(getJson('/runs', runListSchema)).rejects.toMatchObject({ kind: 'shape' });
  });

  test('an aborted request stays an abort and is never reported as an outage', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new DOMException('aborted', 'AbortError')));
    await expect(getJson('/runs', anything)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('queries', () => {
  test('only defined, non-empty parameters are sent', () => {
    expect(queryString({ status: 'failed', limit: 25, offset: 0, verdict: undefined, runId: '' })).toBe('?status=failed&limit=25&offset=0');
    expect(queryString({})).toBe('');
  });

  test('each endpoint builds the path and query the API expects', async () => {
    const stub = stubApi([
      { path: '/runs', respond: ok(fixtures.runs) },
      { path: '/executions/e1/findings', respond: ok(fixtures.findings.fail) },
    ]);
    await api.runs({ status: 'succeeded', limit: 25, offset: 50 });
    await api.findings('e1', { category: 'status-mismatch', entityType: undefined, offset: 25, limit: 25 });
    expect(stub.calls).toEqual(['/runs?status=succeeded&limit=25&offset=50', '/executions/e1/findings?category=status-mismatch&offset=25&limit=25']);
  });

  test('an identifier from the URL cannot change the path it is put into', () => {
    expect(api.executionFileUrl('e1', 'validation-report.json')).toBe('/api/executions/e1/files/validation-report.json');
    expect(api.executionFileUrl('a/../b', 'x y')).toBe('/api/executions/a%2F..%2Fb/files/x%20y');
  });

  test('all pages of an aggregate are loaded, following the next sequence', async () => {
    const page = (events: unknown[], nextSequence: number | null) => ok({ runId: 'r', events, nextSequence });
    const [first, second] = fixtures.aggregate.reorder.runEvents.events;
    let served = 0;
    stubApi([
      {
        path: '/runs/r/events',
        respond: () => {
          served += 1;
          return served === 1 ? page([first], 7)() : page([second], null)();
        },
      },
    ]);
    const events = await loadAggregateEvents('r', 'ord_000088');
    expect(events.map((event) => event.eventId)).toEqual([first?.eventId, second?.eventId]);
  });

  test('all attempts of an aggregate come back in one page when there is no next sequence', async () => {
    stubApi([{ path: `/executions/${fixtures.index.executions.fail}/attempts`, respond: ok(fixtures.aggregate.reorder.attempts) }]);
    const attempts = await loadAggregateAttempts(fixtures.index.executions.fail, 'ord_000088');
    expect(attempts).toHaveLength(4);
  });
});

describe('the schemas accept what the real API sent', () => {
  test('every captured response parses', () => {
    expect(runListSchema.parse(fixtures.runs).runs).toHaveLength(1);
    expect(runSchema.parse(fixtures.run).status).toBe('succeeded');
    expect(runEventsSchema.parse(fixtures.runEvents).events.length).toBeGreaterThan(0);
    expect(executionListSchema.parse(fixtures.executions).executions).toHaveLength(5);
    for (const execution of Object.values(fixtures.execution)) expect(executionSchema.parse(execution).status).toBe('completed');
    for (const report of Object.values(fixtures.report)) expect(reportSchema.parse(report).verdict).toMatch(/PASS|FAIL/);
    expect(findingsSchema.parse(fixtures.findings.fail).findings).toHaveLength(48);
    expect(windowFindingsSchema.parse(fixtures.windowFindings.late).findings).toHaveLength(7);
    for (const fixture of Object.values(fixtures.aggregate)) expect(attemptsSchema.parse(fixture.attempts).attempts.length).toBeGreaterThan(0);
  });

  test('a field the API adds is ignored', () => {
    const extended = { ...fixtures.run, somethingNew: { nested: true } };
    expect(runSchema.parse(extended)).not.toHaveProperty('somethingNew');
  });

  test('a field the UI reads that changes type is reported with its path', () => {
    const broken = { ...fixtures.execution.fail, attemptCount: '486' };
    const result = executionSchema.safeParse(broken);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['attemptCount']);
  });

  test('a fault type the UI does not know is not silently accepted', () => {
    const attempt = { ...fixtures.aggregate.reorder.attempts.attempts[0], faults: [{ type: 'corruption' }] };
    expect(attemptsSchema.safeParse({ ...fixtures.aggregate.reorder.attempts, attempts: [attempt] }).success).toBe(false);
  });

  test('a response of the wrong kind altogether fails', () => {
    expect(runListSchema.safeParse([]).success).toBe(false);
    expect(runListSchema.safeParse(null).success).toBe(false);
  });
});

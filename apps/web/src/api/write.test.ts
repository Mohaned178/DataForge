import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { apiErrorResponse, jsonResponse, proxyDownResponse, stubApi } from '../test/support';
import { ApiError, ApiUnreachable, ResponseShapeError, postJson } from './client';
import { writes } from './endpoints';

afterEach(() => {
  vi.unstubAllGlobals();
});

const created = z.object({ id: z.string() });

describe('postJson', () => {
  test('sends the body as JSON with POST below /api and returns the status with the validated answer', async () => {
    const stub = stubApi([{ method: 'POST', path: '/things', respond: () => jsonResponse({ id: 'x', extra: 'ignored' }, 201) }]);
    const result = await postJson('/things', { name: 'a', seed: '42' }, created);
    expect(result).toEqual({ status: 201, data: { id: 'x' } });
    expect(stub.requests).toEqual([{ method: 'POST', path: '/things', body: { name: 'a', seed: '42' } }]);
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  test('keeps the status that tells a new version (201) from an existing one (200)', async () => {
    stubApi([{ method: 'POST', path: '/things', respond: () => jsonResponse({ id: 'x' }, 200) }]);
    expect((await postJson('/things', {}, created)).status).toBe(200);
  });

  test('a 400 is an ApiError carrying the API\'s problems, one per message', async () => {
    stubApi([
      {
        method: 'POST',
        path: '/things',
        respond: () => apiErrorResponse(400, 'Bad Request', ['customers.count: Too small', 'Unrecognized key: "colour"']),
      },
    ]);
    const failure = await postJson('/things', {}, created).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ statusCode: 400, error: 'Bad Request', messages: ['customers.count: Too small', 'Unrecognized key: "colour"'] });
  });

  test('a 409 conflict keeps its single message', async () => {
    stubApi([{ method: 'POST', path: '/things', respond: () => apiErrorResponse(409, 'Conflict', 'A scenario named "x" already exists') }]);
    const failure = await postJson('/things', {}, created).catch((error: unknown) => error);
    expect(failure).toMatchObject({ statusCode: 409, messages: ['A scenario named "x" already exists'] });
  });

  test('a network failure and the proxy\'s empty 502 are both "the API is not reachable"', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await postJson('/things', {}, created).catch((error: unknown) => error)).toBeInstanceOf(ApiUnreachable);
    stubApi([{ method: 'POST', path: '/things', respond: proxyDownResponse }]);
    expect(await postJson('/things', {}, created).catch((error: unknown) => error)).toBeInstanceOf(ApiUnreachable);
  });

  test('an answer that is not what the UI reads is reported by path (the request may have been accepted)', async () => {
    stubApi([{ method: 'POST', path: '/things', respond: () => jsonResponse({ id: 7 }, 201) }]);
    const failure = await postJson('/things', {}, created).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResponseShapeError);
    expect(failure).toMatchObject({ path: '/things', issues: [expect.stringContaining('id:')] });
  });
});

describe('the writes the UI makes', () => {
  test('use the API\'s paths and the document as given', async () => {
    const stub = stubApi([
      { method: 'POST', path: '/scenarios/validate', respond: () => jsonResponse({ valid: true, name: 'n', scenarioHash: 'h', definition: {} }) },
      { method: 'POST', path: '/chaos-profiles/validate', respond: () => jsonResponse({ valid: true, name: 'n', profileHash: 'h', definition: {} }) },
    ]);
    await writes.validateScenario({ formatVersion: 1, name: 'n' });
    await writes.validateChaosProfile({ formatVersion: 1, name: 'n' });
    expect(stub.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['POST /scenarios/validate', 'POST /chaos-profiles/validate']);
  });
});

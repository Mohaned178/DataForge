import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_VERSION, parseScenario, scenarioHash, type CanonicalEvent } from '@dataforge/core';
import type { RunEventsView, RunListView, RunView } from '../src/runs/run-views';
import type { ScenarioSummaryView, ScenarioVersionView, ScenarioView } from '../src/scenarios/scenario-views';
import { SCENARIOS, clearDatabase, startApi, waitForRun, type TestApi } from './support';

const SMALL = JSON.parse(readFileSync(join(SCENARIOS, 'ecommerce-small.json'), 'utf8')) as Record<string, unknown>;
const UNKNOWN_ID = '01a20000-0000-7000-8000-000000000000';

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  await api.runner.whenIdle();
  await clearDatabase(api.prisma);
});

async function createScenario(document: Record<string, unknown> = SMALL): Promise<ScenarioView> {
  const response = await api.http.post('/scenarios').send(document).expect(201);
  return response.body as ScenarioView;
}

async function startRun(scenarioId: string, seed: string | number, version?: number): Promise<RunView> {
  const response = await api.http
    .post('/runs')
    .send({ scenarioId, seed, ...(version === undefined ? {} : { version }) })
    .expect(202);
  return response.body as RunView;
}

describe('GET /health', () => {
  it('reports the database up and the engine version', async () => {
    await api.http.get('/health').expect(200, { status: 'ok', database: 'up', engineVersion: ENGINE_VERSION });
  });
});

describe('scenarios', () => {
  it('stores a posted scenario file as version 1 with its resolved definition and hash', async () => {
    const scenario = await createScenario();
    expect(scenario).toMatchObject({ name: 'ecommerce-small', latestVersion: 1, versions: [{ version: 1 }] });
    const version = (await api.http.get(`/scenarios/${scenario.id}/versions/1`).expect(200)).body as ScenarioVersionView;
    const resolved = parseScenario(SMALL);
    expect(version).toMatchObject({ scenarioId: scenario.id, scenarioName: 'ecommerce-small', version: 1, scenarioHash: scenarioHash(resolved) });
    expect(version.definition).toEqual(resolved);
    const listed = (await api.http.get('/scenarios').expect(200)).body as { scenarios: ScenarioSummaryView[] };
    expect(listed.scenarios).toEqual([{ id: scenario.id, name: 'ecommerce-small', createdAt: scenario.createdAt, latestVersion: 1 }]);
  });

  it('fills in defaults, so a minimal document becomes a complete definition', async () => {
    const scenario = await createScenario({ formatVersion: 1, name: 'minimal' });
    const version = (await api.http.get(`/scenarios/${scenario.id}/versions/1`).expect(200)).body as ScenarioVersionView;
    expect(version.definition).toEqual(parseScenario({ formatVersion: 1, name: 'minimal' }));
    expect(version.definition.orders.count).toBe(500);
  });

  it('rejects an invalid document with 400 and the path of every problem, storing nothing', async () => {
    const response = await api.http
      .post('/scenarios')
      .send({ ...SMALL, orders: { count: -1 }, customers: { count: 'many' }, colour: 'blue' })
      .expect(400);
    expect(response.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['customers.count: Invalid input: expected number, received string', 'orders.count: Too small: expected number to be >=0', 'Unrecognized key: "colour"'],
    });
    expect((await api.http.get('/scenarios').expect(200)).body).toEqual({ scenarios: [] });
  });

  it('rejects a body that is not JSON', async () => {
    const response = await api.http.post('/scenarios').set('Content-Type', 'application/json').send('{"formatVersion": 1,').expect(400);
    expect((response.body as { message: string }).message).toMatch(/JSON/);
  });

  it('refuses a second scenario with the same name (409) and points at its versions', async () => {
    const first = await createScenario();
    const response = await api.http.post('/scenarios').send(SMALL).expect(409);
    expect((response.body as { message: string }).message).toBe(
      `A scenario named "ecommerce-small" already exists (id ${first.id}); add a version with POST /scenarios/${first.id}/versions.`,
    );
  });

  it('adds a changed definition as a new immutable version and returns the existing version for an identical one', async () => {
    const scenario = await createScenario();
    const changed = { ...SMALL, orders: { ...(SMALL['orders'] as object), count: 60 } };
    const second = (await api.http.post(`/scenarios/${scenario.id}/versions`).send(changed).expect(201)).body as ScenarioVersionView;
    expect(second).toMatchObject({ version: 2, scenarioHash: scenarioHash(parseScenario(changed)) });
    expect(second.definition.orders.count).toBe(60);

    const again = (await api.http.post(`/scenarios/${scenario.id}/versions`).send(SMALL).expect(200)).body as ScenarioVersionView;
    expect(again.version).toBe(1);
    const sameAsTwo = (await api.http.post(`/scenarios/${scenario.id}/versions`).send(changed).expect(200)).body as ScenarioVersionView;
    expect(sameAsTwo.version).toBe(2);

    const detail = (await api.http.get(`/scenarios/${scenario.id}`).expect(200)).body as ScenarioView;
    expect(detail.latestVersion).toBe(2);
    expect(detail.versions.map((version) => version.version)).toEqual([1, 2]);
    const first = (await api.http.get(`/scenarios/${scenario.id}/versions/1`).expect(200)).body as ScenarioVersionView;
    expect(first.definition.orders.count).toBe(120);
  });

  it('refuses a version whose document has another name', async () => {
    const scenario = await createScenario();
    const response = await api.http.post(`/scenarios/${scenario.id}/versions`).send({ ...SMALL, name: 'renamed' }).expect(400);
    expect((response.body as { message: string[] }).message).toEqual([
      'name: the document is named "renamed" but this scenario is "ecommerce-small"; a new name is a new scenario (POST /scenarios)',
    ]);
  });

  it('answers 404 for unknown scenarios and versions and 400 for malformed ids', async () => {
    const scenario = await createScenario();
    await api.http.get(`/scenarios/${UNKNOWN_ID}`).expect(404);
    await api.http.post(`/scenarios/${UNKNOWN_ID}/versions`).send(SMALL).expect(404);
    const missing = await api.http.get(`/scenarios/${scenario.id}/versions/9`).expect(404);
    expect((missing.body as { message: string }).message).toBe(`Scenario ${scenario.id} has no version 9.`);
    const malformed = await api.http.get('/scenarios/not-an-id').expect(400);
    expect((malformed.body as { message: string[] }).message).toEqual(['must be a scenario id (a UUID)']);
    await api.http.get(`/scenarios/${scenario.id}/versions/zero`).expect(400);
  });
});

describe('runs', () => {
  it('answers 202 with a queued run, then moves it to running and succeeded', async () => {
    const scenario = await createScenario();
    const queued = await startRun(scenario.id, 42);
    expect(queued).toMatchObject({
      status: 'queued',
      seed: '42',
      engineVersion: ENGINE_VERSION,
      scenario: { id: scenario.id, name: 'ecommerce-small', version: 1 },
      startedAt: null,
      finishedAt: null,
      eventCount: null,
      files: null,
    });
    const finished = await waitForRun(api, queued.id);
    expect(finished).toMatchObject({ status: 'succeeded', error: null, eventCount: 472 });
    expect(finished.eventsByType).toMatchObject({ ProductCreated: 12, CustomerRegistered: 25, OrderCreated: 120 });
    expect(finished.summary).toMatchObject({ orders: 120, revenueMinor: 2525664 });
    expect(Object.keys(finished.files ?? {}).sort()).toEqual(['events.jsonl', 'expected-state.json', 'scenario.resolved.json']);
    const started = Date.parse(String(finished.startedAt));
    expect(Date.parse(String(finished.requestedAt))).toBeLessThanOrEqual(started);
    expect(started).toBeLessThanOrEqual(Date.parse(String(finished.finishedAt)));
  });

  it('runs a chosen version, or the latest by default', async () => {
    const scenario = await createScenario();
    await api.http
      .post(`/scenarios/${scenario.id}/versions`)
      .send({ ...SMALL, orders: { ...(SMALL['orders'] as object), count: 10 } })
      .expect(201);
    const latest = await startRun(scenario.id, 1);
    const first = await startRun(scenario.id, 1, 1);
    await api.runner.whenIdle();
    expect((await waitForRun(api, latest.id)).summary?.orders).toBe(10);
    expect((await waitForRun(api, first.id)).summary?.orders).toBe(120);
    expect((await api.http.post('/runs').send({ scenarioId: scenario.id, seed: 1, version: 3 }).expect(404)).body).toMatchObject({
      message: `Scenario ${scenario.id} has no version 3.`,
    });
  });

  it('rejects an invalid request with the path of every problem', async () => {
    const response = await api.http.post('/runs').send({ scenarioId: 'x', seed: 'not a seed', speed: 2 }).expect(400);
    expect((response.body as { message: string[] }).message).toEqual([
      'scenarioId: must be a scenario id (a UUID)',
      'seed: Invalid seed "not a seed": use 1-128 characters from A-Z, a-z, 0-9, ".", "_", ":" and "-"',
      'Unrecognized key: "speed"',
    ]);
    await api.http.post('/runs').send({ scenarioId: UNKNOWN_ID, seed: 1 }).expect(404);
    await api.http.get(`/runs/${UNKNOWN_ID}`).expect(404);
  });

  it('lists run history newest first, filtered by scenario and status, with paging', async () => {
    const small = await createScenario();
    const minimal = await createScenario({ formatVersion: 1, name: 'tiny', customers: { count: 2 }, orders: { count: 3, itemsPerOrder: { min: 1, max: 2 } }, catalog: { productCount: 2 } });
    const ids: string[] = [];
    for (const [scenarioId, seed] of [[small.id, 1], [minimal.id, 2], [small.id, 3]] as const) {
      ids.push((await startRun(scenarioId, seed)).id);
      await api.runner.whenIdle();
    }
    const all = (await api.http.get('/runs').expect(200)).body as RunListView;
    expect(all.runs.map((run) => run.id)).toEqual([...ids].reverse());
    expect(all).toMatchObject({ total: 3, limit: 50, offset: 0 });

    const smallOnly = (await api.http.get('/runs').query({ scenarioId: small.id }).expect(200)).body as RunListView;
    expect(smallOnly.runs.map((run) => run.seed)).toEqual(['3', '1']);
    const page = (await api.http.get('/runs').query({ limit: 1, offset: 1 }).expect(200)).body as RunListView;
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1, runs: [{ id: ids[1] }] });
    expect(((await api.http.get('/runs').query({ status: 'queued' }).expect(200)).body as RunListView).total).toBe(0);
    expect(((await api.http.get('/runs').query({ status: 'succeeded' }).expect(200)).body as RunListView).total).toBe(3);
    await api.http.get('/runs').query({ status: 'done' }).expect(400);
  });

  it('serves stored events by sequence range, type and aggregate, in sequence order', async () => {
    const scenario = await createScenario();
    const run = await waitForRun(api, (await startRun(scenario.id, 42)).id);

    const firstPage = (await api.http.get(`/runs/${run.id}/events`).query({ limit: 3 }).expect(200)).body as RunEventsView;
    expect(firstPage.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(firstPage.nextSequence).toBe(4);
    const lastPage = (await api.http.get(`/runs/${run.id}/events`).query({ fromSequence: 471 }).expect(200)).body as RunEventsView;
    expect(lastPage.events.map((event) => event.sequence)).toEqual([471, 472]);
    expect(lastPage.nextSequence).toBeNull();

    const timeline = (await api.http.get(`/runs/${run.id}/events`).query({ aggregateId: 'ord_000088' }).expect(200)).body as RunEventsView;
    expect(timeline.events.map((event) => event.aggregateVersion)).toEqual(timeline.events.map((_, index) => index + 1));
    expect(timeline.events.every((event: CanonicalEvent) => event.aggregateId === 'ord_000088')).toBe(true);
    expect(timeline.events[0]?.type).toBe('OrderCreated');

    const products = (await api.http.get(`/runs/${run.id}/events`).query({ type: 'ProductCreated', limit: 1000 }).expect(200)).body as RunEventsView;
    expect(products.events).toHaveLength(12);
    expect(products.events.every((event) => event.type === 'ProductCreated')).toBe(true);

    const bad = await api.http.get(`/runs/${run.id}/events`).query({ type: 'OrderShipped', limit: 0 }).expect(400);
    expect((bad.body as { message: string[] }).message).toHaveLength(2);
  });

  it('answers 409 for the events and files of a run that has not succeeded, and shows why a run failed', async () => {
    const scenario = await createScenario();
    const version = await api.prisma.scenarioVersion.findFirstOrThrow({ where: { scenarioId: scenario.id } });
    // Rows written directly, as a run looks while it waits or after it failed; the runner never sees them.
    const queued = await api.prisma.simulationRun.create({ data: { scenarioVersionId: version.id, seed: '5', engineVersion: ENGINE_VERSION } });
    const failed = await api.prisma.simulationRun.create({
      data: { scenarioVersionId: version.id, seed: '6', engineVersion: ENGINE_VERSION, status: 'failed', error: 'Generation failed: example' },
    });
    const events = await api.http.get(`/runs/${queued.id}/events`).expect(409);
    expect((events.body as { message: string }).message).toBe(`Run ${queued.id} is queued; its events and files exist once it has succeeded.`);
    await api.http.get(`/runs/${failed.id}/files/events.jsonl`).expect(409);
    expect((await api.http.get(`/runs/${failed.id}`).expect(200)).body).toMatchObject({ status: 'failed', error: 'Generation failed: example', files: null });
  });
});

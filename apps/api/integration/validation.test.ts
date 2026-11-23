import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chaosProfileHash, parseChaosProfile } from '@dataforge/chaos';
import { parseScenario, scenarioHash } from '@dataforge/core';
import type { ChaosProfileView } from '../src/chaos-profiles/chaos-profile-views';
import type { ScenarioView } from '../src/scenarios/scenario-views';
import { CHAOS_PROFILES, SCENARIOS, clearDatabase, startApi, type TestApi } from './support';

const SMALL = JSON.parse(readFileSync(join(SCENARIOS, 'ecommerce-small.json'), 'utf8')) as Record<string, unknown>;
const SPEC_EXAMPLE = JSON.parse(readFileSync(join(CHAOS_PROFILES, 'spec-example.json'), 'utf8')) as Record<string, unknown>;

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  // The runners resume what an earlier suite left unfinished when the application starts; truncating while they do deadlocks.
  await api.runner.whenIdle();
  await api.executions.whenIdle();
  await clearDatabase(api.prisma);
});

/** Bodies the schemas refuse, each for a different reason: a type, a range, an unknown key, a missing field, a cross-field rule. */
const INVALID_SCENARIOS: Record<string, unknown> = {
  'a wrong type and an unknown key': { ...SMALL, customers: { count: 'many' }, colour: 'blue' },
  'a value out of range': { ...SMALL, orders: { count: -1 } },
  'a missing format version': { name: 'no-format' },
  'an empty object': {},
};
const INVALID_PROFILES: Record<string, unknown> = {
  'a rate above 1': { ...SPEC_EXAMPLE, faults: { delay: { rate: 2 } } },
  'the loss rule': { formatVersion: 1, name: 'loses', faults: { transientFailure: { rate: 0.1, failures: { min: 1, max: 5 }, maxRetries: 2 } } },
  'late data without windowing': { formatVersion: 1, name: 'late', faults: { late: { rate: 0.1 } } },
  'an unknown key': { ...SPEC_EXAMPLE, colour: 'blue' },
};

describe('POST /scenarios/validate', () => {
  it('accepts a valid document with its resolved definition and the hash a stored version gets, and stores nothing', async () => {
    const response = await api.http.post('/scenarios/validate').send(SMALL).expect(200);
    const resolved = parseScenario(SMALL);
    expect(response.body).toEqual({ valid: true, name: 'ecommerce-small', scenarioHash: scenarioHash(resolved), definition: resolved });
    expect((await api.http.get('/scenarios').expect(200)).body).toEqual({ scenarios: [] });

    const created = (await api.http.post('/scenarios').send(SMALL).expect(201)).body as ScenarioView;
    expect(created.versions[0]?.scenarioHash).toBe((response.body as { scenarioHash: string }).scenarioHash);
  });

  it('fills in defaults, as a stored version would', async () => {
    const response = await api.http.post('/scenarios/validate').send({ formatVersion: 1, name: 'minimal' }).expect(200);
    expect((response.body as { definition: unknown }).definition).toEqual(parseScenario({ formatVersion: 1, name: 'minimal' }));
  });

  it.each(Object.entries(INVALID_SCENARIOS))('answers %s with exactly the 400 the create endpoint gives', async (_reason, body) => {
    const dryRun = await api.http.post('/scenarios/validate').send(body as object);
    const create = await api.http.post('/scenarios').send(body as object);
    expect(dryRun.status).toBe(400);
    expect(dryRun.status).toBe(create.status);
    expect(dryRun.body).toEqual(create.body);
    expect((dryRun.body as { message: string[] }).message.length).toBeGreaterThan(0);
    expect((await api.http.get('/scenarios').expect(200)).body).toEqual({ scenarios: [] });
  });

  it('checks the document only: a name that is taken is a matter for saving, so the editor can still show the definition', async () => {
    await api.http.post('/scenarios').send(SMALL).expect(201);
    await api.http.post('/scenarios').send(SMALL).expect(409);
    await api.http.post('/scenarios/validate').send(SMALL).expect(200);
  });

  it('refuses a body that is not JSON object syntax with a 400', async () => {
    const response = await api.http.post('/scenarios/validate').set('Content-Type', 'application/json').send('{"name":');
    expect(response.status).toBe(400);
  });
});

describe('POST /chaos-profiles/validate', () => {
  it('accepts a valid profile with its resolved definition and the hash a stored version gets, and stores nothing', async () => {
    const response = await api.http.post('/chaos-profiles/validate').send(SPEC_EXAMPLE).expect(200);
    const resolved = parseChaosProfile(SPEC_EXAMPLE);
    expect(response.body).toEqual({ valid: true, name: 'spec-example', profileHash: chaosProfileHash(resolved), definition: resolved });
    expect((await api.http.get('/chaos-profiles').expect(200)).body).toEqual({ chaosProfiles: [] });

    const created = (await api.http.post('/chaos-profiles').send(SPEC_EXAMPLE).expect(201)).body as ChaosProfileView;
    expect(created.versions[0]?.profileHash).toBe((response.body as { profileHash: string }).profileHash);
  });

  it.each(Object.entries(INVALID_PROFILES))('answers %s with exactly the 400 the create endpoint gives', async (_reason, body) => {
    const dryRun = await api.http.post('/chaos-profiles/validate').send(body as object);
    const create = await api.http.post('/chaos-profiles').send(body as object);
    expect(dryRun.status).toBe(400);
    expect(dryRun.status).toBe(create.status);
    expect(dryRun.body).toEqual(create.body);
    expect((dryRun.body as { message: string[] }).message.length).toBeGreaterThan(0);
    expect((await api.http.get('/chaos-profiles').expect(200)).body).toEqual({ chaosProfiles: [] });
  });
});

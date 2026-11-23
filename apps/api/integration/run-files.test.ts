import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_VERSION, RUN_FILE_NAMES, buildRunFiles, parseScenario, simulate } from '@dataforge/core';
import type { RunView } from '../src/runs/run-views';
import type { ScenarioView } from '../src/scenarios/scenario-views';
import { CLI_MAIN, SCENARIOS, clearDatabase, runNode, startApi, waitForRun, type TestApi } from './support';

let api: TestApi;
let workspace: string;
beforeAll(async () => {
  api = await startApi();
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-api-files-'));
});
afterAll(async () => {
  await api.close();
  rmSync(workspace, { recursive: true, force: true });
});
beforeEach(async () => {
  await api.runner.whenIdle();
  await clearDatabase(api.prisma);
});

function scenarioDocument(name: string): string {
  return readFileSync(join(SCENARIOS, `${name}.json`), 'utf8');
}

async function generateThroughApi(name: string, seed: string): Promise<RunView> {
  const scenario = (await api.http.post('/scenarios').set('Content-Type', 'application/json').send(scenarioDocument(name)).expect(201)).body as ScenarioView;
  const run = (await api.http.post('/runs').send({ scenarioId: scenario.id, seed }).expect(202)).body as RunView;
  return waitForRun(api, run.id, 120_000);
}

/** Downloads the four run files into a directory, byte for byte, as a run directory of the CLI. */
async function download(runId: string, directory: string): Promise<Record<string, Buffer>> {
  mkdirSync(directory, { recursive: true });
  const files: Record<string, Buffer> = {};
  for (const name of RUN_FILE_NAMES) {
    const response = await api.http
      .get(`/runs/${runId}/files/${name}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const body = response.body as Buffer;
    expect(response.headers['content-type']).toBe(name.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8');
    expect(Number(response.headers['content-length'])).toBe(body.length);
    writeFileSync(join(directory, name), body);
    files[name] = body;
  }
  return files;
}

describe('run files from the database', () => {
  it.each([
    ['ecommerce-small', '42'],
    ['ecommerce-small', '7'],
    ['ecommerce-standard', '42'],
  ])('are byte-identical to "dataforge generate" for %s with seed %s, and pass "dataforge verify"', async (name, seed) => {
    const run = await generateThroughApi(name, seed);
    expect(run.status).toBe('succeeded');
    const directory = join(workspace, `${name}-${seed}`);
    const downloaded = await download(run.id, directory);

    const scenario = parseScenario(JSON.parse(scenarioDocument(name)));
    const { contents } = buildRunFiles(scenario, simulate({ scenario, seed }));
    for (const file of RUN_FILE_NAMES) {
      expect([file, downloaded[file]?.equals(Buffer.from(contents[file], 'utf8'))]).toEqual([file, true]);
    }

    const generated = join(workspace, `${name}-${seed}-cli`);
    const cliGenerate = await runNode(CLI_MAIN, ['generate', '--scenario', join(SCENARIOS, `${name}.json`), '--seed', seed, '--out', generated], {}, workspace);
    expect(cliGenerate.code).toBe(0);
    for (const file of RUN_FILE_NAMES) {
      expect([file, readFileSync(join(generated, file)).equals(downloaded[file] ?? Buffer.alloc(0))]).toEqual([file, true]);
    }

    const verify = await runNode(CLI_MAIN, ['verify', '--run', directory], {}, workspace);
    expect(verify.stdout).toMatch(/Result: PASS/);
    expect(verify.code).toBe(0);
  });

  it('refuses to serve a run whose stored events were modified (500 Run Integrity Error), while the other files still match', async () => {
    const run = await generateThroughApi('ecommerce-small', '42');
    // The immutability trigger refuses the update; tampering needs it disabled, as an attacker with table rights would.
    await expect(api.prisma.$executeRawUnsafe(`UPDATE canonical_event SET payload = payload WHERE run_id = '${run.id}' AND sequence = 1`)).rejects.toThrow(
      /canonical_event rows are immutable/,
    );
    await api.prisma.$transaction([
      api.prisma.$executeRawUnsafe('ALTER TABLE canonical_event DISABLE TRIGGER canonical_event_immutable'),
      api.prisma.$executeRawUnsafe(
        `UPDATE canonical_event SET payload = jsonb_set(payload, '{amountMinor}', '1') WHERE run_id = '${run.id}' AND sequence = (SELECT min(sequence) FROM canonical_event WHERE run_id = '${run.id}' AND type = 'PaymentCompleted')`,
      ),
      api.prisma.$executeRawUnsafe('ALTER TABLE canonical_event ENABLE TRIGGER canonical_event_immutable'),
    ]);
    const refused = await api.http.get(`/runs/${run.id}/files/events.jsonl`).expect(500);
    expect(refused.body).toMatchObject({ statusCode: 500, error: 'Run Integrity Error' });
    expect((refused.body as { message: string }).message).toMatch(
      new RegExp(`^events\\.jsonl rebuilt from the database does not match the checksum recorded when run ${run.id} was generated .*The stored run was modified\\.$`),
    );
    await api.http.get(`/runs/${run.id}/files/expected-state.json`).expect(200);
    await api.http.get(`/runs/${run.id}/files/manifest.json`).expect(200);
  });

  it('refuses a stored event that is no longer a canonical event, in the events pages too', async () => {
    const run = await generateThroughApi('ecommerce-small', '42');
    await api.prisma.$transaction([
      api.prisma.$executeRawUnsafe('ALTER TABLE canonical_event DISABLE TRIGGER canonical_event_immutable'),
      api.prisma.$executeRawUnsafe(`UPDATE canonical_event SET type = 'ProductDeleted' WHERE run_id = '${run.id}' AND sequence = 2`),
      api.prisma.$executeRawUnsafe('ALTER TABLE canonical_event ENABLE TRIGGER canonical_event_immutable'),
    ]);
    const page = await api.http.get(`/runs/${run.id}/events`).query({ limit: 5 }).expect(500);
    expect((page.body as { message: string }).message).toMatch(new RegExp(`^Stored event 2 of run ${run.id} is not a valid canonical event: type: `));
    await api.http.get(`/runs/${run.id}/files/events.jsonl`).expect(500);
  });

  it('answers 400 for a file name that is not a run file', async () => {
    const run = await generateThroughApi('ecommerce-small', '42');
    const response = await api.http.get(`/runs/${run.id}/files/secrets.txt`).expect(400);
    expect((response.body as { message: string[] }).message).toEqual([
      'must be one of the run files: events.jsonl, expected-state.json, scenario.resolved.json, manifest.json',
    ]);
  });
});

describe('restart', () => {
  it('keeps run history, and completes runs a stopped API left queued or running', async () => {
    const scenario = (await api.http.post('/scenarios').set('Content-Type', 'application/json').send(scenarioDocument('ecommerce-small')).expect(201)).body as ScenarioView;
    const finished = await waitForRun(api, ((await api.http.post('/runs').send({ scenarioId: scenario.id, seed: 1 }).expect(202)).body as RunView).id);
    const version = await api.prisma.scenarioVersion.findFirstOrThrow({ where: { scenarioId: scenario.id } });
    // What a process killed mid-run leaves behind: one run claimed (running, no rows written), one still queued.
    const interrupted = await api.prisma.simulationRun.create({
      data: { scenarioVersionId: version.id, seed: '42', engineVersion: ENGINE_VERSION, status: 'running', startedAt: new Date() },
    });
    const waiting = await api.prisma.simulationRun.create({ data: { scenarioVersionId: version.id, seed: '7', engineVersion: ENGINE_VERSION } });
    await api.close();

    api = await startApi();
    await api.runner.whenIdle();
    const runs = await Promise.all([finished.id, interrupted.id, waiting.id].map((id) => api.http.get(`/runs/${id}`).expect(200)));
    expect(runs.map((response) => (response.body as RunView).status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect((runs[0]?.body as RunView).finishedAt).toBe(finished.finishedAt);
    const scenarioFile = parseScenario(JSON.parse(scenarioDocument('ecommerce-small')));
    const expected = buildRunFiles(scenarioFile, simulate({ scenario: scenarioFile, seed: '42' })).manifest.files;
    expect((runs[1]?.body as RunView).files).toEqual(expected);
  });
});

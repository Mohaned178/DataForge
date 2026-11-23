import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionView } from '../src/executions/execution-views';
import { CHAOS_PROFILES, CLI_MAIN, SCENARIOS, chaosProfileId, clearDatabase, downloadBytes, runNode, startApi, succeededRun, waitForExecution, type TestApi } from './support';

let api: TestApi;
let workspace: string;
beforeAll(async () => {
  api = await startApi();
  await clearDatabase(api.prisma);
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-api-execution-files-'));
});
afterAll(async () => {
  await api.close();
  rmSync(workspace, { recursive: true, force: true });
});

const PLAN_FILES = ['delivery-plan.jsonl', 'chaos-profile.resolved.json', 'delivery-summary.json'];
const DELIVERY_FILES = ['actual-state.json', 'actual-windows.json', 'target-run.json'];

/** One stored run per scenario and seed, and the CLI's run directory for the same inputs. */
const runs = new Map<string, Promise<{ runId: string; directory: string }>>();
function runFor(scenario: string, seed: string): Promise<{ runId: string; directory: string }> {
  const key = `${scenario}-${seed}`;
  let entry = runs.get(key);
  if (entry === undefined) {
    entry = (async () => {
      const run = await succeededRun(api, scenario, seed);
      const directory = join(workspace, key);
      const generated = await runNode(CLI_MAIN, ['generate', '--scenario', join(SCENARIOS, `${scenario}.json`), '--seed', seed, '--out', directory], {}, workspace);
      expect(generated.code).toBe(0);
      return { runId: run.id, directory };
    })();
    runs.set(key, entry);
  }
  return entry;
}

/** "dataforge chaos plan", "deliver" and "validate --report", as a user runs them, for the same inputs as the execution. */
async function cliExecution(runDirectory: string, profile: string, chaosSeed: string, target: string, transport: string): Promise<string> {
  const base = join(workspace, `${profile}-${chaosSeed}-${target}-${transport}-${runDirectory.split(/[\\/]/).at(-1) ?? ''}`);
  const plan = await runNode(
    CLI_MAIN,
    ['chaos', 'plan', '--run', runDirectory, '--profile', join(CHAOS_PROFILES, `${profile}.json`), '--chaos-seed', chaosSeed, '--out', join(base, 'plan')],
    {},
    workspace,
  );
  expect(plan.code).toBe(0);
  const deliver = await runNode(
    CLI_MAIN,
    ['deliver', '--run', runDirectory, '--plan', join(base, 'plan'), '--target', target, '--out', join(base, 'out'), ...(transport === 'kafka' ? ['--transport', 'kafka'] : [])],
    {},
    workspace,
    120_000,
  );
  expect([deliver.code, deliver.stderr]).toEqual([0, '']);
  const validate = await runNode(
    CLI_MAIN,
    ['validate', '--run', runDirectory, '--actual', join(base, 'out', 'actual-state.json'), '--plan', join(base, 'plan'), '--report', join(base, 'validation-report.json')],
    {},
    workspace,
    120_000,
  );
  expect([0, 1]).toContain(validate.code);
  return base;
}

async function expectSameFiles(execution: ExecutionView, base: string): Promise<void> {
  const expected: [string, string][] = [
    ...PLAN_FILES.map((name): [string, string] => [name, join(base, 'plan', name)]),
    ...DELIVERY_FILES.map((name): [string, string] => [name, join(base, 'out', name)]),
    ['validation-report.json', join(base, 'validation-report.json')],
  ];
  for (const [name, path] of expected) {
    if (!existsSync(path)) {
      expect([name, execution.files[name]]).toEqual([name, undefined]);
      continue;
    }
    const downloaded = await downloadBytes(api, `/executions/${execution.id}/files/${name}`);
    expect([name, downloaded.equals(readFileSync(path))]).toEqual([name, true]);
    expect([name, execution.files[name]?.bytes]).toEqual([name, downloaded.length]);
  }
}

async function apiExecution(runId: string, profile: string, chaosSeed: string, target: Record<string, unknown>): Promise<ExecutionView> {
  const started = await api.http.post('/executions').send({ runId, chaosProfileId: await chaosProfileId(api, profile), chaosSeed, target }).expect(202);
  const execution = await waitForExecution(api, (started.body as ExecutionView).id, 180_000);
  expect([execution.status, execution.error]).toEqual(['completed', null]);
  return execution;
}

describe('execution files are byte-identical to the CLI', () => {
  it.each([
    ['none', 'correct'],
    ['none', 'naive'],
    ['spec-example', 'correct'],
    ['spec-example', 'naive'],
    ['lossy', 'correct'],
    ['lossy', 'naive'],
    ['late-data', 'correct'],
    ['late-data', 'naive'],
  ])('in memory: %s, %s target, small scenario', async (profile, target) => {
    const run = await runFor('ecommerce-small', '42');
    const execution = await apiExecution(run.runId, profile, '7', { type: 'reference', name: target });
    await expectSameFiles(execution, await cliExecution(run.directory, profile, '7', target, 'memory'));
  });

  it.each([
    ['spec-example', 'correct'],
    ['spec-example', 'naive'],
    ['windowed-delays', 'naive'],
  ])('through Kafka: %s, %s target, small scenario', async (profile, target) => {
    const run = await runFor('ecommerce-small', '7');
    const execution = await apiExecution(run.runId, profile, '3', { type: 'reference', name: target, transport: 'kafka' });
    expect(execution.kafka).toMatchObject({ partitions: 1, plannedFailures: 0 });
    expect(execution.kafka?.topic).toMatch(/^dataforge\./);
    await expectSameFiles(execution, await cliExecution(run.directory, profile, '3', target, 'kafka'));

    const kafkaRun = JSON.parse((await downloadBytes(api, `/executions/${execution.id}/files/kafka-run.json`)).toString('utf8')) as { files: Record<string, { bytes: number }> };
    const deliveryLog = await downloadBytes(api, `/executions/${execution.id}/files/delivery-log.jsonl`);
    expect(deliveryLog.length).toBe(kafkaRun.files['delivery-log.jsonl']?.bytes);
    const attempts = (await api.http.get(`/executions/${execution.id}/attempts`).query({ limit: 3 }).expect(200)).body as { attempts: { kafka: { outcome: string; partition: number; offset: string } }[] };
    expect(attempts.attempts.map((attempt) => attempt.kafka)).toEqual([
      expect.objectContaining({ outcome: 'sent', partition: 0, offset: '0' }),
      expect.objectContaining({ outcome: 'sent', partition: 0, offset: '1' }),
      expect.objectContaining({ outcome: 'sent', partition: 0, offset: '2' }),
    ]);
  });

  it('in memory: spec-example, naive target, the specification-sized scenario', async () => {
    const run = await runFor('ecommerce-standard', '42');
    const execution = await apiExecution(run.runId, 'spec-example', '7', { type: 'reference', name: 'naive' });
    expect(execution.attemptCount).toBeGreaterThan(18_000);
    await expectSameFiles(execution, await cliExecution(run.directory, 'spec-example', '7', 'naive', 'memory'));
  });
});

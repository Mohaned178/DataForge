import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChaosProfile } from '@dataforge/chaos';
import { ConsumerProcess } from '@dataforge/execution';
import { connectAdmin, createDeliveryTopic, createKafkaClient, type KafkaAdmin } from '@dataforge/kafka';
import type { ExecutionView } from '../src/executions/execution-views';
import {
  CHAOS_PROFILES,
  CLI_MAIN,
  SCENARIOS,
  chaosProfileId,
  clearDatabase,
  downloadBytes,
  profileDocument,
  runNode,
  startApi,
  succeededRun,
  testConfig,
  waitForExecution,
  type TestApi,
} from './support';

let api: TestApi;
let admin: KafkaAdmin;
let workspace: string;
const brokers = testConfig().kafkaBrokers;

beforeAll(async () => {
  api = await startApi();
  await clearDatabase(api.prisma);
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-api-external-'));
  ({ admin } = await connectAdmin(createKafkaClient({ brokers, clientId: 'dataforge-test-admin', log: () => undefined }), brokers));
});
afterAll(async () => {
  await admin.disconnect();
  await api.close();
  rmSync(workspace, { recursive: true, force: true });
});

const unique = (prefix: string) => `${prefix}.${randomBytes(4).toString('hex')}`;

/** The user's pipeline: the standalone consumer process on its own topic and group, started before the execution. */
async function startPipeline(topic: string, groupId: string, profile: string, name: string): Promise<{ pipeline: ConsumerProcess; directory: string }> {
  const directory = join(workspace, name);
  mkdirSync(directory, { recursive: true });
  const windowing = parseChaosProfile(JSON.parse(profileDocument(profile))).windowing;
  const pipeline = await ConsumerProcess.start({ brokers, topic, groupId, target: 'naive', outDirectory: directory, logPath: join(directory, 'pipeline.log'), windowing });
  return { pipeline, directory };
}

async function startExternal(runId: string, profile: string, topic: string, groupId: string): Promise<ExecutionView> {
  const target = { type: 'external', topic, groupId, timeoutSeconds: 30 };
  const started = await api.http.post('/executions').send({ runId, chaosProfileId: await chaosProfileId(api, profile), chaosSeed: 7, target }).expect(202);
  return waitForExecution(api, (started.body as ExecutionView).id);
}

/** The submission body, built from the files as a script would: the documents pasted into one JSON object. */
function submission(directory: string, windows: boolean): string {
  const state = readFileSync(join(directory, 'actual-state.json'), 'utf8');
  return windows ? `{"actualState":${state},"actualWindows":${readFileSync(join(directory, 'actual-windows.json'), 'utf8')}}` : `{"actualState":${state}}`;
}

describe('an external pipeline', () => {
  it.each([
    ['spec-example', false],
    ['late-data', true],
  ])('is delivered to, waited for, and validated from the state it submits (%s)', async (profile, windows) => {
    const run = await succeededRun(api, 'ecommerce-small', '42');
    const topic = unique('shop-orders');
    const groupId = unique('orders-pipeline');
    await createDeliveryTopic(admin, topic, 1);
    const { pipeline, directory } = await startPipeline(topic, groupId, profile, `${profile}-pipeline`);
    let finished = false;
    try {
      const execution = await startExternal(run.id, profile, topic, groupId);
      expect([execution.status, execution.error]).toEqual(['awaiting_actual_state', null]);
      expect(execution.kafka).toMatchObject({ topic, groupId, partitions: 1, plannedFailures: 0 });
      expect(execution.kafka?.sent).toBe(execution.attemptCount);
      expect(execution.targetResult).toBeNull();
      expect(Object.keys(execution.files)).toEqual(['delivery-plan.jsonl', 'chaos-profile.resolved.json', 'delivery-summary.json', 'delivery-log.jsonl', 'kafka-run.json']);
      await api.http.get(`/executions/${execution.id}/report`).expect(409);
      expect((await api.http.get(`/executions/${execution.id}/attempts`).query({ limit: 1 }).expect(200)).body).toMatchObject({ attempts: [{ kafka: { outcome: 'sent', partition: 0, offset: '0' } }] });

      await pipeline.finish();
      finished = true;

      const invalid = await api.http.post(`/executions/${execution.id}/actual-state`).send({ actualState: { format: 'dataforge.actual-state' } }).expect(400);
      expect((invalid.body as { message: string[] }).message[0]).toMatch(/^actualState\.formatVersion: /);
      if (windows) {
        const noWindows = await api.http.post(`/executions/${execution.id}/actual-state`).set('Content-Type', 'application/json').send(submission(directory, false)).expect(400);
        expect((noWindows.body as { message: string[] }).message).toEqual([
          'actualWindows: required: the chaos profile "late-data" defines event-time windows (sizeMs 3600000, allowedLatenessMs 600000)',
        ]);
      }
      expect(((await api.http.get(`/executions/${execution.id}`).expect(200)).body as ExecutionView).status).toBe('awaiting_actual_state');

      const completed = (await api.http.post(`/executions/${execution.id}/actual-state`).set('Content-Type', 'application/json').send(submission(directory, windows)).expect(200)).body as ExecutionView;
      expect(completed).toMatchObject({ status: 'completed', verdict: 'FAIL' });
      expect(completed.findingCount).toBeGreaterThan(0);
      await api.http.post(`/executions/${execution.id}/actual-state`).set('Content-Type', 'application/json').send(submission(directory, windows)).expect(409);

      // The same judgement as "dataforge validate" of the pipeline's own files against the same plan.
      const runDirectory = join(workspace, `${profile}-run`);
      expect((await runNode(CLI_MAIN, ['generate', '--scenario', join(SCENARIOS, 'ecommerce-small.json'), '--seed', '42', '--out', runDirectory], {}, workspace)).code).toBe(0);
      const planDirectory = join(workspace, `${profile}-plan`);
      expect((await runNode(CLI_MAIN, ['chaos', 'plan', '--run', runDirectory, '--profile', join(CHAOS_PROFILES, `${profile}.json`), '--chaos-seed', '7', '--out', planDirectory], {}, workspace)).code).toBe(0);
      const reportPath = join(workspace, `${profile}-report.json`);
      const validate = await runNode(CLI_MAIN, ['validate', '--run', runDirectory, '--actual', join(directory, 'actual-state.json'), '--plan', planDirectory, '--report', reportPath], {}, workspace);
      expect(validate.code).toBe(1);
      expect((await downloadBytes(api, `/executions/${completed.id}/files/validation-report.json`)).equals(readFileSync(reportPath))).toBe(true);
      expect((await downloadBytes(api, `/executions/${completed.id}/files/actual-state.json`)).equals(readFileSync(join(directory, 'actual-state.json')))).toBe(true);
      expect((await downloadBytes(api, `/executions/${completed.id}/files/delivery-plan.jsonl`)).equals(readFileSync(join(planDirectory, 'delivery-plan.jsonl')))).toBe(true);
    } finally {
      if (!finished) {
        pipeline.kill();
      }
    }
  });

  it('fails early, with the reason, when the topic does not exist or no consumer is active in the group', async () => {
    const run = await succeededRun(api, 'ecommerce-small', '1');
    const missing = await startExternal(run.id, 'none', unique('missing-topic'), unique('pipeline'));
    expect(missing.status).toBe('failed');
    expect(missing.error).toMatch(/^Topic "missing-topic\.[0-9a-f]+" does not exist\. An external execution produces to your pipeline's topic/);

    const topic = unique('idle-topic');
    await createDeliveryTopic(admin, topic, 1);
    const idle = await startExternal(run.id, 'none', topic, 'nobody-home');
    expect(idle.status).toBe('failed');
    expect(idle.error).toBe(
      'Consumer group "nobody-home" has no active member (group state Dead). Start your pipeline, consuming "' +
        `${topic}" with group "nobody-home", before the execution: without an active member the group's lag never reaches zero.`,
    );
    expect(idle.attemptCount).toBeNull();
  });
});

describe('Kafka unavailable', () => {
  it('ends a Kafka execution failed with what to start, and keeps the API serving', async () => {
    const offline = await startApi({ kafkaBrokers: ['localhost:1'] });
    try {
      const run = await succeededRun(offline, 'ecommerce-small', '2');
      const started = await offline.http
        .post('/executions')
        .send({ runId: run.id, chaosProfileId: await chaosProfileId(offline, 'none'), chaosSeed: 7, target: { type: 'reference', name: 'correct', transport: 'kafka' } })
        .expect(202);
      const execution = await waitForExecution(offline, (started.body as ExecutionView).id);
      expect(execution.status).toBe('failed');
      expect(execution.error).toMatch(/^Kafka is not reachable at localhost:1: .*\(ECONNREFUSED\)\. Start it with "docker compose up -d --wait"/);
      await offline.http.get('/health').expect(200);
    } finally {
      await offline.close();
    }
  });
});

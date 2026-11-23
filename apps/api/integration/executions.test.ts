import { PLANNER_VERSION } from '@dataforge/chaos';
import type { ChaosProfileVersionView, ChaosProfileView } from '../src/chaos-profiles/chaos-profile-views';
import type { AttemptsView, ExecutionListView, ExecutionView, FindingsView, ReportView, WindowFindingsView } from '../src/executions/execution-views';
import { INTERRUPTED_EXTERNAL_ERROR } from '../src/executions/prisma-execution-store';
import type { RunView } from '../src/runs/run-views';
import { chaosProfileId, clearDatabase, downloadBytes, profileDocument, startApi, succeededRun, waitForExecution, type TestApi } from './support';

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  await api.runner.whenIdle();
  await api.executions.whenIdle();
  await clearDatabase(api.prisma);
});

const MISSING = '01a2059d-1421-7651-8848-976194c3e863';

async function execute(runId: string, profile: string, target: Record<string, unknown>, chaosSeed: string | number = 7): Promise<ExecutionView> {
  const profileId = await chaosProfileId(api, profile);
  const started = await api.http.post('/executions').send({ runId, chaosProfileId: profileId, chaosSeed, target }).expect(202);
  const queued = started.body as ExecutionView;
  expect(queued.status).toBe('queued');
  return waitForExecution(api, queued.id);
}

describe('chaos profiles', () => {
  it('registers a profile file as version 1 with every default filled in', async () => {
    const created = (await api.http.post('/chaos-profiles').set('Content-Type', 'application/json').send(profileDocument('spec-example')).expect(201)).body as ChaosProfileView;
    expect(created).toMatchObject({ name: 'spec-example', latestVersion: 1, versions: [{ version: 1 }] });
    expect(created.versions[0]?.profileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const version = (await api.http.get(`/chaos-profiles/${created.id}/versions/1`).expect(200)).body as ChaosProfileVersionView;
    expect(version.definition.faults.transientFailure).toEqual({ rate: 0, failures: { min: 1, max: 1 }, maxRetries: 3, retryBackoffMs: { min: 1000, max: 30000 }, allowLoss: false });
    expect((await api.http.get('/chaos-profiles').expect(200)).body).toEqual({
      chaosProfiles: [{ id: created.id, name: 'spec-example', createdAt: created.createdAt, latestVersion: 1 }],
    });
  });

  it('rejects an invalid profile with the path of each problem, the loss rule included', async () => {
    const response = await api.http
      .post('/chaos-profiles')
      .send({ formatVersion: 1, name: 'bad', faults: { delay: { rate: 2 }, transientFailure: { rate: 0.1, failures: { min: 1, max: 5 }, maxRetries: 2 } } })
      .expect(400);
    expect((response.body as { message: string[] }).message).toEqual([
      'faults.delay.rate: Too big: expected number to be <=1',
      'faults.transientFailure.failures.max: cannot exceed maxRetries (2) unless allowLoss is true: an event that fails more often than it is retried is lost',
    ]);
    expect(((await api.http.post('/chaos-profiles').send({ formatVersion: 1, name: 'late', faults: { late: { rate: 0.1 } } }).expect(400)).body as { message: string[] }).message).toEqual([
      'faults.late: needs a "windowing" section: a late event is late relative to the close of its window',
    ]);
  });

  it('refuses a second profile with the same name, and keeps versions immutable', async () => {
    const id = await chaosProfileId(api, 'spec-example');
    const again = await api.http.post('/chaos-profiles').set('Content-Type', 'application/json').send(profileDocument('spec-example')).expect(409);
    expect((again.body as { message: string }).message).toBe(`A chaos profile named "spec-example" already exists (id ${id}); add a version with POST /chaos-profiles/${id}/versions.`);
    const identical = await api.http.post(`/chaos-profiles/${id}/versions`).set('Content-Type', 'application/json').send(profileDocument('spec-example')).expect(200);
    expect((identical.body as ChaosProfileVersionView).version).toBe(1);
    const changed = JSON.parse(profileDocument('spec-example')) as { faults: { delay: { rate: number } } };
    changed.faults.delay.rate = 0.2;
    const second = await api.http.post(`/chaos-profiles/${id}/versions`).send(changed).expect(201);
    expect((second.body as ChaosProfileVersionView).version).toBe(2);
    await api.http.post(`/chaos-profiles/${id}/versions`).send({ ...changed, name: 'other' }).expect(400);
    await expect(api.prisma.$executeRawUnsafe(`UPDATE chaos_profile_version SET profile_hash = 'x' WHERE chaos_profile_id = '${id}'`)).rejects.toThrow(
      /chaos_profile_version rows are immutable/,
    );
    await api.http.get(`/chaos-profiles/${MISSING}`).expect(404);
    await api.http.get(`/chaos-profiles/${id}/versions/3`).expect(404);
  });
});

describe('test executions', () => {
  let run: RunView;
  beforeEach(async () => {
    run = await succeededRun(api, 'ecommerce-small', '42');
  });

  it('runs queued -> running -> completed and passes the correct target under the spec example', async () => {
    const execution = await execute(run.id, 'spec-example', { type: 'reference', name: 'correct' });
    expect(execution).toMatchObject({
      status: 'completed',
      verdict: 'PASS',
      error: null,
      run: { id: run.id, seed: '42', scenario: { name: 'ecommerce-small', version: 1 } },
      chaosProfile: { name: 'spec-example', version: 1 },
      chaosSeed: '7',
      plannerVersion: PLANNER_VERSION,
      target: { type: 'reference', name: 'correct', transport: 'memory' },
      findingCount: 0,
      windowFindingCount: null,
      kafka: null,
      workDirectory: null,
    });
    expect(execution.attemptCount).toBe(execution.delivery?.attempts);
    expect(execution.targetResult?.counters['duplicatesIgnored']).toBeGreaterThan(0);
    expect(Object.keys(execution.files)).toEqual([
      'delivery-plan.jsonl',
      'chaos-profile.resolved.json',
      'delivery-summary.json',
      'actual-state.json',
      'target-run.json',
      'validation-report.json',
    ]);
    expect(execution.startedAt).not.toBeNull();
    expect(execution.finishedAt).not.toBeNull();
  });

  it('fails the naive target under the spec example: double charges explained by duplicated events', async () => {
    const execution = await execute(run.id, 'spec-example', { type: 'reference', name: 'naive' });
    expect(execution).toMatchObject({ status: 'completed', verdict: 'FAIL' });
    const report = (await api.http.get(`/executions/${execution.id}/report`).expect(200)).body as ReportView;
    expect(report.verdict).toBe('FAIL');
    expect(report.counts.findings).toBe(execution.findingCount);
    expect(report.counts.byCategory['double-processing']).toBeGreaterThan(0);
    expect(report.counts.unexplained).toBe(0);
    expect(report).not.toHaveProperty('findings');

    const doubled = (await api.http.get(`/executions/${execution.id}/findings`).query({ category: 'double-processing', limit: 5 }).expect(200)).body as FindingsView;
    expect(doubled.total).toBe(report.counts.byCategory['double-processing']);
    expect(doubled.findings.length).toBeLessThanOrEqual(5);
    const [first] = doubled.findings;
    expect(first?.causes[0]?.faults).toContain('duplicate');
    const sameEntity = (await api.http.get(`/executions/${execution.id}/findings`).query({ entityType: first?.entityType, entityId: first?.entityId }).expect(200)).body as FindingsView;
    expect(sameEntity.findings.map((finding) => finding.entityId)).toEqual(sameEntity.findings.map(() => first?.entityId));
    expect(sameEntity.findings.map((finding) => finding.ordinal)).toContain(first?.ordinal);

    const cause = first?.causes[0]?.eventId ?? '';
    const attempts = (await api.http.get(`/executions/${execution.id}/attempts`).query({ eventId: cause }).expect(200)).body as AttemptsView;
    expect(attempts.attempts.length).toBeGreaterThan(1);
    expect(new Set(attempts.attempts.map((attempt) => attempt.eventId))).toEqual(new Set([cause]));
    expect(new Set(attempts.attempts.map((attempt) => attempt.attemptId)).size).toBe(attempts.attempts.length);
    expect(attempts.attempts.every((attempt) => attempt.kafka === null)).toBe(true);
    const duplicates = (await api.http.get(`/executions/${execution.id}/attempts`).query({ fault: 'duplicate', kind: 'duplicate' }).expect(200)).body as AttemptsView;
    expect(duplicates.attempts.length).toBeGreaterThan(0);
    expect(duplicates.attempts.every((attempt) => attempt.kind === 'duplicate' && attempt.faults.some((fault) => fault.type === 'duplicate'))).toBe(true);
  });

  it('pages the delivery plan of an aggregate in delivery order', async () => {
    const execution = await execute(run.id, 'flaky-network', { type: 'reference', name: 'correct' });
    const all = (await api.http.get(`/executions/${execution.id}/attempts`).query({ limit: 1000 }).expect(200)).body as AttemptsView;
    expect(all.attempts.map((attempt) => attempt.deliverySequence)).toEqual(all.attempts.map((_, index) => index + 1));
    const order = all.attempts.find((attempt) => attempt.eventType === 'OrderCreated')?.aggregateId ?? '';
    expect(all.attempts.filter((attempt) => attempt.aggregateId === order).length).toBeGreaterThan(2);
    const page1 = (await api.http.get(`/executions/${execution.id}/attempts`).query({ aggregateId: order, limit: 2 }).expect(200)).body as AttemptsView;
    expect(page1.attempts).toHaveLength(2);
    const page2 = (await api.http.get(`/executions/${execution.id}/attempts`).query({ aggregateId: order, fromSequence: page1.nextSequence, limit: 1000 }).expect(200)).body as AttemptsView;
    expect([...page1.attempts, ...page2.attempts]).toEqual(all.attempts.filter((attempt) => attempt.aggregateId === order));
    expect(page2.nextSequence).toBeNull();
    const failed = (await api.http.get(`/executions/${execution.id}/attempts`).query({ plannedOutcome: 'failed' }).expect(200)).body as AttemptsView;
    expect(failed.attempts.every((attempt) => attempt.plannedOutcome === 'failed' && attempt.faults.some((fault) => fault.type === 'transientFailure'))).toBe(true);
  });

  it('validates windows and lists the window findings of the naive target under late data', async () => {
    const execution = await execute(run.id, 'late-data', { type: 'reference', name: 'naive' });
    expect(execution).toMatchObject({ status: 'completed', verdict: 'FAIL' });
    expect(execution.windowFindingCount).toBeGreaterThan(0);
    expect(execution.files).toHaveProperty(['actual-windows.json']);
    const report = (await api.http.get(`/executions/${execution.id}/report`).expect(200)).body as ReportView;
    expect(report.windows?.counts.findings).toBe(execution.windowFindingCount);
    expect(report.windows).not.toHaveProperty('findings');
    const windows = (await api.http.get(`/executions/${execution.id}/window-findings`).query({ category: 'window-undercount' }).expect(200)).body as WindowFindingsView;
    expect(windows.total).toBe(report.windows?.counts.byCategory['window-undercount']);
    expect(windows.findings.every((finding) => finding.category === 'window-undercount' && finding.windowEndMs > finding.windowStartMs)).toBe(true);
  });

  it('lists execution history newest first, filtered by run, status and verdict', async () => {
    const passed = await execute(run.id, 'none', { type: 'reference', name: 'naive' });
    const failed = await execute(run.id, 'duplicates-only', { type: 'reference', name: 'naive' });
    const all = (await api.http.get('/executions').expect(200)).body as ExecutionListView;
    expect(all.executions.map((execution) => execution.id)).toEqual([failed.id, passed.id]);
    expect(all.total).toBe(2);
    const byVerdict = (await api.http.get('/executions').query({ verdict: 'PASS', runId: run.id }).expect(200)).body as ExecutionListView;
    expect(byVerdict.executions.map((execution) => execution.id)).toEqual([passed.id]);
    expect(((await api.http.get('/executions').query({ status: 'failed' }).expect(200)).body as ExecutionListView).total).toBe(0);
  });

  it('refuses a run that has not succeeded, unknown ids, and invalid requests', async () => {
    const profileId = await chaosProfileId(api, 'none');
    const queued = await api.prisma.simulationRun.create({
      data: { scenarioVersionId: (await api.prisma.scenarioVersion.findFirstOrThrow()).id, seed: '1', engineVersion: '0.1.0', status: 'failed' },
    });
    const notReady = await api.http.post('/executions').send({ runId: queued.id, chaosProfileId: profileId, chaosSeed: 7, target: { type: 'reference', name: 'correct' } }).expect(409);
    expect((notReady.body as { message: string }).message).toBe(`Run ${queued.id} is failed; start an execution once it has succeeded.`);
    await api.http.post('/executions').send({ runId: MISSING, chaosProfileId: profileId, chaosSeed: 7, target: { type: 'reference', name: 'correct' } }).expect(404);
    await api.http.post('/executions').send({ runId: run.id, chaosProfileId: MISSING, chaosSeed: 7, target: { type: 'reference', name: 'correct' } }).expect(404);
    await api.http.post('/executions').send({ runId: run.id, chaosProfileId: profileId, chaosProfileVersion: 9, chaosSeed: 7, target: { type: 'reference', name: 'correct' } }).expect(404);
    const invalid = await api.http.post('/executions').send({ runId: run.id, chaosProfileId: profileId, chaosSeed: 7, target: { type: 'reference', name: 'correct', partitions: 2 } }).expect(400);
    expect((invalid.body as { message: string[] }).message).toEqual(['target.partitions: applies only to "transport": "kafka"']);
    await api.http.get(`/executions/${MISSING}`).expect(404);
    await api.http.get('/executions/not-a-uuid').expect(400);
  });

  it('answers 409 for the results of an execution that has not got them yet, and 404 for files it never has', async () => {
    const execution = await execute(run.id, 'none', { type: 'reference', name: 'correct' });
    await api.http.get(`/executions/${execution.id}/files/target-run.json`).expect(200);
    const windows = await api.http.get(`/executions/${execution.id}/files/actual-windows.json`).expect(404);
    expect((windows.body as { message: string }).message).toBe(`Execution ${execution.id} has no actual-windows.json: only a chaos profile with a windowing contract has windows.`);
    await api.http.get(`/executions/${execution.id}/files/kafka-run.json`).expect(404);
    await api.http.get(`/executions/${execution.id}/files/notes.txt`).expect(400);
    const submit = await api.http.post(`/executions/${execution.id}/actual-state`).send({ actualState: {} }).expect(409);
    expect((submit.body as { message: string }).message).toBe(`Execution ${execution.id} is completed; only an external execution awaiting its actual state accepts one.`);

    const waiting = await api.prisma.testExecution.create({
      data: { runId: run.id, chaosProfileVersionId: (await api.prisma.chaosProfileVersion.findFirstOrThrow()).id, chaosSeed: '7', plannerVersion: PLANNER_VERSION, target: { type: 'reference', name: 'correct', transport: 'memory' } },
    });
    await api.http.get(`/executions/${waiting.id}/report`).expect(409);
    await api.http.get(`/executions/${waiting.id}/attempts`).expect(409);
    await api.http.get(`/executions/${waiting.id}/files/delivery-plan.jsonl`).expect(409);
  });

  it('never exports a modified attempt or finding: the download fails with an integrity error', async () => {
    const execution = await execute(run.id, 'spec-example', { type: 'reference', name: 'naive' });
    await downloadBytes(api, `/executions/${execution.id}/files/delivery-plan.jsonl`);
    await downloadBytes(api, `/executions/${execution.id}/files/validation-report.json`);
    await expect(api.prisma.$executeRawUnsafe(`UPDATE delivery_attempt SET kind = 'retry' WHERE execution_id = '${execution.id}'`)).rejects.toThrow(
      /delivery_attempt rows are immutable/,
    );

    await api.prisma.$transaction([
      api.prisma.$executeRawUnsafe('ALTER TABLE delivery_attempt DISABLE TRIGGER delivery_attempt_immutable'),
      api.prisma.$executeRawUnsafe(`UPDATE delivery_attempt SET scheduled_delivery_time_ms = scheduled_delivery_time_ms + 1 WHERE execution_id = '${execution.id}' AND delivery_sequence = 5`),
      api.prisma.$executeRawUnsafe('ALTER TABLE delivery_attempt ENABLE TRIGGER delivery_attempt_immutable'),
      api.prisma.$executeRawUnsafe('ALTER TABLE validation_finding DISABLE TRIGGER validation_finding_immutable'),
      api.prisma.$executeRawUnsafe(`UPDATE validation_finding SET message = 'nothing to see' WHERE execution_id = '${execution.id}' AND ordinal = 0`),
      api.prisma.$executeRawUnsafe('ALTER TABLE validation_finding ENABLE TRIGGER validation_finding_immutable'),
    ]);
    const plan = await api.http.get(`/executions/${execution.id}/files/delivery-plan.jsonl`).expect(500);
    expect(plan.body).toMatchObject({ statusCode: 500, error: 'Execution Integrity Error' });
    expect((plan.body as { message: string }).message).toMatch(/^delivery-plan\.jsonl rebuilt from the database does not match the checksum recorded when execution .* made it/);
    const report = await api.http.get(`/executions/${execution.id}/files/validation-report.json`).expect(500);
    expect((report.body as { message: string }).message).toMatch(/^validation-report\.json rebuilt from the database does not match/);
    await downloadBytes(api, `/executions/${execution.id}/files/actual-state.json`);
  });
});

describe('a stop during a Kafka delivery', () => {
  it('aborts the delivery, leaves the execution running with nothing stored, and the next start delivers it again', async () => {
    const run = await succeededRun(api, 'ecommerce-small', '42');
    const stopping = await startApi();
    let closed = false;
    let restarted: TestApi | undefined;
    try {
      const profileId = await chaosProfileId(stopping, 'spec-example');
      const started = await stopping.http
        .post('/executions')
        .send({ runId: run.id, chaosProfileId: profileId, chaosSeed: 7, target: { type: 'reference', name: 'correct', transport: 'kafka', speed: 20_000 } })
        .expect(202);
      const id = (started.body as ExecutionView).id;
      const deadline = Date.now() + 30_000;
      while (((await stopping.http.get(`/executions/${id}`)).body as ExecutionView).status !== 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const closedAt = Date.now();
      await stopping.close();
      closed = true;
      expect(Date.now() - closedAt).toBeLessThan(5_000);
      const left = await api.prisma.testExecution.findUniqueOrThrow({ where: { id } });
      expect([left.status, left.error, left.attemptCount]).toEqual(['running', null, null]);
      expect(await api.prisma.deliveryAttempt.count({ where: { executionId: id } })).toBe(0);

      restarted = await startApi();
      const done = await waitForExecution(restarted, id);
      expect([done.status, done.verdict, done.error]).toEqual(['completed', 'PASS', null]);
      expect(done.kafka?.durationMs).toBeGreaterThan(8_000);
    } finally {
      if (!closed) {
        await stopping.close();
      }
      await restarted?.close();
    }
  });
});

describe('recovery after a restart', () => {
  it('runs a queued or interrupted reference execution again, fails an interrupted external one, keeps a waiting one', async () => {
    const run = await succeededRun(api, 'ecommerce-small', '42');
    const profileId = await chaosProfileId(api, 'spec-example');
    const versionId = (await api.prisma.chaosProfileVersion.findFirstOrThrow({ where: { chaosProfileId: profileId } })).id;
    const create = (status: 'queued' | 'running' | 'awaiting_actual_state', target: object) =>
      api.prisma.testExecution.create({ data: { runId: run.id, chaosProfileVersionId: versionId, chaosSeed: '7', plannerVersion: PLANNER_VERSION, target, status } });
    const queued = await create('queued', { type: 'reference', name: 'correct', transport: 'memory' });
    const interrupted = await create('running', { type: 'reference', name: 'naive', transport: 'memory' });
    const external = await create('running', { type: 'external', topic: 'shop', groupId: 'pipeline', speed: 'max', timeoutSeconds: 60 });
    const waiting = await create('awaiting_actual_state', { type: 'external', topic: 'shop', groupId: 'pipeline', speed: 'max', timeoutSeconds: 60 });

    const restarted = await startApi();
    try {
      await restarted.executions.whenIdle();
      expect(await waitForExecution(restarted, queued.id)).toMatchObject({ status: 'completed', verdict: 'PASS' });
      expect(await waitForExecution(restarted, interrupted.id)).toMatchObject({ status: 'completed', verdict: 'FAIL' });
      expect(await waitForExecution(restarted, external.id)).toMatchObject({ status: 'failed', error: INTERRUPTED_EXTERNAL_ERROR });
      expect((await restarted.http.get(`/executions/${waiting.id}`).expect(200)).body).toMatchObject({ status: 'awaiting_actual_state' });
    } finally {
      await restarted.close();
    }
  });
});

/*
 * The contract between the API and the web UI (Milestone 8). The UI describes only what it reads, in Zod
 * schemas (apps/web/src/api/schemas.ts) and pure logic (apps/web/src/lib); here the real API, with real
 * PostgreSQL and Kafka, answers, and every response must parse with those schemas. This is the test that
 * stops the UI's schemas and fixtures drifting from the API.
 */
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
} from '../../web/src/api/schemas';
import type { Attempt, CanonicalEvent, Execution, Finding, WindowFinding } from '../../web/src/api/schemas';
import { aggregateOfEntity } from '../../web/src/lib/entity';
import { buildExecutionRequest, buildRunRequest, type ExecutionForm } from '../../web/src/lib/launch';
import { parseProblem } from '../../web/src/lib/problems';
import { buildTimeline, orderingOf } from '../../web/src/lib/timeline';
import { chaosProfileId, clearDatabase, profileDocument, scenarioDocument, startApi, succeededRun, waitForExecution, waitForRun, type TestApi } from './support';
import type { ExecutionView } from '../src/executions/execution-views';

let api: TestApi;
let runId: string;
const executions = {} as Record<'pass' | 'fail' | 'late' | 'lossy' | 'kafka', Execution>;

beforeAll(async () => {
  api = await startApi();
  await api.runner.whenIdle();
  await api.executions.whenIdle();
  await clearDatabase(api.prisma);
  runId = (await succeededRun(api, 'ecommerce-small', '42')).id;
  const execute = async (label: keyof typeof executions, profile: string, target: Record<string, unknown>) => {
    const started = await api.http.post('/executions').send({ runId, chaosProfileId: await chaosProfileId(api, profile), chaosSeed: 7, target }).expect(202);
    const finished = await waitForExecution(api, (started.body as ExecutionView).id);
    expect(finished.status).toBe('completed');
    executions[label] = executionSchema.parse((await api.http.get(`/executions/${finished.id}`).expect(200)).body);
  };
  await execute('pass', 'none', { type: 'reference', name: 'correct' });
  await execute('fail', 'spec-example', { type: 'reference', name: 'naive' });
  await execute('late', 'late-data', { type: 'reference', name: 'correct' });
  await execute('lossy', 'lossy', { type: 'reference', name: 'correct' });
  await execute('kafka', 'spec-example', { type: 'reference', name: 'naive', transport: 'kafka' });
});

afterAll(async () => {
  await api.close();
});

async function allAttempts(executionId: string): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let fromSequence: number | null = 1;
  while (fromSequence !== null) {
    const page = attemptsSchema.parse((await api.http.get(`/executions/${executionId}/attempts?fromSequence=${fromSequence}&limit=1000`).expect(200)).body);
    attempts.push(...page.attempts);
    fromSequence = page.nextSequence;
  }
  return attempts;
}

async function allEvents(): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  let fromSequence: number | null = 1;
  while (fromSequence !== null) {
    const page = runEventsSchema.parse((await api.http.get(`/runs/${runId}/events?fromSequence=${fromSequence}&limit=1000`).expect(200)).body);
    events.push(...page.events);
    fromSequence = page.nextSequence;
  }
  return events;
}

async function allFindings(executionId: string): Promise<Finding[]> {
  return findingsSchema.parse((await api.http.get(`/executions/${executionId}/findings?limit=1000`).expect(200)).body).findings;
}

async function allWindowFindings(executionId: string): Promise<WindowFinding[]> {
  return windowFindingsSchema.parse((await api.http.get(`/executions/${executionId}/window-findings?limit=1000`).expect(200)).body).findings;
}

describe('every response the pages read parses with the UI schemas', () => {
  it('runs: the list, one run and a page of events', async () => {
    expect(runListSchema.parse((await api.http.get('/runs').expect(200)).body).runs).toHaveLength(1);
    expect(runSchema.parse((await api.http.get(`/runs/${runId}`).expect(200)).body).eventCount).toBe(472);
    expect(runEventsSchema.parse((await api.http.get(`/runs/${runId}/events?limit=25`).expect(200)).body).events).toHaveLength(25);
  });

  it('executions: the list with every filter the UI sends, and every kind of execution', async () => {
    expect(executionListSchema.parse((await api.http.get('/executions?limit=25&offset=0').expect(200)).body).executions).toHaveLength(5);
    const filtered = executionListSchema.parse((await api.http.get(`/executions?verdict=FAIL&status=completed&runId=${runId}&limit=25&offset=0`).expect(200)).body);
    expect(filtered.executions.every((execution) => execution.verdict === 'FAIL')).toBe(true);
    expect(executions.kafka.kafka).not.toBeNull();
    expect(executions.late.delivery?.windowing).toBeDefined();
    expect(executions.pass.verdict).toBe('PASS');
  });

  it('reports, findings, window findings and attempts of every execution', async () => {
    for (const execution of Object.values(executions)) {
      const report = reportSchema.parse((await api.http.get(`/executions/${execution.id}/report`).expect(200)).body);
      expect(report.verdict).toBe(execution.verdict);
      expect(report.counts.findings).toBe(execution.findingCount);
      expect(await allFindings(execution.id)).toHaveLength(execution.findingCount ?? 0);
      expect((await allAttempts(execution.id)).length).toBe(execution.attemptCount);
    }
    expect(await allWindowFindings(executions.late.id)).toHaveLength(executions.late.windowFindingCount ?? -1);
    expect(reportSchema.parse((await api.http.get(`/executions/${executions.late.id}/report`).expect(200)).body).windows?.counts.findings).toBe(7);
  });

  it('a paged findings request with the UI offset and limit returns that slice', async () => {
    const page = findingsSchema.parse((await api.http.get(`/executions/${executions.fail.id}/findings?limit=1&offset=3`).expect(200)).body);
    expect(page.findings.map((finding) => finding.ordinal)).toEqual([3]);
  });

  it('the Kafka outcome of every attempt of a Kafka execution is present, with partition and offset', async () => {
    const attempts = await allAttempts(executions.kafka.id);
    expect(attempts.every((attempt) => attempt.kafka !== null)).toBe(true);
    expect(attempts.filter((attempt) => attempt.kafka?.outcome === 'sent').every((attempt) => attempt.kafka?.partition === 0 && /^\d+$/.test(attempt.kafka.offset ?? ''))).toBe(true);
  });

  it('an unknown or malformed ID answers in the error shape the UI reads', async () => {
    const missing = await api.http.get('/executions/01a2059d-1421-7651-8848-976194c3e863').expect(404);
    expect(missing.body).toMatchObject({ statusCode: 404, error: 'Not Found', message: expect.any(String) as string });
    const malformed = await api.http.get('/executions/not-an-id').expect(400);
    expect(malformed.body).toMatchObject({ statusCode: 400, error: 'Bad Request', message: expect.any(Array) as string[] });
  });
});

describe('the UI reads the delivery the way the delivery summary counts it', () => {
  it.each(['fail', 'late', 'lossy', 'kafka', 'pass'] as const)('%s: out-of-order events recomputed from every attempt equal the summary', async (label) => {
    const execution = executions[label];
    expect(orderingOf(await allAttempts(execution.id))).toEqual(execution.delivery?.ordering);
  });

  it('the naive target under the specification example has the ordering the roadmap records', () => {
    expect(executions.fail.delivery?.ordering).toEqual({ outOfOrderEvents: 10, inversionPairs: 11, aggregatesAffected: 9 });
  });

  it('every aggregate timeline agrees with the validator about who overtook whom', async () => {
    const events = await allEvents();
    const attempts = await allAttempts(executions.fail.id);
    const findings = await allFindings(executions.fail.id);
    const reported = new Map<string, readonly string[]>();
    for (const cause of findings.flatMap((finding) => finding.causes)) reported.set(cause.eventId, cause.overtakenBy);
    expect(reported.size).toBeGreaterThan(0);
    const aggregates = [...new Set(events.map((event) => event.aggregateId))];
    let compared = 0;
    for (const aggregateId of aggregates) {
      const timeline = buildTimeline(
        events.filter((event) => event.aggregateId === aggregateId),
        attempts.filter((attempt) => attempt.aggregateId === aggregateId),
      );
      for (const entry of timeline.events) {
        const fromValidator = reported.get(entry.event.eventId);
        if (fromValidator !== undefined) {
          expect({ eventId: entry.event.eventId, overtakenBy: entry.overtakenBy }).toEqual({ eventId: entry.event.eventId, overtakenBy: fromValidator });
          compared += 1;
        }
      }
    }
    expect(compared).toBe(reported.size);
  });

  it('a lost event is flagged lost exactly when the summary counts it lost', async () => {
    const events = await allEvents();
    const attempts = await allAttempts(executions.lossy.id);
    const lost = events.filter((event) => {
      const own = attempts.filter((attempt) => attempt.eventId === event.eventId);
      return buildTimeline([event], own).events[0]?.flags.lost === true;
    });
    expect(lost.length).toBe(executions.lossy.delivery?.eventsLost);
    expect(lost.length).toBeGreaterThan(0);
  });
});

describe('every finding can be followed to a timeline', () => {
  it('each entity finding of the failing and the lossy execution maps to an aggregate that has events', async () => {
    const aggregates = new Set((await allEvents()).map((event) => event.aggregateId));
    for (const label of ['fail', 'lossy'] as const) {
      const findings = await allFindings(executions[label].id);
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        const aggregate = aggregateOfEntity(finding.entityType, finding.entityId);
        expect({ entity: finding.entityId, aggregate: aggregate !== null }).toEqual({ entity: finding.entityId, aggregate: true });
        expect({ entity: finding.entityId, hasEvents: aggregates.has(aggregate ?? '') }).toEqual({ entity: finding.entityId, hasEvents: true });
        for (const cause of finding.causes) expect(aggregates.has(cause.aggregateId)).toBe(true);
      }
    }
  });

  it('each event behind a window finding resolves to an aggregate through its delivery attempts', async () => {
    const windowFindings = await allWindowFindings(executions.late.id);
    const eventIds = [...new Set(windowFindings.flatMap((finding) => finding.causes.map((cause) => cause.eventId)))];
    expect(eventIds.length).toBeGreaterThan(0);
    for (const eventId of eventIds) {
      const page = attemptsSchema.parse((await api.http.get(`/executions/${executions.late.id}/attempts?eventId=${eventId}&limit=1`).expect(200)).body);
      expect(page.attempts[0]?.eventId).toBe(eventId);
    }
  });
});

describe('the scenarios and chaos profiles the UI reads and writes', () => {
  const small = () => JSON.parse(scenarioDocument('ecommerce-small')) as Record<string, unknown>;

  it('scenarios: the list, a scenario, a version and the dry run parse, and the dry run hashes as the stored version', async () => {
    const listed = scenarioListSchema.parse((await api.http.get('/scenarios').expect(200)).body).scenarios.find((scenario) => scenario.name === 'ecommerce-small');
    expect(listed).toBeDefined();
    const view = scenarioViewSchema.parse((await api.http.get(`/scenarios/${listed?.id ?? ''}`).expect(200)).body);
    expect(view.versions.map((version) => version.version)).toEqual([1]);
    const version = scenarioVersionSchema.parse((await api.http.get(`/scenarios/${view.id}/versions/1`).expect(200)).body);
    expect(version.scenarioHash).toBe(view.versions[0]?.scenarioHash);
    const dryRun = scenarioValidationSchema.parse((await api.http.post('/scenarios/validate').send(small()).expect(200)).body);
    expect(dryRun.scenarioHash).toBe(version.scenarioHash);
    expect(dryRun.definition).toEqual(version.definition);
  });

  it('scenarios: a new scenario is 201, a changed version is 201, an identical one is 200 with the same number', async () => {
    const created = scenarioViewSchema.parse((await api.http.post('/scenarios').send({ formatVersion: 1, name: 'contract-extra' }).expect(201)).body);
    expect(created.versions).toHaveLength(1);
    const changed = scenarioVersionSchema.parse(
      (await api.http.post(`/scenarios/${created.id}/versions`).send({ formatVersion: 1, name: 'contract-extra', description: 'changed' }).expect(201)).body,
    );
    expect(changed.version).toBe(2);
    const same = scenarioVersionSchema.parse(
      (await api.http.post(`/scenarios/${created.id}/versions`).send({ formatVersion: 1, name: 'contract-extra', description: 'changed' }).expect(200)).body,
    );
    expect(same.version).toBe(2);
  });

  it('chaos profiles: the same, with the profile hash and the loss rule refused by the dry run', async () => {
    const profileId = await chaosProfileId(api, 'spec-example');
    const listed = chaosProfileListSchema.parse((await api.http.get('/chaos-profiles').expect(200)).body).chaosProfiles.find((profile) => profile.id === profileId);
    expect(listed?.name).toBe('spec-example');
    const view = chaosProfileViewSchema.parse((await api.http.get(`/chaos-profiles/${profileId}`).expect(200)).body);
    const version = chaosProfileVersionSchema.parse((await api.http.get(`/chaos-profiles/${profileId}/versions/1`).expect(200)).body);
    const dryRun = chaosProfileValidationSchema.parse(
      (await api.http.post('/chaos-profiles/validate').set('Content-Type', 'application/json').send(profileDocument('spec-example')).expect(200)).body,
    );
    expect(dryRun.profileHash).toBe(version.profileHash);
    expect(view.versions[0]?.profileHash).toBe(version.profileHash);
    const refused = await api.http
      .post('/chaos-profiles/validate')
      .send({ formatVersion: 1, name: 'loses', faults: { transientFailure: { rate: 0.1, failures: { min: 1, max: 5 }, maxRetries: 2 } } })
      .expect(400);
    const problems = (refused.body as { message: string[] }).message.map(parseProblem);
    expect(problems.map((problem) => problem.path)).toEqual(['faults.transientFailure.failures.max']);
  });

  it("the API's problems read 'path: message', or just a message for an unknown key, as the UI splits them", async () => {
    const refused = await api.http.post('/scenarios/validate').send({ ...small(), customers: { count: 'many' }, colour: 'blue' }).expect(400);
    const problems = (refused.body as { message: string[] }).message.map(parseProblem);
    expect(problems).toEqual([
      { path: 'customers.count', message: 'Invalid input: expected number, received string' },
      { message: 'Unrecognized key: "colour"' },
    ]);
  });
});

describe('the requests the launch forms build are the ones the API accepts', () => {
  const form = (overrides: Partial<ExecutionForm>): ExecutionForm => ({
    runId,
    profileId: '',
    profileVersion: '',
    chaosSeed: '7',
    target: 'correct',
    transport: 'memory',
    partitions: '',
    speed: '',
    timeoutSeconds: '',
    topic: '',
    groupId: '',
    ...overrides,
  });

  it('a run: the seed typed as text arrives exactly as typed, and the new run is the one the UI shows', async () => {
    const scenario = scenarioListSchema.parse((await api.http.get('/scenarios').expect(200)).body).scenarios.find((entry) => entry.name === 'ecommerce-small');
    const built = buildRunRequest({ scenarioId: scenario?.id ?? '', version: '', seed: '9007199254740993' });
    if (!built.ok) throw new Error(built.problems.join('; '));
    const queued = runSchema.parse((await api.http.post('/runs').send(built.request).expect(202)).body);
    expect(queued).toMatchObject({ status: 'queued', seed: '9007199254740993' });
    const finished = await waitForRun(api, queued.id, 120_000);
    expect(finished.status).toBe('succeeded');
  });

  it('an execution for each kind of target: memory, Kafka with options, and external', async () => {
    const none = await chaosProfileId(api, 'none');
    const cases: { label: string; overrides: Partial<ExecutionForm>; status: string }[] = [
      { label: 'correct in memory', overrides: {}, status: 'completed' },
      { label: 'naive in memory, with Kafka fields left over', overrides: { target: 'naive', partitions: '3', speed: '5000' }, status: 'completed' },
      { label: 'correct through Kafka with partitions, speed and timeout', overrides: { transport: 'kafka', partitions: '2', speed: 'max', timeoutSeconds: '120' }, status: 'completed' },
      { label: 'external pipeline on a topic that does not exist', overrides: { target: 'external', topic: 'no-such-topic-for-the-contract-test', groupId: 'no-such-group' }, status: 'failed' },
    ];
    for (const { label, overrides, status } of cases) {
      const built = buildExecutionRequest(form({ profileId: none, ...overrides }));
      if (!built.ok) throw new Error(`${label}: ${built.problems.join('; ')}`);
      const queued = executionSchema.parse((await api.http.post('/executions').send(built.request).expect(202)).body);
      expect({ label, status: queued.status }).toEqual({ label, status: expect.stringMatching(/^(queued|running)$/) as string });
      const finished = await waitForExecution(api, queued.id);
      expect({ label, status: finished.status }).toEqual({ label, status });
    }
  });

  it('the API refuses what the form never sends: Kafka options on the memory transport, named by path', async () => {
    const none = await chaosProfileId(api, 'none');
    const refused = await api.http
      .post('/executions')
      .send({ runId, chaosProfileId: none, chaosSeed: '7', target: { type: 'reference', name: 'correct', transport: 'memory', partitions: 3, speed: 5000 } })
      .expect(400);
    expect((refused.body as { message: string[] }).message.map((message) => parseProblem(message).path).sort()).toEqual(['target.partitions', 'target.speed']);
  });
});

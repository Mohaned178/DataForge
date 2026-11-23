import {
  attemptsQuerySchema,
  executionTargetSchema,
  findingsQuerySchema,
  listExecutionsQuerySchema,
  startExecutionSchema,
  submitActualStateSchema,
} from '../src/executions/execution-requests';

const RUN = '01a2059d-1421-7651-8848-976194c3e863';
const PROFILE = '01a2059d-1421-7651-8848-976194c3e864';

function issues(result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }): string[] {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
}

const start = (target: unknown, extra: Record<string, unknown> = {}) =>
  startExecutionSchema.safeParse({ runId: RUN, chaosProfileId: PROFILE, chaosSeed: 7, target, ...extra });

describe('POST /executions body', () => {
  it('fills in the defaults: in memory, and for Kafka one partition, speed max, 60 s', () => {
    expect(start({ type: 'reference', name: 'correct' }).data).toEqual({
      runId: RUN,
      chaosProfileId: PROFILE,
      chaosSeed: '7',
      target: { type: 'reference', name: 'correct', transport: 'memory' },
    });
    expect(start({ type: 'reference', name: 'naive', transport: 'kafka' }).data?.target).toEqual({
      type: 'reference',
      name: 'naive',
      transport: 'kafka',
      partitions: 1,
      speed: 'max',
      timeoutSeconds: 60,
    });
    expect(start({ type: 'external', topic: 'shop.orders', groupId: 'orders-pipeline', speed: 3600 }).data?.target).toEqual({
      type: 'external',
      topic: 'shop.orders',
      groupId: 'orders-pipeline',
      speed: 3600,
      timeoutSeconds: 60,
    });
    expect(start({ type: 'reference', name: 'correct' }, { chaosProfileVersion: 2 }).data?.chaosProfileVersion).toBe(2);
  });

  it('stores a target the stored-target schema reads back unchanged', () => {
    for (const target of [
      { type: 'reference', name: 'correct' },
      { type: 'reference', name: 'naive', transport: 'kafka', partitions: 3, speed: 'max', timeoutSeconds: 120 },
      { type: 'external', topic: 't', groupId: 'g' },
    ]) {
      const stored = start(target).data?.target;
      expect(executionTargetSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    }
  });

  it('refuses the Kafka options for the in-memory transport, naming each one', () => {
    expect(issues(start({ type: 'reference', name: 'correct', partitions: 3, speed: 'max', timeoutSeconds: 5 }))).toEqual([
      'target.partitions: applies only to "transport": "kafka"',
      'target.speed: applies only to "transport": "kafka"',
      'target.timeoutSeconds: applies only to "transport": "kafka"',
    ]);
  });

  it('rejects unknown targets, transports, bad options and names with their paths', () => {
    expect(issues(start({ type: 'reference', name: 'clever' }))).toEqual(['target.name: Invalid option: expected one of "correct"|"naive"']);
    expect(issues(start({ type: 'webhook' }))).toEqual([
      'target.type: must be {"type": "reference", "name": ...} or {"type": "external", "topic": ..., "groupId": ...}',
    ]);
    expect(issues(start({ type: 'reference', name: 'correct', transport: 'kafka', partitions: 65, speed: 0, timeoutSeconds: 0 }))).toEqual([
      'target.partitions: Too big: expected number to be <=64',
      'target.speed: Too small: expected number to be >0',
      'target.timeoutSeconds: Too small: expected number to be >=1',
    ]);
    expect(issues(start({ type: 'external', topic: 'my topic', groupId: '' }))).toEqual([
      'target.topic: must be a Kafka topic name: 1-249 letters, digits, ".", "_" or "-"',
      'target.groupId: Too small: expected string to have >=1 characters',
    ]);
    expect(issues(start({ type: 'external', topic: '..', groupId: 'g', partitions: 2 }))).toEqual([
      'target.topic: must not be "." or ".."',
      'target: Unrecognized key: "partitions"',
    ]);
  });

  it('follows the seed rules of the CLI for the chaos seed, and rejects unknown fields', () => {
    expect(issues(startExecutionSchema.safeParse({ runId: 'r', chaosProfileId: PROFILE, chaosSeed: 'two words', target: { type: 'reference', name: 'correct' }, extra: 1 }))).toEqual([
      'runId: must be a run id (a UUID)',
      'chaosSeed: Invalid seed "two words": use 1-128 characters from A-Z, a-z, 0-9, ".", "_", ":" and "-"',
      ': Unrecognized key: "extra"',
    ]);
  });
});

describe('POST /executions/:id/actual-state body', () => {
  it('needs the actual state; the windows are optional', () => {
    expect(submitActualStateSchema.safeParse({ actualState: { format: 'x' } }).success).toBe(true);
    expect(issues(submitActualStateSchema.safeParse({ actualWindows: {} }))).toEqual(['actualState: is required']);
    expect(issues(submitActualStateSchema.safeParse({ actualState: {}, state: {} }))).toEqual([': Unrecognized key: "state"']);
  });
});

describe('execution query strings', () => {
  it('pages execution history and filters it by run, profile, status and verdict', () => {
    expect(listExecutionsQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(listExecutionsQuerySchema.parse({ runId: RUN, status: 'awaiting_actual_state', verdict: 'FAIL', limit: '3' })).toEqual({
      runId: RUN,
      status: 'awaiting_actual_state',
      verdict: 'FAIL',
      limit: 3,
      offset: 0,
    });
    expect(issues(listExecutionsQuerySchema.safeParse({ verdict: 'passed' }))).toEqual(['verdict: Invalid option: expected one of "PASS"|"FAIL"']);
  });

  it('filters attempts by event, aggregate, kind, fault and planned outcome', () => {
    expect(attemptsQuerySchema.parse({ aggregateId: 'ord_000001', fault: 'duplicate', kind: 'duplicate', plannedOutcome: 'delivered' })).toEqual({
      aggregateId: 'ord_000001',
      fault: 'duplicate',
      kind: 'duplicate',
      plannedOutcome: 'delivered',
      fromSequence: 1,
      limit: 100,
    });
    expect(issues(attemptsQuerySchema.safeParse({ fault: 'loss' }))).toEqual([
      'fault: Invalid option: expected one of "delay"|"late"|"reorder"|"duplicate"|"transientFailure"',
    ]);
  });

  it('filters findings by category and entity', () => {
    expect(findingsQuerySchema.parse({ category: 'double-processing', entityType: 'customer', entityId: 'cus_000001' })).toEqual({
      category: 'double-processing',
      entityType: 'customer',
      entityId: 'cus_000001',
      limit: 100,
      offset: 0,
    });
    expect(issues(findingsQuerySchema.safeParse({ entityType: 'invoice' }))).toHaveLength(1);
  });
});

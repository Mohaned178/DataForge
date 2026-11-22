import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcessingLog } from '@dataforge/kafka';
import { runCli } from '../src/cli';
import type { CliIo } from '../src/cli-io';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SEEDS = ['42', '7'];
const PROFILES = ['none', 'spec-example', 'flaky-network', 'lossy'];
const TARGETS = ['correct', 'naive'];

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(...argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line = '') => out.push(line), err: (line = '') => err.push(line) };
  const code = await runCli(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const read = (...path: string[]) => readFileSync(join(...path), 'utf8');
const lines = (text: string) => text.split('\n').filter((line) => line !== '');

let workspace: string;
const runOf = (seed: string) => join(workspace, `run-${seed}`);
const planOf = (seed: string, profile: string) => join(workspace, `plan-${seed}-${profile}`);

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-kafka-'));
  for (const seed of SEEDS) {
    expect((await run('generate', '--scenario', join(REPO_ROOT, 'scenarios', 'ecommerce-small.json'), '--seed', seed, '--out', runOf(seed))).code).toBe(0);
    for (const profile of PROFILES) {
      const profilePath = join(REPO_ROOT, 'chaos-profiles', `${profile}.json`);
      expect((await run('chaos', 'plan', '--run', runOf(seed), '--profile', profilePath, '--chaos-seed', '7', '--out', planOf(seed, profile))).code).toBe(0);
    }
  }
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function deliver(seed: string, profile: string, target: string, out: string, ...extra: string[]): Promise<Captured> {
  return run('deliver', '--run', runOf(seed), '--plan', planOf(seed, profile), '--target', target, '--out', join(workspace, out), ...extra);
}

function validate(seed: string, profile: string, out: string): Promise<Captured> {
  const actual = join(workspace, out, 'actual-state.json');
  return run('validate', '--run', runOf(seed), '--actual', actual, '--plan', planOf(seed, profile), '--report', join(workspace, `${out}.report.json`));
}

describe('deliver --transport kafka (real broker, separate consumer process)', () => {
  const cases = SEEDS.flatMap((seed) => PROFILES.flatMap((profile) => TARGETS.map((target) => [seed, profile, target] as const)));

  it.each(cases)('seed %s, profile %s, target %s: the same files and findings as the in-memory delivery', async (seed, profile, target) => {
    const name = `${seed}-${profile}-${target}`;
    const memory = await deliver(seed, profile, target, `memory-${name}`);
    const kafka = await deliver(seed, profile, target, `kafka-${name}`, '--transport', 'kafka');
    expect(memory).toMatchObject({ code: 0, err: '' });
    expect(kafka).toMatchObject({ code: 0, err: '' });
    for (const file of ['actual-state.json', 'target-run.json']) {
      expect(read(workspace, `kafka-${name}`, file)).toBe(read(workspace, `memory-${name}`, file));
    }
    const memoryReport = await validate(seed, profile, `memory-${name}`);
    const kafkaReport = await validate(seed, profile, `kafka-${name}`);
    expect(kafkaReport.code).toBe(memoryReport.code);
    expect(read(workspace, `kafka-${name}.report.json`)).toBe(read(workspace, `memory-${name}.report.json`));
  });

  it('runs the consumer as its own process and records what really happened on Kafka', async () => {
    const result = await deliver('42', 'flaky-network', 'naive', 'kafka-records', '--transport', 'kafka');
    expect(result.code).toBe(0);
    const directory = join(workspace, 'kafka-records');
    const kafkaRun = JSON.parse(read(directory, 'kafka-run.json')) as {
      consumer: { pid: number; exitCode: number };
      kafka: { topic: string; partitions: number };
      execution: { sent: number; plannedFailures: number; speed: string };
      consumed: { messages: number; kafkaRedeliveries: number };
    };
    expect(kafkaRun.consumer.pid).not.toBe(process.pid);
    expect(kafkaRun.consumer.exitCode).toBe(0);
    expect(kafkaRun.kafka).toMatchObject({ partitions: 1, topic: expect.stringMatching(/^dataforge\.\d{8}T\d{9}Z-[0-9a-f]{6}$/) as unknown });

    const plan = lines(read(planOf('42', 'flaky-network'), 'delivery-plan.jsonl')).map(
      (line) => JSON.parse(line) as { attemptId: string; plannedOutcome: string },
    );
    const log = lines(read(directory, 'delivery-log.jsonl')).map((line) => JSON.parse(line) as { attemptId: string; outcome: string; offset: string | null });
    expect(log.map((entry) => entry.attemptId)).toEqual(plan.map((attempt) => attempt.attemptId));
    expect(log.map((entry) => entry.outcome)).toEqual(plan.map((attempt) => (attempt.plannedOutcome === 'failed' ? 'planned-failure' : 'sent')));
    expect(kafkaRun.execution.plannedFailures).toBeGreaterThan(0);
    expect(kafkaRun.execution).toMatchObject({ sent: log.filter((entry) => entry.outcome === 'sent').length, speed: 'max' });

    const processed = parseProcessingLog(read(directory, 'processing-log.jsonl'));
    const sentOffsets = log.filter((entry) => entry.outcome === 'sent').map((entry) => `${entry.attemptId}@${entry.offset}`);
    expect(processed.map((entry) => `${entry.attemptId}@${entry.offset}`)).toEqual(sentOffsets);
    expect(kafkaRun.consumed).toEqual({ messages: processed.length, kafkaRedeliveries: 0 });
    expect(result.out).toMatch(/consumer {4}process \d+, group dataforge-consumer\./);
    expect(result.out).toMatch(/completion {2}consumer-group lag 0/);
  });

  it('keeps the correct target passing with three partitions', async () => {
    const result = await deliver('42', 'flaky-network', 'correct', 'kafka-three', '--transport', 'kafka', '--partitions', '3');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/\(3 partitions\)/);
    expect(result.out).toMatch(/joined after [\d.]+ s \(partitions 0, 1, 2\)/);
    expect((await validate('42', 'flaky-network', 'kafka-three')).code).toBe(0);
  });

  it('paces the plan at a numeric speed and reports the drift', async () => {
    const result = await deliver('42', 'none', 'correct', 'kafka-paced', '--transport', 'kafka', '--speed', '100000');
    expect(result.code).toBe(0);
    const kafkaRun = JSON.parse(read(workspace, 'kafka-paced', 'kafka-run.json')) as { execution: { speed: number; durationMs: number; maxDriftMs: number } };
    const plan = lines(read(planOf('42', 'none'), 'delivery-plan.jsonl')).map((line) => JSON.parse(line) as { scheduledDeliveryTimeMs: number });
    const planned = Math.floor((plan[plan.length - 1]!.scheduledDeliveryTimeMs - plan[0]!.scheduledDeliveryTimeMs) / 100000);
    expect(kafkaRun.execution.speed).toBe(100000);
    expect(kafkaRun.execution.durationMs).toBeGreaterThanOrEqual(planned);
    expect(kafkaRun.execution.maxDriftMs).toBeGreaterThanOrEqual(0);
    expect(result.out).toMatch(/speed 100000x, [\d.]+ s, largest drift \d+ ms/);
  });

  it('fails with exit code 3 and the command to start Kafka when the broker is unreachable', async () => {
    const result = await deliver('42', 'none', 'correct', 'kafka-down', '--transport', 'kafka', '--brokers', 'localhost:1');
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/Kafka is not reachable at localhost:1: Connection error \(ECONNREFUSED\)/);
    expect(result.err).toMatch(/docker compose up -d --wait/);
  });
});

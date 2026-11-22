import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCli } from '../src/cli';
import type { CliIo } from '../src/cli-io';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SMALL_SCENARIO = join(REPO_ROOT, 'scenarios', 'ecommerce-small.json');
const profilePath = (name: string) => join(REPO_ROOT, 'chaos-profiles', `${name}.json`);

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function run(...argv: string[]): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line = '') => out.push(line), err: (line = '') => err.push(line) };
  const code = runCli(argv, io);
  if (typeof code !== 'number') {
    throw new Error('expected a synchronous command');
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

let workspace: string;
let runDirectory: string;
const plans = new Map<string, string>();

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-validate-'));
  runDirectory = join(workspace, 'run');
  expect(run('generate', '--scenario', SMALL_SCENARIO, '--seed', '42', '--out', runDirectory).code).toBe(0);
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function plan(profile: string, chaosSeed = '7'): string {
  const key = `${profile}-${chaosSeed}`;
  const existing = plans.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const directory = join(workspace, `plan-${key}`);
  expect(run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath(profile), '--chaos-seed', chaosSeed, '--out', directory).code).toBe(0);
  plans.set(key, directory);
  return directory;
}

function deliver(name: string, target: string, planDirectory: string): string {
  const directory = join(workspace, name);
  const result = run('deliver', '--run', runDirectory, '--plan', planDirectory, '--target', target, '--out', directory);
  expect(result).toMatchObject({ code: 0, err: '' });
  return directory;
}

const validate = (actualDirectory: string, ...extra: string[]) =>
  run('validate', '--run', runDirectory, '--actual', join(actualDirectory, 'actual-state.json'), ...extra);

describe('dataforge deliver', () => {
  it('writes the actual state and a target run that binds it to its run and plan', () => {
    const planDirectory = plan('spec-example');
    const directory = deliver('deliver-naive', 'naive', planDirectory);
    const targetRun = JSON.parse(readFileSync(join(directory, 'target-run.json'), 'utf8')) as {
      target: { name: string };
      source: { eventsSha256: string };
      plan: { chaosSeed: string; planSha256: string };
      delivery: Record<string, number>;
      counters: Record<string, number>;
      files: Record<string, { sha256: string; bytes: number }>;
    };
    expect(targetRun.target.name).toBe('naive');
    expect(targetRun.source.eventsSha256).toBe(sha256(join(runDirectory, 'events.jsonl')));
    expect(targetRun.plan).toMatchObject({ chaosSeed: '7', planSha256: sha256(join(planDirectory, 'delivery-plan.jsonl')) });
    expect(targetRun.delivery).toEqual({ messages: 486, distinctEvents: 472, redeliveries: 14, failedAttempts: 0 });
    expect(targetRun.counters).toEqual({ updatesLost: 6 });
    expect(targetRun.files['actual-state.json']!.sha256).toBe(sha256(join(directory, 'actual-state.json')));
    expect(readFileSync(join(directory, 'actual-state.json')).includes(13)).toBe(false);
  });

  it('is deterministic: same run, plan and target, same bytes', () => {
    const first = deliver('repeat-a', 'correct', plan('flaky-network'));
    const second = deliver('repeat-b', 'correct', plan('flaky-network'));
    for (const name of ['actual-state.json', 'target-run.json']) {
      expect(sha256(join(second, name))).toBe(sha256(join(first, name)));
    }
  });

  it('a correct target with zero faults writes exactly the expected records', () => {
    const directory = deliver('none-correct', 'correct', plan('none'));
    const actual = JSON.parse(readFileSync(join(directory, 'actual-state.json'), 'utf8')) as Record<string, unknown>;
    const expected = JSON.parse(readFileSync(join(runDirectory, 'expected-state.json'), 'utf8')) as Record<string, unknown>;
    for (const collection of ['products', 'customers', 'orders', 'payments', 'shipments']) {
      expect(actual[collection]).toEqual(expected[collection]);
    }
  });

  it('rejects an unknown target, a missing option, and writing over the run or the plan', () => {
    const planDirectory = plan('none');
    const base = ['deliver', '--run', runDirectory, '--plan', planDirectory];
    expect(run(...base, '--target', 'clever', '--out', join(workspace, 'never'))).toMatchObject({
      code: 2,
      err: 'Unknown target "clever". Reference targets: correct, naive.',
    });
    expect(run(...base, '--target', 'naive').code).toBe(2);
    expect(run(...base, '--target', 'naive', '--out', planDirectory)).toMatchObject({ code: 2, err: expect.stringMatching(/--out must be its own directory/) as unknown });
    expect(run(...base, '--target', 'naive', '--out', runDirectory).code).toBe(2);
  });

  it('refuses an edited plan', () => {
    const edited = join(workspace, 'plan-edited');
    cpSync(plan('spec-example'), edited, { recursive: true });
    const path = join(edited, 'delivery-plan.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"kind":"duplicate"', '"kind":"original"'));
    const result = run('deliver', '--run', runDirectory, '--plan', edited, '--target', 'naive', '--out', join(workspace, 'never'));
    expect(result).toMatchObject({ code: 2, err: expect.stringMatching(/the plan was modified/) as unknown });
  });
});

describe('dataforge validate', () => {
  it('passes the correct target under the specification example, exit code 0', () => {
    const planDirectory = plan('spec-example');
    const result = validate(deliver('spec-correct', 'correct', planDirectory), '--plan', planDirectory);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/written by target correct from profile spec-example, chaos seed 7/);
    expect(result.out).toMatch(/findings\s+0/);
    expect(result.out).toMatch(/Result: PASS/);
  });

  it('fails the naive target with exit code 1, counts per category, causes, and a deterministic report', () => {
    const planDirectory = plan('spec-example');
    const directory = deliver('spec-naive', 'naive', planDirectory);
    const reportA = join(workspace, 'reports', 'a.json');
    const reportB = join(workspace, 'reports', 'b.json');
    const result = validate(directory, '--plan', planDirectory, '--report', reportA);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/findings\s+48/);
    expect(result.out).toMatch(/status-mismatch\s+8/);
    expect(result.out).toMatch(/double-processing\s+8/);
    expect(result.out).toMatch(/explained\s+48 of 48 findings are linked to abnormal deliveries; 0 are not explained/);
    expect(result.out).toMatch(/Most likely causes/);
    expect(result.out).toMatch(/order\s+ord_000018\s+double-processing\s+amountPaidMinor is 7000, expected 3500 \(2x\)/);
    expect(result.out).toMatch(/cause: evt_ord_000018_3 PaymentCompleted, delivered 2 times \[duplicate\]/);
    expect(result.out).toMatch(/Findings \(first 20 of 48; all of them are in the report\)/);
    expect(result.out).toMatch(/Result: FAIL \(48 findings\)/);
    expect(validate(directory, '--plan', planDirectory, '--report', reportB).code).toBe(1);
    expect(sha256(reportB)).toBe(sha256(reportA));
    const report = JSON.parse(readFileSync(reportA, 'utf8')) as { format: string; verdict: string; target: unknown; findings: unknown[] };
    expect(report).toMatchObject({ format: 'dataforge.validation-report', verdict: 'FAIL', target: { name: 'naive', editedAfterDelivery: false } });
    expect(report.findings).toHaveLength(48);
  });

  it('works without a plan, without hints', () => {
    const result = validate(deliver('spec-naive-noplan', 'naive', plan('spec-example')), '--limit', '0');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/plan\s+none given: findings have no root-cause hints/);
    expect(result.out).not.toMatch(/explained|cause:/);
  });

  it('flags an actual state edited after delivery and reports what changed', () => {
    const directory = join(workspace, 'edited-actual');
    cpSync(deliver('to-edit', 'correct', plan('none')), directory, { recursive: true });
    const path = join(directory, 'actual-state.json');
    writeFileSync(path, String.fromCharCode(0xfeff) + readFileSync(path, 'utf8').replace('"status": "DELIVERED"', '"status": "SHIPPED"'));
    const result = validate(directory, '--plan', plan('none'));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/EDITED since \(checksum differs from target-run\.json\)/);
    expect(result.out).toMatch(/status-mismatch\s+status is SHIPPED, expected DELIVERED/);
    expect(result.out).toMatch(/cause: none found; no delivery fault touched/);
    expect(result.out).toMatch(/\(no delivery fault\)/);
  });

  it('rejects an invalid actual state with the path of each problem, exit code 2', () => {
    const path = join(workspace, 'invalid-actual.json');
    const actual = JSON.parse(readFileSync(join(runDirectory, 'expected-state.json'), 'utf8')) as Record<string, unknown> & { orders: Record<string, unknown>[] };
    actual.orders[3]!.status = 'SHIPPPED';
    writeFileSync(path, JSON.stringify(actual));
    const result = run('validate', '--run', runDirectory, '--actual', path);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/format: format must be "dataforge\.actual-state"/);
    expect(result.err).toMatch(/orders\.3\.status: Invalid option/);
    expect(result.err).toMatch(/\(root\): Unrecognized keys: "lastEventTimeMs", "lastSequence", "summary"/);
    expect(run('validate', '--run', runDirectory, '--actual', join(workspace, 'nope.json'))).toMatchObject({
      code: 2,
      err: expect.stringMatching(/Cannot read actual state file/) as unknown,
    });
  });

  it('refuses a plan other than the one the target consumed', () => {
    const directory = deliver('seed-7-naive', 'naive', plan('spec-example', '7'));
    const result = validate(directory, '--plan', plan('spec-example', '8'));
    expect(result).toMatchObject({ code: 2, err: expect.stringMatching(/was produced from a different delivery plan/) as unknown });
    expect(result.err).toMatch(/target run: profile spec-example, chaos seed 7/);
    expect(result.err).toMatch(/--plan:\s+profile spec-example, chaos seed 8/);
  });

  it('refuses an actual state delivered from another run, and a run whose expected state was edited', () => {
    const directory = deliver('other-run-source', 'correct', plan('none'));
    const otherRun = join(workspace, 'run-43');
    expect(run('generate', '--scenario', SMALL_SCENARIO, '--seed', '43', '--out', otherRun).code).toBe(0);
    const mismatch = run('validate', '--run', otherRun, '--actual', join(directory, 'actual-state.json'));
    expect(mismatch).toMatchObject({ code: 2, err: expect.stringMatching(/was produced from a different canonical log/) as unknown });

    const editedRun = join(workspace, 'run-edited');
    cpSync(runDirectory, editedRun, { recursive: true });
    const path = join(editedRun, 'expected-state.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"status": "DELIVERED"', '"status": "SHIPPED"'));
    const edited = run('validate', '--run', editedRun, '--actual', join(directory, 'actual-state.json'));
    expect(edited).toMatchObject({ code: 2, err: expect.stringMatching(/expected-state\.json in .* does not match the checksum in manifest\.json/) as unknown });
  });

  it('rejects a bad --limit and a report path that is the actual state', () => {
    const directory = deliver('limit', 'correct', plan('none'));
    expect(validate(directory, '--limit', 'ten')).toMatchObject({ code: 2, err: expect.stringMatching(/--limit must be a whole number/) as unknown });
    expect(validate(directory, '--report', join(directory, 'actual-state.json'))).toMatchObject({ code: 2, err: '--report must not be the actual state file.' });
  });
});

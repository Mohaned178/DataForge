import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCli } from '../src/cli';
import type { CliIo } from '../src/cli-io';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SMALL_SCENARIO = join(REPO_ROOT, 'scenarios', 'ecommerce-small.json');
const profilePath = (name: string) => join(REPO_ROOT, 'chaos-profiles', `${name}.json`);
const PLAN_FILES = ['delivery-plan.jsonl', 'chaos-profile.resolved.json', 'delivery-summary.json'];

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

interface PlanLine {
  attemptId: string;
  eventId: string;
  kind: string;
  plannedOutcome: string;
  deliverySequence: number;
  eventSequence: number;
  scheduledDeliveryTimeMs: number;
  eventTimeMs: number;
  faults: { type: string }[];
}

const readPlan = (directory: string): PlanLine[] =>
  readFileSync(join(directory, 'delivery-plan.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as PlanLine);

let workspace: string;
let runDirectory: string;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-chaos-'));
  runDirectory = join(workspace, 'run');
  expect(run('generate', '--scenario', SMALL_SCENARIO, '--seed', '42', '--out', runDirectory).code).toBe(0);
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function plan(name: string, profile = 'spec-example', chaosSeed = '7', runDir = runDirectory): string {
  const directory = join(workspace, name);
  const result = run('chaos', 'plan', '--run', runDir, '--profile', profilePath(profile), '--chaos-seed', chaosSeed, '--out', directory);
  expect(result).toMatchObject({ code: 0, err: '' });
  return directory;
}

describe('dataforge chaos plan', () => {
  it('writes the plan files, with checksums in the summary that match the bytes on disk', () => {
    const directory = plan('checksums');
    const summary = JSON.parse(readFileSync(join(directory, 'delivery-summary.json'), 'utf8')) as {
      chaosSeed: string;
      source: { seed: string; eventsSha256: string };
      files: Record<string, { sha256: string; bytes: number }>;
    };
    expect(summary.chaosSeed).toBe('7');
    expect(summary.source.seed).toBe('42');
    expect(summary.source.eventsSha256).toBe(sha256(join(runDirectory, 'events.jsonl')));
    expect(Object.keys(summary.files).sort()).toEqual(['chaos-profile.resolved.json', 'delivery-plan.jsonl']);
    for (const [name, entry] of Object.entries(summary.files)) {
      const bytes = readFileSync(join(directory, name));
      expect(sha256(join(directory, name))).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.bytes);
      expect(bytes.includes(13)).toBe(false);
    }
  });

  it('writes byte-identical plan files for the same run, profile and chaos seed', () => {
    const first = plan('repeat-a');
    const second = plan('repeat-b');
    for (const name of PLAN_FILES) {
      expect(sha256(join(second, name))).toBe(sha256(join(first, name)));
    }
  });

  it('changes the plan but not the canonical run when the chaos seed changes', () => {
    const runHashes = () => ['events.jsonl', 'expected-state.json', 'manifest.json'].map((name) => sha256(join(runDirectory, name)));
    const before = runHashes();
    const seven = plan('seed-7', 'flaky-network', '7');
    const eight = plan('seed-8', 'flaky-network', '8');
    expect(sha256(join(eight, 'delivery-plan.jsonl'))).not.toBe(sha256(join(seven, 'delivery-plan.jsonl')));
    expect(runHashes()).toEqual(before);
    expect(run('verify', '--run', runDirectory).code).toBe(0);
  });

  it('plans exactly the canonical order at event time with the profile without faults', () => {
    const attempts = readPlan(plan('none', 'none'));
    const events = readFileSync(join(runDirectory, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(attempts).toHaveLength(events.length);
    attempts.forEach((attempt, index) => {
      expect(attempt).toMatchObject({ kind: 'original', plannedOutcome: 'delivered', deliverySequence: index + 1, eventSequence: index + 1, faults: [] });
      expect(attempt.scheduledDeliveryTimeMs).toBe(attempt.eventTimeMs);
    });
  });

  it('prints observed against configured fault rates', () => {
    const result = run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath('spec-example'), '--chaos-seed', '7', '--out', join(workspace, 'printed'));
    expect(result.out).toMatch(/attempts\s+486: original 472, retry 0, duplicate 14; delivered 486, failed 0/);
    expect(result.out).toMatch(/delay\s+26 of 472 events\s+5\.51%\s+\(configured 5\.00%\)/);
    expect(result.out).toMatch(/reorder\s+8 of 315 eligible\s+2\.54%\s+\(configured 2\.00%\)/);
    expect(result.out).toMatch(/duplicate\s+14 of 472 delivered\s+2\.97%\s+\(configured 3\.00%\)/);
    expect(result.out).toMatch(/ordering\s+10 events delivered after a later event of their aggregate \(11 inverted pairs in 9 aggregates\)/);
  });

  it('explains an invalid profile with the path of each problem and exits with code 2', () => {
    const path = join(workspace, 'invalid-profile.json');
    writeFileSync(path, JSON.stringify({ formatVersion: 1, name: 'bad', faults: { delay: { rate: 1.5 }, dealy: {} } }));
    const result = run('chaos', 'plan', '--run', runDirectory, '--profile', path, '--chaos-seed', '7', '--out', join(workspace, 'never-1'));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/faults\.delay\.rate: /);
    expect(result.err).toMatch(/faults: Unrecognized key: "dealy"/);
  });

  it('rejects an invalid chaos seed, a missing profile and a missing option with code 2', () => {
    const base = ['chaos', 'plan', '--run', runDirectory, '--profile', profilePath('none'), '--out', join(workspace, 'never-2')];
    expect(run(...base, '--chaos-seed', 'not valid')).toMatchObject({ code: 2, err: expect.stringMatching(/^Invalid chaos seed "not valid"/) as unknown });
    expect(run('chaos', 'plan', '--run', runDirectory, '--profile', join(workspace, 'nope.json'), '--chaos-seed', '1', '--out', join(workspace, 'never-3')).err).toMatch(
      /Cannot read chaos profile file/,
    );
    expect(run('chaos', 'plan', '--run', runDirectory).code).toBe(2);
    expect(run('chaos').code).toBe(2);
    expect(run('chaos', 'frobnicate').err).toMatch(/Unknown chaos subcommand "frobnicate"/);
  });

  it('refuses to plan from a modified run and to write into the run directory', () => {
    const edited = join(workspace, 'run-edited');
    cpSync(runDirectory, edited, { recursive: true });
    const eventsPath = join(edited, 'events.jsonl');
    writeFileSync(eventsPath, readFileSync(eventsPath, 'utf8').replace('"priceMinor":8991', '"priceMinor":8992'));
    const tampered = run('chaos', 'plan', '--run', edited, '--profile', profilePath('none'), '--chaos-seed', '7', '--out', join(workspace, 'never-4'));
    expect(tampered).toMatchObject({ code: 2, err: expect.stringMatching(/does not match the checksum in manifest\.json/) as unknown });

    const intoRun = run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath('none'), '--chaos-seed', '7', '--out', runDirectory);
    expect(intoRun).toMatchObject({ code: 2, err: expect.stringMatching(/--out must not be the run directory/) as unknown });
  });

  it('refuses to write into a non-empty directory without --force', () => {
    const directory = plan('force');
    const refused = run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath('none'), '--chaos-seed', '7', '--out', directory);
    expect(refused).toMatchObject({ code: 2, err: expect.stringMatching(/not empty[\s\S]*plan files/) as unknown });
    expect(run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath('none'), '--chaos-seed', '7', '--out', directory, '--force').code).toBe(0);
  });
});

describe('dataforge explain', () => {
  let planDirectory: string;
  let attempts: PlanLine[];
  beforeAll(() => {
    planDirectory = plan('explain', 'flaky-network');
    attempts = readPlan(planDirectory);
  });

  const explain = (eventId: string, planDir = planDirectory, runDir = runDirectory) =>
    run('explain', '--run', runDir, '--plan', planDir, '--event', eventId);

  it('lists every attempt of a duplicated event under the same eventId', () => {
    const duplicate = attempts.find((attempt) => attempt.kind === 'duplicate') as PlanLine;
    const own = attempts.filter((attempt) => attempt.eventId === duplicate.eventId);
    const result = explain(duplicate.eventId);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(new RegExp(`Delivery attempts \\(${own.length}\\):`));
    for (const attempt of own) {
      expect(result.out).toContain(attempt.attemptId);
    }
    expect(result.out).toMatch(/duplicate copy 1 of \d/);
    expect(result.out).toMatch(/Outcome: delivered \d times with the same eventId/);
  });

  it('shows a reordered event as out of order within its aggregate', () => {
    const reordered = attempts.find((attempt) => attempt.faults.some((fault) => fault.type === 'reorder')) as PlanLine;
    const result = explain(reordered.eventId);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/reorder: moved behind evt_/);
    expect(result.out).toMatch(/Aggregate order: OUT OF ORDER/);
  });

  it('shows failed attempts and their retries', () => {
    const retried = attempts.find((attempt) => attempt.kind === 'retry') as PlanLine;
    const result = explain(retried.eventId);
    expect(result.out).toMatch(/FAILED\s+transient failure 1 of \d/);
    expect(result.out).toMatch(/retry [\d,]+ ms after att_\S+ failed/);
  });

  it('reports a lost event as lost', () => {
    const lossyPlan = plan('explain-lossy', 'lossy');
    const lossy = readPlan(lossyPlan);
    const lost = [...new Set(lossy.map((attempt) => attempt.eventId))].find((eventId) =>
      lossy.filter((attempt) => attempt.eventId === eventId).every((attempt) => attempt.plannedOutcome === 'failed'),
    ) as string;
    expect(explain(lost, lossyPlan).out).toMatch(/Outcome: LOST\. All 3 attempts fail and the sender gives up after 2 retries/);
  });

  it('exits with code 1 for an event that is not in the log', () => {
    expect(explain('evt_ord_999999_1')).toMatchObject({ code: 1, err: expect.stringMatching(/not in the canonical log/) as unknown });
  });

  it('refuses a plan whose files were edited', () => {
    const edited = join(workspace, 'plan-edited');
    cpSync(planDirectory, edited, { recursive: true });
    const path = join(edited, 'delivery-plan.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"kind":"duplicate"', '"kind":"original"'));
    expect(explain('evt_prd_000001_1', edited)).toMatchObject({ code: 2, err: expect.stringMatching(/delivery-plan\.jsonl .* the plan was modified/) as unknown });
  });

  it('refuses a plan made for a different run', () => {
    const otherRun = join(workspace, 'run-43');
    expect(run('generate', '--scenario', SMALL_SCENARIO, '--seed', '43', '--out', otherRun).code).toBe(0);
    expect(explain('evt_prd_000001_1', planDirectory, otherRun)).toMatchObject({
      code: 2,
      err: expect.stringMatching(/was made for a different canonical log/) as unknown,
    });
  });
});

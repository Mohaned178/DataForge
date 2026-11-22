import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

let workspace: string;
let runDirectory: string;
const plans = new Map<string, string>();

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-windows-'));
  runDirectory = join(workspace, 'run');
  expect(run('generate', '--scenario', SMALL_SCENARIO, '--seed', '42', '--out', runDirectory).code).toBe(0);
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function plan(profile: string): string {
  const existing = plans.get(profile);
  if (existing !== undefined) {
    return existing;
  }
  const directory = join(workspace, `plan-${profile}`);
  const result = run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath(profile), '--chaos-seed', '7', '--out', directory);
  expect(result).toMatchObject({ code: 0, err: '' });
  plans.set(profile, directory);
  return directory;
}

function deliver(name: string, target: string, planDirectory: string, ...extra: string[]): string {
  const directory = join(workspace, name);
  expect(run('deliver', '--run', runDirectory, '--plan', planDirectory, '--target', target, '--out', directory, ...extra)).toMatchObject({ code: 0, err: '' });
  return directory;
}

const validate = (directory: string, ...extra: string[]) => run('validate', '--run', runDirectory, '--actual', join(directory, 'actual-state.json'), ...extra);

describe('dataforge chaos plan with a windowing contract', () => {
  it('prints the windowing, the late tally and the arrivals, and records them in the summary', () => {
    const directory = join(workspace, 'plan-print');
    const result = run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath('late-data'), '--chaos-seed', '7', '--out', directory);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/late\s+\d+ of\s+\d+ eligible\s+[\d.]+%\s+\(configured 5\.00%\)\s+arrive after their window closed/);
    expect(result.out).toMatch(/windowing\s+1 h tumbling event-time windows, allowed lateness 10 min/);
    expect(result.out).toMatch(/arrivals\s+\d+ windowed events \(OrderCreated, PaymentCompleted\), by stream time: \d+ on time, \d+ within the allowed lateness, [1-9]\d* after their window closed, 0 lost/);
    const summary = readJson(join(directory, 'delivery-summary.json')).summary as { windowing: unknown; faults: Record<string, unknown> };
    expect(summary.windowing).toMatchObject({ sizeMs: 3_600_000, allowedLatenessMs: 600_000 });
    expect(summary.faults.late).toBeDefined();
  });

  it('prints neither for a profile without windowing', () => {
    const result = run('chaos', 'plan', '--run', runDirectory, '--profile', profilePath('spec-example'), '--chaos-seed', '7', '--out', join(workspace, 'plan-plain'));
    expect(result.out).not.toMatch(/windowing|arrivals|\blate\b/);
    const summary = readJson(join(workspace, 'plan-plain', 'delivery-summary.json')).summary as Record<string, unknown>;
    expect('windowing' in summary).toBe(false);
  });

  it('rejects a late fault without windowing, with its path, exit code 2', () => {
    const profile = join(workspace, 'late-without-windows.json');
    writeFileSync(profile, JSON.stringify({ formatVersion: 1, name: 'x', faults: { late: { rate: 0.1 } } }));
    const result = run('chaos', 'plan', '--run', runDirectory, '--profile', profile, '--chaos-seed', '7', '--out', join(workspace, 'never'));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/faults\.late: needs a "windowing" section/);
  });
});

describe('dataforge explain for a windowed plan', () => {
  it('shows the late fault, the window, its close and the arrival', () => {
    const planDirectory = plan('late-data');
    const lines = readFileSync(join(planDirectory, 'delivery-plan.jsonl'), 'utf8').trim().split('\n');
    const late = lines.map((line) => JSON.parse(line) as { eventId: string; faults: { type: string }[] }).find((attempt) => attempt.faults.some((fault) => fault.type === 'late'));
    const result = run('explain', '--run', runDirectory, '--plan', planDirectory, '--event', late?.eventId ?? '');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/window\s+\[2026-01-0\dT\d\d:00Z, \d\d:00Z\), closes at 2026-01-0\dT\d\d:10Z \(1 h tumbling event-time windows, allowed lateness 10 min\)/);
    expect(result.out).toMatch(/late: held until after evt_\S+, which is past the window close/);
    expect(result.out).toMatch(/Window: arrives AFTER its window closed \(stream time \S+, .+ past the close\)\. A pipeline with this allowed lateness drops it\./);
  });
});

describe('dataforge deliver and validate with windows', () => {
  it('passes the correct target under windowed-delays and records the windows in target-run.json', () => {
    const directory = deliver('correct-delays', 'correct', plan('windowed-delays'));
    const targetRun = readJson(join(directory, 'target-run.json')) as { windowing: unknown; files: Record<string, { sha256: string }>; counters: Record<string, number> };
    expect(targetRun.windowing).toEqual({ sizeMs: 3_600_000, allowedLatenessMs: 600_000 });
    expect(targetRun.files['actual-windows.json']?.sha256).toBe(sha256(join(directory, 'actual-windows.json')));
    expect(targetRun.counters.windowEventsDropped).toBe(0);
    const result = validate(directory, '--plan', plan('windowed-delays'));
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Windows \(1 h tumbling event-time windows, allowed lateness 10 min\)/);
    expect(result.out).toMatch(/Result: PASS \(.*every window has its true values\)/);
  });

  it('fails the naive target under windowed-delays with explained short and long windows', () => {
    const directory = deliver('naive-delays', 'naive', plan('windowed-delays'));
    const result = validate(directory, '--plan', plan('windowed-delays'), '--limit', '50');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/window-undercount\s+[1-9]/);
    expect(result.out).toMatch(/window-overcount\s+[1-9]/);
    expect(result.out).toMatch(/explained\s+(\d+) of \1 window findings/);
    expect(result.out).toMatch(/cause: evt_\S+ (OrderCreated|PaymentCompleted) at \S+, .*delivered during the window starting/);
    expect(result.out).toMatch(/Result: FAIL \(\d+ findings, \d+ window findings\)/);
  });

  it('explains every short window of the correct target under late-data by an event that arrived after close', () => {
    const directory = deliver('correct-late', 'correct', plan('late-data'));
    const result = validate(directory, '--plan', plan('late-data'), '--limit', '50', '--report', join(workspace, 'correct-late.json'));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/Result: FAIL \(0 findings, [1-9]\d* window findings\)/);
    const report = readJson(join(workspace, 'correct-late.json')) as { windows: { findings: { category: string; causes: { arrival: string }[] }[] } };
    expect(report.windows.findings.every((finding) => finding.category === 'window-undercount' && finding.causes[0]?.arrival === 'after-close')).toBe(true);
    expect(result.out).toMatch(/arrived AFTER its window closed \(stream time \S+, [\d.]+ min past the close at \S+\): dropped by a pipeline with this lateness.*\[.*late.*\]/);
  });

  it('validates windows without --plan from target-run.json, with the same verdict and no causes', () => {
    const directory = join(workspace, 'correct-late');
    const result = validate(directory);
    expect(result.code).toBe(1);
    expect(result.out).not.toMatch(/cause:/);
    expect(result.out).toMatch(/window findings\)/);
  });

  it('is deterministic: same plan and target, same actual-windows.json and report', () => {
    const first = deliver('naive-late-1', 'naive', plan('late-data'));
    const second = deliver('naive-late-2', 'naive', plan('late-data'));
    expect(sha256(join(first, 'actual-windows.json'))).toBe(sha256(join(second, 'actual-windows.json')));
    validate(first, '--plan', plan('late-data'), '--report', join(workspace, 'r1.json'));
    validate(second, '--plan', plan('late-data'), '--report', join(workspace, 'r2.json'));
    expect(sha256(join(workspace, 'r1.json'))).toBe(sha256(join(workspace, 'r2.json')));
  });

  it('flags windows edited after delivery and reports the difference as unexplained', () => {
    const directory = deliver('edited', 'correct', plan('windowed-none'));
    expect(validate(directory, '--plan', plan('windowed-none')).code).toBe(0);
    const windowsPath = join(directory, 'actual-windows.json');
    const windows = readJson(windowsPath) as { windows: { revenueMinor: number }[] };
    (windows.windows[5] as { revenueMinor: number }).revenueMinor += 1;
    writeFileSync(windowsPath, JSON.stringify(windows, null, 2));
    const result = validate(directory, '--plan', plan('windowed-none'));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/EDITED since delivery/);
    expect(result.out).toMatch(/0 of 1 window findings are linked/);
    expect(result.out).toMatch(/cause: none found/);
  });

  it('refuses a windowed plan without windows, windows without a contract, and an invalid windows file, exit code 2', () => {
    const missing = join(workspace, 'missing-windows');
    cpSync(join(workspace, 'correct-delays'), missing, { recursive: true });
    rmSync(join(missing, 'actual-windows.json'));
    const noWindows = validate(missing, '--plan', plan('windowed-delays'));
    expect(noWindows.code).toBe(2);
    expect(noWindows.err).toMatch(/The plan defines event-time windows \(1 h tumbling event-time windows, allowed lateness 10 min\), but no windows were found/);

    const plain = deliver('plain', 'correct', plan('spec-example'));
    const noContract = validate(plain, '--plan', plan('spec-example'), '--windows', join(workspace, 'correct-delays', 'actual-windows.json'));
    expect(noContract.code).toBe(2);
    expect(noContract.err).toMatch(/no windowing contract to check them against[\s\S]*has no "windowing" section/);

    const invalid = join(workspace, 'invalid-windows.json');
    writeFileSync(invalid, JSON.stringify({ format: 'dataforge.actual-windows', formatVersion: 1, windows: [{ windowStartMs: 0, windowEndMs: 1, ordersCreated: 'x' }] }));
    const badFile = validate(join(workspace, 'correct-delays'), '--plan', plan('windowed-delays'), '--windows', invalid);
    expect(badFile.code).toBe(2);
    expect(badFile.err).toMatch(/windows\.0\.ordersCreated/);
    expect(badFile.err).toMatch(/windows\.0\.paymentsCompleted/);
  });

  it('removes a windows file left by an earlier delivery when the new plan has no windows', () => {
    const directory = deliver('reused', 'correct', plan('windowed-delays'));
    expect(existsSync(join(directory, 'actual-windows.json'))).toBe(true);
    deliver('reused', 'correct', plan('spec-example'), '--force');
    expect(existsSync(join(directory, 'actual-windows.json'))).toBe(false);
    expect(validate(directory, '--plan', plan('spec-example')).code).toBe(0);
  });

  it('leaves plans and deliveries without windowing exactly as before: no windows file, no windowing keys', () => {
    const directory = deliver('plain-naive', 'naive', plan('spec-example'));
    const targetRun = readJson(join(directory, 'target-run.json')) as { files: Record<string, unknown> };
    expect('windowing' in targetRun).toBe(false);
    expect(Object.keys(targetRun.files)).toEqual(['actual-state.json']);
    const report = join(workspace, 'plain-report.json');
    validate(directory, '--plan', plan('spec-example'), '--report', report);
    const parsed = readJson(report) as { target: Record<string, unknown> };
    expect('windows' in parsed).toBe(false);
    expect(Object.keys(parsed.target).sort()).toEqual(['editedAfterDelivery', 'name']);
  });
});

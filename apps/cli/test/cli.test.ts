import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCli } from '../src/cli';
import type { CliIo } from '../src/cli-io';

const SMALL_SCENARIO = join(__dirname, '..', '..', '..', 'scenarios', 'ecommerce-small.json');

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
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

let workspace: string;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-cli-'));
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function generateRun(name: string, seed = '42'): string {
  const directory = join(workspace, name);
  const result = run('generate', '--scenario', SMALL_SCENARIO, '--seed', seed, '--out', directory);
  expect(result).toMatchObject({ code: 0, err: '' });
  return directory;
}

describe('dataforge generate', () => {
  it('writes the four run files, with checksums in the manifest that match the bytes on disk', () => {
    const directory = generateRun('checksums');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      seed: string;
      engineVersion: string;
      files: Record<string, { sha256: string; bytes: number }>;
    };
    expect(manifest.seed).toBe('42');
    expect(Object.keys(manifest.files).sort()).toEqual(['events.jsonl', 'expected-state.json', 'scenario.resolved.json']);
    for (const [name, entry] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(directory, name));
      expect(sha256(join(directory, name))).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.bytes);
      expect(bytes.includes(13)).toBe(false);
    }
  });

  it('writes byte-identical files when run twice with the same scenario and seed', () => {
    const first = generateRun('repeat-a');
    const second = generateRun('repeat-b');
    for (const name of ['events.jsonl', 'expected-state.json', 'scenario.resolved.json', 'manifest.json']) {
      expect(sha256(join(second, name))).toBe(sha256(join(first, name)));
    }
  });

  it('refuses to write into a non-empty directory without --force, and overwrites with it', () => {
    const directory = generateRun('force');
    const refused = run('generate', '--scenario', SMALL_SCENARIO, '--seed', '7', '--out', directory);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/not empty/);
    const forced = run('generate', '--scenario', SMALL_SCENARIO, '--seed', '7', '--out', directory, '--force');
    expect(forced.code).toBe(0);
    expect(readFileSync(join(directory, 'manifest.json'), 'utf8')).toMatch(/"seed": "7"/);
  });

  it('explains an invalid scenario and exits with code 2', () => {
    const path = join(workspace, 'invalid-scenario.json');
    writeFileSync(path, JSON.stringify({ formatVersion: 1, name: 'bad', payments: { failureRate: 2 }, orders: { coutn: 5 } }));
    const result = run('generate', '--scenario', path, '--seed', '1', '--out', join(workspace, 'never'));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/payments\.failureRate/);
    expect(result.err).toMatch(/coutn/);
  });

  it('rejects an invalid seed, a missing file and malformed JSON with code 2', () => {
    const malformed = join(workspace, 'malformed.json');
    writeFileSync(malformed, '{ "formatVersion": 1,');
    expect(run('generate', '--scenario', SMALL_SCENARIO, '--seed', 'bad seed', '--out', join(workspace, 'x')).code).toBe(2);
    expect(run('generate', '--scenario', join(workspace, 'missing.json'), '--seed', '1', '--out', join(workspace, 'x')).err).toMatch(
      /Cannot read scenario file/,
    );
    expect(run('generate', '--scenario', malformed, '--seed', '1', '--out', join(workspace, 'x')).err).toMatch(/not valid JSON/);
    expect(run('generate', '--scenario', SMALL_SCENARIO).code).toBe(2);
  });
});

describe('dataforge verify', () => {
  it('passes for an untouched run', () => {
    const result = run('verify', '--run', generateRun('verify-ok'));
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Result: PASS/);
    expect(result.out).not.toMatch(/FAIL/);
  });

  it('detects an edited event that breaks a business rule', () => {
    const directory = generateRun('verify-tampered');
    const path = join(directory, 'events.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes('"type":"PaymentCompleted"'));
    lines[index] = lines[index]!.replace(/"amountMinor":\d+/, '"amountMinor":1');
    writeFileSync(path, lines.join('\n'));

    const result = run('verify', '--run', directory);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/checksum\s+events\.jsonl\s+FAIL/);
    expect(result.out).toMatch(/\[payment\.amount-matches-order\]/);
    expect(result.out).toMatch(/Result: FAIL/);
  });

  it('detects an expected-state file that no longer matches the events', () => {
    const directory = generateRun('verify-state');
    const path = join(directory, 'expected-state.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"revenueMinor": \d+/, '"revenueMinor": 0'));
    const result = run('verify', '--run', directory);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/state\s+replayed state vs expected-state\.json\s+FAIL/);
    expect(result.out).toMatch(/first difference at line/);
  });

  it('detects a scenario edited after generation via the reproduce step', () => {
    const directory = generateRun('verify-scenario');
    const path = join(directory, 'scenario.resolved.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"failureRate": 0.2', '"failureRate": 0.3'));
    const result = run('verify', '--run', directory);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/reproduce\s+regenerate from scenario \+ seed\s+FAIL/);
  });

  it('reports a missing run directory with code 2', () => {
    expect(run('verify', '--run', join(workspace, 'does-not-exist')).err).toMatch(/Run directory not found/);
  });
});

describe('dataforge timeline', () => {
  it('prints the lifecycle of one aggregate in order', () => {
    const result = run('timeline', '--run', generateRun('timeline'), '--aggregate', 'ord_000007');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Timeline of ord_000007/);
    const types = [...result.out.matchAll(/\b(OrderCreated|PaymentFailed|PaymentCompleted|OrderCancelled|ShipmentCreated|ShipmentDelivered)\b/g)].map(
      (match) => match[1],
    );
    expect(types[0]).toBe('OrderCreated');
  });

  it('exits with code 1 for an aggregate that has no events', () => {
    const result = run('timeline', '--run', generateRun('timeline-missing'), '--aggregate', 'ord_999999');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/No events found/);
  });
});

describe('command dispatch', () => {
  it('prints help with exit code 0 and rejects unknown commands and options with exit code 2', () => {
    expect(run('help')).toMatchObject({ code: 0 });
    expect(run('help').out).toMatch(/dataforge generate/);
    expect(run('explode').code).toBe(2);
    expect(run('verify', '--run', workspace, '--unknown').code).toBe(2);
  });
});

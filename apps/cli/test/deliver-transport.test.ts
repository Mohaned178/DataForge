import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli';
import type { CliIo } from '../src/cli-io';
import { parseSpeed } from '../src/commands/deliver';

const REPO_ROOT = join(__dirname, '..', '..', '..');

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
    throw new Error('expected the command to finish synchronously (it should fail before touching Kafka)');
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

let workspace: string;
let runDirectory: string;
let planDirectory: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dataforge-transport-'));
  runDirectory = join(workspace, 'run');
  planDirectory = join(workspace, 'plan');
  expect(run('generate', '--scenario', join(REPO_ROOT, 'scenarios', 'ecommerce-small.json'), '--seed', '42', '--out', runDirectory).code).toBe(0);
  expect(run('chaos', 'plan', '--run', runDirectory, '--profile', join(REPO_ROOT, 'chaos-profiles', 'spec-example.json'), '--chaos-seed', '7', '--out', planDirectory).code).toBe(0);
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const deliver = (out: string, ...extra: string[]) =>
  run('deliver', '--run', runDirectory, '--plan', planDirectory, '--target', 'naive', '--out', join(workspace, out), ...extra);

describe('deliver --transport', () => {
  it('memory is the default and the explicit choice gives the same files', () => {
    expect(deliver('implicit').code).toBe(0);
    expect(deliver('explicit', '--transport', 'memory').code).toBe(0);
    for (const file of ['actual-state.json', 'target-run.json']) {
      expect(readFileSync(join(workspace, 'explicit', file), 'utf8')).toBe(readFileSync(join(workspace, 'implicit', file), 'utf8'));
    }
  });

  it.each([
    [['--transport', 'carrier-pigeon'], /Unknown transport "carrier-pigeon". Transports: memory, kafka./],
    [['--speed', '10'], /--speed applies only to --transport kafka/],
    [['--transport', 'memory', '--brokers', 'localhost:9092', '--partitions', '3'], /--brokers, --partitions apply only to --transport kafka/],
    [['--transport', 'kafka', '--speed', 'fast'], /--speed must be "max" or a positive number/],
    [['--transport', 'kafka', '--speed', '0'], /--speed must be "max" or a positive number/],
    [['--transport', 'kafka', '--partitions', '0'], /--partitions must be a whole number from 1 to 64/],
    [['--transport', 'kafka', '--partitions', '65'], /--partitions must be a whole number from 1 to 64/],
    [['--transport', 'kafka', '--timeout', '1.5'], /--timeout must be a whole number from 1 to 3600/],
    [['--transport', 'kafka', '--brokers', 'localhost'], /Invalid Kafka broker list "localhost"/],
  ])('rejects %j with exit code 2 before touching Kafka', (extra, message) => {
    const result = deliver('rejected', ...extra);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
  });

  it('names KAFKA_BROKERS when the bad broker list came from the environment', () => {
    const previous = process.env.KAFKA_BROKERS;
    process.env.KAFKA_BROKERS = 'not a broker';
    try {
      const result = deliver('from-env', '--transport', 'kafka');
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/Invalid Kafka broker list "not a broker".*\(from KAFKA_BROKERS\)/);
    } finally {
      if (previous === undefined) {
        delete process.env.KAFKA_BROKERS;
      } else {
        process.env.KAFKA_BROKERS = previous;
      }
    }
  });

  it('parses --speed as max or simulated milliseconds per real millisecond', () => {
    expect(parseSpeed(undefined)).toBe('max');
    expect(parseSpeed('max')).toBe('max');
    expect(parseSpeed('3600')).toBe(3600);
    expect(parseSpeed('0.5')).toBe(0.5);
  });

  it('documents exit code 3 in the help', () => {
    expect(run('help').out).toMatch(/3 infrastructure unavailable \(Kafka, consumer\)/);
  });
});

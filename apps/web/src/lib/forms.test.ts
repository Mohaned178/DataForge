import { describe, expect, test } from 'vitest';
import { formatWaited } from './format';
import { formatJson, parseJsonText, positionOf } from './json-text';
import { buildExecutionRequest, buildRunRequest, type ExecutionForm } from './launch';
import { describeFailure, parseProblem } from './problems';

describe('the run request', () => {
  test('sends the seed as the text typed and leaves the version out for "latest"', () => {
    expect(buildRunRequest({ scenarioId: 'scn', version: '', seed: '42' })).toEqual({ ok: true, request: { scenarioId: 'scn', seed: '42' } });
  });

  test('never passes a seed through Number: a large whole number keeps every digit', () => {
    const result = buildRunRequest({ scenarioId: 'scn', version: '', seed: '9007199254740993' });
    expect(result).toEqual({ ok: true, request: { scenarioId: 'scn', seed: '9007199254740993' } });
  });

  test('a chosen version is a number', () => {
    expect(buildRunRequest({ scenarioId: 'scn', version: '2', seed: 'spring' })).toEqual({ ok: true, request: { scenarioId: 'scn', version: 2, seed: 'spring' } });
  });

  test('names every missing field with the API\'s own field names', () => {
    const result = buildRunRequest({ scenarioId: '', version: '', seed: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((problem) => parseProblem(problem).path)).toEqual(['scenarioId', 'seed']);
  });
});

const BASE: ExecutionForm = {
  runId: 'run-1',
  profileId: 'profile-1',
  profileVersion: '',
  chaosSeed: '7',
  target: 'correct',
  transport: 'memory',
  partitions: '',
  speed: '',
  timeoutSeconds: '',
  topic: '',
  groupId: '',
};

describe('the execution request', () => {
  test('a reference target in memory sends no Kafka option, even when the fields were filled in earlier', () => {
    expect(buildExecutionRequest(BASE)).toEqual({
      ok: true,
      request: { runId: 'run-1', chaosProfileId: 'profile-1', chaosSeed: '7', target: { type: 'reference', name: 'correct', transport: 'memory' } },
    });
    const stale = buildExecutionRequest({ ...BASE, target: 'naive', partitions: '3', speed: '5000', timeoutSeconds: '90' });
    expect(stale).toMatchObject({ ok: true, request: { target: { type: 'reference', name: 'naive', transport: 'memory' } } });
    if (stale.ok) expect(Object.keys(stale.request.target).sort()).toEqual(['name', 'transport', 'type']);
  });

  test('a chosen profile version is a number; "latest" sends none', () => {
    expect(buildExecutionRequest({ ...BASE, profileVersion: '3' })).toMatchObject({ ok: true, request: { chaosProfileVersion: 3 } });
    const latest = buildExecutionRequest(BASE);
    if (latest.ok) expect(latest.request).not.toHaveProperty('chaosProfileVersion');
  });

  test('a reference target through Kafka sends only the options that were filled in', () => {
    expect(buildExecutionRequest({ ...BASE, target: 'naive', transport: 'kafka' })).toMatchObject({
      ok: true,
      request: { target: { type: 'reference', name: 'naive', transport: 'kafka' } },
    });
    const bare = buildExecutionRequest({ ...BASE, target: 'naive', transport: 'kafka' });
    if (bare.ok) expect(Object.keys(bare.request.target).sort()).toEqual(['name', 'transport', 'type']);

    expect(buildExecutionRequest({ ...BASE, transport: 'kafka', partitions: '3', speed: '5000', timeoutSeconds: '120' })).toMatchObject({
      ok: true,
      request: { target: { type: 'reference', name: 'correct', transport: 'kafka', partitions: 3, speed: 5000, timeoutSeconds: 120 } },
    });
    expect(buildExecutionRequest({ ...BASE, transport: 'kafka', speed: 'max' })).toMatchObject({ ok: true, request: { target: { speed: 'max' } } });
  });

  test('an external pipeline sends its topic and group, and no partitions', () => {
    const result = buildExecutionRequest({ ...BASE, target: 'external', transport: 'kafka', topic: 'shop-orders', groupId: 'shop-pipeline', partitions: '4', speed: '5000' });
    expect(result).toEqual({
      ok: true,
      request: { runId: 'run-1', chaosProfileId: 'profile-1', chaosSeed: '7', target: { type: 'external', topic: 'shop-orders', groupId: 'shop-pipeline', speed: 5000 } },
    });
  });

  test('refuses what the API would refuse, naming the field the way the API does', () => {
    const problems = (form: Partial<ExecutionForm>) => {
      const result = buildExecutionRequest({ ...BASE, ...form });
      return result.ok ? [] : result.problems.map((problem) => parseProblem(problem).path);
    };
    expect(problems({ runId: '', profileId: '', chaosSeed: '' })).toEqual(['runId', 'chaosProfileId', 'chaosSeed']);
    expect(problems({ target: 'external', topic: '', groupId: '' })).toEqual(['target.topic', 'target.groupId']);
    expect(problems({ transport: 'kafka', partitions: '0' })).toEqual(['target.partitions']);
    expect(problems({ transport: 'kafka', speed: 'fast' })).toEqual(['target.speed']);
    expect(problems({ transport: 'kafka', speed: '-5' })).toEqual(['target.speed']);
    expect(problems({ transport: 'kafka', timeoutSeconds: '1.5' })).toEqual(['target.timeoutSeconds']);
  });
});

describe('JSON text', () => {
  test('parses an object', () => {
    expect(parseJsonText('{ "formatVersion": 1, "name": "x" }')).toEqual({ ok: true, value: { formatVersion: 1, name: 'x' } });
  });

  test('refuses empty text and anything that is not an object', () => {
    expect(parseJsonText('  \n ')).toMatchObject({ ok: false, message: 'The document is empty.' });
    expect(parseJsonText('[1, 2]')).toMatchObject({ ok: false, message: 'The document must be a JSON object ({ ... }).' });
    expect(parseJsonText('42')).toMatchObject({ ok: false });
    expect(parseJsonText('null')).toMatchObject({ ok: false });
  });

  test('says where a syntax error is, whichever way the engine words it', () => {
    // "... at position 8 (line 1 column 9)"
    expect(parseJsonText('{"a": 1,}')).toMatchObject({ ok: false, line: 1, column: 9 });
    // "Unexpected token '}', ... is not valid JSON": no position in the message, found by bisection
    expect(parseJsonText('{\n  "a": 1,\n  "b": }\n')).toMatchObject({ ok: false, line: 3, column: 8 });
    expect(parseJsonText('{"a": tru}')).toMatchObject({ ok: false, line: 1, column: 10 });
  });

  test('a document that is merely unfinished is reported at its end, not before', () => {
    const result = parseJsonText('{"a": 1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.line).toBe(1);
  });

  test('positionOf counts lines and columns from 1', () => {
    expect(positionOf('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
    expect(positionOf('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });

  test('formatJson indents like the repository files and ends with a newline', () => {
    expect(formatJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });
});

describe('waiting', () => {
  test('is told in whole seconds, and "less than a second" at the start', () => {
    expect(formatWaited(0)).toBe('less than a second');
    expect(formatWaited(999)).toBe('less than a second');
    expect(formatWaited(1000)).toBe('1 s');
    expect(formatWaited(9400)).toBe('9 s');
    expect(formatWaited(65_000)).toBe('1 min 5 s');
  });
});

describe('the API\'s problems', () => {
  test('splits "path: message" and leaves a message without a path whole', () => {
    expect(parseProblem('orders.count: Too small: expected number to be >=0')).toEqual({ path: 'orders.count', message: 'Too small: expected number to be >=0' });
    expect(parseProblem('faults.transientFailure.failures.max: cannot exceed maxRetries (2)')).toMatchObject({ path: 'faults.transientFailure.failures.max' });
    expect(parseProblem('Unrecognized key: "colour"')).toEqual({ message: 'Unrecognized key: "colour"' });
    expect(parseProblem('target.speed: must be "max" or a positive number')).toMatchObject({ path: 'target.speed' });
    expect(parseProblem('actualState.orders[2].id: Required')).toMatchObject({ path: 'actualState.orders[2].id' });
  });

  test('describes any thrown value', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom');
    expect(describeFailure('plain')).toBe('plain');
    expect(describeFailure({ a: 1 })).toBe('{"a":1}');
  });
});

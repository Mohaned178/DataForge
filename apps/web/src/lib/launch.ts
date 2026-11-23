import type { StartExecutionRequest, StartRunRequest, TargetRequest } from '../api/endpoints';

export type TargetChoice = 'correct' | 'naive' | 'external';
export type Transport = 'memory' | 'kafka';

/** What the run form holds: text as typed, never converted. */
export interface RunForm {
  readonly scenarioId: string;
  /** "" means the scenario's latest version. */
  readonly version: string;
  readonly seed: string;
}

/** What the execution form holds: text as typed, never converted. */
export interface ExecutionForm {
  readonly runId: string;
  readonly profileId: string;
  /** "" means the profile's latest version. */
  readonly profileVersion: string;
  readonly chaosSeed: string;
  readonly target: TargetChoice;
  readonly transport: Transport;
  readonly partitions: string;
  readonly speed: string;
  readonly timeoutSeconds: string;
  readonly topic: string;
  readonly groupId: string;
}

export type Built<T> = { readonly ok: true; readonly request: T } | { readonly ok: false; readonly problems: readonly string[] };

const WHOLE = /^\d+$/;

/**
 * The POST /runs body. The seed is the text typed: a large whole number must never pass through `Number`,
 * and the API normalizes 42 and "42" to one seed.
 */
export function buildRunRequest(form: RunForm): Built<StartRunRequest> {
  const problems: string[] = [];
  if (form.scenarioId === '') problems.push('scenarioId: choose a scenario');
  if (form.seed === '') problems.push('seed: enter a seed (any text or whole number: the same seed always gives the same world)');
  if (form.version !== '' && !(WHOLE.test(form.version) && Number(form.version) >= 1)) problems.push('version: choose a version');
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, request: { scenarioId: form.scenarioId, ...(form.version === '' ? {} : { version: Number(form.version) }), seed: form.seed } };
}

function wholeOption(name: string, text: string, min: number, problems: string[]): number | undefined {
  if (text === '') return undefined;
  if (!WHOLE.test(text) || Number(text) < min) {
    problems.push(`target.${name}: enter a whole number of at least ${min}, or leave it empty for the default`);
    return undefined;
  }
  return Number(text);
}

function speedOption(text: string, problems: string[]): 'max' | number | undefined {
  if (text === '') return undefined;
  if (text === 'max') return 'max';
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    problems.push('target.speed: enter "max" (no waiting) or a positive number of simulated milliseconds per real millisecond');
    return undefined;
  }
  return value;
}

/**
 * The POST /executions body. Options a target does not take are absent, not null or defaulted: the API rejects
 * misplaced keys, and the memory transport takes no partitions, speed or timeout at all.
 */
export function buildExecutionRequest(form: ExecutionForm): Built<StartExecutionRequest> {
  const problems: string[] = [];
  if (form.runId === '') problems.push('runId: choose a run');
  if (form.profileId === '') problems.push('chaosProfileId: choose a chaos profile');
  if (form.chaosSeed === '') problems.push('chaosSeed: enter a chaos seed (any text or whole number)');
  if (form.profileVersion !== '' && !(WHOLE.test(form.profileVersion) && Number(form.profileVersion) >= 1)) problems.push('chaosProfileVersion: choose a version');

  let target: TargetRequest | undefined;
  if (form.target === 'external') {
    if (form.topic === '') problems.push('target.topic: enter the topic your pipeline reads (it must exist)');
    if (form.groupId === '') problems.push('target.groupId: enter your pipeline\'s consumer group');
    const speed = speedOption(form.speed, problems);
    const timeoutSeconds = wholeOption('timeoutSeconds', form.timeoutSeconds, 1, problems);
    target = {
      type: 'external',
      topic: form.topic,
      groupId: form.groupId,
      ...(speed === undefined ? {} : { speed }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    };
  } else if (form.transport === 'memory') {
    target = { type: 'reference', name: form.target, transport: 'memory' };
  } else {
    const partitions = wholeOption('partitions', form.partitions, 1, problems);
    const speed = speedOption(form.speed, problems);
    const timeoutSeconds = wholeOption('timeoutSeconds', form.timeoutSeconds, 1, problems);
    target = {
      type: 'reference',
      name: form.target,
      transport: 'kafka',
      ...(partitions === undefined ? {} : { partitions }),
      ...(speed === undefined ? {} : { speed }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    };
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    request: {
      runId: form.runId,
      chaosProfileId: form.profileId,
      ...(form.profileVersion === '' ? {} : { chaosProfileVersion: Number(form.profileVersion) }),
      chaosSeed: form.chaosSeed,
      target,
    },
  };
}

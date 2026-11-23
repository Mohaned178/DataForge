import { buildRunFiles, parseScenario, simulate, type ScenarioInput } from '@dataforge/core';
import type { GeneratedRun, RunGenerator } from '../src/runs/run-generation';
import { RunRunner, type ClaimedRun, type RunStore } from '../src/runs/run-runner';

type Status = 'queued' | 'running' | 'succeeded' | 'failed';

const SCENARIO: ScenarioInput = { formatVersion: 1, name: 'runner', customers: { count: 3 }, orders: { count: 4 }, catalog: { productCount: 5 } };

/** The run table, in memory, recording every status change in order. */
class MemoryRunStore implements RunStore {
  readonly status = new Map<string, Status>();
  readonly errors = new Map<string, string>();
  readonly completed: string[] = [];
  readonly history: string[] = [];
  readonly engineVersions = new Map<string, string>();
  failNextComplete: Error | undefined;

  add(id: string, status: Status = 'queued', engineVersion = '0.1.0'): void {
    this.status.set(id, status);
    this.engineVersions.set(id, engineVersion);
  }

  async claim(runId: string): Promise<ClaimedRun | undefined> {
    await Promise.resolve();
    if (this.status.get(runId) !== 'queued') {
      return undefined;
    }
    this.set(runId, 'running');
    const definition = parseScenario(SCENARIO);
    return { id: runId, seed: runId, engineVersion: this.engineVersions.get(runId) ?? '', definition, scenarioHash: 'unused' };
  }

  async complete(runId: string): Promise<void> {
    await Promise.resolve();
    if (this.failNextComplete !== undefined) {
      const error = this.failNextComplete;
      this.failNextComplete = undefined;
      throw error;
    }
    this.completed.push(runId);
    this.set(runId, 'succeeded');
  }

  async fail(runId: string, error: string): Promise<void> {
    await Promise.resolve();
    this.errors.set(runId, error);
    this.set(runId, 'failed');
  }

  async requeueUnfinished(): Promise<string[]> {
    await Promise.resolve();
    for (const [id, status] of this.status) {
      if (status === 'running') {
        this.set(id, 'queued');
      }
    }
    return [...this.status].filter(([, status]) => status === 'queued').map(([id]) => id);
  }

  private set(id: string, status: Status): void {
    this.status.set(id, status);
    this.history.push(`${id}:${status}`);
  }
}

const generate: RunGenerator = ({ definition, seed }) => {
  const scenario = parseScenario(definition);
  const result = simulate({ scenario, seed });
  return { result, files: buildRunFiles(scenario, result) } satisfies GeneratedRun;
};

describe('RunRunner', () => {
  it('moves each run from queued to running to succeeded, one at a time, in the order given', async () => {
    const store = new MemoryRunStore();
    ['run-1', 'run-2', 'run-3'].forEach((id) => store.add(id));
    const runner = new RunRunner(store, { generate, engineVersion: '0.1.0' });
    ['run-1', 'run-2', 'run-3'].forEach((id) => runner.enqueue(id));
    await runner.whenIdle();
    expect(store.history).toEqual([
      'run-1:running',
      'run-1:succeeded',
      'run-2:running',
      'run-2:succeeded',
      'run-3:running',
      'run-3:succeeded',
    ]);
  });

  it('processes a run enqueued twice, or no longer queued, at most once', async () => {
    const store = new MemoryRunStore();
    store.add('run-1');
    store.add('done', 'succeeded');
    const runner = new RunRunner(store, { generate, engineVersion: '0.1.0' });
    runner.enqueue('run-1');
    runner.enqueue('run-1');
    runner.enqueue('done');
    await runner.whenIdle();
    runner.enqueue('run-1');
    await runner.whenIdle();
    expect(store.completed).toEqual(['run-1']);
  });

  it('marks a run failed with the generation error and carries on with the next one', async () => {
    const store = new MemoryRunStore();
    store.add('broken');
    store.add('fine');
    const failing: RunGenerator = (inputs) => {
      if (inputs.seed === 'broken') {
        throw new Error('the definition is not a scenario');
      }
      return generate(inputs);
    };
    const runner = new RunRunner(store, { generate: failing, engineVersion: '0.1.0' });
    runner.enqueue('broken');
    runner.enqueue('fine');
    await runner.whenIdle();
    expect(store.status.get('broken')).toBe('failed');
    expect(store.errors.get('broken')).toBe('Generation failed: the definition is not a scenario');
    expect(store.status.get('fine')).toBe('succeeded');
  });

  it('marks a run failed when it cannot be stored', async () => {
    const store = new MemoryRunStore();
    store.add('run-1');
    store.failNextComplete = new Error('connection lost');
    const runner = new RunRunner(store, { generate, engineVersion: '0.1.0' });
    runner.enqueue('run-1');
    await runner.whenIdle();
    expect(store.status.get('run-1')).toBe('failed');
    expect(store.errors.get('run-1')).toBe('Storing the run failed: connection lost');
  });

  it('refuses to generate a run requested for another engine version', async () => {
    const store = new MemoryRunStore();
    store.add('old', 'queued', '0.0.9');
    const runner = new RunRunner(store, { generate, engineVersion: '0.1.0' });
    runner.enqueue('old');
    await runner.whenIdle();
    expect(store.status.get('old')).toBe('failed');
    expect(store.errors.get('old')).toMatch(/requested for engine 0\.0\.9, but this API runs engine 0\.1\.0/);
  });

  it('resumes the runs a stopped process left queued or running, oldest first', async () => {
    const store = new MemoryRunStore();
    store.add('interrupted', 'running');
    store.add('waiting', 'queued');
    store.add('finished', 'succeeded');
    const runner = new RunRunner(store, { generate, engineVersion: '0.1.0' });
    expect(await runner.recover()).toBe(2);
    await runner.whenIdle();
    expect(store.completed).toEqual(['interrupted', 'waiting']);
  });

  it('finishes the run in progress on stop and leaves the others queued', async () => {
    const store = new MemoryRunStore();
    ['run-1', 'run-2', 'run-3'].forEach((id) => store.add(id));
    const runner = new RunRunner(store, { generate, engineVersion: '0.1.0' });
    ['run-1', 'run-2', 'run-3'].forEach((id) => runner.enqueue(id));
    await runner.stop();
    expect(store.status.get('run-1')).toBe('succeeded');
    expect([store.status.get('run-2'), store.status.get('run-3')]).toEqual(['queued', 'queued']);
    runner.enqueue('run-2');
    await runner.whenIdle();
    expect(store.status.get('run-2')).toBe('queued');
  });
});

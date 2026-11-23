import { PLANNER_VERSION, parseChaosProfile } from '@dataforge/chaos';
import { buildRunFiles, parseActualState, parseScenario, simulate, type ScenarioInput } from '@dataforge/core';
import { buildValidationReport, deliverInProcess, planExecution, reportPlanOf, reportSourceOf, validateExecution, type ValidationReport } from '@dataforge/execution';
import type { ExecutionTarget } from '../src/executions/execution-requests';
import {
  ExecutionRunner,
  type ClaimedExecution,
  type DeliveredResults,
  type ExecutionOutcome,
  type ExecutionStore,
  type ExecutionWork,
  type ValidatedResults,
} from '../src/executions/execution-runner';

type Status = 'queued' | 'running' | 'awaiting_actual_state' | 'completed' | 'failed';

const MEMORY: ExecutionTarget = { type: 'reference', name: 'naive', transport: 'memory' };
const EXTERNAL: ExecutionTarget = { type: 'external', topic: 'orders', groupId: 'pipeline', speed: 'max', timeoutSeconds: 60 };

/** The execution table, in memory, recording every status change in order. */
class MemoryExecutionStore implements ExecutionStore {
  readonly status = new Map<string, Status>();
  readonly targets = new Map<string, ExecutionTarget>();
  readonly plannerVersions = new Map<string, string>();
  readonly errors = new Map<string, string>();
  readonly verdicts = new Map<string, string>();
  readonly history: string[] = [];
  failNextStore: Error | undefined;

  add(id: string, target: ExecutionTarget, status: Status = 'queued', plannerVersion = PLANNER_VERSION): void {
    this.status.set(id, status);
    this.targets.set(id, target);
    this.plannerVersions.set(id, plannerVersion);
  }

  async claim(id: string): Promise<ClaimedExecution | undefined> {
    await Promise.resolve();
    if (this.status.get(id) !== 'queued') {
      return undefined;
    }
    this.set(id, 'running');
    return {
      id,
      runId: 'run',
      chaosSeed: '7',
      plannerVersion: this.plannerVersions.get(id) ?? '',
      target: this.targets.get(id) ?? MEMORY,
      profile: { definition: {}, profileHash: 'unused' },
    };
  }

  async complete(id: string, _delivered: DeliveredResults, validated: ValidatedResults): Promise<void> {
    await this.store(id);
    this.verdicts.set(id, validated.report.verdict);
    this.set(id, 'completed');
  }

  async awaitActualState(id: string): Promise<void> {
    await this.store(id);
    this.set(id, 'awaiting_actual_state');
  }

  async fail(id: string, error: string): Promise<void> {
    await Promise.resolve();
    this.errors.set(id, error);
    this.set(id, 'failed');
  }

  async recoverUnfinished(): Promise<{ queued: string[]; interrupted: string[] }> {
    await Promise.resolve();
    const interrupted: string[] = [];
    for (const [id, status] of this.status) {
      if (status === 'running' && this.targets.get(id)?.type === 'external') {
        interrupted.push(id);
        this.errors.set(id, 'interrupted');
        this.set(id, 'failed');
      } else if (status === 'running') {
        this.set(id, 'queued');
      }
    }
    return { queued: [...this.status].filter(([, status]) => status === 'queued').map(([id]) => id), interrupted };
  }

  private async store(id: string): Promise<void> {
    await Promise.resolve();
    if (this.failNextStore !== undefined) {
      const error = this.failNextStore;
      this.failNextStore = undefined;
      this.errors.set(id, error.message);
      throw error;
    }
  }

  private set(id: string, status: Status): void {
    this.status.set(id, status);
    this.history.push(`${id}:${status}`);
  }
}

const SCENARIO: ScenarioInput = { formatVersion: 1, name: 'runner', customers: { count: 3 }, orders: { count: 6 }, catalog: { productCount: 4 } };

/** A real (small) execution: the steps the API runs, on a world simulated here. */
function realOutcome(): { delivered: DeliveredResults; validated: ValidatedResults; report: ValidationReport } {
  const scenario = parseScenario(SCENARIO);
  const result = simulate({ scenario, seed: '42' });
  const manifest = buildRunFiles(scenario, result).manifest;
  const profile = parseChaosProfile({ formatVersion: 1, name: 'dups', faults: { duplicate: { rate: 1 } } });
  const planned = planExecution({ manifest, events: result.events, profile, chaosSeed: '7' });
  const state = deliverInProcess({ manifest, events: result.events, attempts: planned.plan.attempts, summaryFile: planned.summaryFile, windowing: undefined, targetName: 'naive' });
  const validation = validateExecution({ events: result.events, expected: result.expectedState, actual: parseActualState(JSON.parse(state.actualStateText)), attempts: planned.plan.attempts });
  const report = buildValidationReport({ source: reportSourceOf(manifest), target: { name: 'naive', editedAfterDelivery: false }, plan: reportPlanOf(planned.summaryFile), result: validation });
  return {
    delivered: { attempts: planned.plan.attempts, deliveryLog: undefined, files: [], workDirectory: undefined },
    validated: { files: [], report },
    report,
  };
}

const outcome = realOutcome();

/** Work that completes reference targets and leaves external ones waiting, recording what it was asked to do. */
function recordingWork(calls: string[]): ExecutionWork {
  return async (execution): Promise<ExecutionOutcome> => {
    await Promise.resolve();
    calls.push(execution.id);
    return execution.target.type === 'external'
      ? { status: 'awaiting_actual_state', delivered: outcome.delivered }
      : { status: 'completed', delivered: outcome.delivered, validated: outcome.validated };
  };
}

describe('ExecutionRunner', () => {
  it('moves an execution queued -> running -> completed with the verdict of its report', async () => {
    const store = new MemoryExecutionStore();
    store.add('a', MEMORY);
    const runner = new ExecutionRunner(store, recordingWork([]));
    runner.enqueue('a');
    await runner.whenIdle();
    expect(store.history).toEqual(['a:running', 'a:completed']);
    expect(outcome.report.verdict).toBe('FAIL');
    expect(store.verdicts.get('a')).toBe('FAIL');
  });

  it('leaves an external execution awaiting its actual state after the delivery', async () => {
    const store = new MemoryExecutionStore();
    store.add('ext', EXTERNAL);
    const runner = new ExecutionRunner(store, recordingWork([]));
    runner.enqueue('ext');
    await runner.whenIdle();
    expect(store.history).toEqual(['ext:running', 'ext:awaiting_actual_state']);
  });

  it('processes one execution at a time, in order, and each only once', async () => {
    const store = new MemoryExecutionStore();
    ['a', 'b', 'c'].forEach((id) => store.add(id, MEMORY));
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const work: ExecutionWork = async (execution, signal) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return recordingWork(calls)(execution, signal);
    };
    const runner = new ExecutionRunner(store, work);
    ['a', 'b', 'a', 'c', 'b'].forEach((id) => runner.enqueue(id));
    await runner.whenIdle();
    runner.enqueue('a');
    await runner.whenIdle();
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
  });

  it('ends failed with the error when the work throws (for example Kafka unreachable) or storing fails', async () => {
    const store = new MemoryExecutionStore();
    store.add('kafka-down', MEMORY);
    store.add('store-down', MEMORY);
    const runner = new ExecutionRunner(store, async (execution, signal) => {
      if (execution.id === 'kafka-down') {
        throw new Error('Kafka is not reachable at localhost:1: connection refused (ECONNREFUSED)');
      }
      return recordingWork([])(execution, signal);
    });
    store.failNextStore = new Error('database went away');
    runner.enqueue('kafka-down');
    runner.enqueue('store-down');
    await runner.whenIdle();
    expect(store.status.get('kafka-down')).toBe('failed');
    expect(store.errors.get('kafka-down')).toBe('Kafka is not reachable at localhost:1: connection refused (ECONNREFUSED)');
    expect(store.status.get('store-down')).toBe('failed');
    expect(store.errors.get('store-down')).toBe('Storing the execution failed: database went away');
  });

  it('refuses an execution requested for another planner version', async () => {
    const store = new MemoryExecutionStore();
    store.add('old', MEMORY, 'queued', '0.0.9');
    const calls: string[] = [];
    const runner = new ExecutionRunner(store, recordingWork(calls));
    runner.enqueue('old');
    await runner.whenIdle();
    expect(calls).toEqual([]);
    expect(store.status.get('old')).toBe('failed');
    expect(store.errors.get('old')).toMatch(/requested for planner 0\.0\.9, but this API runs planner/);
  });

  it('on start-up: processes queued executions, runs interrupted reference executions again, fails interrupted external ones, leaves waiting ones', async () => {
    const store = new MemoryExecutionStore();
    store.add('queued', MEMORY, 'queued');
    store.add('interrupted-reference', MEMORY, 'running');
    store.add('interrupted-external', EXTERNAL, 'running');
    store.add('waiting', EXTERNAL, 'awaiting_actual_state');
    store.add('done', MEMORY, 'completed');
    const calls: string[] = [];
    const runner = new ExecutionRunner(store, recordingWork(calls));
    await runner.onApplicationBootstrap();
    await runner.whenIdle();
    expect(calls).toEqual(['queued', 'interrupted-reference']);
    expect(store.status.get('interrupted-reference')).toBe('completed');
    expect(store.status.get('interrupted-external')).toBe('failed');
    expect(store.errors.get('interrupted-external')).toBe('interrupted');
    expect(store.status.get('waiting')).toBe('awaiting_actual_state');
    expect(store.status.get('done')).toBe('completed');
  });

  it('on stop: aborts the execution in progress and leaves it running for the next start, not failed', async () => {
    const store = new MemoryExecutionStore();
    store.add('slow', MEMORY);
    let started!: () => void;
    const startedWork = new Promise<void>((resolve) => (started = resolve));
    const runner = new ExecutionRunner(store, (_execution, signal) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error)));
    });
    runner.enqueue('slow');
    await startedWork;
    await runner.onModuleDestroy();
    expect(store.status.get('slow')).toBe('running');
    expect(store.errors.has('slow')).toBe(false);
    runner.enqueue('slow');
    await runner.whenIdle();
    expect(store.history).toEqual(['slow:running']);
  });
});

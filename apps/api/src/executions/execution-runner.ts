import { PLANNER_VERSION, type DeliveryAttempt } from '@dataforge/chaos';
import type { ValidationReport } from '@dataforge/execution';
import type { DeliveryLogEntry } from '@dataforge/kafka';
import { SerialQueue } from '../background/serial-queue';
import type { ExecutionTarget } from './execution-requests';

/** An execution the runner has moved from queued to running; nobody else will process it. */
export interface ClaimedExecution {
  readonly id: string;
  readonly runId: string;
  readonly chaosSeed: string;
  readonly plannerVersion: string;
  readonly target: ExecutionTarget;
  /** The chaos profile version: its resolved definition and the hash recorded with it. */
  readonly profile: { readonly definition: unknown; readonly profileHash: string };
}

/** A JSON file of an execution, by name, with its exact text. */
export interface ExecutionFileContent {
  readonly name: string;
  readonly text: string;
}

/** What the delivery leaves: the plan, the real Kafka outcome of each attempt, and the delivery's files. */
export interface DeliveredResults {
  readonly attempts: readonly DeliveryAttempt[];
  /** One entry per attempt for a Kafka execution; undefined in memory. */
  readonly deliveryLog: readonly DeliveryLogEntry[] | undefined;
  readonly files: readonly ExecutionFileContent[];
  readonly workDirectory: string | undefined;
}

/** What validation leaves: the target's state files and the report. */
export interface ValidatedResults {
  readonly files: readonly ExecutionFileContent[];
  readonly report: ValidationReport;
}

export type ExecutionOutcome =
  | { readonly status: 'completed'; readonly delivered: DeliveredResults; readonly validated: ValidatedResults }
  /** An external pipeline was delivered to; its state arrives later (POST /executions/:id/actual-state). */
  | { readonly status: 'awaiting_actual_state'; readonly delivered: DeliveredResults };

/** Plans, delivers and (for a reference target) validates one claimed execution. */
export type ExecutionWork = (execution: ClaimedExecution, signal: AbortSignal) => Promise<ExecutionOutcome>;

/** Where execution status and results live (the database, PrismaExecutionStore). */
export interface ExecutionStore {
  /** Moves a queued execution to running and returns it, or undefined when it is not queued (anymore). */
  claim(executionId: string): Promise<ClaimedExecution | undefined>;
  /** Stores everything and marks the execution completed with its verdict, atomically. */
  complete(executionId: string, delivered: DeliveredResults, validated: ValidatedResults): Promise<void>;
  /** Stores the plan and the delivery and marks the execution awaiting its actual state, atomically. */
  awaitActualState(executionId: string, delivered: DeliveredResults): Promise<void>;
  fail(executionId: string, error: string): Promise<void>;
  /**
   * Executions a stopped process left running: those of a reference target go back to the queue,
   * those of an external pipeline are failed (`interrupted`). Returns every queued execution, oldest first.
   */
  recoverUnfinished(): Promise<{ readonly queued: readonly string[]; readonly interrupted: readonly string[] }>;
}

export interface RunnerLog {
  log(message: string): void;
  error(message: string): void;
}

export interface ExecutionRunnerOptions {
  readonly plannerVersion?: string;
  readonly log?: RunnerLog;
}

const silent: RunnerLog = { log: () => undefined, error: () => undefined };

/**
 * Processes test executions in the background, one at a time, in the API process (ADR-0012), beside
 * the run runner. The status lives in the database. When the API stops, the execution in progress is
 * aborted and left running, so that the next start processes it again (reference target) or fails it
 * with the reason (external pipeline); it is never recorded as a failure of the target or of DataForge.
 */
export class ExecutionRunner {
  private readonly queue = new SerialQueue((executionId) => this.process(executionId));
  private readonly abort = new AbortController();
  private readonly plannerVersion: string;
  private readonly log: RunnerLog;

  constructor(
    private readonly store: ExecutionStore,
    private readonly work: ExecutionWork,
    options: ExecutionRunnerOptions = {},
  ) {
    this.plannerVersion = options.plannerVersion ?? PLANNER_VERSION;
    this.log = options.log ?? silent;
  }

  enqueue(executionId: string): void {
    this.queue.enqueue(executionId);
  }

  /** Requeues or fails what a stopped process left unfinished, and queues every queued execution. */
  async recover(): Promise<number> {
    const { queued, interrupted } = await this.store.recoverUnfinished();
    if (interrupted.length > 0) {
      this.log.error(`Failed ${interrupted.length} external execution(s) interrupted by a stop: ${interrupted.join(', ')}`);
    }
    if (queued.length > 0) {
      this.log.log(`Resuming ${queued.length} queued execution(s): ${queued.join(', ')}`);
    }
    queued.forEach((executionId) => this.enqueue(executionId));
    return queued.length;
  }

  whenIdle(): Promise<void> {
    return this.queue.whenIdle();
  }

  /** Takes no new work, aborts the execution in progress and waits for it to stop. */
  async stop(): Promise<void> {
    this.abort.abort(new Error('the API is stopping'));
    await this.queue.stop();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recover();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async process(executionId: string): Promise<void> {
    let claimed: ClaimedExecution | undefined;
    try {
      claimed = await this.store.claim(executionId);
    } catch (error) {
      this.log.error(`Execution ${executionId} could not be claimed and stays queued: ${messageOf(error)}`);
      return;
    }
    if (claimed === undefined) {
      return;
    }
    const startedAt = performance.now();
    let outcome: ExecutionOutcome;
    try {
      if (claimed.plannerVersion !== this.plannerVersion) {
        throw new Error(
          `the execution was requested for planner ${claimed.plannerVersion}, but this API runs planner ${this.plannerVersion}; ` +
            'an execution is only planned by the planner it names, so that its plan is reproducible',
        );
      }
      outcome = await this.work(claimed, this.abort.signal);
    } catch (error) {
      await this.markFailed(executionId, messageOf(error));
      return;
    }
    try {
      if (outcome.status === 'completed') {
        await this.store.complete(executionId, outcome.delivered, outcome.validated);
      } else {
        await this.store.awaitActualState(executionId, outcome.delivered);
      }
    } catch (error) {
      await this.markFailed(executionId, `Storing the execution failed: ${messageOf(error)}`);
      return;
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    this.log.log(
      outcome.status === 'completed'
        ? `Execution ${executionId} completed in ${elapsedMs} ms: ${outcome.validated.report.verdict}`
        : `Execution ${executionId} delivered in ${elapsedMs} ms; awaiting the external pipeline's actual state`,
    );
  }

  private async markFailed(executionId: string, message: string): Promise<void> {
    if (this.abort.signal.aborted) {
      this.log.log(`Execution ${executionId} was interrupted by the stop and stays running until the next start (${message})`);
      return;
    }
    this.log.error(`Execution ${executionId} failed: ${message}`);
    try {
      await this.store.fail(executionId, message);
    } catch (error) {
      this.log.error(`Execution ${executionId} could not be marked failed and stays running until the next start: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

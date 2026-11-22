import { fork, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { consumerToParentSchema } from '@dataforge/kafka';
import type { ReferenceTargetName } from '@dataforge/targets';

const READY_TIMEOUT_MS = 30_000;
const FINISH_TIMEOUT_MS = 30_000;

export class ConsumerProcessError extends Error {
  constructor(
    message: string,
    readonly logPath: string,
  ) {
    super(`${message} See ${logPath}.`);
    this.name = 'ConsumerProcessError';
  }
}

export interface ConsumerProcessOptions {
  readonly brokers: readonly string[];
  readonly topic: string;
  readonly groupId: string;
  readonly target: ReferenceTargetName;
  /** The parent has already applied the output-directory rule (empty, or --force), so the consumer may overwrite. */
  readonly outDirectory: string;
  /** Where the consumer's stdout and stderr (including its Kafka client log) go. */
  readonly logPath: string;
}

/** The built entry point of @dataforge/consumer; the consumer runs as compiled JavaScript in its own process. */
export function consumerEntryPoint(): string {
  const entry = join(dirname(require.resolve('@dataforge/consumer/package.json')), 'dist', 'main.js');
  if (!existsSync(entry)) {
    throw new ConsumerProcessError(`The consumer is not built (${entry} is missing): run "pnpm build" first.`, entry);
  }
  return entry;
}

/**
 * The reference consumer, running as a separate Node.js process. The two processes share nothing but
 * Kafka and a small IPC protocol: the consumer says when it has joined its group, the parent says
 * when to finish (after the group's lag reached zero), and the consumer says when its files are written.
 */
export class ConsumerProcess {
  private exitCode: number | null = null;
  private finished = false;
  private failure: string | undefined;
  private readonly exited: Promise<number | null>;

  private constructor(
    private readonly child: ChildProcess,
    readonly logPath: string,
    readonly partitions: readonly number[],
    readonly joinedAfterMs: number,
  ) {
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.on('exit', (code) => {
      this.exitCode = code ?? -1;
    });
    child.on('message', (raw: unknown) => {
      const message = consumerToParentSchema.safeParse(raw);
      if (message.success && message.data.type === 'finished') {
        this.finished = true;
      }
      if (message.success && message.data.type === 'failed') {
        this.failure = message.data.message;
      }
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get hasExited(): boolean {
    return this.exitCode !== null;
  }

  /** Why the process stopped early, for an error message. */
  describeExit(): string {
    return this.failure !== undefined
      ? `The consumer process failed: ${this.failure}`
      : `The consumer process exited unexpectedly with code ${this.exitCode ?? 'unknown'}.`;
  }

  /** Starts the consumer and resolves once it has joined its group. */
  static start(options: ConsumerProcessOptions): Promise<ConsumerProcess> {
    const entry = consumerEntryPoint();
    const logFd = openSync(options.logPath, 'w');
    const startedAt = Date.now();
    const child = fork(
      entry,
      ['--brokers', options.brokers.join(','), '--topic', options.topic, '--group', options.groupId, '--target', options.target, '--out', options.outDirectory, '--force'],
      { stdio: ['ignore', logFd, logFd, 'ipc'], execArgv: [], env: process.env },
    );
    closeSync(logFd);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new ConsumerProcessError(`The consumer process did not join its consumer group within ${READY_TIMEOUT_MS / 1000} s.`, options.logPath));
      }, READY_TIMEOUT_MS);
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        child.removeAllListeners('message');
        child.removeAllListeners('exit');
        outcome();
      };
      child.on('message', (raw: unknown) => {
        const message = consumerToParentSchema.safeParse(raw);
        if (!message.success) {
          return;
        }
        if (message.data.type === 'ready') {
          const { partitions } = message.data;
          settle(() => resolve(new ConsumerProcess(child, options.logPath, partitions, Date.now() - startedAt)));
        } else if (message.data.type === 'failed') {
          const { message: reason } = message.data;
          settle(() => reject(new ConsumerProcessError(`The consumer process failed to start: ${reason}`, options.logPath)));
        }
      });
      child.on('exit', (code) => {
        settle(() => reject(new ConsumerProcessError(`The consumer process exited with code ${code ?? 'unknown'} before joining its group.`, options.logPath)));
      });
    });
  }

  /** Asks the consumer to finish and waits until it has written its files and exited with code 0. */
  async finish(): Promise<void> {
    if (this.hasExited) {
      throw new ConsumerProcessError(this.describeExit(), this.logPath);
    }
    this.child.send({ type: 'finish' });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), FINISH_TIMEOUT_MS);
    });
    const code = await Promise.race([this.exited, timeout]);
    clearTimeout(timer);
    if (code === 'timeout') {
      this.child.kill();
      throw new ConsumerProcessError(`The consumer process did not finish within ${FINISH_TIMEOUT_MS / 1000} s.`, this.logPath);
    }
    if (code !== 0 || !this.finished) {
      throw new ConsumerProcessError(this.describeExit(), this.logPath);
    }
  }

  /** Stops the process if it is still running (after an error elsewhere). */
  kill(): void {
    if (!this.hasExited) {
      this.child.kill();
    }
  }
}

import type { DeliveryAttempt, DeliverySummary } from '@dataforge/chaos';
import type { FileEntry } from '@dataforge/core';
import type { ValidationReport } from '@dataforge/execution';
import type { DeliveryLogEntry } from '@dataforge/kafka';
import type { Finding, WindowFinding } from '@dataforge/validation';
import type { ExecutionStatusName, ExecutionTarget } from './execution-requests';

/** An execution as listed: its inputs, status and outcome. */
export interface ExecutionSummaryView {
  readonly id: string;
  readonly status: ExecutionStatusName;
  /** Set once the execution completed: whether the target's state was right. */
  readonly verdict: 'PASS' | 'FAIL' | null;
  /** Why the execution could not complete (status failed). */
  readonly error: string | null;
  readonly run: { readonly id: string; readonly seed: string; readonly scenario: { readonly id: string; readonly name: string; readonly version: number } };
  readonly chaosProfile: { readonly id: string; readonly name: string; readonly version: number; readonly profileHash: string };
  readonly chaosSeed: string;
  readonly plannerVersion: string;
  readonly target: ExecutionTarget;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly finishedAt: Date | null;
  readonly attemptCount: number | null;
  readonly findingCount: number | null;
  readonly windowFindingCount: number | null;
}

/** One execution with what its delivery did and the files it has. */
export interface ExecutionView extends ExecutionSummaryView {
  /** The plan's summary (delivery-summary.json): attempts, faults by type, ordering, losses, arrivals. */
  readonly delivery: DeliverySummary | null;
  /** What the reference target received and did (target-run.json). */
  readonly targetResult: {
    readonly delivery: { readonly messages: number; readonly distinctEvents: number; readonly redeliveries: number; readonly failedAttempts: number };
    readonly counters: Readonly<Record<string, number>>;
    readonly parkedEvents: number;
  } | null;
  /** What happened on Kafka (kafka-run.json). */
  readonly kafka: {
    readonly topic: string;
    readonly groupId: string;
    readonly partitions: number;
    readonly sent: number;
    readonly plannedFailures: number;
    readonly durationMs: number;
    readonly lagZeroAfterMs: number;
  } | null;
  /** Where the consumer output and Kafka client logs of a Kafka execution are. */
  readonly workDirectory: string | null;
  /** The files that can be downloaded now, with the checksum each was recorded with. */
  readonly files: Readonly<Record<string, FileEntry>>;
}

export interface ExecutionListView {
  readonly executions: readonly ExecutionSummaryView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** A planned attempt and, for Kafka, what really happened to it (its delivery-log.jsonl entry). */
export type AttemptView = DeliveryAttempt & {
  readonly kafka: Omit<DeliveryLogEntry, 'deliverySequence' | 'attemptId' | 'eventId' | 'aggregateId' | 'scheduledDeliveryTimeMs'> | null;
};

export interface AttemptsView {
  readonly executionId: string;
  readonly attempts: readonly AttemptView[];
  /** The fromSequence of the next page, or null when this page reached the end. */
  readonly nextSequence: number | null;
}

/** The report without its findings, which are paged (GET /executions/:id/findings, /window-findings). */
export type ReportView = Omit<ValidationReport, 'findings' | 'windows'> & {
  readonly windows?: Omit<NonNullable<ValidationReport['windows']>, 'findings'>;
};

export interface FindingsView {
  readonly executionId: string;
  readonly findings: readonly (Finding & { readonly ordinal: number })[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface WindowFindingsView {
  readonly executionId: string;
  readonly findings: readonly (WindowFinding & { readonly ordinal: number })[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

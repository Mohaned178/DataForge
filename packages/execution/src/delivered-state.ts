import { serializeActualState, serializeActualWindows, type CanonicalEvent, type RunManifest, type WindowingSpec } from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import { createReferenceTarget, deliverInMemory, type ReferenceTargetName } from '@dataforge/targets';
import type { ConsumedOutput } from './kafka-delivery';
import type { DeliverySummaryFile } from './plan-files';
import { buildTargetRun, type TargetRunFile } from './target-run';

/** What a delivery to a reference target leaves behind, whatever the transport. */
export interface DeliveredState {
  readonly target: { readonly name: string; readonly description: string };
  readonly targetRun: TargetRunFile;
  readonly actualStateText: string;
  /** Only for a plan with a windowing contract. */
  readonly actualWindowsText: string | undefined;
}

export interface InProcessDeliveryInput {
  readonly manifest: RunManifest;
  readonly events: readonly CanonicalEvent[];
  readonly attempts: readonly DeliveryAttempt[];
  readonly summaryFile: DeliverySummaryFile;
  readonly windowing: WindowingSpec | undefined;
  readonly targetName: ReferenceTargetName;
}

/** Plays a plan into a reference target in this process (the in-memory transport). */
export function deliverInProcess(input: InProcessDeliveryInput): DeliveredState {
  const target = createReferenceTarget(input.targetName, input.windowing === undefined ? {} : { windowing: input.windowing });
  const result = deliverInMemory({ events: input.events, attempts: input.attempts, target });
  const actualStateText = serializeActualState(result.actualState);
  const actualWindowsText = result.windows === undefined ? undefined : serializeActualWindows(result.windows);
  const targetRun = buildTargetRun({
    target,
    manifest: input.manifest,
    summaryFile: input.summaryFile,
    delivery: { messages: result.messages, distinctEvents: result.distinctEvents, redeliveries: result.redeliveries, failedAttempts: result.failedAttempts },
    counters: result.counters,
    parkedEventIds: result.parkedEventIds,
    actualStateText,
    ...(input.windowing === undefined || actualWindowsText === undefined ? {} : { windows: { windowing: input.windowing, actualWindowsText } }),
  });
  return { target: { name: target.name, description: target.description }, targetRun, actualStateText, actualWindowsText };
}

export interface ConsumedStateInput {
  readonly manifest: RunManifest;
  readonly summaryFile: DeliverySummaryFile;
  readonly windowing: WindowingSpec | undefined;
  /** What the reference consumer process wrote (deliverThroughKafka). */
  readonly consumed: ConsumedOutput;
  /** Planned failures are never sent, so the consumer cannot count them. */
  readonly plannedFailures: number;
}

/** The delivered state of a Kafka delivery to the reference consumer: the same target-run.json as in process. */
export function deliveredStateFromConsumer(input: ConsumedStateInput): DeliveredState {
  const { report, actualStateText, actualWindowsText } = input.consumed;
  const targetRun = buildTargetRun({
    target: report.target,
    manifest: input.manifest,
    summaryFile: input.summaryFile,
    delivery: { messages: report.messages, distinctEvents: report.distinctEvents, redeliveries: report.redeliveries, failedAttempts: input.plannedFailures },
    counters: report.counters,
    parkedEventIds: report.parkedEventIds,
    actualStateText,
    ...(input.windowing === undefined || actualWindowsText === undefined ? {} : { windows: { windowing: input.windowing, actualWindowsText } }),
  });
  return { target: { name: report.target.name, description: report.target.description }, targetRun, actualStateText, actualWindowsText };
}

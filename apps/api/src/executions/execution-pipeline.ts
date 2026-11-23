import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chaosProfileHash, parseChaosProfile } from '@dataforge/chaos';
import { parseActualState, parseActualWindows, parseUtcInstant, type WindowingSpec } from '@dataforge/core';
import {
  DELIVERY_FILES,
  KAFKA_DELIVERY_FILES,
  PLAN_FILES,
  buildValidationReport,
  deliverInProcess,
  deliverThroughKafka,
  deliveredStateFromConsumer,
  planExecution,
  reportPlanOf,
  reportSourceOf,
  serializeTargetRun,
  validateExecution,
  type DeliveredState,
  type PlannedExecution,
} from '@dataforge/execution';
import { KafkaUnavailableError } from '@dataforge/kafka';
import type { ApiConfig } from '../config';
import type { PrismaService } from '../database/prisma.service';
import { loadIntactRun, type IntactRun } from '../runs/stored-run';
import type { ClaimedExecution, DeliveredResults, ExecutionFileContent, ExecutionOutcome, ExecutionWork, ValidatedResults } from './execution-runner';

/**
 * The work of one execution, with the steps "dataforge chaos plan", "deliver" and "validate" run on
 * a stored run: the same functions, so the same inputs give the same files (ADR-0012).
 */
export function executionPipeline(prisma: PrismaService, config: ApiConfig): ExecutionWork {
  return async (execution: ClaimedExecution, signal: AbortSignal): Promise<ExecutionOutcome> => {
    const run = await loadIntactRun(prisma, execution.runId);
    const profile = parseChaosProfile(execution.profile.definition);
    if (chaosProfileHash(profile) !== execution.profile.profileHash) {
      throw new Error(`the stored chaos profile definition hashes to ${chaosProfileHash(profile)}, but its version records ${execution.profile.profileHash}`);
    }
    const planned = planExecution({ manifest: run.manifest, events: run.events, profile, chaosSeed: execution.chaosSeed });
    const { windowing } = profile;
    const { target } = execution;
    const summaryFile: ExecutionFileContent = { name: PLAN_FILES.summary, text: planned.contents[PLAN_FILES.summary] };

    if (target.type === 'reference' && target.transport === 'memory') {
      const delivered = deliverInProcess({
        manifest: run.manifest,
        events: run.events,
        attempts: planned.plan.attempts,
        summaryFile: planned.summaryFile,
        windowing,
        targetName: target.name,
      });
      return {
        status: 'completed',
        delivered: { attempts: planned.plan.attempts, deliveryLog: undefined, files: [summaryFile], workDirectory: undefined },
        validated: validateDelivered(run, planned, windowing, delivered),
      };
    }

    const workDirectory = join(config.executionWorkDirectory, execution.id);
    rmSync(workDirectory, { recursive: true, force: true });
    mkdirSync(workDirectory, { recursive: true });
    const kafka = await withKafkaHint(deliverThroughKafka({
      events: run.events,
      attempts: planned.plan.attempts,
      epochUnixMs: parseUtcInstant(run.manifest.simulation.epoch),
      windowing,
      brokers: config.kafkaBrokers,
      speed: target.speed,
      timeoutMs: target.timeoutSeconds * 1000,
      consumer:
        target.type === 'reference'
          ? { type: 'reference', target: target.name, partitions: target.partitions }
          : { type: 'external', topic: target.topic, groupId: target.groupId },
      workDirectory,
      signal,
    }));
    const delivered: DeliveredResults = {
      attempts: planned.plan.attempts,
      deliveryLog: kafka.execution.log,
      files: [summaryFile, { name: KAFKA_DELIVERY_FILES.kafkaRun, text: kafka.kafkaRunText }],
      workDirectory,
    };
    if (kafka.consumed === undefined) {
      return { status: 'awaiting_actual_state', delivered };
    }
    const state = deliveredStateFromConsumer({
      manifest: run.manifest,
      summaryFile: planned.summaryFile,
      windowing,
      consumed: kafka.consumed,
      plannedFailures: kafka.execution.plannedFailures,
    });
    return { status: 'completed', delivered, validated: validateDelivered(run, planned, windowing, state) };
  };
}

const START_KAFKA = 'Start it with "docker compose up -d --wait" (see compose.yaml), or point KAFKA_BROKERS at a running broker, and restart the API.';

/** An unreachable broker says what to start, as the CLI does. */
async function withKafkaHint<T>(delivery: Promise<T>): Promise<T> {
  try {
    return await delivery;
  } catch (error) {
    if (error instanceof KafkaUnavailableError) {
      throw new Error(`${error.message}. ${START_KAFKA}`, { cause: error });
    }
    throw error;
  }
}

/** Validates what a reference target ended in, as "dataforge validate --plan --report" does on unedited delivery files. */
function validateDelivered(run: IntactRun, planned: PlannedExecution, windowing: WindowingSpec | undefined, delivered: DeliveredState): ValidatedResults {
  const actual = parseActualState(JSON.parse(delivered.actualStateText));
  const actualWindows =
    windowing === undefined || delivered.actualWindowsText === undefined ? undefined : parseActualWindows(JSON.parse(delivered.actualWindowsText));
  const result = validateExecution({
    events: run.events,
    expected: run.expected,
    actual,
    ...(windowing === undefined || actualWindows === undefined ? {} : { windows: { windowing, actual: actualWindows } }),
    attempts: planned.plan.attempts,
  });
  const report = buildValidationReport({
    source: reportSourceOf(run.manifest),
    target: {
      name: delivered.target.name,
      editedAfterDelivery: false,
      ...(actualWindows === undefined ? {} : { windowsEditedAfterDelivery: false }),
    },
    plan: reportPlanOf(planned.summaryFile),
    result,
  });
  const files: ExecutionFileContent[] = [
    { name: DELIVERY_FILES.actualState, text: delivered.actualStateText },
    ...(delivered.actualWindowsText === undefined ? [] : [{ name: DELIVERY_FILES.actualWindows, text: delivered.actualWindowsText }]),
    { name: DELIVERY_FILES.targetRun, text: serializeTargetRun(delivered.targetRun) },
  ];
  return { files, report };
}

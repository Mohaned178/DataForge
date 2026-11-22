import { join, normalize } from 'node:path';
import { canonicalJson, type CanonicalEvent } from '@dataforge/core';
import type { DeliveryAttempt } from '@dataforge/chaos';
import type { Speed } from '@dataforge/kafka';
import type { ReferenceTargetName } from '@dataforge/targets';
import { formatCount, padRight, type CliIo } from './cli-io';
import { DELIVERY_FILES, type TargetRunFile } from './delivery-directory';
import type { DeliverySummaryFile } from './plan-directory';
import { writeRunFile, type RunManifest } from './run-directory';

const COUNTER_LABELS: Record<string, string> = {
  duplicatesIgnored: 'redeliveries ignored (eventId already received)',
  eventsParked: 'events parked until their predecessor or referenced entities arrived',
  updatesLost: 'updates lost (the row did not exist yet when the message arrived)',
};

/** What a delivery reads, whatever the transport: a run, its plan, and where the target's state goes. */
export interface DeliveryInputs {
  readonly targetName: ReferenceTargetName;
  readonly runDirectory: string;
  readonly planDirectory: string;
  readonly outDirectory: string;
  readonly manifest: RunManifest;
  readonly events: readonly CanonicalEvent[];
  readonly summaryFile: DeliverySummaryFile;
  readonly attempts: readonly DeliveryAttempt[];
  /** The paths as the user typed them, for the suggested next command. */
  readonly typed: { readonly run: string; readonly plan: string; readonly out: string };
}

export interface KafkaOptions {
  readonly brokers: readonly string[];
  readonly speed: Speed;
  readonly partitions: number;
  readonly timeoutMs: number;
}

export function writeTargetRun(outDirectory: string, targetRun: TargetRunFile): void {
  writeRunFile(outDirectory, DELIVERY_FILES.targetRun, `${canonicalJson(targetRun, 2)}\n`);
}

export function printDeliveryHeader(io: CliIo, inputs: DeliveryInputs, title: string): void {
  io.out(title);
  io.out(`  run         ${inputs.runDirectory}`);
  io.out(`              seed ${inputs.manifest.seed}, ${formatCount(inputs.events.length)} events`);
  io.out(`  plan        ${inputs.planDirectory}`);
  io.out(
    `              profile ${inputs.summaryFile.profile.name}, chaos seed ${inputs.summaryFile.chaosSeed}, ${formatCount(inputs.attempts.length)} attempts`,
  );
}

/** What the target received and did, the files written, and the next command; `moreFiles` are listed after the two shared ones. */
export function printDeliveryOutcome(io: CliIo, inputs: DeliveryInputs, targetRun: TargetRunFile, moreFiles: readonly string[]): void {
  const { delivery } = targetRun;
  io.out(
    `  delivered   ${formatCount(delivery.messages)} messages: ${formatCount(delivery.distinctEvents)} distinct events, ` +
      `${formatCount(delivery.redeliveries)} redeliveries; ${formatCount(delivery.failedAttempts)} failed attempts never reached the target`,
  );
  Object.entries(targetRun.counters).forEach(([name, value], position) => {
    io.out(`  ${position === 0 ? 'target   ' : '         '}   ${formatCount(value).padStart(5)} ${COUNTER_LABELS[name] ?? name}`);
  });
  io.out(
    targetRun.parkedEventIds.length === 0
      ? '  parked      none: every received event was applied'
      : `  parked      ${formatCount(targetRun.parkedEventIds.length)} events never applied (what they wait for never arrived): ` +
          `${targetRun.parkedEventIds.slice(0, 5).join(', ')}${targetRun.parkedEventIds.length > 5 ? ', ...' : ''}`,
  );
  io.out(`  output      ${inputs.outDirectory}`);
  io.out(`                ${padRight(DELIVERY_FILES.actualState, 28)} sha256 ${targetRun.files[DELIVERY_FILES.actualState].sha256}`);
  io.out(`                ${DELIVERY_FILES.targetRun}`);
  for (const file of moreFiles) {
    io.out(`                ${file}`);
  }
  io.out(
    `  next        pnpm dataforge validate --run ${normalize(inputs.typed.run)} --actual ${join(inputs.typed.out, DELIVERY_FILES.actualState)} --plan ${normalize(inputs.typed.plan)}`,
  );
}

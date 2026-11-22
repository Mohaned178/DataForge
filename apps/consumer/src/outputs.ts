import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, serializeActualState, sha256Hex } from '@dataforge/core';
import { CONSUMER_FILES, serializeProcessingLog, type ConsumerOutcome, type ConsumerReport } from '@dataforge/kafka';
import type { Target } from '@dataforge/targets';
import { ConsumerUsageError, type ConsumerOptions } from './options';

const fileEntry = (content: string) => ({ sha256: sha256Hex(content), bytes: Buffer.byteLength(content, 'utf8') });

/** The output directory may exist (the delivering process writes its own files there), but not hold a consumer's files. */
export function prepareConsumerOutput(options: ConsumerOptions): void {
  mkdirSync(options.out, { recursive: true });
  const existing = Object.values(CONSUMER_FILES).filter((name) => existsSync(join(options.out, name)));
  if (existing.length > 0 && !options.force) {
    throw new ConsumerUsageError(`${options.out} already holds ${existing.join(', ')}. Use --force to overwrite.`);
  }
}

/** Writes actual-state.json (the Milestone 3 actual-state format), processing-log.jsonl and consumer-report.json. */
export function writeConsumerOutput(options: ConsumerOptions, target: Target, outcome: ConsumerOutcome): ConsumerReport {
  const actualStateText = serializeActualState(outcome.result.actualState);
  const processingLogText = serializeProcessingLog(outcome.processingLog);
  const report: ConsumerReport = {
    format: 'dataforge.consumer-report',
    formatVersion: 1,
    target: { name: target.name, description: target.description },
    kafka: { topic: options.topic, groupId: options.groupId, partitions: [...outcome.partitions] },
    startedAt: new Date(outcome.startedAtUnixMs).toISOString(),
    finishedAt: new Date(outcome.finishedAtUnixMs).toISOString(),
    messages: outcome.messages,
    distinctEvents: outcome.distinctEvents,
    redeliveries: outcome.redeliveries,
    kafkaRedeliveries: outcome.kafkaRedeliveries,
    counters: { ...outcome.result.counters },
    parkedEventIds: [...outcome.result.parkedEventIds],
    files: {
      [CONSUMER_FILES.actualState]: fileEntry(actualStateText),
      [CONSUMER_FILES.processingLog]: fileEntry(processingLogText),
    },
  };
  writeFileSync(join(options.out, CONSUMER_FILES.actualState), actualStateText, { encoding: 'utf8' });
  writeFileSync(join(options.out, CONSUMER_FILES.processingLog), processingLogText, { encoding: 'utf8' });
  writeFileSync(join(options.out, CONSUMER_FILES.report), `${canonicalJson(report, 2)}\n`, { encoding: 'utf8' });
  return report;
}

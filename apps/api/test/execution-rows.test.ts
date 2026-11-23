import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChaosProfile, serializeDeliveryPlan } from '@dataforge/chaos';
import { buildRunFiles, parseActualState, parseActualWindows, parseScenario, simulate } from '@dataforge/core';
import {
  buildValidationReport,
  deliverInProcess,
  planExecution,
  reportPlanOf,
  reportSourceOf,
  serializeValidationReport,
  validateExecution,
} from '@dataforge/execution';
import { serializeDeliveryLog, type DeliveryLogEntry } from '@dataforge/kafka';
import { chunkColumns, deliveryLogEntryOf, fromAttemptRow, toAttemptColumns, type AttemptColumns, type StoredAttemptRow } from '../src/executions/attempt-rows';
import { ExecutionIntegrityError } from '../src/executions/execution-integrity';
import { fromReportRows, toReportRows } from '../src/executions/report-rows';

const REPOSITORY = join(__dirname, '..', '..', '..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(REPOSITORY, path), 'utf8'));
/** What a JSONB column gives back. */
const viaJsonb = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A windowed naive execution of the small scenario: duplicates, delays, window findings. */
function naiveWindowedExecution() {
  const scenario = parseScenario(readJson('scenarios/ecommerce-small.json'));
  const result = simulate({ scenario, seed: '42' });
  const manifest = buildRunFiles(scenario, result).manifest;
  const profile = parseChaosProfile(readJson('chaos-profiles/windowed-delays.json'));
  const planned = planExecution({ manifest, events: result.events, profile, chaosSeed: '7' });
  const state = deliverInProcess({
    manifest,
    events: result.events,
    attempts: planned.plan.attempts,
    summaryFile: planned.summaryFile,
    windowing: profile.windowing,
    targetName: 'naive',
  });
  const windowing = profile.windowing!;
  const validation = validateExecution({
    events: result.events,
    expected: result.expectedState,
    actual: parseActualState(JSON.parse(state.actualStateText)),
    windows: { windowing, actual: parseActualWindows(JSON.parse(state.actualWindowsText ?? '')) },
    attempts: planned.plan.attempts,
  });
  const report = buildValidationReport({
    source: reportSourceOf(manifest),
    target: { name: 'naive', editedAfterDelivery: false, windowsEditedAfterDelivery: false },
    plan: reportPlanOf(planned.summaryFile),
    result: validation,
  });
  return { planned, report };
}

/** Column arrays to rows, as PostgreSQL stores them (BIGINT as bigint, JSON text as JSONB values). */
function rowsOf(columns: AttemptColumns): StoredAttemptRow[] {
  return columns.deliverySequences.map((deliverySequence, index) => ({
    deliverySequence,
    attemptId: columns.attemptIds[index]!,
    attemptNumber: columns.attemptNumbers[index]!,
    kind: columns.kinds[index]!,
    plannedOutcome: columns.plannedOutcomes[index]!,
    scheduledDeliveryTimeMs: BigInt(columns.scheduledDeliveryTimesMs[index]!),
    eventId: columns.eventIds[index]!,
    eventSequence: columns.eventSequences[index]!,
    eventType: columns.eventTypes[index]!,
    eventTimeMs: BigInt(columns.eventTimesMs[index]!),
    aggregateId: columns.aggregateIds[index]!,
    aggregateVersion: columns.aggregateVersions[index]!,
    derivedFrom: columns.derivedFroms[index] === null ? null : (JSON.parse(columns.derivedFroms[index]!) as unknown),
    faults: JSON.parse(columns.faults[index]!) as unknown,
    kafkaOutcome: columns.kafkaOutcomes[index]!,
    kafkaPartition: columns.kafkaPartitions[index]!,
    kafkaOffset: columns.kafkaOffsets[index]!,
    dueAtMs: columns.dueAtMs[index]!,
    startedAtMs: columns.startedAtMs[index]!,
    ackedAtMs: columns.ackedAtMs[index]!,
    driftMs: columns.driftMs[index]!,
  }));
}

const { planned, report } = naiveWindowedExecution();
const { attempts } = planned.plan;

describe('delivery attempt rows', () => {
  it('rebuild the plan byte for byte, in memory (no Kafka columns)', () => {
    const rows = rowsOf(toAttemptColumns(attempts, undefined));
    const rebuilt = rows.map((row) => fromAttemptRow(row, 'exec'));
    expect(serializeDeliveryPlan(rebuilt)).toBe(planned.contents['delivery-plan.jsonl']);
    expect(rows.every((row) => deliveryLogEntryOf(row) === undefined)).toBe(true);
    expect(rows.some((row) => row.derivedFrom !== null)).toBe(true);
  });

  it('keep the Kafka delivery log of every attempt and give it back byte for byte', () => {
    const log: DeliveryLogEntry[] = attempts.map((attempt, index) => ({
      deliverySequence: attempt.deliverySequence,
      attemptId: attempt.attemptId,
      eventId: attempt.eventId,
      aggregateId: attempt.aggregateId,
      scheduledDeliveryTimeMs: attempt.scheduledDeliveryTimeMs,
      outcome: attempt.plannedOutcome === 'failed' ? 'planned-failure' : 'sent',
      dueAtMs: index * 2,
      startedAtMs: index * 2 + 1,
      ackedAtMs: attempt.plannedOutcome === 'failed' ? null : index * 2 + 2,
      driftMs: 1,
      partition: attempt.plannedOutcome === 'failed' ? null : 0,
      offset: attempt.plannedOutcome === 'failed' ? null : String(index),
    }));
    const rows = rowsOf(toAttemptColumns(attempts, log));
    expect(serializeDeliveryLog(rows.map((row) => deliveryLogEntryOf(row)!))).toBe(serializeDeliveryLog(log));
    expect(serializeDeliveryPlan(rows.map((row) => fromAttemptRow(row, 'exec')))).toBe(planned.contents['delivery-plan.jsonl']);
  });

  it('refuse a delivery log that does not belong to the plan', () => {
    expect(() => toAttemptColumns(attempts, [])).toThrow(/0 entries for \d+ planned attempts/);
  });

  it('report a row that is no longer a delivery attempt as an integrity error, with its path', () => {
    const [row] = rowsOf(toAttemptColumns(attempts.slice(0, 1), undefined));
    expect(() => fromAttemptRow({ ...row!, kind: 'copy' }, 'exec')).toThrow(ExecutionIntegrityError);
    expect(() => fromAttemptRow({ ...row!, kind: 'copy' }, 'exec')).toThrow(/Stored attempt 1 of execution exec is not a valid delivery attempt: kind:/);
  });

  it('are chunked into statements of bounded size', () => {
    const columns = toAttemptColumns(attempts, undefined);
    const chunks = chunkColumns(columns, 100);
    expect(chunks.map((chunk) => chunk.attemptIds.length).reduce((a, b) => a + b, 0)).toBe(attempts.length);
    expect(chunks.every((chunk) => chunk.attemptIds.length <= 100 && chunk.faults.length === chunk.attemptIds.length)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.deliverySequences)).toEqual(columns.deliverySequences);
  });
});

describe('validation report rows', () => {
  it('store the findings as rows and rebuild validation-report.json byte for byte', () => {
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.windows?.findings.length).toBeGreaterThan(0);
    const rows = toReportRows(report);
    expect(rows.document.findings).toEqual([]);
    expect(rows.document.windows?.findings).toEqual([]);
    expect(rows.findings.map((row) => row.ordinal)).toEqual(report.findings.map((_, index) => index));
    const stored = viaJsonb(rows);
    const shuffled = [...stored.findings].reverse();
    const windowRows = stored.windowFindings.map((row) => ({ ...row, windowStartMs: BigInt(row.windowStartMs), windowEndMs: BigInt(row.windowEndMs) }));
    expect(serializeValidationReport(fromReportRows(stored.document, shuffled, windowRows))).toBe(serializeValidationReport(report));
  });

  it('give a different file when a finding row was changed', () => {
    const rows = viaJsonb(toReportRows(report));
    const [first, ...rest] = rows.findings;
    const edited = [{ ...first!, message: 'edited' }, ...rest];
    expect(serializeValidationReport(fromReportRows(rows.document, edited, rows.windowFindings))).not.toBe(serializeValidationReport(report));
  });
});

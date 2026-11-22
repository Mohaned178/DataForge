import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, simTimeToIso, type WindowingSpec } from '@dataforge/core';
import { WINDOW_FINDING_CATEGORIES, type WindowCause, type WindowFinding, type WindowValidationResult } from '@dataforge/validation';
import { formatCount, padRight, type CliIo } from './cli-io';

/** "2026-01-01T10:00Z": an instant, with seconds and milliseconds left out when they are zero. */
export function shortIso(epochUnixMs: number, simTimeMs: number): string {
  return simTimeToIso(epochUnixMs, simTimeMs).replace(/:00\.000Z$/, 'Z').replace(/\.000Z$/, 'Z');
}

/** "1 h", "10 min", "90 s" when exact; otherwise rounded, for example "19.6 min" or "4.2 s". */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [
    ['d', DAY_MS],
    ['h', HOUR_MS],
    ['min', MINUTE_MS],
    ['s', SECOND_MS],
  ] as const) {
    if (ms !== 0 && ms % size === 0) {
      return `${formatCount(ms / size)} ${unit}`;
    }
  }
  const magnitude = Math.abs(ms);
  if (magnitude >= HOUR_MS) {
    return `${(ms / HOUR_MS).toFixed(1)} h`;
  }
  if (magnitude >= MINUTE_MS) {
    return `${(ms / MINUTE_MS).toFixed(1)} min`;
  }
  if (magnitude >= SECOND_MS) {
    return `${(ms / SECOND_MS).toFixed(1)} s`;
  }
  return `${formatCount(ms)} ms`;
}

export function describeWindowing(windowing: WindowingSpec): string {
  return `${formatDuration(windowing.sizeMs)} tumbling event-time windows, allowed lateness ${windowing.allowedLatenessMs === 0 ? 'none' : formatDuration(windowing.allowedLatenessMs)}`;
}

/** "[2026-01-01T10:00Z, 11:00Z)": the end is shortened to the time of day when it falls on the same day. */
export function windowLabel(epochUnixMs: number, startMs: number, endMs: number): string {
  const start = shortIso(epochUnixMs, startMs);
  const end = shortIso(epochUnixMs, endMs);
  return `[${start}, ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end})`;
}

/** One line on why a counted event can explain a wrong window. */
export function describeWindowCause(cause: WindowCause, epochUnixMs: number, findingWindowStartMs: number): string {
  const parts: string[] = [];
  switch (cause.arrival) {
    case 'lost':
      parts.push('LOST, never arrived');
      break;
    case 'after-close':
      parts.push(
        `arrived AFTER its window closed (stream time ${shortIso(epochUnixMs, cause.streamTimeMs ?? 0)}, ` +
          `${formatDuration((cause.streamTimeMs ?? 0) - cause.windowCloseMs)} past the close at ${shortIso(epochUnixMs, cause.windowCloseMs)}): dropped by a pipeline with this lateness`,
      );
      break;
    case 'within-lateness':
      parts.push(`arrived after its window ended, within the allowed lateness (stream time ${shortIso(epochUnixMs, cause.streamTimeMs ?? 0)}): still to be counted`);
      break;
    case 'on-time':
      break;
  }
  if (cause.windowStartMs !== findingWindowStartMs) {
    parts.push(`belongs to the window starting ${shortIso(epochUnixMs, cause.windowStartMs)}`);
  }
  const elsewhere = [...new Set(cause.arrivalWindowStartsMs)].filter((start) => start !== cause.windowStartMs);
  if (elsewhere.length > 0) {
    parts.push(`delivered during ${elsewhere.map((start) => `the window starting ${shortIso(epochUnixMs, start)}`).join(' and ')}`);
  }
  if (cause.deliveries > 1) {
    parts.push(`delivered ${cause.deliveries} times`);
  }
  return `${parts.length === 0 ? 'delivered once, on time' : parts.join(', ')} [${cause.faults.join(', ')}]`;
}

const CAUSES_PER_FINDING = 2;

export function printWindowSection(
  io: CliIo,
  input: { readonly result: WindowValidationResult; readonly epochUnixMs: number; readonly windowsPath: string; readonly edited: boolean; readonly limit: number; readonly hasReport: boolean },
): void {
  const { result, epochUnixMs } = input;
  io.out('');
  io.out(`Windows (${describeWindowing(result.windowing)})`);
  io.out(`  actual      ${input.windowsPath}${input.edited ? '  EDITED since delivery (checksum differs from target-run.json)' : ''}`);
  io.out(`  checked     ${formatCount(result.checked.actual)} reported windows against ${formatCount(result.checked.expected)} expected (the true values from the canonical log)`);
  io.out(`  findings    ${formatCount(result.counts.findings)}`);
  for (const category of WINDOW_FINDING_CATEGORIES) {
    io.out(`                ${padRight(category, 22)} ${formatCount(result.counts.byCategory[category]).padStart(6)}`);
  }
  if (result.counts.explained !== null && result.counts.findings > 0) {
    io.out(
      `  explained   ${formatCount(result.counts.explained)} of ${formatCount(result.counts.findings)} window findings are linked to late, lost, misplaced or duplicated events; ` +
        `${formatCount(result.counts.unexplained ?? 0)} are not explained by any delivery fault`,
    );
  }
  if (result.findings.length === 0 || input.limit === 0) {
    return;
  }
  const shown = result.findings.slice(0, input.limit);
  io.out('');
  io.out(
    shown.length === result.findings.length
      ? `Window findings (${formatCount(result.findings.length)}):`
      : `Window findings (first ${formatCount(shown.length)} of ${formatCount(result.findings.length)}; ${input.hasReport ? 'all of them are in the report' : 'add --report <file> for all of them'}):`,
  );
  for (const finding of shown) {
    printWindowFinding(io, finding, epochUnixMs, result.hints);
  }
}

function printWindowFinding(io: CliIo, finding: WindowFinding, epochUnixMs: number, hints: boolean): void {
  io.out(`  ${padRight(windowLabel(epochUnixMs, finding.windowStartMs, finding.windowEndMs), 27)} ${padRight(finding.category, 18)} ${finding.message}`);
  if (!hints) {
    return;
  }
  const indent = ' '.repeat(4);
  if (finding.category === 'duplicate-window' || finding.category === 'misaligned-window') {
    io.out(`${indent}cause: not a delivery effect; the target listed this window wrongly`);
  } else if (finding.causes.length === 0) {
    io.out(`${indent}cause: none found; no abnormal delivery of an event counted in this window`);
  }
  for (const cause of finding.causes.slice(0, CAUSES_PER_FINDING)) {
    io.out(`${indent}cause: ${cause.eventId} ${cause.eventType} at ${shortIso(epochUnixMs, cause.eventTimeMs)}, ${describeWindowCause(cause, epochUnixMs, finding.windowStartMs)}`);
  }
  if (finding.causes.length > CAUSES_PER_FINDING) {
    io.out(`${indent}       ... ${finding.causes.length - CAUSES_PER_FINDING} more`);
  }
}

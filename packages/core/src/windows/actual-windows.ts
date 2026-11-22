import { z } from 'zod';
import { canonicalJson } from '../serialization/canonical-json';
import type { WindowAggregate } from './windowing';

export const ACTUAL_WINDOWS_FORMAT = 'dataforge.actual-windows';
export const ACTUAL_WINDOWS_FORMAT_VERSION = 1;

const int = z.number().int().refine(Number.isSafeInteger, { error: 'must be a safe integer' });

const windowSchema = z.strictObject({
  windowStartMs: int,
  windowEndMs: int,
  ordersCreated: int,
  paymentsCompleted: int,
  revenueMinor: int,
});

/**
 * The per-window metrics a target reports, in any order. Like the actual state, the schema checks
 * shape, not correctness: a misaligned window or a window listed twice is a finding, not a format error.
 */
export const actualWindowsSchema = z.strictObject({
  format: z.literal(ACTUAL_WINDOWS_FORMAT, { error: `format must be "${ACTUAL_WINDOWS_FORMAT}"` }),
  formatVersion: z.literal(ACTUAL_WINDOWS_FORMAT_VERSION, { error: `formatVersion must be ${ACTUAL_WINDOWS_FORMAT_VERSION}` }),
  windows: z.array(windowSchema),
});

export interface ActualWindows {
  format: typeof ACTUAL_WINDOWS_FORMAT;
  formatVersion: typeof ACTUAL_WINDOWS_FORMAT_VERSION;
  windows: WindowAggregate[];
}

export class ActualWindowsValidationError extends Error {
  constructor(readonly issues: readonly { readonly path: string; readonly message: string }[]) {
    super(`Invalid actual windows:\n${issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'ActualWindowsValidationError';
  }
}

const MAX_REPORTED_ISSUES = 20;

/** Validates a target's reported windows, listing the path of each problem (at most 20). */
export function parseActualWindows(input: unknown): ActualWindows {
  const result = actualWindowsSchema.safeParse(input);
  if (!result.success) {
    throw new ActualWindowsValidationError(
      result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function buildActualWindows(windows: readonly WindowAggregate[]): ActualWindows {
  return {
    format: ACTUAL_WINDOWS_FORMAT,
    formatVersion: ACTUAL_WINDOWS_FORMAT_VERSION,
    windows: [...windows].sort((a, b) => a.windowStartMs - b.windowStartMs).map((window) => ({ ...window })),
  };
}

/** Pretty-printed canonical JSON with a trailing newline, like actual-state.json. */
export function serializeActualWindows(actualWindows: ActualWindows): string {
  return `${canonicalJson(actualWindows, 2)}\n`;
}

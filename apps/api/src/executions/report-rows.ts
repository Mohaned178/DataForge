import type { ValidationReport } from '@dataforge/execution';
import type { Finding, WindowFinding } from '@dataforge/validation';

/** A finding of the report as a row: its position, the columns it is queried by, and the rest as JSON. */
export interface FindingRow {
  readonly ordinal: number;
  readonly category: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly check: string;
  readonly message: string;
  readonly differences: unknown;
  readonly causes: unknown;
}

export interface WindowFindingRow {
  readonly ordinal: number;
  readonly category: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly message: string;
  readonly differences: unknown;
  readonly causes: unknown;
}

/** A stored window_finding row as Prisma returns it (the window bounds are BIGINT). */
export type StoredWindowFindingRow = Omit<WindowFindingRow, 'windowStartMs' | 'windowEndMs'> & {
  readonly windowStartMs: bigint;
  readonly windowEndMs: bigint;
};

export interface ReportRows {
  /** The report with empty finding lists: the findings are the rows. */
  readonly document: ValidationReport;
  readonly findings: readonly FindingRow[];
  readonly windowFindings: readonly WindowFindingRow[];
}

/** Splits a validation report into its document and one row per finding and window finding, in report order. */
export function toReportRows(report: ValidationReport): ReportRows {
  const findings = report.findings.map(
    (finding, ordinal): FindingRow => ({
      ordinal,
      category: finding.category,
      entityType: finding.entityType,
      entityId: finding.entityId,
      check: finding.check,
      message: finding.message,
      differences: finding.differences,
      causes: finding.causes,
    }),
  );
  const windowFindings = (report.windows?.findings ?? []).map(
    (finding, ordinal): WindowFindingRow => ({
      ordinal,
      category: finding.category,
      windowStartMs: finding.windowStartMs,
      windowEndMs: finding.windowEndMs,
      message: finding.message,
      differences: finding.differences,
      causes: finding.causes,
    }),
  );
  const document: ValidationReport = {
    ...report,
    findings: [],
    ...(report.windows === undefined ? {} : { windows: { ...report.windows, findings: [] } }),
  };
  return { document, findings, windowFindings };
}

export function findingOf(row: FindingRow): Finding {
  return {
    category: row.category,
    entityType: row.entityType,
    entityId: row.entityId,
    check: row.check,
    message: row.message,
    differences: row.differences,
    causes: row.causes,
  } as Finding;
}

export function windowFindingOf(row: StoredWindowFindingRow | WindowFindingRow): WindowFinding {
  return {
    category: row.category,
    windowStartMs: Number(row.windowStartMs),
    windowEndMs: Number(row.windowEndMs),
    message: row.message,
    differences: row.differences,
    causes: row.causes,
  } as WindowFinding;
}

/** The report again: the stored document with its findings put back, in ordinal order. */
export function fromReportRows(
  document: ValidationReport,
  findings: readonly FindingRow[],
  windowFindings: readonly (StoredWindowFindingRow | WindowFindingRow)[],
): ValidationReport {
  const byOrdinal = <T extends { readonly ordinal: number }>(rows: readonly T[]) => [...rows].sort((a, b) => a.ordinal - b.ordinal);
  return {
    ...document,
    findings: byOrdinal(findings).map(findingOf),
    ...(document.windows === undefined ? {} : { windows: { ...document.windows, findings: byOrdinal(windowFindings).map(windowFindingOf) } }),
  };
}

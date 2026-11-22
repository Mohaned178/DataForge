import {
  WINDOW_METRICS,
  WINDOW_METRIC_EVENT_TYPE,
  compareCodeUnits,
  windowStartOf,
  type ActualWindows,
  type EventType,
  type WindowAggregate,
  type WindowMetric,
  type WindowingSpec,
} from '@dataforge/core';
import { FAULT_TYPES, classifyArrivals, isWindowedEventType, type ArrivalClass, type DeliveryAttempt, type FaultType } from '@dataforge/chaos';
import type { FieldDifference } from './finding';

/** Window finding categories, in the order reports list them. */
export const WINDOW_FINDING_CATEGORIES = ['window-undercount', 'window-overcount', 'duplicate-window', 'misaligned-window'] as const;
export type WindowFindingCategory = (typeof WINDOW_FINDING_CATEGORIES)[number];

/**
 * A counted event whose delivery could explain a wrong window: it belongs to the window, or it
 * arrived during it. Like entity causes, it is a hint.
 */
export interface WindowCause {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly eventTimeMs: number;
  /** The event-time window the event belongs to. */
  readonly windowStartMs: number;
  readonly windowCloseMs: number;
  /** Its first arrival, by stream time (see `classifyArrivals`). */
  readonly arrival: ArrivalClass;
  readonly firstDeliveryTimeMs: number | null;
  /** Stream time when it first arrived; null when it was the first message, or lost. */
  readonly streamTimeMs: number | null;
  /** How many times the target received it. */
  readonly deliveries: number;
  /** The windows (by delivery time, the processing-time view) its copies arrived in, in delivery order. */
  readonly arrivalWindowStartsMs: readonly number[];
  readonly faults: readonly FaultType[];
}

export interface WindowFinding {
  readonly category: WindowFindingCategory;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly message: string;
  /** The differing metrics, for under- and over-counts; empty otherwise. */
  readonly differences: readonly FieldDifference[];
  /** Most likely first. Empty when no abnormal delivery touches the window, or when no plan was given. */
  readonly causes: readonly WindowCause[];
}

export interface WindowValidationInput {
  readonly windowing: WindowingSpec;
  /** The true windows, from the canonical log (`computeExpectedWindows`). */
  readonly expected: readonly WindowAggregate[];
  readonly actual: ActualWindows;
  /** The delivery plan the target consumed: with it, every finding gets causes. */
  readonly attempts?: readonly DeliveryAttempt[];
}

export interface WindowValidationResult {
  readonly windowing: WindowingSpec;
  readonly hints: boolean;
  /** Windows with at least one counted event in the expected values, and windows the target listed. */
  readonly checked: { readonly expected: number; readonly actual: number };
  readonly counts: {
    readonly findings: number;
    readonly byCategory: Record<WindowFindingCategory, number>;
    readonly explained: number | null;
    readonly unexplained: number | null;
  };
  /** Sorted by window start, then category. */
  readonly findings: readonly WindowFinding[];
}

type Metrics = Record<WindowMetric, number>;
type UnrankedFinding = Omit<WindowFinding, 'causes'> & { readonly metrics: readonly WindowMetric[] };

const ZERO: Metrics = { ordersCreated: 0, paymentsCompleted: 0, revenueMinor: 0 };

/**
 * Compares a target's windows with the true windows, by window start; a window missing on one side
 * counts as zeros. With the delivery plan, each wrong window is linked to the counted events whose
 * delivery could have moved its values: lost or too late, arrived in another window, or duplicated.
 */
export function validateWindows(input: WindowValidationInput): WindowValidationResult {
  const { windowing } = input;
  const raw: UnrankedFinding[] = [];
  const actualByStart = new Map<number, Metrics>();
  const occurrences = new Map<number, number>();

  for (const window of input.actual.windows) {
    occurrences.set(window.windowStartMs, (occurrences.get(window.windowStartMs) ?? 0) + 1);
    if (window.windowStartMs % windowing.sizeMs !== 0 || window.windowEndMs !== window.windowStartMs + windowing.sizeMs) {
      raw.push({
        category: 'misaligned-window',
        windowStartMs: window.windowStartMs,
        windowEndMs: window.windowEndMs,
        message: `[${window.windowStartMs}, ${window.windowEndMs}) is not a window of ${windowing.sizeMs} ms aligned to the epoch; its values are not compared`,
        differences: [],
        metrics: [],
      });
      continue;
    }
    if (!actualByStart.has(window.windowStartMs)) {
      actualByStart.set(window.windowStartMs, window);
    }
  }
  for (const [windowStartMs, count] of occurrences) {
    if (count > 1) {
      raw.push({
        category: 'duplicate-window',
        windowStartMs,
        windowEndMs: windowStartMs + windowing.sizeMs,
        message: `listed ${count} times; the first one is compared`,
        differences: [],
        metrics: [],
      });
    }
  }

  const expectedByStart = new Map<number, Metrics>(input.expected.map((window) => [window.windowStartMs, window]));
  const starts = [...new Set([...expectedByStart.keys(), ...actualByStart.keys()])].sort((a, b) => a - b);
  for (const windowStartMs of starts) {
    const expected = expectedByStart.get(windowStartMs) ?? ZERO;
    const actual = actualByStart.get(windowStartMs) ?? ZERO;
    for (const [category, differs] of [
      ['window-undercount', (metric: WindowMetric) => actual[metric] < expected[metric]],
      ['window-overcount', (metric: WindowMetric) => actual[metric] > expected[metric]],
    ] as const) {
      const metrics = WINDOW_METRICS.filter(differs);
      if (metrics.length === 0) {
        continue;
      }
      const differences = metrics.map((metric) => ({ field: metric, expected: expected[metric], actual: actual[metric] }));
      raw.push({
        category,
        windowStartMs,
        windowEndMs: windowStartMs + windowing.sizeMs,
        message: differences.map((difference) => `${difference.field} is ${difference.actual}, expected ${difference.expected}`).join('; '),
        differences,
        metrics,
      });
    }
  }

  const index = input.attempts === undefined ? undefined : new WindowDeliveryIndex(input.attempts, windowing);
  const findings: WindowFinding[] = raw
    .map(({ metrics, ...finding }) => ({ ...finding, causes: index === undefined ? [] : index.causesOf(finding, metrics) }))
    .sort(
      (a, b) =>
        a.windowStartMs - b.windowStartMs ||
        WINDOW_FINDING_CATEGORIES.indexOf(a.category) - WINDOW_FINDING_CATEGORIES.indexOf(b.category) ||
        compareCodeUnits(a.message, b.message),
    );

  const byCategory = Object.fromEntries(WINDOW_FINDING_CATEGORIES.map((category) => [category, 0])) as Record<WindowFindingCategory, number>;
  for (const finding of findings) {
    byCategory[finding.category] += 1;
  }
  const explained = findings.filter((finding) => finding.causes.length > 0).length;
  return {
    windowing,
    hints: index !== undefined,
    checked: { expected: input.expected.length, actual: input.actual.windows.length },
    counts: {
      findings: findings.length,
      byCategory,
      explained: index === undefined ? null : explained,
      unexplained: index === undefined ? null : findings.length - explained,
    },
    findings,
  };
}

/** What the plan did to every counted event, from the windows' point of view. */
class WindowDeliveryIndex {
  private readonly causes = new Map<string, WindowCause>();
  /** Abnormally delivered counted events, by the event-time window they belong to. */
  private readonly ownByWindow = new Map<number, string[]>();
  /** Abnormally delivered counted events, by every window one of their copies arrived in. */
  private readonly arrivingByWindow = new Map<number, string[]>();

  constructor(attempts: readonly DeliveryAttempt[], windowing: WindowingSpec) {
    const arrivals = classifyArrivals(attempts, windowing);
    const byEvent = new Map<string, DeliveryAttempt[]>();
    for (const attempt of [...attempts].sort((a, b) => a.deliverySequence - b.deliverySequence)) {
      if (isWindowedEventType(attempt.eventType)) {
        const list = byEvent.get(attempt.eventId) ?? [];
        list.push(attempt);
        byEvent.set(attempt.eventId, list);
      }
    }
    for (const [eventId, own] of byEvent) {
      const arrival = arrivals.get(eventId);
      if (arrival === undefined) {
        continue;
      }
      const delivered = own.filter((attempt) => attempt.plannedOutcome === 'delivered');
      const faultTypes = new Set(own.flatMap((attempt) => attempt.faults.map((fault) => fault.type)));
      const cause: WindowCause = {
        eventId,
        eventType: arrival.eventType,
        eventTimeMs: arrival.eventTimeMs,
        windowStartMs: arrival.windowStartMs,
        windowCloseMs: arrival.windowCloseMs,
        arrival: arrival.arrival,
        firstDeliveryTimeMs: arrival.firstDeliveryTimeMs,
        streamTimeMs: arrival.streamTimeMs,
        deliveries: delivered.length,
        arrivalWindowStartsMs: delivered.map((attempt) => windowStartOf(attempt.scheduledDeliveryTimeMs, windowing.sizeMs)),
        faults: FAULT_TYPES.filter((type) => faultTypes.has(type)),
      };
      const abnormal =
        cause.faults.length > 0 ||
        cause.deliveries !== 1 ||
        cause.arrival !== 'on-time' ||
        cause.arrivalWindowStartsMs.some((start) => start !== cause.windowStartMs);
      if (!abnormal) {
        continue;
      }
      this.causes.set(eventId, cause);
      push(this.ownByWindow, cause.windowStartMs, eventId);
      for (const start of new Set(cause.arrivalWindowStartsMs)) {
        push(this.arrivingByWindow, start, eventId);
      }
    }
  }

  causesOf(finding: Omit<WindowFinding, 'causes'>, metrics: readonly WindowMetric[]): WindowCause[] {
    if (finding.category !== 'window-undercount' && finding.category !== 'window-overcount') {
      return [];
    }
    const types = new Set(metrics.map((metric) => WINDOW_METRIC_EVENT_TYPE[metric]));
    const window = finding.windowStartMs;
    const ids = new Set(this.ownByWindow.get(window) ?? []);
    if (finding.category === 'window-overcount') {
      for (const eventId of this.arrivingByWindow.get(window) ?? []) {
        ids.add(eventId);
      }
    }
    const rank = finding.category === 'window-undercount' ? undercountRank(window) : overcountRank(window);
    return [...ids]
      .map((eventId) => this.causes.get(eventId) as WindowCause)
      .filter((cause) => types.has(cause.eventType))
      .sort((a, b) => rank(a) - rank(b) || a.eventTimeMs - b.eventTimeMs || compareCodeUnits(a.eventId, b.eventId));
  }
}

/** Short windows: events that never counted first, then events counted elsewhere. */
function undercountRank(window: number): (cause: WindowCause) => number {
  return (cause) => {
    if (cause.arrival === 'lost' || cause.arrival === 'after-close') {
      return 0;
    }
    if (cause.arrival === 'within-lateness') {
      return 1;
    }
    return cause.arrivalWindowStartsMs[0] !== window ? 2 : 3;
  };
}

/** Long windows: the window's own events delivered more than once first, then events of other windows that arrived during it. */
function overcountRank(window: number): (cause: WindowCause) => number {
  return (cause) => {
    if (cause.windowStartMs === window && cause.deliveries > 1) {
      return 0;
    }
    return cause.windowStartMs !== window ? 1 : 2;
  };
}

function push(map: Map<number, string[]>, key: number, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

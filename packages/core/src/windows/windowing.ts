import { z } from 'zod';
import type { CanonicalEvent } from '../events/canonical-event';
import { DAY_MS, SECOND_MS } from '../time/sim-time';

export const WINDOWING_LIMITS = {
  minSizeMs: SECOND_MS,
  maxSizeMs: 30 * DAY_MS,
  maxAllowedLatenessMs: 30 * DAY_MS,
} as const;

/**
 * How the pipeline under test groups events in time: tumbling event-time windows of `sizeMs`,
 * aligned to the scenario epoch (simulation time 0). A window [start, start + sizeMs) closes when the
 * pipeline's stream time (the largest event time it has received) reaches its end plus
 * `allowedLatenessMs`; an event of that window arriving later is too late.
 */
export const windowingSpecSchema = z.strictObject({
  sizeMs: z.number().int().min(WINDOWING_LIMITS.minSizeMs).max(WINDOWING_LIMITS.maxSizeMs),
  allowedLatenessMs: z.number().int().min(0).max(WINDOWING_LIMITS.maxAllowedLatenessMs).default(0),
});

export type WindowingSpec = z.output<typeof windowingSpecSchema>;

/** Start of the window an instant falls in. Simulation time is never negative. */
export function windowStartOf(timeMs: number, sizeMs: number): number {
  return Math.floor(timeMs / sizeMs) * sizeMs;
}

/** Stream time at or after which the window starting at `windowStartMs` no longer accepts events. */
export function windowCloseOf(windowStartMs: number, spec: WindowingSpec): number {
  return windowStartMs + spec.sizeMs + spec.allowedLatenessMs;
}

/** The per-window business metrics a windowed pipeline reports. */
export const WINDOW_METRICS = ['ordersCreated', 'paymentsCompleted', 'revenueMinor'] as const;
export type WindowMetric = (typeof WINDOW_METRICS)[number];
export type WindowMetrics = Record<WindowMetric, number>;

/** The event type each metric counts: the only events a window depends on. */
export const WINDOW_METRIC_EVENT_TYPE: Readonly<Record<WindowMetric, CanonicalEvent['type']>> = {
  ordersCreated: 'OrderCreated',
  paymentsCompleted: 'PaymentCompleted',
  revenueMinor: 'PaymentCompleted',
};

/**
 * What one event adds to the window it is counted in, or undefined when windows do not count it.
 * The single definition of the metrics: the expected windows and both reference targets use it.
 */
export function windowContribution(event: CanonicalEvent): WindowMetrics | undefined {
  switch (event.type) {
    case 'OrderCreated':
      return { ordersCreated: 1, paymentsCompleted: 0, revenueMinor: 0 };
    case 'PaymentCompleted':
      return { ordersCreated: 0, paymentsCompleted: 1, revenueMinor: event.payload.amountMinor };
    default:
      return undefined;
  }
}

export interface WindowAggregate extends WindowMetrics {
  windowStartMs: number;
  windowEndMs: number;
}

/** Sums contributions per window start; windows are listed in start order, and only once something was counted. */
export class WindowAccumulator {
  private readonly windows = new Map<number, WindowAggregate>();

  constructor(private readonly sizeMs: number) {}

  add(windowStartMs: number, contribution: WindowMetrics): void {
    const window = this.windows.get(windowStartMs) ?? {
      windowStartMs,
      windowEndMs: windowStartMs + this.sizeMs,
      ordersCreated: 0,
      paymentsCompleted: 0,
      revenueMinor: 0,
    };
    for (const metric of WINDOW_METRICS) {
      window[metric] += contribution[metric];
    }
    this.windows.set(windowStartMs, window);
  }

  list(): WindowAggregate[] {
    return [...this.windows.values()].sort((a, b) => a.windowStartMs - b.windowStartMs).map((window) => ({ ...window }));
  }
}

/**
 * The true per-window metrics of a canonical log: every counted event in the window of its event
 * time, exactly once. This is what a pipeline that sees every event in time must report.
 */
export function computeExpectedWindows(events: readonly CanonicalEvent[], sizeMs: number): WindowAggregate[] {
  const accumulator = new WindowAccumulator(sizeMs);
  for (const event of events) {
    const contribution = windowContribution(event);
    if (contribution !== undefined) {
      accumulator.add(windowStartOf(event.eventTimeMs, sizeMs), contribution);
    }
  }
  return accumulator.list();
}

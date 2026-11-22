import { WINDOW_METRIC_EVENT_TYPE, windowCloseOf, windowStartOf, type EventType, type WindowingSpec } from '@dataforge/core';
import type { DeliveryAttempt } from './delivery-attempt';

/**
 * When an event first reached the target, relative to its event-time window, measured in stream time
 * (the largest event time the target had received before it):
 *
 * - `on-time`: the window had not ended yet;
 * - `within-lateness`: the window had ended, but not closed (within the allowed lateness);
 * - `after-close`: the window had closed, so a pipeline with this allowed lateness drops it;
 * - `lost`: it never arrived.
 */
export const ARRIVAL_CLASSES = ['on-time', 'within-lateness', 'after-close', 'lost'] as const;
export type ArrivalClass = (typeof ARRIVAL_CLASSES)[number];

export interface EventArrival {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly eventTimeMs: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly windowCloseMs: number;
  readonly arrival: ArrivalClass;
  /** The event's first delivered attempt; null when lost. */
  readonly firstDeliverySequence: number | null;
  readonly firstDeliveryTimeMs: number | null;
  /** Stream time when it first arrived; null when it was the first message, or lost. */
  readonly streamTimeMs: number | null;
}

/**
 * Classifies the first arrival of every event of a plan. Stream time advances with every delivered
 * attempt, in delivery order, which is exactly what a target that tracks the largest event time it
 * has seen observes (through Kafka with one partition, too).
 */
export function classifyArrivals(attempts: readonly DeliveryAttempt[], windowing: WindowingSpec): Map<string, EventArrival> {
  const ordered = [...attempts].sort((a, b) => a.deliverySequence - b.deliverySequence);
  const arrivals = new Map<string, EventArrival>();
  let streamTimeMs: number | null = null;
  for (const attempt of ordered) {
    if (attempt.plannedOutcome !== 'delivered') {
      continue;
    }
    if (!arrivals.has(attempt.eventId)) {
      const window = windowOf(attempt.eventTimeMs, windowing);
      const arrival: ArrivalClass =
        streamTimeMs === null || streamTimeMs < window.windowEndMs ? 'on-time' : streamTimeMs < window.windowCloseMs ? 'within-lateness' : 'after-close';
      arrivals.set(attempt.eventId, {
        eventId: attempt.eventId,
        eventType: attempt.eventType,
        eventTimeMs: attempt.eventTimeMs,
        ...window,
        arrival,
        firstDeliverySequence: attempt.deliverySequence,
        firstDeliveryTimeMs: attempt.scheduledDeliveryTimeMs,
        streamTimeMs,
      });
    }
    streamTimeMs = streamTimeMs === null ? attempt.eventTimeMs : Math.max(streamTimeMs, attempt.eventTimeMs);
  }
  for (const attempt of ordered) {
    if (!arrivals.has(attempt.eventId)) {
      arrivals.set(attempt.eventId, {
        eventId: attempt.eventId,
        eventType: attempt.eventType,
        eventTimeMs: attempt.eventTimeMs,
        ...windowOf(attempt.eventTimeMs, windowing),
        arrival: 'lost',
        firstDeliverySequence: null,
        firstDeliveryTimeMs: null,
        streamTimeMs: null,
      });
    }
  }
  return arrivals;
}

/** Arrival counts of the events windows count (OrderCreated and PaymentCompleted). */
export function countWindowedArrivals(arrivals: ReadonlyMap<string, EventArrival>): Record<'onTime' | 'withinLateness' | 'afterClose' | 'lost', number> {
  const counts = { onTime: 0, withinLateness: 0, afterClose: 0, lost: 0 };
  for (const arrival of arrivals.values()) {
    if (!WINDOWED_EVENT_TYPES.has(arrival.eventType)) {
      continue;
    }
    switch (arrival.arrival) {
      case 'on-time':
        counts.onTime += 1;
        break;
      case 'within-lateness':
        counts.withinLateness += 1;
        break;
      case 'after-close':
        counts.afterClose += 1;
        break;
      case 'lost':
        counts.lost += 1;
        break;
    }
  }
  return counts;
}

const WINDOWED_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>(Object.values(WINDOW_METRIC_EVENT_TYPE));

/** Whether windows count events of this type. */
export function isWindowedEventType(type: EventType): boolean {
  return WINDOWED_EVENT_TYPES.has(type);
}

function windowOf(eventTimeMs: number, windowing: WindowingSpec): { windowStartMs: number; windowEndMs: number; windowCloseMs: number } {
  const windowStartMs = windowStartOf(eventTimeMs, windowing.sizeMs);
  return { windowStartMs, windowEndMs: windowStartMs + windowing.sizeMs, windowCloseMs: windowCloseOf(windowStartMs, windowing) };
}

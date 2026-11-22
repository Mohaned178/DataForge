import {
  WindowAccumulator,
  WorldState,
  applyEvent,
  buildActualState,
  buildActualWindows,
  compareCodeUnits,
  windowCloseOf,
  windowContribution,
  windowStartOf,
  type CanonicalEvent,
  type WindowingSpec,
} from '@dataforge/core';
import type { DeliveryMessage } from '../message';
import type { Target, TargetOptions, TargetResult } from '../target';

/**
 * A pipeline that handles delivery chaos correctly:
 *
 * - idempotent: an eventId it has already received is ignored;
 * - version-aware: each aggregate's events are applied in aggregateVersion order, and an event that
 *   arrives before its predecessor is parked until the predecessor arrives;
 * - dependency-aware: an order is parked until its customer and every product it lists exist.
 *
 * With a windowing contract it also counts each event once in its event-time window, until the
 * window closes: stream time (the largest event time received) reaching the window's end plus the
 * allowed lateness. An event arriving later is dropped and counted, as a correctly configured
 * Kafka Streams or Flink job with that grace period does.
 *
 * It applies events with the core projection, the same one that defines the expected state, so any
 * difference it shows comes from what was delivered, not from business logic.
 */
export class CorrectTarget implements Target {
  readonly name = 'correct';
  readonly description: string;

  private readonly state = new WorldState();
  private readonly received = new Set<string>();
  private readonly appliedVersion = new Map<string, number>();
  /** Received but not yet applicable events, by aggregate and version. */
  private readonly parked = new Map<string, Map<number, CanonicalEvent>>();
  /** Aggregates whose next event waits for an entity (a customer or product ID) to exist. */
  private readonly waitingFor = new Map<string, Set<string>>();
  private duplicatesIgnored = 0;
  private eventsParked = 0;
  private readonly windowing: WindowingSpec | undefined;
  private readonly windows: WindowAccumulator | undefined;
  /** The largest event time received so far; null before the first message. */
  private streamTimeMs: number | null = null;
  private windowEventsDropped = 0;

  constructor(options: TargetOptions = {}) {
    this.windowing = options.windowing;
    this.windows = options.windowing === undefined ? undefined : new WindowAccumulator(options.windowing.sizeMs);
    this.description =
      'idempotent by eventId, applies each aggregate in version order, waits for referenced entities' +
      (options.windowing === undefined ? '' : '; event-time windows, an event arriving after its window closed is dropped');
  }

  handle(message: DeliveryMessage): void {
    const { event } = message;
    this.handleEvent(event);
    this.streamTimeMs = this.streamTimeMs === null ? event.eventTimeMs : Math.max(this.streamTimeMs, event.eventTimeMs);
  }

  private handleEvent(event: CanonicalEvent): void {
    if (this.received.has(event.eventId)) {
      this.duplicatesIgnored += 1;
      return;
    }
    this.received.add(event.eventId);
    this.countInWindow(event);
    const pending = this.parked.get(event.aggregateId) ?? new Map<number, CanonicalEvent>();
    pending.set(event.aggregateVersion, event);
    this.parked.set(event.aggregateId, pending);
    if (!this.drain(event.aggregateId).has(event.eventId)) {
      this.eventsParked += 1;
    }
  }

  finish(): TargetResult {
    const parkedEventIds = [...this.parked.values()]
      .flatMap((pending) => [...pending.values()].map((event) => event.eventId))
      .sort(compareCodeUnits);
    const result: TargetResult = {
      actualState: buildActualState(this.state),
      counters: { duplicatesIgnored: this.duplicatesIgnored, eventsParked: this.eventsParked },
      parkedEventIds,
    };
    if (this.windows === undefined) {
      return result;
    }
    return {
      ...result,
      counters: { ...result.counters, windowEventsDropped: this.windowEventsDropped },
      windows: buildActualWindows(this.windows.list()),
    };
  }

  /** Counts a first arrival in its event-time window, unless stream time has already closed that window. */
  private countInWindow(event: CanonicalEvent): void {
    const contribution = this.windowing === undefined ? undefined : windowContribution(event);
    if (contribution === undefined || this.windowing === undefined || this.windows === undefined) {
      return;
    }
    const windowStartMs = windowStartOf(event.eventTimeMs, this.windowing.sizeMs);
    if (this.streamTimeMs !== null && this.streamTimeMs >= windowCloseOf(windowStartMs, this.windowing)) {
      this.windowEventsDropped += 1;
      return;
    }
    this.windows.add(windowStartMs, contribution);
  }

  /** Applies every parked event that has become applicable, starting from one aggregate. Returns the IDs applied. */
  private drain(start: string): Set<string> {
    const applied = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const aggregateId = queue.shift() as string;
      const pending = this.parked.get(aggregateId);
      if (pending === undefined) {
        continue;
      }
      for (;;) {
        const event = pending.get((this.appliedVersion.get(aggregateId) ?? 0) + 1);
        if (event === undefined) {
          break;
        }
        const missing = this.missingEntities(event);
        if (missing.length > 0) {
          for (const entityId of missing) {
            const waiting = this.waitingFor.get(entityId) ?? new Set<string>();
            waiting.add(aggregateId);
            this.waitingFor.set(entityId, waiting);
          }
          break;
        }
        applyEvent(this.state, event);
        applied.add(event.eventId);
        pending.delete(event.aggregateVersion);
        this.appliedVersion.set(aggregateId, event.aggregateVersion);
        const dependents = this.waitingFor.get(aggregateId);
        if (dependents !== undefined) {
          this.waitingFor.delete(aggregateId);
          queue.push(...[...dependents].sort(compareCodeUnits));
        }
      }
      if (pending.size === 0) {
        this.parked.delete(aggregateId);
      }
    }
    return applied;
  }

  /** Entities an event references that do not exist yet. Only OrderCreated references other aggregates. */
  private missingEntities(event: CanonicalEvent): string[] {
    if (event.type !== 'OrderCreated') {
      return [];
    }
    const missing = this.state.customers.has(event.payload.customerId) ? [] : [event.payload.customerId];
    for (const line of event.payload.lines) {
      if (!this.state.products.has(line.productId)) {
        missing.push(line.productId);
      }
    }
    return missing;
  }
}

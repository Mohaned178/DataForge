import { WorldState, applyEvent, buildActualState, compareCodeUnits, type CanonicalEvent } from '@dataforge/core';
import type { DeliveryMessage } from '../message';
import type { Target, TargetResult } from '../target';

/**
 * A pipeline that handles delivery chaos correctly:
 *
 * - idempotent: an eventId it has already received is ignored;
 * - version-aware: each aggregate's events are applied in aggregateVersion order, and an event that
 *   arrives before its predecessor is parked until the predecessor arrives;
 * - dependency-aware: an order is parked until its customer and every product it lists exist.
 *
 * It applies events with the core projection, the same one that defines the expected state, so any
 * difference it shows comes from what was delivered, not from business logic.
 */
export class CorrectTarget implements Target {
  readonly name = 'correct';
  readonly description = 'idempotent by eventId, applies each aggregate in version order, waits for referenced entities';

  private readonly state = new WorldState();
  private readonly received = new Set<string>();
  private readonly appliedVersion = new Map<string, number>();
  /** Received but not yet applicable events, by aggregate and version. */
  private readonly parked = new Map<string, Map<number, CanonicalEvent>>();
  /** Aggregates whose next event waits for an entity (a customer or product ID) to exist. */
  private readonly waitingFor = new Map<string, Set<string>>();
  private duplicatesIgnored = 0;
  private eventsParked = 0;

  handle(message: DeliveryMessage): void {
    const { event } = message;
    if (this.received.has(event.eventId)) {
      this.duplicatesIgnored += 1;
      return;
    }
    this.received.add(event.eventId);
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
    return {
      actualState: buildActualState(this.state),
      counters: { duplicatesIgnored: this.duplicatesIgnored, eventsParked: this.eventsParked },
      parkedEventIds,
    };
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

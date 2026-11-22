import { FAULT_TYPES, firstDeliveriesByAggregate, type DeliveryAttempt, type FaultType } from '@dataforge/chaos';
import type { DeliveryCause } from './finding';

/**
 * What a delivery plan did to each canonical event, reduced to the events whose delivery was
 * abnormal (any fault, not exactly one delivery, or overtaken within its aggregate), by aggregate.
 */
export class DeliveryIndex {
  private readonly abnormalByAggregate = new Map<string, DeliveryCause[]>();

  constructor(attempts: readonly DeliveryAttempt[]) {
    const byEvent = new Map<string, DeliveryAttempt[]>();
    for (const attempt of attempts) {
      const list = byEvent.get(attempt.eventId) ?? [];
      list.push(attempt);
      byEvent.set(attempt.eventId, list);
    }
    const firstDeliveries = firstDeliveriesByAggregate(attempts);

    for (const [eventId, own] of byEvent) {
      const sample = own[0] as DeliveryAttempt;
      const delivered = own.filter((attempt) => attempt.plannedOutcome === 'delivered').sort((a, b) => a.deliverySequence - b.deliverySequence);
      const faultTypes = new Set<FaultType>(own.flatMap((attempt) => attempt.faults.map((fault) => fault.type)));
      let delayMs: number | null = null;
      for (const fault of own.flatMap((attempt) => attempt.faults)) {
        if (fault.type === 'delay') {
          delayMs = fault.delayMs;
        }
      }
      const first = delivered[0];
      const overtakenBy =
        first === undefined
          ? []
          : (firstDeliveries.get(sample.aggregateId) ?? [])
              .filter((sibling) => sibling.aggregateVersion > sample.aggregateVersion && sibling.deliverySequence < first.deliverySequence)
              .map((sibling) => sibling.eventId);

      const cause: DeliveryCause = {
        eventId,
        eventType: sample.eventType,
        aggregateId: sample.aggregateId,
        aggregateVersion: sample.aggregateVersion,
        faults: FAULT_TYPES.filter((type) => faultTypes.has(type)),
        deliveries: delivered.length,
        failedAttempts: own.length - delivered.length,
        lost: delivered.length === 0,
        delayMs,
        overtakenBy,
      };
      if (cause.faults.length > 0 || cause.deliveries !== 1 || cause.overtakenBy.length > 0) {
        const list = this.abnormalByAggregate.get(cause.aggregateId) ?? [];
        list.push(cause);
        this.abnormalByAggregate.set(cause.aggregateId, list);
      }
    }
    for (const list of this.abnormalByAggregate.values()) {
      list.sort((a, b) => a.aggregateVersion - b.aggregateVersion);
    }
  }

  abnormalEventsOf(aggregateId: string): readonly DeliveryCause[] {
    return this.abnormalByAggregate.get(aggregateId) ?? [];
  }
}

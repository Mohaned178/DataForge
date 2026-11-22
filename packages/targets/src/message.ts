import type { CanonicalEvent } from '@dataforge/core';

/** Delivery metadata the transport attaches to a message. It describes the attempt, never the business event. */
export interface DeliveryHeaders {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly deliverySequence: number;
  readonly scheduledDeliveryTimeMs: number;
}

/**
 * One delivered attempt as a target receives it: the shape a Kafka record will carry in
 * Milestone 4 (key = aggregateId, value = the canonical event, headers = attempt metadata).
 * Redeliveries of one event carry the same event, with its eventId, and different headers.
 */
export interface DeliveryMessage {
  readonly key: string;
  readonly event: CanonicalEvent;
  readonly headers: DeliveryHeaders;
}

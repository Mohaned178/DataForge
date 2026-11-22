import { eventId } from '../domain/ids';
import { EVENT_SCHEMA_VERSION } from '../version';
import { AGGREGATE_TYPE_BY_EVENT_TYPE, type CanonicalEvent, type EventType, type PayloadOf } from './canonical-event';
import { compareCodeUnits } from '../serialization/canonical-json';

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never;

/** An event that has been generated but not yet placed in the canonical log. */
export type EventDraft = DistributiveOmit<CanonicalEvent, 'sequence'>;
export type EventDraftOf<T extends EventType> = Extract<EventDraft, { type: T }>;

export interface DraftPosition {
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventTimeMs: number;
}

export function draftEvent<T extends EventType>(type: T, position: DraftPosition, payload: PayloadOf<T>): EventDraftOf<T> {
  const draft = {
    eventId: eventId(position.aggregateId, position.aggregateVersion),
    type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventTimeMs: position.eventTimeMs,
    aggregateType: AGGREGATE_TYPE_BY_EVENT_TYPE[type],
    aggregateId: position.aggregateId,
    aggregateVersion: position.aggregateVersion,
    payload,
  };
  // TypeScript cannot correlate the generic `type` with its union member; the shape above is exact.
  return draft as unknown as EventDraftOf<T>;
}

/**
 * The total order of the canonical log: event time, then aggregate ID, then aggregate version.
 * Causally related events always have strictly increasing event times, so the tie-breakers only
 * ever order independent events, and they do so identically on every machine.
 */
export function compareCanonicalOrder(a: EventDraft, b: EventDraft): number {
  return (
    a.eventTimeMs - b.eventTimeMs ||
    compareCodeUnits(a.aggregateId, b.aggregateId) ||
    a.aggregateVersion - b.aggregateVersion
  );
}

export function sequenceDrafts(drafts: readonly EventDraft[]): CanonicalEvent[] {
  return [...drafts].sort(compareCanonicalOrder).map((draft, index): CanonicalEvent => ({ ...draft, sequence: index + 1 }));
}

import type { CanonicalEvent, EventOfType, EventType } from '../events/canonical-event';
import type { WorldStateView } from '../projection/world-state';

/**
 * A business constraint checked against the world state immediately before an event is applied.
 * Returning a message reports a violation; returning undefined means the event is acceptable.
 */
export interface BusinessRule {
  readonly id: string;
  readonly description: string;
  readonly eventTypes: readonly EventType[];
  check(state: WorldStateView, event: CanonicalEvent): string | undefined;
}

export interface RuleDefinition<T extends EventType> {
  readonly id: string;
  readonly description: string;
  readonly eventTypes: readonly T[];
  check(state: WorldStateView, event: EventOfType<T>): string | undefined;
}

export function defineRule<T extends EventType>(definition: RuleDefinition<T>): BusinessRule {
  const applicable: readonly EventType[] = definition.eventTypes;
  return {
    id: definition.id,
    description: definition.description,
    eventTypes: definition.eventTypes,
    check(state, event) {
      if (!applicable.includes(event.type)) {
        return undefined;
      }
      // The guard above guarantees the event is one of T.
      return definition.check(state, event as EventOfType<T>);
    },
  };
}

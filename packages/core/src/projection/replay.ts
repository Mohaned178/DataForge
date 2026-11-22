import { aggregateIdInPayload, type CanonicalEvent } from '../events/canonical-event';
import { compareCanonicalOrder } from '../events/event-draft';
import type { BusinessRule } from '../rules/business-rule';
import { ECOMMERCE_RULES } from '../rules/ecommerce-rules';
import { applyEvent } from './apply-event';
import { buildExpectedState, type ExpectedState } from './expected-state';
import { WorldState } from './world-state';

export interface RuleViolation {
  readonly ruleId: string;
  readonly message: string;
}

/** Raised when a canonical log breaks log integrity or a business rule. Generation treats it as a bug. */
export class CanonicalLogViolationError extends Error {
  constructor(
    readonly event: Pick<CanonicalEvent, 'sequence' | 'eventId' | 'type'>,
    readonly violations: readonly RuleViolation[],
  ) {
    const details = violations.map((violation) => `  - [${violation.ruleId}] ${violation.message}`).join('\n');
    super(`Event #${event.sequence} ${event.eventId} (${event.type}) violates the canonical log rules:\n${details}`);
    this.name = 'CanonicalLogViolationError';
  }
}

export interface ReplayResult {
  readonly state: WorldState;
  readonly expectedState: ExpectedState;
}

/**
 * Rebuilds the world by applying canonical events in order. Every event is first checked for log
 * integrity and against every business rule; the first offending event stops the replay.
 */
export function replayCanonicalLog(
  events: Iterable<CanonicalEvent>,
  rules: readonly BusinessRule[] = ECOMMERCE_RULES,
): ReplayResult {
  const state = new WorldState();
  const seenEventIds = new Set<string>();
  const aggregateVersions = new Map<string, number>();
  let previous: CanonicalEvent | undefined;

  for (const event of events) {
    const violations = checkLogIntegrity(event, previous, seenEventIds, aggregateVersions);
    for (const rule of rules) {
      const message = rule.check(state, event);
      if (message !== undefined) {
        violations.push({ ruleId: rule.id, message });
      }
    }
    if (violations.length > 0) {
      throw new CanonicalLogViolationError(event, violations);
    }
    applyEvent(state, event);
    seenEventIds.add(event.eventId);
    aggregateVersions.set(event.aggregateId, event.aggregateVersion);
    previous = event;
  }

  const expectedState = buildExpectedState(state, {
    lastSequence: previous?.sequence ?? 0,
    lastEventTimeMs: previous?.eventTimeMs ?? 0,
  });
  return { state, expectedState };
}

function checkLogIntegrity(
  event: CanonicalEvent,
  previous: CanonicalEvent | undefined,
  seenEventIds: ReadonlySet<string>,
  aggregateVersions: ReadonlyMap<string, number>,
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const expectedSequence = (previous?.sequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    violations.push({ ruleId: 'log.sequence', message: `expected sequence ${expectedSequence}, got ${event.sequence}` });
  }
  if (previous !== undefined && compareCanonicalOrder(previous, event) >= 0) {
    violations.push({
      ruleId: 'log.canonical-order',
      message: `event must come after ${previous.eventId} (ordered by eventTimeMs, aggregateId, aggregateVersion)`,
    });
  }
  if (seenEventIds.has(event.eventId)) {
    violations.push({ ruleId: 'log.unique-event-id', message: `event ID ${event.eventId} already appeared in the log` });
  }
  const expectedVersion = (aggregateVersions.get(event.aggregateId) ?? 0) + 1;
  if (event.aggregateVersion !== expectedVersion) {
    violations.push({
      ruleId: 'log.aggregate-version',
      message: `expected version ${expectedVersion} of ${event.aggregateId}, got ${event.aggregateVersion}`,
    });
  }
  const payloadAggregateId = aggregateIdInPayload(event);
  if (payloadAggregateId !== event.aggregateId) {
    violations.push({
      ruleId: 'log.aggregate-id',
      message: `aggregateId ${event.aggregateId} does not match payload ID ${payloadAggregateId}`,
    });
  }
  return violations;
}

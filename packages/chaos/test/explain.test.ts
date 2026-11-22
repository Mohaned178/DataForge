import { UnknownEventError, explainEvent, planDelivery, type DeliveryAttempt } from '../src';
import { canonicalLog, exampleProfile, profile } from './support/fixtures';

describe('explainEvent', () => {
  const events = canonicalLog('ecommerce-small');

  it('accounts for every attempt of every event, and nothing else', () => {
    const plan = planDelivery({ events, profile: exampleProfile('flaky-network'), chaosSeed: '7' });
    let total = 0;
    for (const event of events) {
      const explanation = explainEvent(events, plan.attempts, event.eventId);
      expect(explanation.event).toBe(event);
      expect(explanation.attempts.every((attempt) => attempt.eventId === event.eventId)).toBe(true);
      expect(explanation.attempts.map((attempt) => attempt.attemptNumber)).toEqual(explanation.attempts.map((_, index) => index + 1));
      total += explanation.attempts.length;
    }
    expect(total).toBe(plan.attempts.length);
  });

  it('shows a reordered event as overtaken by the later event it was moved behind', () => {
    const plan = planDelivery({ events, profile: profile({ reorder: { rate: 0.3 } }), chaosSeed: '7' });
    const reordered = plan.attempts.find((attempt) => attempt.faults.some((fault) => fault.type === 'reorder')) as DeliveryAttempt;
    const fault = reordered.faults.find((candidate) => candidate.type === 'reorder');
    const explanation = explainEvent(events, plan.attempts, reordered.eventId);
    expect(explanation.outcome).toBe('delivered');
    expect(explanation.overtakenBy.map((sibling) => sibling.eventId)).toContain(fault?.type === 'reorder' ? fault.behindEventId : '');
    const target = explainEvent(events, plan.attempts, fault?.type === 'reorder' ? fault.behindEventId : '');
    expect(target.overtook.map((sibling) => sibling.eventId)).toContain(reordered.eventId);
  });

  it('counts deliveries of a duplicated event and reports a lost event as lost', () => {
    const plan = planDelivery({ events, profile: exampleProfile('lossy'), chaosSeed: '7' });
    const duplicated = plan.attempts.find((attempt) => attempt.kind === 'duplicate') as DeliveryAttempt;
    const duplicateExplanation = explainEvent(events, plan.attempts, duplicated.eventId);
    expect(duplicateExplanation.deliveries).toBe(duplicateExplanation.attempts.filter((a) => a.plannedOutcome === 'delivered').length);
    expect(duplicateExplanation.deliveries).toBeGreaterThanOrEqual(2);

    const lostEventId = events.find((event) =>
      plan.attempts.filter((attempt) => attempt.eventId === event.eventId).every((attempt) => attempt.plannedOutcome === 'failed'),
    )?.eventId as string;
    const lost = explainEvent(events, plan.attempts, lostEventId);
    expect(lost).toMatchObject({ outcome: 'lost', deliveries: 0, firstDelivery: undefined, overtakenBy: [], overtook: [] });
  });

  it('rejects an event ID that is not in the log', () => {
    const plan = planDelivery({ events, profile: profile(), chaosSeed: '7' });
    expect(() => explainEvent(events, plan.attempts, 'evt_ord_999999_1')).toThrow(UnknownEventError);
  });
});

import { customerId } from '../domain/ids';
import { draftEvent, type EventDraftOf } from '../events/event-draft';
import { RandomStream } from '../random/random-stream';
import type { ScenarioConfig } from '../scenario/scenario-schema';
import { compareCodeUnits } from '../serialization/canonical-json';
import { COUNTRIES, FIRST_NAMES, LAST_NAMES } from './vocabulary';

export interface GeneratedCustomer {
  readonly customerId: string;
  readonly registeredAtMs: number;
}

export interface GeneratedCustomers {
  /** Sorted by registration time, then ID: the order in which customers become able to buy. */
  readonly byRegistration: readonly GeneratedCustomer[];
  readonly events: readonly EventDraftOf<'CustomerRegistered'>[];
}

/**
 * Customers register uniformly across the simulation window. The last millisecond is excluded so
 * that every customer can still place an order strictly after registering.
 */
export function generateCustomers(scenario: ScenarioConfig, seed: string): GeneratedCustomers {
  const { durationMs } = scenario.simulation;
  const customers: GeneratedCustomer[] = [];
  const events: EventDraftOf<'CustomerRegistered'>[] = [];

  for (let customerNumber = 1; customerNumber <= scenario.customers.count; customerNumber++) {
    const random = RandomStream.derive(seed, 'customer.profile', String(customerNumber));
    const id = customerId(customerNumber);
    const registeredAtMs = random.int(0, durationMs - 2);
    const firstName = random.pick(FIRST_NAMES);
    const lastName = random.pick(LAST_NAMES);
    const country = random.weightedPick(COUNTRIES);
    const email = `${firstName}.${lastName}.${customerNumber}@example.com`.toLowerCase();

    customers.push({ customerId: id, registeredAtMs });
    events.push(
      draftEvent(
        'CustomerRegistered',
        { aggregateId: id, aggregateVersion: 1, eventTimeMs: registeredAtMs },
        { customerId: id, name: `${firstName} ${lastName}`, email, country },
      ),
    );
  }

  const byRegistration = customers.sort(
    (a, b) => a.registeredAtMs - b.registeredAtMs || compareCodeUnits(a.customerId, b.customerId),
  );
  return { byRegistration, events };
}

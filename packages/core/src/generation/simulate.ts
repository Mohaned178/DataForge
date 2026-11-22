import type { CanonicalEvent } from '../events/canonical-event';
import { sequenceDrafts } from '../events/event-draft';
import type { ExpectedState } from '../projection/expected-state';
import { replayCanonicalLog } from '../projection/replay';
import { scenarioHash, type ScenarioConfig } from '../scenario/scenario-schema';
import { normalizeSeed } from '../scenario/seed';
import { ENGINE_VERSION } from '../version';
import { generateCatalog } from './catalog';
import { generateCustomers } from './customers';
import { generateOrders } from './orders';

export interface SimulationInput {
  readonly scenario: ScenarioConfig;
  readonly seed: string | number;
}

export interface SimulationResult {
  readonly engineVersion: string;
  readonly seed: string;
  readonly scenarioHash: string;
  readonly events: readonly CanonicalEvent[];
  readonly expectedState: ExpectedState;
}

/**
 * Generates the canonical event log for a scenario and seed, then derives the expected state by
 * replaying that log through the business rules and projections. Same inputs, same bytes.
 */
export function simulate(input: SimulationInput): SimulationResult {
  const seed = normalizeSeed(input.seed);
  const { scenario } = input;

  const catalog = generateCatalog(scenario, seed);
  const customers = generateCustomers(scenario, seed);
  const orders = generateOrders({
    scenario,
    seed,
    products: catalog.products,
    customersByRegistration: customers.byRegistration,
  });

  const events = sequenceDrafts([...catalog.events, ...customers.events, ...orders]);
  for (const event of events) {
    deepFreeze(event);
  }
  const { expectedState } = replayCanonicalLog(events);

  return { engineVersion: ENGINE_VERSION, seed, scenarioHash: scenarioHash(scenario), events, expectedState };
}

function deepFreeze(value: object): void {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) {
      deepFreeze(child as object);
    }
  }
  Object.freeze(value);
}

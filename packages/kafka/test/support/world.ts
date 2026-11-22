import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScenario, parseUtcInstant, simulate, type SimulationResult } from '@dataforge/core';
import { parseChaosProfile, planDelivery, type ChaosProfileInput, type DeliveryAttempt } from '@dataforge/chaos';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const worlds = new Map<string, SimulationResult>();
const scenario = () => parseScenario(JSON.parse(readFileSync(join(REPO_ROOT, 'scenarios', 'ecommerce-small.json'), 'utf8')));

/** The ecommerce-small world for a seed, simulated once per test file. */
export function world(seed = '42'): SimulationResult {
  let result = worlds.get(seed);
  if (result === undefined) {
    result = simulate({ scenario: scenario(), seed });
    worlds.set(seed, result);
  }
  return result;
}

/** The scenario epoch (2026-01-01T00:00:00Z) in Unix milliseconds. */
export const EPOCH_UNIX_MS = parseUtcInstant(scenario().simulation.epoch);

export function plan(simulation: SimulationResult, profile: string | ChaosProfileInput['faults'], chaosSeed = '7'): readonly DeliveryAttempt[] {
  const parsed =
    typeof profile === 'string'
      ? parseChaosProfile(JSON.parse(readFileSync(join(REPO_ROOT, 'chaos-profiles', `${profile}.json`), 'utf8')))
      : parseChaosProfile({ formatVersion: 1, name: 'test', faults: profile });
  return planDelivery({ events: simulation.events, profile: parsed, chaosSeed }).attempts;
}

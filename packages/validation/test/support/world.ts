import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_STATE_FORMAT,
  ACTUAL_STATE_FORMAT_VERSION,
  parseScenario,
  simulate,
  type ActualState,
  type ExpectedState,
  type SimulationResult,
} from '@dataforge/core';
import { parseChaosProfile, planDelivery, type ChaosProfileInput, type DeliveryAttempt } from '@dataforge/chaos';
import { createReferenceTarget, deliverInMemory, type ReferenceTargetName } from '@dataforge/targets';
import { validate, type ValidationResult } from '../../src';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const worlds = new Map<string, SimulationResult>();

export function world(scenarioName: 'ecommerce-small' | 'ecommerce-standard' = 'ecommerce-small', seed = '42'): SimulationResult {
  const key = `${scenarioName}/${seed}`;
  let result = worlds.get(key);
  if (result === undefined) {
    const scenario = parseScenario(JSON.parse(readFileSync(join(REPO_ROOT, 'scenarios', `${scenarioName}.json`), 'utf8')));
    result = simulate({ scenario, seed });
    worlds.set(key, result);
  }
  return result;
}

export function plan(simulation: SimulationResult, profile: string | ChaosProfileInput['faults'], chaosSeed = '7'): readonly DeliveryAttempt[] {
  const parsed =
    typeof profile === 'string'
      ? parseChaosProfile(JSON.parse(readFileSync(join(REPO_ROOT, 'chaos-profiles', `${profile}.json`), 'utf8')))
      : parseChaosProfile({ formatVersion: 1, name: 'test', faults: profile });
  return planDelivery({ events: simulation.events, profile: parsed, chaosSeed }).attempts;
}

/** The expected state as a target would report it: a correct target's output. */
export function asActual(expected: ExpectedState): ActualState {
  const { products, customers, orders, payments, shipments } = structuredClone(expected);
  return { format: ACTUAL_STATE_FORMAT, formatVersion: ACTUAL_STATE_FORMAT_VERSION, products, customers, orders, payments, shipments };
}

/** Simulate, plan, deliver to a reference target, validate: the whole offline loop. */
export function endToEnd(
  target: ReferenceTargetName,
  profile: string | ChaosProfileInput['faults'],
  options: { scenario?: 'ecommerce-small' | 'ecommerce-standard'; seed?: string; chaosSeed?: string } = {},
): ValidationResult {
  const simulation = world(options.scenario, options.seed);
  const attempts = plan(simulation, profile, options.chaosSeed);
  const { actualState } = deliverInMemory({ events: simulation.events, attempts, target: createReferenceTarget(target) });
  return validate({ expected: simulation.expectedState, actual: actualState, attempts });
}

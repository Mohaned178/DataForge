import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScenario, simulate, type CanonicalEvent } from '@dataforge/core';
import { parseChaosProfile, type ChaosProfile, type ChaosProfileInput, type DeliveryAttempt } from '../../src';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const worlds = new Map<string, readonly CanonicalEvent[]>();

/** The canonical log of a scenario in scenarios/, simulated once per test file. */
export function canonicalLog(scenarioName: 'ecommerce-small' | 'ecommerce-standard', seed = '42'): readonly CanonicalEvent[] {
  const key = `${scenarioName}/${seed}`;
  let events = worlds.get(key);
  if (events === undefined) {
    const scenario = parseScenario(JSON.parse(readFileSync(join(REPO_ROOT, 'scenarios', `${scenarioName}.json`), 'utf8')));
    events = simulate({ scenario, seed }).events;
    worlds.set(key, events);
  }
  return events;
}

export function exampleProfile(name: 'none' | 'spec-example' | 'flaky-network' | 'lossy'): ChaosProfile {
  return parseChaosProfile(JSON.parse(readFileSync(join(REPO_ROOT, 'chaos-profiles', `${name}.json`), 'utf8')));
}

export function profile(faults: ChaosProfileInput['faults'] = {}): ChaosProfile {
  return parseChaosProfile({ formatVersion: 1, name: 'test', faults });
}

export function attemptsByEvent(attempts: readonly DeliveryAttempt[]): Map<string, DeliveryAttempt[]> {
  const byEvent = new Map<string, DeliveryAttempt[]>();
  for (const attempt of attempts) {
    const list = byEvent.get(attempt.eventId) ?? [];
    list.push(attempt);
    byEvent.set(attempt.eventId, list);
  }
  for (const list of byEvent.values()) {
    list.sort((a, b) => a.attemptNumber - b.attemptNumber);
  }
  return byEvent;
}

/** IDs of the events that carry at least one fault record of the given type. */
export function eventsWithFault(attempts: readonly DeliveryAttempt[], type: string): string[] {
  const ids = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.faults.some((fault) => fault.type === type)) {
      ids.add(attempt.eventId);
    }
  }
  return [...ids].sort();
}

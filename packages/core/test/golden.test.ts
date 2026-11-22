import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_VERSION, parseScenario, serializeEventLog, serializeExpectedState, sha256Hex, simulate } from '../src';

/**
 * Pins the exact output of scenarios/ecommerce-small.json with seed 42.
 *
 * These hashes were produced by this engine; they are a regression guard, not an external
 * reference. If this test fails, generation changed: either fix the accidental change, or (if the
 * change is intended) bump ENGINE_VERSION in src/version.ts and update both the version and the
 * hashes below in the same commit.
 */
const GOLDEN = {
  engineVersion: '0.1.0',
  eventsSha256: '01b57d640ab12e33702ccb72339fd00552e6b37b3fddce4dff7a5a8c0cca42de',
  expectedStateSha256: '3546842d89241f81b31bd2bfaa11916fff0ee04cc400195a70b4c2e6beff2101',
};

describe('golden output', () => {
  const scenarioPath = join(__dirname, '..', '..', '..', 'scenarios', 'ecommerce-small.json');
  const scenario = parseScenario(JSON.parse(readFileSync(scenarioPath, 'utf8')));
  const result = simulate({ scenario, seed: '42' });

  it('is pinned to the current engine version', () => {
    expect(ENGINE_VERSION).toBe(GOLDEN.engineVersion);
  });

  it('reproduces the pinned canonical event log', () => {
    expect(sha256Hex(serializeEventLog(result.events))).toBe(GOLDEN.eventsSha256);
  });

  it('reproduces the pinned expected state', () => {
    expect(sha256Hex(serializeExpectedState(result.expectedState))).toBe(GOLDEN.expectedStateSha256);
  });
});

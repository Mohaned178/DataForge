import { canonicalJson, sha256Hex } from '@dataforge/core';
import { PLANNER_VERSION, planDelivery, serializeDeliveryPlan } from '../src';
import { canonicalLog, exampleProfile } from './support/fixtures';

/**
 * Pins the exact plan for scenarios/ecommerce-small.json (seed 42) under
 * chaos-profiles/flaky-network.json with chaos seed 7.
 *
 * These hashes were produced by this planner; they are a regression guard, not an external
 * reference. If this test fails, planning changed: either fix the accidental change, or (if the
 * change is intended) bump PLANNER_VERSION in src/version.ts and update the version and the hashes
 * below in the same commit.
 */
const GOLDEN = {
  plannerVersion: '0.1.0',
  planSha256: '70b88efd88ae23de874781625f1bce81c17733cd2a6bddf638e0338baf612a60',
  summarySha256: '5b101e18f0a0ae1170f2507fd36ba46a1287a3339d92b3b7aec4bda5c37ce845',
};

describe('golden delivery plan', () => {
  const plan = planDelivery({ events: canonicalLog('ecommerce-small'), profile: exampleProfile('flaky-network'), chaosSeed: '7' });

  it('is pinned to the current planner version', () => {
    expect(PLANNER_VERSION).toBe(GOLDEN.plannerVersion);
  });

  it('reproduces the pinned plan', () => {
    expect(sha256Hex(serializeDeliveryPlan(plan.attempts))).toBe(GOLDEN.planSha256);
  });

  it('reproduces the pinned summary', () => {
    expect(sha256Hex(canonicalJson(plan.summary))).toBe(GOLDEN.summarySha256);
  });
});

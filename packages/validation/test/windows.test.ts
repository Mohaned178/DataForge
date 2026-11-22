import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOUR_MS,
  MINUTE_MS,
  buildActualWindows,
  canonicalJson,
  computeExpectedWindows,
  sha256Hex,
  type ActualWindows,
  type SimulationResult,
  type WindowAggregate,
} from '@dataforge/core';
import { parseChaosProfile, planDelivery, type ChaosProfile, type DeliveryAttempt } from '@dataforge/chaos';
import { createReferenceTarget, deliverInMemory, type ReferenceTargetName } from '@dataforge/targets';
import { validate, validateWindows, type WindowValidationResult } from '../src';
import { asActual, world } from './support/world';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const WINDOWING = { sizeMs: HOUR_MS, allowedLatenessMs: 10 * MINUTE_MS };

function profileNamed(name: string): ChaosProfile {
  return parseChaosProfile(JSON.parse(readFileSync(join(REPO_ROOT, 'chaos-profiles', `${name}.json`), 'utf8')));
}

const noFaults = parseChaosProfile({ formatVersion: 1, name: 'none', windowing: WINDOWING, faults: {} });

interface Delivered {
  readonly simulation: SimulationResult;
  readonly attempts: readonly DeliveryAttempt[];
  readonly expected: WindowAggregate[];
  readonly actual: ActualWindows;
}

function deliverWindows(target: ReferenceTargetName, profile: ChaosProfile, scenario: 'ecommerce-small' | 'ecommerce-standard' = 'ecommerce-small'): Delivered {
  const simulation = world(scenario);
  const attempts = planDelivery({ events: simulation.events, profile, chaosSeed: '7' }).attempts;
  const windowing = profile.windowing ?? WINDOWING;
  const result = deliverInMemory({ events: simulation.events, attempts, target: createReferenceTarget(target, { windowing }) });
  return { simulation, attempts, expected: computeExpectedWindows(simulation.events, windowing.sizeMs), actual: result.windows as ActualWindows };
}

function check(delivered: Delivered, actual = delivered.actual, withPlan = true): WindowValidationResult {
  return validateWindows({ windowing: WINDOWING, expected: delivered.expected, actual, ...(withPlan ? { attempts: delivered.attempts } : {}) });
}

describe('window validation', () => {
  const baseline = deliverWindows('correct', noFaults);

  it('passes the true windows', () => {
    const result = check(baseline);
    expect(result.counts.findings).toBe(0);
    expect(result.checked.expected).toBe(baseline.expected.length);
  });

  it('reports a short window as window-undercount and a long one as window-overcount, per metric', () => {
    const windows = baseline.expected.map((window) => ({ ...window }));
    const short = windows.find((window) => window.paymentsCompleted > 0) as WindowAggregate;
    const long = windows.find((window) => window !== short && window.ordersCreated > 0) as WindowAggregate;
    short.paymentsCompleted -= 1;
    short.revenueMinor -= 100;
    long.ordersCreated += 2;
    const result = check(baseline, buildActualWindows(windows));
    expect(result.findings.map((finding) => [finding.category, finding.windowStartMs])).toEqual(
      [
        ['window-undercount', short.windowStartMs],
        ['window-overcount', long.windowStartMs],
      ].sort((a, b) => (a[1] as number) - (b[1] as number)),
    );
    const under = result.findings.find((finding) => finding.category === 'window-undercount');
    expect(under?.differences.map((difference) => difference.field)).toEqual(['paymentsCompleted', 'revenueMinor']);
    expect(under?.message).toBe(`paymentsCompleted is ${short.paymentsCompleted}, expected ${short.paymentsCompleted + 1}; revenueMinor is ${short.revenueMinor}, expected ${short.revenueMinor + 100}`);
  });

  it('treats a window missing on either side as zeros', () => {
    const [first, ...rest] = baseline.expected;
    const extra = { windowStartMs: 1000 * HOUR_MS, windowEndMs: 1001 * HOUR_MS, ordersCreated: 1, paymentsCompleted: 0, revenueMinor: 0 };
    const empty = { windowStartMs: 2000 * HOUR_MS, windowEndMs: 2001 * HOUR_MS, ordersCreated: 0, paymentsCompleted: 0, revenueMinor: 0 };
    const result = check(baseline, buildActualWindows([...rest, extra, empty]));
    expect(result.findings.map((finding) => [finding.category, finding.windowStartMs])).toEqual([
      ['window-undercount', (first as WindowAggregate).windowStartMs],
      ['window-overcount', extra.windowStartMs],
    ]);
  });

  it('reports a misaligned window and a window listed twice', () => {
    const [first, second, ...rest] = baseline.expected as [WindowAggregate, WindowAggregate, ...WindowAggregate[]];
    const shifted = { ...second, windowStartMs: second.windowStartMs + MINUTE_MS, windowEndMs: second.windowEndMs + MINUTE_MS };
    const result = check(baseline, buildActualWindows([first, first, shifted, ...rest]));
    const categories = result.findings.map((finding) => finding.category);
    expect(categories).toEqual(expect.arrayContaining(['duplicate-window', 'misaligned-window', 'window-undercount']));
    expect(result.counts.byCategory['misaligned-window']).toBe(1);
    expect(result.counts.byCategory['duplicate-window']).toBe(1);
  });

  it('reports a difference that no delivery explains as unexplained, and has no causes without a plan', () => {
    const windows = baseline.expected.map((window) => ({ ...window }));
    (windows[3] as WindowAggregate).revenueMinor += 1;
    const withPlan = check(baseline, buildActualWindows(windows));
    expect(withPlan.counts).toMatchObject({ findings: 1, explained: 0, unexplained: 1 });
    const withoutPlan = check(baseline, buildActualWindows(windows), false);
    expect(withoutPlan.hints).toBe(false);
    expect(withoutPlan.counts.explained).toBeNull();
  });

  it('makes the verdict FAIL even when the entity state is right', () => {
    const windows = baseline.expected.map((window) => ({ ...window }));
    (windows[0] as WindowAggregate).ordersCreated += 1;
    const simulation = baseline.simulation;
    const result = validate({
      expected: simulation.expectedState,
      actual: asActual(simulation.expectedState),
      attempts: baseline.attempts,
      windows: { windowing: WINDOWING, expected: baseline.expected, actual: buildActualWindows(windows) },
    });
    expect(result.counts.findings).toBe(0);
    expect(result.windows?.counts.findings).toBe(1);
    expect(result.verdict).toBe('FAIL');
    const withoutWindows = validate({ expected: simulation.expectedState, actual: asActual(simulation.expectedState), attempts: baseline.attempts });
    expect(withoutWindows.verdict).toBe('PASS');
    expect('windows' in withoutWindows).toBe(false);
  });
});

describe('window findings of the reference targets', () => {
  it('correct passes when delays stay within the allowed lateness, on the small and the specification-sized scenario', () => {
    for (const scenario of ['ecommerce-small', 'ecommerce-standard'] as const) {
      expect(check(deliverWindows('correct', profileNamed('windowed-delays'), scenario)).counts.findings).toBe(0);
    }
  });

  it('correct under late-data: only short windows, each led by an event that arrived after its window closed', () => {
    const delivered = deliverWindows('correct', profileNamed('late-data'));
    const result = check(delivered);
    expect(result.counts.findings).toBeGreaterThan(2);
    expect(result.counts.byCategory['window-overcount']).toBe(0);
    expect(result.counts.unexplained).toBe(0);
    for (const finding of result.findings) {
      expect(finding.category).toBe('window-undercount');
      expect(finding.causes[0]?.arrival).toBe('after-close');
      expect(finding.causes[0]?.windowStartMs).toBe(finding.windowStartMs);
      expect(finding.causes[0]?.faults).toContain('late');
    }
  });

  it('naive under windowed-delays: short and long windows, explained by events counted in the wrong window and by duplicates', () => {
    const delivered = deliverWindows('naive', profileNamed('windowed-delays'));
    const result = check(delivered);
    expect(result.counts.byCategory['window-undercount']).toBeGreaterThan(0);
    expect(result.counts.byCategory['window-overcount']).toBeGreaterThan(0);
    expect(result.counts.unexplained).toBe(0);
    for (const finding of result.findings.filter((candidate) => candidate.category === 'window-overcount')) {
      const first = finding.causes[0];
      const misplacedHere = first !== undefined && first.windowStartMs !== finding.windowStartMs && first.arrivalWindowStartsMs.includes(finding.windowStartMs);
      const duplicated = first !== undefined && first.deliveries > 1;
      expect(misplacedHere || duplicated).toBe(true);
    }
    for (const finding of result.findings.filter((candidate) => candidate.category === 'window-undercount')) {
      expect(finding.causes[0]?.arrivalWindowStartsMs[0]).not.toBe(finding.windowStartMs);
    }
  });

  it('detect a pipeline that drops events arriving within the allowed lateness', () => {
    const delivered = deliverWindows('correct', profileNamed('windowed-delays'), 'ecommerce-standard');
    expect(check(delivered).counts.findings).toBe(0);
    // The same pipeline configured without lateness closes each window at its end.
    const tooStrict = deliverInMemory({
      events: delivered.simulation.events,
      attempts: delivered.attempts,
      target: createReferenceTarget('correct', { windowing: { ...WINDOWING, allowedLatenessMs: 0 } }),
    }).windows as ActualWindows;
    const strict = check(delivered, tooStrict);
    expect(strict.counts.byCategory['window-undercount']).toBeGreaterThan(0);
    for (const finding of strict.findings) {
      expect(finding.causes[0]?.arrival).toBe('within-lateness');
    }
  });

  it('produce a byte-identical result for the same inputs (golden: naive, late-data, chaos seed 7)', () => {
    const result = check(deliverWindows('naive', profileNamed('late-data')));
    expect(canonicalJson(result)).toBe(canonicalJson(check(deliverWindows('naive', profileNamed('late-data')))));
    expect(sha256Hex(canonicalJson(result))).toBe('10033fcdba2d3632f59d87e2b0e415124706d61f5b9e7a6be974328e298119e5');
  });
});

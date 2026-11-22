import { canonicalJson, sha256Hex } from '@dataforge/core';
import type { ChaosProfileInput } from '@dataforge/chaos';
import type { Finding } from '../src';
import { endToEnd } from './support/world';

const LOSSLESS_EXAMPLES = ['none', 'spec-example', 'flaky-network', 'duplicates-only', 'reorders-only'];

const EXTREME: Record<string, ChaosProfileInput['faults']> = {
  'every event delayed': { delay: { rate: 1, delayMs: { min: 1, max: 3_600_000 } } },
  'every event reordered': { reorder: { rate: 1, distance: { min: 1, max: 3 } } },
  'every event duplicated': { duplicate: { rate: 1, copies: { min: 1, max: 3 }, redeliveryOffsetMs: { min: 0, max: 600_000 } } },
  'every event retried': { transientFailure: { rate: 1, failures: { min: 1, max: 3 }, maxRetries: 3 } },
  'all four at once': {
    delay: { rate: 1, delayMs: { min: 1, max: 3_600_000 } },
    reorder: { rate: 1, distance: { min: 1, max: 3 } },
    duplicate: { rate: 1, copies: { min: 1, max: 3 } },
    transientFailure: { rate: 1, failures: { min: 1, max: 3 }, maxRetries: 3 },
  },
};

const ofCategory = (findings: readonly Finding[], category: Finding['category']) => findings.filter((finding) => finding.category === category);

describe('offline end to end: simulate, plan, deliver, validate', () => {
  it.each(['correct', 'naive'] as const)('%s passes when nothing goes wrong', (target) => {
    expect(endToEnd(target, 'none').verdict).toBe('PASS');
  });

  it.each(LOSSLESS_EXAMPLES)('correct passes under %s', (profile) => {
    expect(endToEnd('correct', profile)).toMatchObject({ verdict: 'PASS', findings: [] });
  });

  it.each(Object.keys(EXTREME))('correct passes with %s, over several chaos seeds', (name) => {
    for (const chaosSeed of ['1', '2', '3']) {
      expect({ chaosSeed, verdict: endToEnd('correct', EXTREME[name], { chaosSeed }).verdict }).toEqual({ chaosSeed, verdict: 'PASS' });
    }
  });

  it('naive under duplicates charges customers twice, and each double charge points at a duplicated event', () => {
    const result = endToEnd('naive', 'duplicates-only');
    expect(result.verdict).toBe('FAIL');
    const doubled = ofCategory(result.findings, 'double-processing');
    const charged = doubled.filter((finding) => finding.differences.some((difference) => difference.field === 'totalPaidMinor'));
    expect(charged.length).toBeGreaterThan(0);
    expect(doubled.some((finding) => finding.entityType === 'order' && finding.differences.some((d) => d.field === 'amountPaidMinor'))).toBe(true);
    for (const finding of doubled) {
      expect({ finding: finding.entityId, first: finding.causes[0]?.faults }).toEqual({ finding: finding.entityId, first: ['duplicate'] });
      expect(finding.causes[0]!.deliveries).toBeGreaterThan(1);
    }
    expect(ofCategory(result.findings, 'status-mismatch').every((finding) => finding.causes[0]?.faults.includes('duplicate'))).toBe(true);
  });

  it('naive under reorders ends orders in the wrong status, and each points at an event that arrived out of order', () => {
    const result = endToEnd('naive', 'reorders-only');
    const wrong = ofCategory(result.findings, 'status-mismatch');
    expect(wrong.length).toBeGreaterThan(0);
    for (const finding of wrong) {
      expect(finding.causes[0]!.overtakenBy.length).toBeGreaterThan(0);
      expect(finding.causes[0]!.faults).toEqual(['reorder']);
    }
    expect(ofCategory(result.findings, 'double-processing')).toEqual([]);
  });

  it.each(['1', '2', '3'])('every naive finding is linked to an abnormal delivery (flaky-network, chaos seed %s)', (chaosSeed) => {
    const result = endToEnd('naive', 'flaky-network', { chaosSeed });
    expect(result.verdict).toBe('FAIL');
    expect(result.counts.unexplained).toBe(0);
  });

  it('correct under loss fails, and every finding is linked to a lost event', () => {
    const result = endToEnd('correct', 'lossy');
    expect(result.verdict).toBe('FAIL');
    expect(ofCategory(result.findings, 'missing-entity').length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect({ finding: `${finding.category} ${finding.entityId}`, lost: finding.causes.some((cause) => cause.lost) }).toEqual({
        finding: `${finding.category} ${finding.entityId}`,
        lost: true,
      });
    }
  });

  it('on the specification-sized scenario, correct passes and naive fails', () => {
    expect(endToEnd('correct', 'spec-example', { scenario: 'ecommerce-standard' }).verdict).toBe('PASS');
    const naive = endToEnd('naive', 'spec-example', { scenario: 'ecommerce-standard' });
    expect(naive.verdict).toBe('FAIL');
    expect(naive.counts.unexplained).toBe(0);
  });

  /**
   * A regression guard, produced by this code: if it fails, findings, their order or their hints
   * changed. Fix the accidental change, or update the hash (and the manual verification values)
   * in the same commit as the intended one.
   */
  it('produces the pinned report for naive, spec-example, chaos seed 7 (golden)', () => {
    const result = endToEnd('naive', 'spec-example');
    expect(result.counts.findings).toBe(48);
    expect(sha256Hex(canonicalJson(result))).toBe('a94e173acf8ba3509dee2669c11c200af17b4ddb0c9243228b92c2efb5c3e43c');
  });
});

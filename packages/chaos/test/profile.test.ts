import { ChaosProfileValidationError, chaosProfileHash, parseChaosProfile } from '../src';

function validationIssues(input: unknown): readonly string[] {
  try {
    parseChaosProfile(input);
  } catch (error) {
    if (error instanceof ChaosProfileValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected the profile to be rejected');
}

describe('chaos profile', () => {
  it('turns every fault type off unless its rate is set', () => {
    const profile = parseChaosProfile({ formatVersion: 1, name: 'minimal' });
    expect(profile.faults.delay).toEqual({ rate: 0, delayMs: { min: 1_000, max: 300_000 } });
    expect(profile.faults.reorder).toEqual({ rate: 0, distance: { min: 1, max: 1 } });
    expect(profile.faults.duplicate).toEqual({ rate: 0, copies: { min: 1, max: 1 }, redeliveryOffsetMs: { min: 0, max: 60_000 } });
    expect(profile.faults.transientFailure).toEqual({
      rate: 0,
      failures: { min: 1, max: 1 },
      maxRetries: 3,
      retryBackoffMs: { min: 1_000, max: 30_000 },
      allowLoss: false,
    });
  });

  it('gives a minimal document and its fully written-out equivalent the same hash', () => {
    const minimal = parseChaosProfile({ formatVersion: 1, name: 'same' });
    const explicit = parseChaosProfile(JSON.parse(JSON.stringify(minimal)));
    expect(chaosProfileHash(explicit)).toBe(chaosProfileHash(minimal));
    expect(chaosProfileHash(parseChaosProfile({ formatVersion: 1, name: 'same', faults: { delay: { rate: 0.01 } } }))).not.toBe(
      chaosProfileHash(minimal),
    );
  });

  it('reports every problem with the path of the offending setting', () => {
    const issues = validationIssues({
      formatVersion: 1,
      name: 'broken',
      faults: {
        delay: { rate: 1.5, delayMs: { min: 10, max: 5 } },
        reorder: { distance: { min: 0, max: 2 } },
        duplicate: { copies: { min: 1, max: 99 } },
        transientFailure: { maxRetries: -1 },
      },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^faults\.delay\.rate: /),
        expect.stringMatching(/^faults\.delay\.delayMs\.max: "min" must be less than or equal to "max"/),
        expect.stringMatching(/^faults\.reorder\.distance\.min: /),
        expect.stringMatching(/^faults\.duplicate\.copies\.max: /),
        expect.stringMatching(/^faults\.transientFailure\.maxRetries: /),
      ]),
    );
    expect(issues).toHaveLength(5);
  });

  it('rejects unknown fields, so a typo is an error rather than a silently ignored setting', () => {
    expect(validationIssues({ formatVersion: 1, name: 'typo', faults: { dealy: { rate: 0.1 } } })).toEqual([
      expect.stringMatching(/^faults: Unrecognized key: "dealy"/),
    ]);
    expect(validationIssues({ formatVersion: 1, name: 'typo', faults: { delay: { rte: 0.1 } } })).toEqual([
      expect.stringMatching(/^faults\.delay: Unrecognized key: "rte"/),
    ]);
  });

  it('requires the format version and a name', () => {
    expect(validationIssues({ name: 'x' })).toEqual([expect.stringMatching(/^formatVersion: formatVersion must be 1/)]);
    expect(validationIssues({ formatVersion: 1 })).toEqual([expect.stringMatching(/^name: /)]);
  });

  it('only allows a profile that can lose events when it opts in with allowLoss', () => {
    const lossy = { rate: 0.1, failures: { min: 1, max: 4 }, maxRetries: 2 };
    expect(validationIssues({ formatVersion: 1, name: 'lossy', faults: { transientFailure: lossy } })).toEqual([
      expect.stringMatching(/^faults\.transientFailure\.failures\.max: cannot exceed maxRetries \(2\) unless allowLoss is true/),
    ]);
    expect(parseChaosProfile({ formatVersion: 1, name: 'lossy', faults: { transientFailure: { ...lossy, allowLoss: true } } }).faults
      .transientFailure.allowLoss).toBe(true);
    expect(() => parseChaosProfile({ formatVersion: 1, name: 'off', faults: { transientFailure: { ...lossy, rate: 0 } } })).not.toThrow();
  });
});

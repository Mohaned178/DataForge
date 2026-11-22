import { ScenarioValidationError, parseScenario, scenarioHash } from '../src';

function validationIssues(input: unknown): readonly string[] {
  try {
    parseScenario(input);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected the scenario to be rejected');
}

describe('scenario configuration', () => {
  it('fills every unspecified setting with a documented default', () => {
    const scenario = parseScenario({ formatVersion: 1, name: 'minimal' });
    expect(scenario.simulation).toEqual({ epoch: '2026-01-01T00:00:00.000Z', durationMs: 7 * 24 * 3_600_000 });
    expect(scenario.catalog).toEqual({ productCount: 50, currency: 'USD', priceMinor: { min: 500, max: 25_000 } });
    expect(scenario.customers.count).toBe(100);
    expect(scenario.orders.count).toBe(500);
    expect(scenario.payments).toMatchObject({ failureRate: 0.1, maxAttempts: 3 });
  });

  it('gives a minimal document and its fully written-out equivalent the same hash', () => {
    const minimal = parseScenario({ formatVersion: 1, name: 'same' });
    const explicit = parseScenario(JSON.parse(JSON.stringify(minimal)));
    expect(scenarioHash(explicit)).toBe(scenarioHash(minimal));
    expect(scenarioHash(parseScenario({ formatVersion: 1, name: 'same', customers: { count: 101 } }))).not.toBe(
      scenarioHash(minimal),
    );
  });

  it('normalizes the epoch to millisecond precision', () => {
    expect(parseScenario({ formatVersion: 1, name: 'x', simulation: { epoch: '2026-05-01T10:00:00Z' } }).simulation.epoch).toBe(
      '2026-05-01T10:00:00.000Z',
    );
  });

  it('reports every problem with the path of the offending setting', () => {
    const issues = validationIssues({
      formatVersion: 1,
      name: 'broken',
      orders: { count: -1, customerCancellationRate: 1.5, paymentDelayMs: { min: 10, max: 5 } },
      payments: { maxAttempts: 0 },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^orders\.count: /),
        expect.stringMatching(/^orders\.customerCancellationRate: /),
        expect.stringMatching(/^orders\.paymentDelayMs\.max: "min" must be less than or equal to "max"/),
        expect.stringMatching(/^payments\.maxAttempts: /),
      ]),
    );
  });

  it('rejects unknown settings, so a typo cannot silently fall back to a default', () => {
    expect(validationIssues({ formatVersion: 1, name: 'typo', customers: { cout: 10 } })).toEqual([
      expect.stringMatching(/^customers: .*cout/),
    ]);
  });

  it('rejects an unsupported format version and a missing name', () => {
    expect(validationIssues({ formatVersion: 2, name: 'x' })).toEqual([expect.stringMatching(/^formatVersion: formatVersion must be 1/)]);
    expect(validationIssues({ formatVersion: 1 })).toEqual([expect.stringMatching(/^name: /)]);
  });

  it('rejects fractional counts and money, which must be integers', () => {
    expect(validationIssues({ formatVersion: 1, name: 'x', customers: { count: 10.5 } })).toEqual([expect.stringMatching(/^customers\.count: /)]);
    expect(validationIssues({ formatVersion: 1, name: 'x', catalog: { priceMinor: { min: 1.25, max: 3 } } })).toEqual([
      expect.stringMatching(/^catalog\.priceMinor\.min: /),
    ]);
  });

  it('rejects orders with more distinct lines than the catalog has products', () => {
    expect(
      validationIssues({ formatVersion: 1, name: 'x', catalog: { productCount: 2 }, orders: { itemsPerOrder: { min: 1, max: 3 } } }),
    ).toEqual([expect.stringMatching(/^orders\.itemsPerOrder\.max: cannot exceed catalog\.productCount \(2\)/)]);
  });

  it('rejects an epoch that is not an explicit UTC instant', () => {
    expect(validationIssues({ formatVersion: 1, name: 'x', simulation: { epoch: '2026-01-01T00:00:00+02:00' } })).toEqual([
      expect.stringMatching(/^simulation\.epoch: /),
    ]);
  });
});

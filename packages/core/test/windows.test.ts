import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_WINDOWS_FORMAT,
  ActualWindowsValidationError,
  HOUR_MS,
  MINUTE_MS,
  buildActualWindows,
  computeExpectedWindows,
  parseActualWindows,
  parseScenario,
  serializeActualWindows,
  simulate,
  windowCloseOf,
  windowContribution,
  windowStartOf,
  windowingSpecSchema,
} from '../src';

const REPO_ROOT = join(__dirname, '..', '..', '..');

function smallWorld() {
  const scenario = parseScenario(JSON.parse(readFileSync(join(REPO_ROOT, 'scenarios', 'ecommerce-small.json'), 'utf8')));
  return simulate({ scenario, seed: '42' });
}

describe('windowing contract', () => {
  it('defaults the allowed lateness to 0 and rejects unknown fields and out-of-range sizes', () => {
    expect(windowingSpecSchema.parse({ sizeMs: HOUR_MS })).toEqual({ sizeMs: HOUR_MS, allowedLatenessMs: 0 });
    expect(windowingSpecSchema.safeParse({ sizeMs: HOUR_MS, slideMs: 1 }).success).toBe(false);
    expect(windowingSpecSchema.safeParse({ sizeMs: 999 }).success).toBe(false);
    expect(windowingSpecSchema.safeParse({ sizeMs: HOUR_MS, allowedLatenessMs: -1 }).success).toBe(false);
  });

  it('aligns tumbling windows to simulation time 0 and closes them after the allowed lateness', () => {
    const spec = { sizeMs: HOUR_MS, allowedLatenessMs: 10 * MINUTE_MS };
    expect(windowStartOf(0, HOUR_MS)).toBe(0);
    expect(windowStartOf(HOUR_MS - 1, HOUR_MS)).toBe(0);
    expect(windowStartOf(HOUR_MS, HOUR_MS)).toBe(HOUR_MS);
    expect(windowStartOf(5 * HOUR_MS + 59 * MINUTE_MS, HOUR_MS)).toBe(5 * HOUR_MS);
    expect(windowCloseOf(2 * HOUR_MS, spec)).toBe(3 * HOUR_MS + 10 * MINUTE_MS);
    expect(windowCloseOf(2 * HOUR_MS, { ...spec, allowedLatenessMs: 0 })).toBe(3 * HOUR_MS);
  });
});

describe('expected windows', () => {
  const world = smallWorld();
  const windows = computeExpectedWindows(world.events, HOUR_MS);

  it('add up to the orders and the revenue of the expected state', () => {
    const sum = (metric: 'ordersCreated' | 'paymentsCompleted' | 'revenueMinor') => windows.reduce((total, window) => total + window[metric], 0);
    expect(sum('ordersCreated')).toBe(world.expectedState.summary.orders);
    expect(sum('revenueMinor')).toBe(world.expectedState.summary.revenueMinor);
    expect(sum('paymentsCompleted')).toBe(world.expectedState.payments.filter((payment) => payment.status === 'COMPLETED').length);
  });

  it('count each event in the window of its event time, and list only windows with something in them', () => {
    for (const window of windows) {
      expect(window.windowEndMs - window.windowStartMs).toBe(HOUR_MS);
      expect(window.windowStartMs % HOUR_MS).toBe(0);
      const inside = world.events.filter((event) => event.eventTimeMs >= window.windowStartMs && event.eventTimeMs < window.windowEndMs);
      expect(window.ordersCreated).toBe(inside.filter((event) => event.type === 'OrderCreated').length);
      expect(window.ordersCreated + window.paymentsCompleted).toBeGreaterThan(0);
    }
    expect(windows.map((window) => window.windowStartMs)).toEqual([...windows.map((window) => window.windowStartMs)].sort((a, b) => a - b));
  });

  it('count only OrderCreated and PaymentCompleted', () => {
    const types = new Set(world.events.filter((event) => windowContribution(event) !== undefined).map((event) => event.type));
    expect([...types].sort()).toEqual(['OrderCreated', 'PaymentCompleted']);
  });

  it('depend on the window size only through grouping', () => {
    const daily = computeExpectedWindows(world.events, 24 * HOUR_MS);
    expect(daily.reduce((total, window) => total + window.revenueMinor, 0)).toBe(world.expectedState.summary.revenueMinor);
    expect(daily.length).toBeLessThan(windows.length);
  });
});

describe('actual windows contract', () => {
  const sample = buildActualWindows([
    { windowStartMs: HOUR_MS, windowEndMs: 2 * HOUR_MS, ordersCreated: 1, paymentsCompleted: 0, revenueMinor: 0 },
    { windowStartMs: 0, windowEndMs: HOUR_MS, ordersCreated: 2, paymentsCompleted: 1, revenueMinor: 1999 },
  ]);

  it('round-trips through its JSON form, sorted by window start', () => {
    expect(sample.windows.map((window) => window.windowStartMs)).toEqual([0, HOUR_MS]);
    expect(parseActualWindows(JSON.parse(serializeActualWindows(sample)))).toEqual(sample);
  });

  it('reports the path of every problem, including unknown fields', () => {
    const bad = {
      format: ACTUAL_WINDOWS_FORMAT,
      formatVersion: 1,
      windows: [{ windowStartMs: 0, windowEndMs: HOUR_MS, ordersCreated: 1.5, paymentsCompleted: 0, revenueMinor: 0, region: 'eu' }],
    };
    let error: unknown;
    try {
      parseActualWindows(bad);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ActualWindowsValidationError);
    const paths = (error as ActualWindowsValidationError).issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['windows.0.ordersCreated', 'windows.0']));
    expect(() => parseActualWindows({ ...sample, format: 'dataforge.actual-state' })).toThrow(/format must be "dataforge.actual-windows"/);
  });

  it('keeps a window listed twice, so the validator can report it', () => {
    const twice = { ...sample, windows: [...sample.windows, sample.windows[0]] };
    expect(parseActualWindows(twice).windows).toHaveLength(3);
  });
});

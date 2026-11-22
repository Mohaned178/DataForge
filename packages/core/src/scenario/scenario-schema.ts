import { z } from 'zod';
import { canonicalJson } from '../serialization/canonical-json';
import { sha256Hex } from '../hashing';
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, normalizeUtcInstant, parseUtcInstant } from '../time/sim-time';

export const SCENARIO_FORMAT_VERSION = 1;

export const SCENARIO_LIMITS = {
  maxProducts: 10_000,
  maxCustomers: 100_000,
  maxOrders: 100_000,
  maxItemsPerOrder: 20,
  maxQuantityPerItem: 100,
  maxPriceMinor: 10_000_000,
  maxPaymentAttempts: 10,
  minDurationMs: MINUTE_MS,
  maxDurationMs: 366 * DAY_MS,
  maxDelayMs: 30 * DAY_MS,
} as const;

function boundedInt(min: number, max: number) {
  return z.number().int().min(min).max(max);
}

function intRange(min: number, max: number, defaults: { min: number; max: number }) {
  return z
    .strictObject({ min: boundedInt(min, max), max: boundedInt(min, max) })
    .refine((range) => range.min <= range.max, { error: '"min" must be less than or equal to "max"', path: ['max'] })
    .prefault(defaults);
}

function delayRange(defaults: { min: number; max: number }) {
  return intRange(1, SCENARIO_LIMITS.maxDelayMs, defaults);
}

const probability = (defaultValue: number) => z.number().min(0).max(1).default(defaultValue);

const utcInstant = z.string().transform((value, ctx) => {
  try {
    parseUtcInstant(value);
    return normalizeUtcInstant(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

export const scenarioSchema = z
  .strictObject({
    formatVersion: z.literal(SCENARIO_FORMAT_VERSION, { error: `formatVersion must be ${SCENARIO_FORMAT_VERSION}` }),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1_000).optional(),
    simulation: z
      .strictObject({
        epoch: utcInstant.default('2026-01-01T00:00:00.000Z'),
        durationMs: boundedInt(SCENARIO_LIMITS.minDurationMs, SCENARIO_LIMITS.maxDurationMs).default(7 * DAY_MS),
      })
      .prefault({}),
    catalog: z
      .strictObject({
        productCount: boundedInt(1, SCENARIO_LIMITS.maxProducts).default(50),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/, 'currency must be a three-letter ISO 4217 code such as USD')
          .default('USD'),
        priceMinor: intRange(1, SCENARIO_LIMITS.maxPriceMinor, { min: 500, max: 25_000 }),
      })
      .prefault({}),
    customers: z
      .strictObject({
        count: boundedInt(1, SCENARIO_LIMITS.maxCustomers).default(100),
      })
      .prefault({}),
    orders: z
      .strictObject({
        count: boundedInt(0, SCENARIO_LIMITS.maxOrders).default(500),
        itemsPerOrder: intRange(1, SCENARIO_LIMITS.maxItemsPerOrder, { min: 1, max: 4 }),
        quantityPerItem: intRange(1, SCENARIO_LIMITS.maxQuantityPerItem, { min: 1, max: 3 }),
        customerCancellationRate: probability(0.05),
        customerCancellationDelayMs: delayRange({ min: MINUTE_MS, max: HOUR_MS }),
        paymentDelayMs: delayRange({ min: SECOND_MS, max: 10 * MINUTE_MS }),
      })
      .prefault({}),
    payments: z
      .strictObject({
        failureRate: probability(0.1),
        maxAttempts: boundedInt(1, SCENARIO_LIMITS.maxPaymentAttempts).default(3),
        retryDelayMs: delayRange({ min: MINUTE_MS, max: 30 * MINUTE_MS }),
        cancellationDelayMs: delayRange({ min: SECOND_MS, max: MINUTE_MS }),
      })
      .prefault({}),
    shipments: z
      .strictObject({
        fulfillmentDelayMs: delayRange({ min: HOUR_MS, max: DAY_MS }),
        deliveryDelayMs: delayRange({ min: DAY_MS, max: 5 * DAY_MS }),
      })
      .prefault({}),
  })
  .superRefine((scenario, ctx) => {
    if (scenario.orders.itemsPerOrder.max > scenario.catalog.productCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['orders', 'itemsPerOrder', 'max'],
        message: `cannot exceed catalog.productCount (${scenario.catalog.productCount}) because order lines use distinct products`,
      });
    }
  });

export type ScenarioInput = z.input<typeof scenarioSchema>;
export type ScenarioConfig = z.output<typeof scenarioSchema>;

export class ScenarioValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid scenario configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ScenarioValidationError';
  }
}

/** Validates a scenario document and fills in defaults. Throws ScenarioValidationError on failure. */
export function parseScenario(input: unknown): ScenarioConfig {
  const result = scenarioSchema.safeParse(input);
  if (!result.success) {
    throw new ScenarioValidationError(result.error.issues.map(formatIssue));
  }
  return result.data;
}

/** Fingerprint of a resolved scenario. Two documents that resolve to the same config share a hash. */
export function scenarioHash(config: ScenarioConfig): string {
  return `sha256:${sha256Hex(canonicalJson(config))}`;
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
  return `${path}: ${issue.message}`;
}

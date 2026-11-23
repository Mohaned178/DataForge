/** Ports the suite's own servers listen on: not the integration tests', and not any milestone's self-check (3106 to 3109, 5208 and 5209). */
export const API_PORT = 3209;
export const WEB_PORT = 5309;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/**
 * What `dataforge generate --scenario scenarios/ecommerce-small.json --seed 42` writes, pinned by the core's golden
 * test (packages/core/test/golden.test.ts). A run launched from the UI from the unchanged example must match it.
 */
export const GOLDEN_SMALL_SEED_42 = {
  eventCount: 472,
  eventsSha256: '01b57d640ab12e33702ccb72339fd00552e6b37b3fddce4dff7a5a8c0cca42de',
  expectedStateSha256: '3546842d89241f81b31bd2bfaa11916fff0ee04cc400195a70b4c2e6beff2101',
  scenarioResolvedSha256: 'f642fb41261117d68dde26c14b0859b6fd01d898c1c3c0dc5fcf8354e1978714',
} as const;

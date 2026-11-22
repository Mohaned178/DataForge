/**
 * Identifies the generation algorithm. Any change that alters the output produced for the same
 * scenario and seed must bump this version (the golden test in test/golden.test.ts enforces it).
 */
export const ENGINE_VERSION = '0.1.0';

/** Version of the canonical event envelope and payload schemas. */
export const EVENT_SCHEMA_VERSION = 1;

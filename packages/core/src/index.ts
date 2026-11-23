export { ENGINE_VERSION, EVENT_SCHEMA_VERSION } from './version';
export { sha256Hex } from './hashing';
export { canonicalJson, compareCodeUnits } from './serialization/canonical-json';

export { RandomStream, deriveStreamState, type IntRange, type WeightedChoice } from './random/random-stream';
export { Xoshiro128StarStar, type Xoshiro128State } from './random/xoshiro128';

export { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, normalizeUtcInstant, parseUtcInstant, simTimeToIso } from './time/sim-time';

export {
  SCENARIO_FORMAT_VERSION,
  SCENARIO_LIMITS,
  ScenarioValidationError,
  parseScenario,
  scenarioHash,
  scenarioSchema,
  type ScenarioConfig,
  type ScenarioInput,
} from './scenario/scenario-schema';
export { InvalidSeedError, normalizeSeed } from './scenario/seed';

export * from './domain/ids';
export * from './domain/order-lifecycle';

export {
  AGGREGATE_TYPE_BY_EVENT_TYPE,
  EVENT_TYPES,
  canonicalEventSchema,
  type AggregateType,
  type CanonicalEvent,
  type EventOfType,
  type EventType,
  type OrderLine,
  type PayloadOf,
} from './events/canonical-event';
export {
  EVENT_UPCASTERS,
  EventVersionError,
  upcastEventRecord,
  versionedEventSchema,
  type EventUpcaster,
  type EventUpcasters,
} from './events/upcast';
export { compareCanonicalOrder, draftEvent, sequenceDrafts, type EventDraft, type EventDraftOf } from './events/event-draft';
export {
  BYTE_ORDER_MARK_CODE,
  EventLogParseError,
  parseEventLog,
  serializeEventLog,
  stripByteOrderMark,
} from './events/event-log-jsonl';

export { defineRule, type BusinessRule, type RuleDefinition } from './rules/business-rule';
export { ECOMMERCE_RULES } from './rules/ecommerce-rules';
export {
  ECOMMERCE_INVARIANTS,
  ENTITY_TYPES,
  INVARIANT_CATEGORIES,
  type EntityType,
  type InvariantCategory,
  type InvariantViolation,
  type StateInvariant,
} from './rules/state-invariants';

export { ProjectionError, applyEvent } from './projection/apply-event';
export {
  EXPECTED_STATE_FORMAT,
  EXPECTED_STATE_FORMAT_VERSION,
  buildExpectedState,
  serializeExpectedState,
  type ExpectedState,
  type ExpectedStateSummary,
} from './projection/expected-state';
export {
  ACTUAL_STATE_FORMAT,
  ACTUAL_STATE_FORMAT_VERSION,
  ActualStateValidationError,
  actualStateSchema,
  buildActualState,
  parseActualState,
  serializeActualState,
  type ActualState,
} from './projection/actual-state';
export { CanonicalLogViolationError, replayCanonicalLog, type ReplayResult, type RuleViolation } from './projection/replay';
export * from './projection/world-state';

export { simulate, type SimulationInput, type SimulationResult } from './generation/simulate';

export {
  WINDOWING_LIMITS,
  WINDOW_METRICS,
  WINDOW_METRIC_EVENT_TYPE,
  WindowAccumulator,
  computeExpectedWindows,
  windowCloseOf,
  windowContribution,
  windowStartOf,
  windowingSpecSchema,
  type WindowAggregate,
  type WindowMetric,
  type WindowMetrics,
  type WindowingSpec,
} from './windows/windowing';
export {
  ACTUAL_WINDOWS_FORMAT,
  ACTUAL_WINDOWS_FORMAT_VERSION,
  ActualWindowsValidationError,
  actualWindowsSchema,
  buildActualWindows,
  parseActualWindows,
  serializeActualWindows,
  type ActualWindows,
} from './windows/actual-windows';

export {
  CHECKSUMMED_FILES,
  RUN_FILES,
  RUN_FILE_NAMES,
  buildRunFiles,
  countEventsByType,
  fileEntry,
  fileEntrySchema,
  runManifestSchema,
  serializeResolvedScenario,
  serializeRunManifest,
  type ChecksummedFile,
  type FileEntry,
  type RunFileName,
  type RunFiles,
  type RunManifest,
} from './run/run-files';

export type { DeliveryHeaders, DeliveryMessage } from './message';
export type { Target, TargetResult } from './target';
export { CorrectTarget } from './reference/correct';
export { NaiveTarget } from './reference/naive';
export { REFERENCE_TARGETS, createReferenceTarget, type ReferenceTargetName } from './reference/reference-targets';
export {
  PlanDoesNotMatchLogError,
  deliverInMemory,
  type InMemoryDeliveryInput,
  type InMemoryDeliveryResult,
} from './transport/in-memory';

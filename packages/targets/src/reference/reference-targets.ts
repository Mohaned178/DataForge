import type { Target } from '../target';
import { CorrectTarget } from './correct';
import { NaiveTarget } from './naive';

export const REFERENCE_TARGETS = ['correct', 'naive'] as const;
export type ReferenceTargetName = (typeof REFERENCE_TARGETS)[number];

/** A fresh instance of a reference target; each run needs its own, since targets keep state. */
export function createReferenceTarget(name: ReferenceTargetName): Target {
  return name === 'correct' ? new CorrectTarget() : new NaiveTarget();
}

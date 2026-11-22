import type { ActualState } from '@dataforge/core';
import type { DeliveryMessage } from './message';

export interface TargetResult {
  readonly actualState: ActualState;
  /** Target-specific tallies (for example duplicates ignored, or updates lost), sorted by name in JSON. */
  readonly counters: Readonly<Record<string, number>>;
  /** Events the target received but never applied, because what they wait for never arrived. */
  readonly parkedEventIds: readonly string[];
}

/** A pipeline under test: it receives messages one at a time and reports the state it ended in. */
export interface Target {
  readonly name: string;
  readonly description: string;
  handle(message: DeliveryMessage): void;
  finish(): TargetResult;
}

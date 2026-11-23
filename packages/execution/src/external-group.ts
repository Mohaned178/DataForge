import type { ConsumerGroupDescription, GroupLag } from '@dataforge/kafka';

/** An external pipeline that cannot be tested as it is: the topic, the group or its position is wrong. */
export class ExternalPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalPipelineError';
  }
}

export interface ExternalPipelineState {
  readonly topic: string;
  readonly groupId: string;
  /** The topic's partition count; undefined when the topic does not exist. */
  readonly partitions: number | undefined;
  readonly group: ConsumerGroupDescription;
  /** The group's lag on the topic before the first record; undefined when the topic does not exist. */
  readonly lag: GroupLag | undefined;
}

/**
 * Why an external pipeline cannot be tested now, or undefined when it can. Zero lag after the last
 * record is the completion signal, so before the first one the group must be active on the topic
 * and must have consumed everything already in it; otherwise completion could never be detected, or
 * records from before the execution would be counted as part of it.
 */
export function externalPipelineProblem(state: ExternalPipelineState): string | undefined {
  const { topic, groupId, group } = state;
  if (state.partitions === undefined || state.lag === undefined) {
    return `Topic "${topic}" does not exist. An external execution produces to your pipeline's topic: create it, and start your pipeline on it, before the execution.`;
  }
  if (group.members.length === 0) {
    return (
      `Consumer group "${groupId}" has no active member (group state ${group.state}). ` +
      `Start your pipeline, consuming "${topic}" with group "${groupId}", before the execution: without an active member the group's lag never reaches zero.`
    );
  }
  const decoded = group.members.filter((member) => member.topics !== undefined);
  if (decoded.length === group.members.length && !decoded.some((member) => member.topics?.includes(topic))) {
    const subscribed = [...new Set(decoded.flatMap((member) => member.topics ?? []))].sort();
    return (
      `No member of consumer group "${groupId}" subscribes to "${topic}" ` +
      `(the group subscribes to ${subscribed.length === 0 ? 'nothing' : subscribed.map((name) => `"${name}"`).join(', ')}).`
    );
  }
  if (state.lag.total > 0) {
    return (
      `Consumer group "${groupId}" has ${state.lag.total} records of "${topic}" it has not consumed yet. ` +
      'They could not be told apart from the execution\'s records: let the pipeline catch up, or use a new topic or group.'
    );
  }
  return undefined;
}

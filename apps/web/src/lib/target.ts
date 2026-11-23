import type { Target } from '../api/schemas';

/** A target in one line: "naive · kafka", or "external · topic / group". */
export function describeTarget(target: Target): string {
  if (target.type === 'external') return `external · ${target.topic} / ${target.groupId}`;
  return `${target.name} · ${target.transport}`;
}

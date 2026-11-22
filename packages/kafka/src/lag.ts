/** A partition's log offsets, as the broker reports them: `high` is the next offset to be written. */
export interface PartitionOffsets {
  readonly partition: number;
  readonly low: string;
  readonly high: string;
}

/** A consumer group's committed offset for a partition: the next offset it will read, "-1" if none. */
export interface CommittedOffset {
  readonly partition: number;
  readonly offset: string;
}

export interface PartitionLag {
  readonly partition: number;
  readonly endOffset: string;
  readonly committedOffset: string | null;
  readonly lag: number;
}

export interface GroupLag {
  readonly total: number;
  readonly partitions: readonly PartitionLag[];
}

/**
 * Lag per partition = log end offset - committed offset (or the log start, when the group has not
 * committed). Zero over every partition means the group has handled every record written so far.
 */
export function consumerGroupLag(ends: readonly PartitionOffsets[], committed: readonly CommittedOffset[]): GroupLag {
  const committedByPartition = new Map(committed.map((entry) => [entry.partition, entry.offset]));
  const partitions = [...ends]
    .sort((a, b) => a.partition - b.partition)
    .map((end): PartitionLag => {
      const commit = committedByPartition.get(end.partition);
      const hasCommit = commit !== undefined && BigInt(commit) >= 0n;
      const position = hasCommit ? BigInt(commit) : BigInt(end.low);
      const lag = BigInt(end.high) - position;
      return { partition: end.partition, endOffset: end.high, committedOffset: hasCommit ? commit : null, lag: Number(lag > 0n ? lag : 0n) };
    });
  return { total: partitions.reduce((sum, partition) => sum + partition.lag, 0), partitions };
}

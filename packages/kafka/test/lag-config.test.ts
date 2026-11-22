import { BrokerListError, consumerGroupLag, consumerToParentSchema, parentToConsumerSchema, parseBrokers } from '../src';

describe('consumer-group lag', () => {
  const ends = [
    { partition: 1, low: '0', high: '40' },
    { partition: 0, low: '0', high: '100' },
    { partition: 2, low: '5', high: '5' },
  ];

  it('is the log end offset minus the committed offset, summed over partitions in partition order', () => {
    const lag = consumerGroupLag(ends, [
      { partition: 0, offset: '100' },
      { partition: 1, offset: '30' },
      { partition: 2, offset: '5' },
    ]);
    expect(lag).toEqual({
      total: 10,
      partitions: [
        { partition: 0, endOffset: '100', committedOffset: '100', lag: 0 },
        { partition: 1, endOffset: '40', committedOffset: '30', lag: 10 },
        { partition: 2, endOffset: '5', committedOffset: '5', lag: 0 },
      ],
    });
  });

  it('counts from the log start when the group has not committed ("-1" or no entry)', () => {
    const lag = consumerGroupLag(ends, [{ partition: 0, offset: '-1' }]);
    expect(lag.total).toBe(140);
    expect(lag.partitions.map((partition) => partition.committedOffset)).toEqual([null, null, null]);
  });

  it('is zero exactly when every partition is committed up to its end', () => {
    expect(consumerGroupLag(ends, ends.map((end) => ({ partition: end.partition, offset: end.high }))).total).toBe(0);
    expect(consumerGroupLag([{ partition: 0, low: '0', high: '0' }], []).total).toBe(0);
  });
});

describe('broker list', () => {
  it('accepts host:port lists, trimming spaces and empty entries', () => {
    expect(parseBrokers('localhost:9092')).toEqual(['localhost:9092']);
    expect(parseBrokers(' kafka-1.local:9092 , 10.0.0.2:19092,,[::1]:9092 ')).toEqual(['kafka-1.local:9092', '10.0.0.2:19092', '[::1]:9092']);
  });

  it.each(['', ' , ', 'localhost', 'localhost:0', 'localhost:65536', 'http://localhost:9092', 'local host:9092'])('rejects "%s"', (text) => {
    expect(() => parseBrokers(text)).toThrow(BrokerListError);
  });
});

describe('consumer process protocol', () => {
  it('accepts the documented messages and nothing else', () => {
    expect(consumerToParentSchema.safeParse({ type: 'ready', partitions: [0, 1] }).success).toBe(true);
    expect(consumerToParentSchema.safeParse({ type: 'finished' }).success).toBe(true);
    expect(consumerToParentSchema.safeParse({ type: 'failed', message: 'x' }).success).toBe(true);
    expect(consumerToParentSchema.safeParse({ type: 'ready' }).success).toBe(false);
    expect(parentToConsumerSchema.safeParse({ type: 'finish' }).success).toBe(true);
    expect(parentToConsumerSchema.safeParse({ type: 'finish', now: true }).success).toBe(false);
  });
});

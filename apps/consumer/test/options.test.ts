import { ConsumerUsageError, parseConsumerOptions } from '../src/options';

const required = ['--topic', 'dataforge.test', '--group', 'dataforge-consumer.test', '--target', 'naive', '--out', 'out/x'];

describe('consumer command line', () => {
  it('reads every option, with brokers from --brokers, then KAFKA_BROKERS, then localhost:9092', () => {
    expect(parseConsumerOptions(required, {})).toEqual({
      brokers: ['localhost:9092'],
      topic: 'dataforge.test',
      groupId: 'dataforge-consumer.test',
      target: 'naive',
      out: 'out/x',
      force: false,
    });
    expect(parseConsumerOptions(required, { KAFKA_BROKERS: 'k1:9092,k2:9092' }).brokers).toEqual(['k1:9092', 'k2:9092']);
    expect(parseConsumerOptions([...required, '--brokers', 'k3:1', '--force'], { KAFKA_BROKERS: 'k1:9092' })).toMatchObject({ brokers: ['k3:1'], force: true });
  });

  it.each([
    [['--topic', 't', '--group', 'g', '--target', 'naive'], /Missing required option/],
    [[...required.slice(0, 5), 'clever', '--out', 'x'], /Unknown target "clever"/],
    [['--topic', 'bad topic', ...required.slice(2)], /Invalid topic/],
    [[...required, '--brokers', 'nowhere'], /Invalid Kafka broker list/],
    [[...required, '--verbose'], /Unknown option/],
    [[...required, '--allowed-lateness-ms', '600000'], /--allowed-lateness-ms needs --window-size-ms/],
    [[...required, '--window-size-ms', '10'], /Invalid windowing: sizeMs/],
    [[...required, '--window-size-ms', '1h'], /Invalid windowing: sizeMs/],
    [[...required, '--window-size-ms', '3600000', '--allowed-lateness-ms', '1.5'], /Invalid windowing: allowedLatenessMs/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseConsumerOptions(argv, {})).toThrow(ConsumerUsageError);
    expect(() => parseConsumerOptions(argv, {})).toThrow(message);
  });

  it('reads a windowing contract, with no allowed lateness unless given', () => {
    expect(parseConsumerOptions(required, {}).windowing).toBeUndefined();
    expect(parseConsumerOptions([...required, '--window-size-ms', '3600000'], {}).windowing).toEqual({ sizeMs: 3_600_000, allowedLatenessMs: 0 });
    expect(parseConsumerOptions([...required, '--window-size-ms', '3600000', '--allowed-lateness-ms', '600000'], {}).windowing).toEqual({
      sizeMs: 3_600_000,
      allowedLatenessMs: 600_000,
    });
  });
});

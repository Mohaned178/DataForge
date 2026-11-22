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
  ])('rejects %j', (argv, message) => {
    expect(() => parseConsumerOptions(argv, {})).toThrow(ConsumerUsageError);
    expect(() => parseConsumerOptions(argv, {})).toThrow(message);
  });
});

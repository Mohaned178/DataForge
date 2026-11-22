#!/usr/bin/env node
import {
  ConsumerRunner,
  createKafkaClient,
  parentToConsumerSchema,
  silenceKafkaClientTimerWarning,
  type ConsumerToParent,
} from '@dataforge/kafka';
import { createReferenceTarget } from '@dataforge/targets';
import { ConsumerUsageError, parseConsumerOptions, type ConsumerOptions } from './options';
import { prepareConsumerOutput, writeConsumerOutput } from './outputs';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

/** Tells the parent process (when there is one), then exits once the message is on its way. */
function sendThenExit(message: ConsumerToParent | undefined, code: number): void {
  if (message !== undefined && process.send !== undefined && process.connected) {
    process.send(message, () => process.exit(code));
    return;
  }
  process.exit(code);
}

async function main(options: ConsumerOptions): Promise<void> {
  const target = createReferenceTarget(options.target);
  const kafka = createKafkaClient({ brokers: options.brokers, clientId: `dataforge-consumer-${options.target}`, log: err });
  const runner = new ConsumerRunner({ kafka, topic: options.topic, groupId: options.groupId, target });
  let finishing = false;

  const fail = (error: unknown) => {
    if (finishing) {
      return;
    }
    finishing = true;
    const message = (error as Error).message ?? String(error);
    err(`dataforge-consumer: FAILED: ${message}`);
    void runner.stop().then(() => sendThenExit({ type: 'failed', message }, EXIT_FAILED));
  };

  const finish = () => {
    if (finishing) {
      return;
    }
    finishing = true;
    runner
      .finish()
      .then((outcome) => {
        const report = writeConsumerOutput(options, target, outcome);
        out(
          `  consumed    ${report.messages} records: ${report.distinctEvents} distinct events, ${report.redeliveries} redeliveries` +
            (report.kafkaRedeliveries > 0 ? `, ${report.kafkaRedeliveries} handed over twice by Kafka` : ''),
        );
        out(`  output      ${options.out} (actual-state.json, consumer-report.json, processing-log.jsonl)`);
        sendThenExit({ type: 'finished' }, 0);
      })
      .catch((error: unknown) => {
        finishing = false;
        fail(error);
      });
  };

  process.on('message', (message: unknown) => {
    if (parentToConsumerSchema.safeParse(message).success) {
      finish();
    }
  });
  process.on('disconnect', finish);
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  void runner.failure.then(fail);

  out(`DataForge consumer: target ${target.name} (${target.description})`);
  out(`  kafka       ${options.brokers.join(',')}, topic ${options.topic}, group ${options.groupId}`);
  const started = Date.now();
  const partitions = await runner.start();
  out(`  joined      partitions ${partitions.join(', ')} after ${((Date.now() - started) / 1000).toFixed(1)} s; consuming (Ctrl+C to finish and write the state)`);
  if (process.send !== undefined && process.connected) {
    process.send({ type: 'ready', partitions: [...partitions] } satisfies ConsumerToParent);
  }
}

function readOptions(): ConsumerOptions | undefined {
  try {
    const parsed = parseConsumerOptions(process.argv.slice(2), process.env);
    prepareConsumerOutput(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ConsumerUsageError) {
      err(error.message);
      sendThenExit({ type: 'failed', message: error.message }, EXIT_USAGE);
      return undefined;
    }
    throw error;
  }
}

silenceKafkaClientTimerWarning();
const options = readOptions();
if (options !== undefined) {
  main(options).catch((error: unknown) => {
    const message = (error as Error).message ?? String(error);
    err(`dataforge-consumer: FAILED: ${message}`);
    sendThenExit({ type: 'failed', message }, EXIT_FAILED);
  });
}

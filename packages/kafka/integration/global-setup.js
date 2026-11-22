// Runs once before the integration tests (after `pnpm build`, which test:integration does first).
const { DEFAULT_BROKERS, connectAdmin, createKafkaClient, parseBrokers, silenceKafkaClientTimerWarning } = require('../dist/index.js');

module.exports = async function checkKafka() {
  silenceKafkaClientTimerWarning();
  const brokers = parseBrokers(process.env.KAFKA_BROKERS ?? DEFAULT_BROKERS);
  const kafka = createKafkaClient({ brokers, clientId: 'dataforge-integration-check', log: () => undefined });
  try {
    const { admin } = await connectAdmin(kafka, brokers);
    await admin.disconnect();
  } catch (error) {
    throw new Error(
      [
        '',
        'KAFKA UNAVAILABLE: the integration tests need a running Kafka broker and did not run.',
        `  ${error.message}`,
        '  Start it with:   docker compose up -d --wait',
        '  Then rerun:      pnpm test:integration',
        '',
      ].join('\n'),
      { cause: error },
    );
  }
};

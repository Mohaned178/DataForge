// Global setup of pnpm test:integration: checks every piece of infrastructure the suite needs and
// reports all that are missing at once, instead of skipping tests silently.
const checkKafka = require('./packages/kafka/integration/global-setup.js');
const preparePostgres = require('./apps/api/integration/global-setup.js');

module.exports = async function checkInfrastructure() {
  const results = await Promise.allSettled([checkKafka(), preparePostgres()]);
  const problems = results.filter((result) => result.status === 'rejected').map((result) => result.reason.message);
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
};

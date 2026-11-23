/*
 * Real API responses captured by scripts/capture-fixtures.mjs (small scenario, seed 42, chaos seed 7).
 * They are generated: regenerate them, do not edit them.
 */
import aggregateDuplicate from './fixtures/aggregate-duplicate.json';
import aggregateKafka from './fixtures/aggregate-kafka.json';
import aggregateLate from './fixtures/aggregate-late.json';
import aggregateLost from './fixtures/aggregate-lost.json';
import aggregateReorder from './fixtures/aggregate-reorder.json';
import executionFail from './fixtures/execution-fail.json';
import executionKafka from './fixtures/execution-kafka.json';
import executionLate from './fixtures/execution-late.json';
import executionLossy from './fixtures/execution-lossy.json';
import executionPass from './fixtures/execution-pass.json';
import executions from './fixtures/executions.json';
import findingsFail from './fixtures/findings-fail.json';
import findingsLossy from './fixtures/findings-lossy.json';
import index from './fixtures/index.json';
import reportFail from './fixtures/report-fail.json';
import reportKafka from './fixtures/report-kafka.json';
import reportLate from './fixtures/report-late.json';
import reportLossy from './fixtures/report-lossy.json';
import reportPass from './fixtures/report-pass.json';
import run from './fixtures/run.json';
import runEvents from './fixtures/run-events.json';
import runs from './fixtures/runs.json';
import windowFindingsLate from './fixtures/window-findings-late.json';

export const fixtures = {
  index,
  runs,
  run,
  runEvents,
  executions,
  execution: { pass: executionPass, fail: executionFail, late: executionLate, lossy: executionLossy, kafka: executionKafka },
  report: { pass: reportPass, fail: reportFail, late: reportLate, lossy: reportLossy, kafka: reportKafka },
  findings: { fail: findingsFail, lossy: findingsLossy },
  windowFindings: { late: windowFindingsLate },
  aggregate: { reorder: aggregateReorder, duplicate: aggregateDuplicate, lost: aggregateLost, late: aggregateLate, kafka: aggregateKafka },
};

export type AggregateFixture = (typeof fixtures.aggregate)[keyof typeof fixtures.aggregate];

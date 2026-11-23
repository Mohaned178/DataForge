// Captures the API responses the web tests use (apps/web/src/test/fixtures/*.json) from a running API.
//
//   node apps/web/scripts/capture-fixtures.mjs [api-url]      (default http://127.0.0.1:3000)
//
// It registers the example scenario and chaos profiles, generates the small scenario with seed 42,
// runs the executions the tests need (chaos seed 7), and saves the real responses. Run it against a
// freshly migrated scratch database. The simulation and the planner are deterministic, so the same
// inputs give the same fixtures, apart from the generated IDs and timestamps. The fixtures are generated:
// regenerate them instead of editing them, then run "pnpm test:web".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = join(root, 'apps/web/src/test/fixtures');
mkdirSync(outDir, { recursive: true });

async function call(method, path, body) {
  const response = await fetch(api + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  return JSON.parse(text);
}
const get = (path) => call('GET', path);
const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const save = (name, value) => writeFileSync(join(outDir, `${name}.json`), JSON.stringify(value));
const until = async (path, done) => {
  for (;;) {
    const value = await get(path);
    if (done(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
};

async function register(kind, listKey, file) {
  const definition = readJson(file);
  try {
    return (await call('POST', `/${kind}`, definition)).id;
  } catch (error) {
    if (!String(error).includes(' 409 ')) throw error;
    return (await get(`/${kind}`))[listKey].find((item) => item.name === definition.name).id;
  }
}

const scenarioId = await register('scenarios', 'scenarios', 'scenarios/ecommerce-small.json');
const profile = {};
for (const name of ['none', 'spec-example', 'late-data', 'lossy']) {
  profile[name] = await register('chaos-profiles', 'chaosProfiles', `chaos-profiles/${name}.json`);
}
const queued = await call('POST', '/runs', { scenarioId, seed: 42 });
const run = await until(`/runs/${queued.id}`, (value) => value.status === 'succeeded');

const execution = {};
async function execute(label, profileName, target) {
  const started = await call('POST', '/executions', { runId: run.id, chaosProfileId: profile[profileName], chaosSeed: 7, target });
  execution[label] = await until(`/executions/${started.id}`, (value) => !['queued', 'running'].includes(value.status));
  if (execution[label].status !== 'completed') throw new Error(`${label}: ${execution[label].status} ${execution[label].error}`);
}
await execute('pass', 'none', { type: 'reference', name: 'correct' });
await execute('fail', 'spec-example', { type: 'reference', name: 'naive' });
await execute('late', 'late-data', { type: 'reference', name: 'correct' });
await execute('lossy', 'lossy', { type: 'reference', name: 'correct' });
await execute('kafka', 'spec-example', { type: 'reference', name: 'naive', transport: 'kafka' });

// Lists and details.
save('runs', await get('/runs'));
save('run', run);
save('run-events', await get(`/runs/${run.id}/events?limit=25`));
save('executions', await get('/executions'));
for (const [label, value] of Object.entries(execution)) {
  save(`execution-${label}`, value);
  save(`report-${label}`, await get(`/executions/${value.id}/report`));
}
save('findings-fail', await get(`/executions/${execution.fail.id}/findings?limit=1000`));
save('findings-lossy', await get(`/executions/${execution.lossy.id}/findings?limit=5`));
save('window-findings-late', await get(`/executions/${execution.late.id}/window-findings?limit=1000`));

// One aggregate per phenomenon, with its canonical events and its attempts.
async function aggregate(name, executionLabel, aggregateId) {
  const id = execution[executionLabel].id;
  save(`aggregate-${name}`, {
    executionId: id,
    aggregateId,
    runEvents: await get(`/runs/${run.id}/events?aggregateId=${aggregateId}&limit=1000`),
    attempts: await get(`/executions/${id}/attempts?aggregateId=${aggregateId}&limit=1000`),
  });
}
const failReport = await get(`/executions/${execution.fail.id}/report`);
const causes = (await get(`/executions/${execution.fail.id}/findings?limit=1000`)).findings.flatMap((finding) => finding.causes);
const reorder = causes.find((cause) => cause.overtakenBy.length > 0);
const duplicate = causes.find((cause) => cause.faults.includes('duplicate') && cause.deliveries > 1);
const lost = (await get(`/executions/${execution.lossy.id}/findings?limit=1000`)).findings.flatMap((finding) => finding.causes).find((cause) => cause.lost);
const lateWindowCause = (await get(`/executions/${execution.late.id}/window-findings?limit=1000`)).findings.flatMap((finding) => finding.causes)[0];
if (!reorder || !duplicate || !lost || !lateWindowCause || failReport.verdict !== 'FAIL') {
  throw new Error('The captured executions do not contain a reorder, a duplicate, a lost event and a late event.');
}
await aggregate('reorder', 'fail', reorder.aggregateId);
await aggregate('duplicate', 'fail', duplicate.aggregateId);
await aggregate('lost', 'lossy', lost.aggregateId);
await aggregate('kafka', 'kafka', reorder.aggregateId);
const lateAttempt = (await get(`/executions/${execution.late.id}/attempts?eventId=${lateWindowCause.eventId}&limit=1`)).attempts[0];
await aggregate('late', 'late', lateAttempt.aggregateId);

save('index', {
  runId: run.id,
  executions: Object.fromEntries(Object.entries(execution).map(([label, value]) => [label, value.id])),
  aggregates: { reorder: reorder.aggregateId, duplicate: duplicate.aggregateId, lost: lost.aggregateId, late: lateAttempt.aggregateId },
  lateWindowEventId: lateWindowCause.eventId,
});
console.log(`Fixtures written to ${outDir}`);

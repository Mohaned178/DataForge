// Fills a running DataForge API with examples to explore in the web UI, then prints where to look.
//
//   pnpm demo:seed                        against http://127.0.0.1:3000 (API_HOST and API_PORT are honoured)
//   pnpm demo:seed --api http://127.0.0.1:3210
//
// It registers the two example scenarios and every example chaos profile, simulates the small scenario
// (seed 42) and the specification's example size, and runs five tests that tell a story:
//   1. correct target, no faults             -> PASS
//   2. naive target, the spec's example      -> FAIL (double charges and wrong statuses, each explained)
//   3. correct target, the spec's example    -> PASS (the same faults, handled)
//   4. naive target, duplicates only         -> FAIL (customers charged twice)
//   5. correct target, late data in windows  -> FAIL, every window finding explained by a late event
// Running it again reuses what exists (same names) and adds new executions only for new runs.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const api = option('api', `http://${process.env.API_HOST ?? '127.0.0.1'}:${process.env.API_PORT ?? '3000'}`);
const web = option('web', `http://${process.env.WEB_HOST ?? '127.0.0.1'}:${process.env.WEB_PORT ?? '5173'}`);

const readJson = (...parts) => JSON.parse(readFileSync(join(root, ...parts), 'utf8'));

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(`${api}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`The API at ${api} is not reachable (${error.cause?.code ?? error.message}). Start it with "docker compose up -d --wait", "pnpm db:migrate" and "pnpm api".`, { cause: error });
  }
  const text = await response.text();
  const parsed = text === '' ? undefined : JSON.parse(text);
  return { status: response.status, body: parsed };
}

async function expectOk(method, path, body) {
  const result = await request(method, path, body);
  if (result.status >= 400) {
    throw new Error(`${method} ${path} answered ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

/** Registers a document, or finds the one with that name when an earlier seeding already did. */
async function ensure(collection, listKey, document) {
  const created = await request('POST', `/${collection}`, document);
  if (created.status === 201) {
    return created.body;
  }
  if (created.status === 409) {
    const listed = await expectOk('GET', `/${collection}`);
    const existing = listed[listKey].find((item) => item.name === document.name);
    if (existing !== undefined) {
      return existing;
    }
  }
  throw new Error(`POST /${collection} (${document.name}) answered ${created.status}: ${JSON.stringify(created.body)}`);
}

async function until(path, done, label) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const view = await expectOk('GET', path);
    if (done(view)) {
      return view;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} did not finish within ten minutes`);
}

async function runFor(scenario, seed) {
  const listed = await expectOk('GET', `/runs?scenarioId=${scenario.id}&status=succeeded&limit=200`);
  const existing = listed.runs.find((run) => run.seed === String(seed));
  if (existing !== undefined) {
    return existing;
  }
  const started = await expectOk('POST', '/runs', { scenarioId: scenario.id, seed: String(seed) });
  const finished = await until(`/runs/${started.id}`, (view) => view.status === 'succeeded' || view.status === 'failed', `run ${started.id}`);
  if (finished.status !== 'succeeded') {
    throw new Error(`run ${started.id} failed: ${finished.error}`);
  }
  return finished;
}

console.log(`Seeding the DataForge API at ${api}`);
const health = await request('GET', '/health');
if (health.status !== 200) {
  throw new Error(`GET /health answered ${health.status}`);
}

const scenarios = {};
for (const file of readdirSync(join(root, 'scenarios')).filter((name) => name.endsWith('.json')).sort()) {
  const definition = readJson('scenarios', file);
  scenarios[definition.name] = await ensure('scenarios', 'scenarios', definition);
  console.log(`  scenario        ${definition.name}`);
}
const profiles = {};
for (const file of readdirSync(join(root, 'chaos-profiles')).filter((name) => name.endsWith('.json')).sort()) {
  const definition = readJson('chaos-profiles', file);
  profiles[definition.name] = await ensure('chaos-profiles', 'chaosProfiles', definition);
  console.log(`  chaos profile   ${definition.name}`);
}

const small = await runFor(scenarios['ecommerce-small'], 42);
console.log(`  run             ecommerce-small, seed 42: ${small.eventCount} events (${small.id})`);
const standard = await runFor(scenarios['ecommerce-standard'], 42);
console.log(`  run             ecommerce-standard, seed 42: ${standard.eventCount} events (${standard.id})`);

const tests = [
  { title: '1. correct target, no faults', run: small, profile: 'none', target: 'correct', chaosSeed: '7', expect: 'PASS' },
  { title: '2. naive target, spec example faults', run: small, profile: 'spec-example', target: 'naive', chaosSeed: '7', expect: 'FAIL' },
  { title: '3. correct target, spec example faults', run: small, profile: 'spec-example', target: 'correct', chaosSeed: '7', expect: 'PASS' },
  { title: '4. naive target, duplicates only', run: small, profile: 'duplicates-only', target: 'naive', chaosSeed: '7', expect: 'FAIL' },
  { title: '5. correct target, late data in event-time windows', run: standard, profile: 'late-data', target: 'correct', chaosSeed: '7', expect: 'FAIL' },
];

const links = [];
for (const test of tests) {
  const existing = await expectOk('GET', `/executions?runId=${test.run.id}&chaosProfileId=${profiles[test.profile].id}&limit=200`);
  const sameTest = existing.executions.find((execution) => execution.chaosSeed === test.chaosSeed && execution.target?.name === test.target && execution.status === 'completed');
  let execution = sameTest;
  if (execution === undefined) {
    const started = await expectOk('POST', '/executions', {
      runId: test.run.id,
      chaosProfileId: profiles[test.profile].id,
      chaosSeed: test.chaosSeed,
      target: { type: 'reference', name: test.target, transport: 'memory' },
    });
    execution = await until(`/executions/${started.id}`, (view) => view.status === 'completed' || view.status === 'failed', `execution ${started.id}`);
  }
  if (execution.status !== 'completed') {
    throw new Error(`execution ${execution.id} (${test.title}) failed: ${execution.error}`);
  }
  const matches = execution.verdict === test.expect ? '' : `   (expected ${test.expect})`;
  console.log(`  test            ${test.title.padEnd(52)} ${execution.verdict}${matches}`);
  links.push(`${web}/executions/${execution.id}`);
}

console.log('');
console.log('Open the web UI:');
console.log(`  ${web}/executions          the five tests above; open a FAIL to see findings and root-cause hints`);
console.log(`  ${web}/runs                the two simulated worlds, their events and expected state`);
console.log(`  ${web}/executions/new      launch your own test`);
for (const link of links.slice(1, 2)) {
  console.log(`  ${link}   the naive target under the spec example, with its findings`);
}

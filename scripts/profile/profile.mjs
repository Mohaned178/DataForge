// Profiles DataForge at a chosen size and prints one row per stage: wall time and peak memory.
//
//   pnpm profile                          the specification's example size (1,000 customers, 5,000 orders)
//   pnpm profile --orders 100000          the scenario limit (customers and products scale with it)
//   pnpm profile --orders 100000 --api http://127.0.0.1:3000 --api-pid <pid>
//                                         also drives a running API: run, download, execution, event-loop stalls
//
// The CLI stages run as child processes of the built CLI (pnpm build first); the peak is the child's own
// resource usage. The API stages need `pnpm api` running against a database you do not mind filling.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'apps', 'cli', 'dist', 'main.js');
const preload = pathToFileURL(join(root, 'scripts', 'profile', 'peak-rss.mjs')).href;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const orders = Number(option('orders', '5000'));
const customers = Number(option('customers', String(Math.min(100_000, Math.max(1, Math.round(orders / 5))))));
const products = Number(option('products', String(Math.min(10_000, Math.max(1, Math.round(orders / 25))))));
const seed = option('seed', '42');
const chaosSeed = option('chaos-seed', '7');
const profileName = option('profile', 'spec-example');
const out = resolve(option('out', join(root, 'out', 'profile')));
const apiUrl = option('api', undefined);
const apiPid = option('api-pid', undefined);

const rows = [];
const mb = (kilobytes) => (kilobytes === undefined ? '' : `${Math.round(kilobytes / 1024)} MB`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const sizeOf = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(0)} MB`;

function record(stage, ms, peakKb, note = '') {
  rows.push({ stage, time: seconds(ms), peak: mb(peakKb), note });
  console.log(`${stage.padEnd(34)} ${seconds(ms).padStart(9)} ${mb(peakKb).padStart(9)}  ${note}`);
}

function stage(name, args, note) {
  const peakFile = join(out, 'peak.txt');
  rmSync(peakFile, { force: true });
  const started = Date.now();
  return new Promise((resolveStage, rejectStage) => {
    const child = spawn(process.execPath, ['--import', preload, cli, ...args], {
      cwd: root,
      env: { ...process.env, PROFILE_PEAK_FILE: peakFile },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => {
      const elapsed = Date.now() - started;
      if (code !== 0 && !(name === 'validate' && code === 1)) {
        rejectStage(new Error(`${name} exited with code ${String(code)}: ${stderr.slice(0, 500)}`));
        return;
      }
      let peak;
      try {
        peak = Number(readFileSync(peakFile, 'utf8').trim().split('\n').pop());
      } catch {
        peak = undefined;
      }
      record(name, elapsed, peak, typeof note === 'function' ? note() : note);
      resolveStage();
    });
  });
}

function scenarioFor() {
  const standard = JSON.parse(readFileSync(join(root, 'scenarios', 'ecommerce-standard.json'), 'utf8'));
  standard.name = `profile-${orders}`;
  standard.customers.count = customers;
  standard.orders.count = orders;
  standard.catalog.productCount = products;
  return standard;
}

async function cliStages() {
  const scenarioFile = join(out, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenarioFor(), null, 2));
  const run = join(out, 'run');
  const plan = join(out, 'plan');
  const delivered = join(out, 'delivered');
  const profile = join(root, 'chaos-profiles', `${profileName}.json`);
  await stage('generate', ['generate', '--scenario', scenarioFile, '--seed', seed, '--out', run, '--force'], () => `events.jsonl ${sizeOf(join(run, 'events.jsonl'))}`);
  await stage('verify', ['verify', '--run', run]);
  await stage('chaos plan', ['chaos', 'plan', '--run', run, '--profile', profile, '--chaos-seed', chaosSeed, '--out', plan, '--force'], () => `delivery-plan.jsonl ${sizeOf(join(plan, 'delivery-plan.jsonl'))}`);
  await stage('deliver (correct, memory)', ['deliver', '--run', run, '--plan', plan, '--target', 'correct', '--out', delivered, '--force'], () => `actual-state.json ${sizeOf(join(delivered, 'actual-state.json'))}`);
  await stage('validate', ['validate', '--run', run, '--actual', join(delivered, 'actual-state.json'), '--plan', plan]);
}

function apiMemoryKb() {
  if (apiPid === undefined) {
    return undefined;
  }
  try {
    if (process.platform === 'win32') {
      const text = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${apiPid}).WorkingSet64`], { encoding: 'utf8' });
      return Number(text.trim()) / 1024;
    }
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', apiPid], { encoding: 'utf8' }).trim());
  } catch {
    return undefined;
  }
}

/** A busy API can reset an idle keep-alive connection while its event loop is blocked: retry a refused connection. */
async function fetchRetrying(url, init) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt === 5 || init?.method === 'POST') {
        throw error;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function call(path, init) {
  const response = await fetchRetrying(`${apiUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Probes /health every 100 ms until stopped and keeps the slowest answer: what a busy event loop costs. */
function stallProbe() {
  let worst = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        await fetch(`${apiUrl}/health`);
      } catch {
        // an unreachable API counts as the time it took to find out
      }
      worst = Math.max(worst, Date.now() - started);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    return worst;
  };
}

async function untilDone(path, done) {
  for (;;) {
    const view = await (await call(path)).json();
    if (done(view)) {
      return view;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function apiStages() {
  const suffix = Date.now().toString(36);
  const scenario = { ...scenarioFor(), name: `${scenarioFor().name}-${suffix}` };
  const created = await (await call('/scenarios', json(scenario))).json();
  const profile = JSON.parse(readFileSync(join(root, 'chaos-profiles', `${profileName}.json`), 'utf8'));
  const chaos = await (await call('/chaos-profiles', json({ ...profile, name: `${profileName}-${suffix}` }))).json();

  let stopProbe = stallProbe();
  let started = Date.now();
  const run = await (await call('/runs', json({ scenarioId: created.id, seed }))).json();
  const finished = await untilDone(`/runs/${run.id}`, (view) => view.status === 'succeeded' || view.status === 'failed');
  let worst = await stopProbe();
  record('API: generate + store a run', Date.now() - started, apiMemoryKb(), `${finished.status}, ${finished.eventCount} events, worst /health answer ${seconds(worst)}`);

  for (const file of ['events.jsonl', 'expected-state.json']) {
    started = Date.now();
    stopProbe = stallProbe();
    const response = await call(`/runs/${run.id}/files/${file}`);
    const bytes = (await response.arrayBuffer()).byteLength;
    worst = await stopProbe();
    record(`API: download ${file}`, Date.now() - started, apiMemoryKb(), `${(bytes / 1024 / 1024).toFixed(0)} MB, worst /health answer ${seconds(worst)}`);
  }

  started = Date.now();
  stopProbe = stallProbe();
  const execution = await (await call('/executions', json({ runId: run.id, chaosProfileId: chaos.id, chaosSeed, target: { type: 'reference', name: 'correct', transport: 'memory' } }))).json();
  const result = await untilDone(`/executions/${execution.id}`, (view) => view.status === 'completed' || view.status === 'failed');
  worst = await stopProbe();
  record('API: execution (correct, memory)', Date.now() - started, apiMemoryKb(), `${result.status}, verdict ${result.verdict ?? 'none'}, worst /health answer ${seconds(worst)}`);
}

mkdirSync(out, { recursive: true });
console.log(`profile: ${orders} orders, ${customers} customers, ${products} products, seed ${seed}, chaos ${profileName} seed ${chaosSeed}`);
console.log(`${'stage'.padEnd(34)} ${'time'.padStart(9)} ${'peak'.padStart(9)}`);
await cliStages();
if (apiUrl !== undefined) {
  await apiStages();
}
writeFileSync(join(out, 'profile.json'), `${JSON.stringify({ orders, customers, products, seed, chaosSeed, profile: profileName, rows }, null, 2)}\n`);

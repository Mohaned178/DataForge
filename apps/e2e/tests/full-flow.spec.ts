import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { API_URL, GOLDEN_SMALL_SEED_42 } from '../support/constants';

/*
 * The whole product, from the browser: author a scenario and chaos profiles, generate a world, test it, read
 * the report. Each test builds on the one before (one database for the file), so they run in order and stop
 * at the first failure. Expected numbers are the ones earlier milestones pinned: the small scenario with seed
 * 42 (472 events, the CLI's checksums), `spec-example` with chaos seed 7 (486 attempts; the naive target: 48
 * findings, all explained by a delivery fault).
 */
test.describe.configure({ mode: 'serial' });

const repository = resolve(__dirname, '..', '..', '..');

/** The value next to a label in a facts list ("Verdict", "Delivery attempts"). */
function fact(page: Page, label: string): Locator {
  return page.locator('dl.facts > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
}

async function chooseTemplate(page: Page, name: string): Promise<void> {
  await page.getByLabel('Start from').selectOption(name);
  await expect(page.getByRole('heading', { name: 'Valid', exact: true })).toBeVisible();
}

async function registerFromTemplate(page: Page, route: '/scenarios' | '/chaos-profiles', template: string, noun: string): Promise<string> {
  await page.goto(`${route}/new`);
  await chooseTemplate(page, template);
  await page.getByRole('button', { name: `Save as a new ${noun}` }).click();
  await expect(page).toHaveURL(new RegExp(`${route}/[0-9a-f-]{36}\\?saved=1$`));
  await expect(page.getByText('Saved as version 1.')).toBeVisible();
  return /\/([0-9a-f-]{36})\?/.exec(page.url())?.[1] ?? '';
}

let scenarioId = '';
let runPath = '';

test('an empty installation points at the first thing to create', async ({ page }) => {
  await page.goto('/scenarios');
  await expect(page.getByText('No scenarios yet')).toBeVisible();
  await page.goto('/executions');
  await expect(page.getByText('No executions yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New execution' })).toBeVisible();
});

test('an invalid scenario shows every problem with its path and cannot be saved', async ({ page }) => {
  await page.goto('/scenarios/new');
  await page.getByLabel('Document (JSON)').fill('{ "formatVersion": 1, "name": "bad", "customers": { "count": "many" }, "colour": "blue" }');
  await expect(page.getByRole('heading', { name: '2 problems in the scenario' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'customers.count' })).toContainText('expected number, received string');
  await expect(page.getByRole('listitem').filter({ hasText: 'Unrecognized key' })).toContainText('colour');
  await expect(page.getByRole('button', { name: 'Save as a new scenario' })).toBeDisabled();

  await page.getByLabel('Document (JSON)').fill('{ "formatVersion": 1, "name": }');
  await expect(page.getByText('Not valid JSON.')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Not valid JSON' })).toContainText('line 1, column 31');
  await expect(page.getByRole('button', { name: 'Save as a new scenario' })).toBeDisabled();

  await page.goto('/scenarios');
  await expect(page.getByText('No scenarios yet')).toBeVisible();
});

test('registers the small scenario and the chaos profiles from the repository examples', async ({ page }) => {
  scenarioId = await registerFromTemplate(page, '/scenarios', 'ecommerce-small', 'scenario');
  for (const profile of ['none', 'spec-example']) {
    await registerFromTemplate(page, '/chaos-profiles', profile, 'chaos profile');
  }
  await page.goto('/chaos-profiles');
  await expect(page.getByRole('link', { name: 'none', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'spec-example' })).toBeVisible();

  await page.goto('/chaos-profiles/new');
  await page.getByLabel('Start from').selectOption('lossy');
  await expect(page.getByRole('heading', { name: 'Valid', exact: true })).toBeVisible();
  await page.getByLabel('Document (JSON)').fill(
    '{ "formatVersion": 1, "name": "loses", "faults": { "transientFailure": { "rate": 0.1, "failures": { "min": 1, "max": 5 }, "maxRetries": 2 } } }',
  );
  await expect(page.getByRole('heading', { name: '1 problem in the chaos profile' })).toBeVisible();
  await expect(page.getByText('faults.transientFailure.failures.max')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as a new chaos profile' })).toBeDisabled();
});

test('launches a run from the form and follows it to success: its checksums are the command line\'s', async ({ page }) => {
  await page.goto(`/scenarios/${scenarioId}`);
  await page.getByRole('link', { name: 'New run' }).click();
  await expect(page.getByLabel('Scenario')).toHaveValue(scenarioId);
  await page.getByLabel('Seed').fill('42');
  await page.getByRole('button', { name: 'Start run' }).click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  runPath = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { name: 'Stored canonical events' })).toBeVisible();
  await expect(fact(page, 'Status')).toHaveText('succeeded');
  await expect(fact(page, 'Events')).toHaveText(String(GOLDEN_SMALL_SEED_42.eventCount));
  for (const sha of [GOLDEN_SMALL_SEED_42.eventsSha256, GOLDEN_SMALL_SEED_42.expectedStateSha256, GOLDEN_SMALL_SEED_42.scenarioResolvedSha256]) {
    await expect(page.locator(`code[title="${sha}"]`)).toHaveCount(1);
  }
});

test('the naive target under spec-example fails with every finding explained, and a root cause opens the order\'s two timelines', async ({ page }) => {
  await page.goto(runPath);
  await page.getByRole('link', { name: 'New execution' }).first().click();
  await expect(page).toHaveURL(/\/executions\/new\?runId=/);
  await page.getByLabel('Chaos profile').selectOption({ label: 'spec-example' });
  await page.getByLabel('Chaos seed').fill('7');
  await page.getByRole('radio', { name: /Reference target: naive/ }).check();
  await page.getByRole('button', { name: 'Start execution' }).click();

  await expect(page).toHaveURL(/\/executions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible();
  await expect(fact(page, 'Verdict')).toHaveText('FAIL');
  await expect(fact(page, 'Delivery attempts')).toHaveText('486');
  await expect(page.getByText('48 findings: 48 explained by a delivery fault, 0 not explained by delivery.')).toBeVisible();

  await page.getByRole('table', { name: /root causes of the findings/i }).getByRole('link', { name: 'ord_000045', exact: true }).first().click();
  await expect(page).toHaveURL(/\/aggregates\/ord_000045\?event=/);
  await expect(page.getByRole('heading', { name: /Order ord_000045/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Canonical timeline' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery timeline' })).toBeVisible();
  await expect(page.getByText('out of order').first()).toBeVisible();
});

test('the correct target under the fault-free profile passes', async ({ page }) => {
  await page.goto(runPath);
  await page.getByRole('link', { name: 'New execution' }).first().click();
  await page.getByLabel('Chaos profile').selectOption({ label: 'none' });
  await page.getByLabel('Chaos seed').fill('7');
  await page.getByRole('button', { name: 'Start execution' }).click();

  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible();
  await expect(fact(page, 'Verdict')).toHaveText('PASS');
  await expect(fact(page, 'Delivery attempts')).toHaveText(String(GOLDEN_SMALL_SEED_42.eventCount));
  await expect(page.getByText('No findings: the target ended in the expected state.')).toBeVisible();

  await page.goto('/executions');
  await expect(page.getByRole('table', { name: /test executions, newest first/i }).getByRole('row')).toHaveCount(3);
});

test('a changed document becomes the next version of a scenario, and an identical one is recognised before saving', async ({ page }) => {
  await page.goto('/scenarios');
  await page.getByRole('link', { name: 'ecommerce-small' }).click();
  await page.getByRole('link', { name: 'New version' }).click();
  await expect(page.getByRole('heading', { name: 'New version of ecommerce-small' })).toBeVisible();
  await expect(page.getByText('It is identical to')).toContainText('version 1');

  const editor = page.getByLabel('Document (JSON)');
  const definition = JSON.parse(await editor.inputValue()) as Record<string, unknown>;
  await editor.fill(JSON.stringify({ ...definition, description: 'A small store, tested from the browser.' }, null, 2));
  await expect(page.getByRole('heading', { name: 'Valid', exact: true })).toBeVisible();
  await expect(page.getByText('It is identical to')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save as a new version' }).click();

  await expect(page).toHaveURL(new RegExp(`/scenarios/${scenarioId}\\?saved=2$`));
  await expect(page.getByText('Saved as version 2.')).toBeVisible();
  await expect(page.getByRole('table', { name: /versions of ecommerce-small/i }).getByRole('row')).toHaveCount(3);
  await expect(page.getByText('A small store, tested from the browser.')).toBeVisible();
});

test('a run that has not succeeded is refused by the API, and the form explains why', async ({ page, request }) => {
  const document = JSON.parse(readFileSync(resolve(repository, 'scenarios', 'ecommerce-standard.json'), 'utf8')) as Record<string, unknown>;
  const standard = (await (await request.post(`${API_URL}/scenarios`, { data: document })).json()) as { id: string };
  // The runner takes one run at a time: of a burst of specification-sized runs, the last waits for the others.
  const runs: { id: string }[] = [];
  for (const seed of ['burst-1', 'burst-2', 'burst-3', 'burst-4', 'burst-5', 'burst-6']) {
    runs.push((await (await request.post(`${API_URL}/runs`, { data: { scenarioId: standard.id, seed } })).json()) as { id: string });
  }
  const last = runs[runs.length - 1]?.id ?? '';

  await page.goto(`/executions/new?runId=${last}`);
  await expect(page.getByLabel('Run').locator('option:checked')).toHaveText(/ · (queued|running)$/);
  await page.getByLabel('Chaos seed').fill('7');
  await page.getByRole('button', { name: 'Start execution' }).click();
  await expect(page.getByRole('heading', { name: 'The API cannot do this now' })).toBeVisible();
  await expect(page.getByText(/is (queued|running); start an execution once it has succeeded/)).toBeVisible();
  await expect(page).toHaveURL(/\/executions\/new/);

  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/runs/${last}`)).json()) as { status: string }).status, { timeout: 120_000 })
    .toBe('succeeded');
});

test('an execution through Kafka is followed live and shows the partition and offset of every delivery', async ({ page }) => {
  await page.goto(runPath);
  await page.getByRole('link', { name: 'New execution' }).first().click();
  await page.getByLabel('Chaos profile').selectOption({ label: 'spec-example' });
  await page.getByLabel('Chaos seed').fill('7');
  await page.getByRole('radio', { name: /Reference target: naive/ }).check();
  await page.getByLabel('Transport').selectOption('kafka');
  await page.getByLabel('Speed').fill('20000');
  await page.getByRole('button', { name: 'Start execution' }).click();

  await expect(page).toHaveURL(/\/executions\/[0-9a-f-]{36}$/);
  // The plan is played in compressed real time (about nine seconds), so the page can be seen moving by itself.
  await expect(page.getByText(/This execution is (queued|running)/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/This execution is (queued|running)/)).toHaveCount(0);
  await expect(fact(page, 'Verdict')).toHaveText('FAIL');
  await expect(fact(page, 'Records sent')).toHaveText('486');

  await page.getByRole('table', { name: /root causes of the findings/i }).getByRole('link', { name: 'ord_000045', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Delivery timeline' })).toBeVisible();
  await expect(page.getByText(/partition 0, offset \d+/).first()).toBeVisible();
});

test('a live page keeps its data while the API cannot be reached, says so, and recovers by itself', async ({ page }) => {
  await page.goto(runPath);
  await page.getByRole('link', { name: 'New execution' }).first().click();
  await page.getByLabel('Chaos profile').selectOption({ label: 'none' });
  await page.getByLabel('Chaos seed').fill('7');
  await page.getByLabel('Transport').selectOption('kafka');
  await page.getByLabel('Speed').fill('20000');
  await page.getByRole('button', { name: 'Start execution' }).click();
  await expect(page.getByText(/This execution is (queued|running)/)).toBeVisible();

  // The browser loses the API: every poll fails, as if the proxy answered 502 or the network dropped.
  await page.route('**/api/executions/*', (route) => route.abort('connectionrefused'));
  await expect(page.getByText('The latest refresh failed.')).toBeVisible();
  await expect(page.getByText(/This execution is (queued|running)/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The API is not reachable' })).toHaveCount(0);

  await page.unroute('**/api/executions/*');
  await expect(page.getByText('The latest refresh failed.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible({ timeout: 120_000 });
  await expect(fact(page, 'Verdict')).toHaveText('PASS');
});

test('a double click on Start run starts one run, not two', async ({ page, request }) => {
  const total = async (): Promise<number> => ((await (await request.get(`${API_URL}/runs`)).json()) as { total: number }).total;
  const before = await total();
  await page.goto(`/runs/new?scenarioId=${scenarioId}`);
  await page.getByLabel('Seed').fill('double');
  await page.getByRole('button', { name: 'Start run' }).dblclick();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Stored canonical events' })).toBeVisible();
  // Two identical requests would be two runs (D-6.1): the button is disabled while the first is in flight.
  expect(await total()).toBe(before + 1);
});

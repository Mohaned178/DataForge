import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiErrorResponse, jsonResponse, ok, renderApp, stubApi, type StubRoute } from '../test/support';
import { CHAOS_PROFILE_TEMPLATES, SCENARIO_TEMPLATES } from '../templates';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SLOW = { timeout: 4000 };
const HASH_1 = `sha256:${'1'.repeat(64)}`;
const HASH_2 = `sha256:${'2'.repeat(64)}`;
const HASH_3 = `sha256:${'3'.repeat(64)}`;
const SCENARIO_ID = '01a20000-0000-7000-8000-0000000000a1';
const PROFILE_ID = '01a20000-0000-7000-8000-0000000000b1';

const scenario = (latestVersion = 2) => ({
  id: SCENARIO_ID,
  name: 'ecommerce-small',
  createdAt: '2026-11-23T10:00:00.000Z',
  latestVersion,
  versions: [
    { version: 1, scenarioHash: HASH_1, createdAt: '2026-11-23T10:00:00.000Z' },
    { version: 2, scenarioHash: HASH_2, createdAt: '2026-11-23T11:00:00.000Z' },
  ].slice(0, latestVersion),
});
const version = (n: number, hash: string, extra: Record<string, unknown> = {}) => ({
  version: n,
  createdAt: '2026-11-23T10:00:00.000Z',
  scenarioId: SCENARIO_ID,
  scenarioName: 'ecommerce-small',
  scenarioHash: hash,
  definition: { formatVersion: 1, name: 'ecommerce-small', ...extra },
});
const valid = (hash: string, name = 'ecommerce-small') => ({ valid: true, name, scenarioHash: hash, definition: { formatVersion: 1, name } });

function scenarioRoutes(): StubRoute[] {
  return [
    { path: `/scenarios/${SCENARIO_ID}`, respond: ok(scenario()) },
    { path: `/scenarios/${SCENARIO_ID}/versions/1`, respond: ok(version(1, HASH_1, { description: 'the first' })) },
    { path: `/scenarios/${SCENARIO_ID}/versions/2`, respond: ok(version(2, HASH_2, { description: 'the second' })) },
  ];
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Document (JSON)' });
}
function type(text: string): void {
  fireEvent.change(textarea(), { target: { value: text } });
}

describe('the scenario list', () => {
  test('lists the scenarios by name, each linking to its page, with a way to create one', async () => {
    stubApi([{ path: '/scenarios', respond: ok({ scenarios: [{ id: SCENARIO_ID, name: 'ecommerce-small', createdAt: '2026-11-23T10:00:00.000Z', latestVersion: 2 }] }) }]);
    renderApp('/scenarios');
    const table = await screen.findByRole('table', { name: /scenarios, by name/i });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByRole('link', { name: 'ecommerce-small' })).toHaveAttribute('href', `/scenarios/${SCENARIO_ID}`);
    expect(within(row).getByText('v2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New scenario' })).toHaveAttribute('href', '/scenarios/new');
  });

  test('with none, the empty state leads to creating the first', async () => {
    stubApi([{ path: '/scenarios', respond: ok({ scenarios: [] }) }]);
    renderApp('/scenarios');
    expect(await screen.findByText(/No scenarios yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create the first one' })).toHaveAttribute('href', '/scenarios/new');
  });

  test('the navigation reaches scenarios and chaos profiles', async () => {
    stubApi([{ path: '/executions', respond: ok({ executions: [], total: 0, limit: 25, offset: 0 }) }]);
    renderApp('/executions');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Scenarios' })).toHaveAttribute('href', '/scenarios');
    expect(within(nav).getByRole('link', { name: 'Chaos profiles' })).toHaveAttribute('href', '/chaos-profiles');
  });
});

describe('a scenario page', () => {
  test('shows its versions, the latest definition, and where to go next', async () => {
    stubApi(scenarioRoutes());
    renderApp(`/scenarios/${SCENARIO_ID}`);
    expect(await screen.findByRole('heading', { name: 'ecommerce-small' })).toBeInTheDocument();
    const versions = screen.getByRole('table', { name: /versions of ecommerce-small/i });
    const rows = within(versions).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('v2');
    expect(rows[1]).toHaveTextContent('v1');
    expect(await screen.findByText(/"description": "the second"/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New version' })).toHaveAttribute('href', `/scenarios/${SCENARIO_ID}/versions/new`);
    expect(screen.getByRole('link', { name: 'New run' })).toHaveAttribute('href', `/runs/new?scenarioId=${SCENARIO_ID}`);
  });

  test('another version is chosen in the address, and a save is announced', async () => {
    stubApi(scenarioRoutes());
    renderApp(`/scenarios/${SCENARIO_ID}?version=1&saved=2`);
    expect(await screen.findByText('Saved as version 2.')).toBeInTheDocument();
    expect(await screen.findByText(/"description": "the first"/)).toBeInTheDocument();
    expect(screen.queryByText(/"description": "the second"/)).not.toBeInTheDocument();
  });

  test('an unknown scenario is "not found"', async () => {
    stubApi([{ path: `/scenarios/${SCENARIO_ID}`, respond: () => apiErrorResponse(404, 'Not Found', 'Scenario does not exist') }]);
    renderApp(`/scenarios/${SCENARIO_ID}`);
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });
});

describe('the scenario editor', () => {
  test('starts from an example: the text is the repository file, it is checked, and saving opens the new scenario', async () => {
    const user = userEvent.setup();
    const small = SCENARIO_TEMPLATES.find((template) => template.name === 'ecommerce-small');
    expect(small).toBeDefined();
    const stub = stubApi([
      { method: 'POST', path: '/scenarios/validate', respond: () => jsonResponse(valid(HASH_1)) },
      { method: 'POST', path: '/scenarios', respond: () => jsonResponse({ ...scenario(1), versions: scenario(1).versions }, 201) },
      ...scenarioRoutes().map((route) => (route.path === `/scenarios/${SCENARIO_ID}` ? { ...route, respond: ok(scenario(1)) } : route)),
    ]);
    renderApp('/scenarios/new');
    await user.selectOptions(screen.getByLabelText('Start from'), 'ecommerce-small');
    expect(textarea().value).toBe(small?.text);

    expect(await screen.findByRole('heading', { name: 'Valid' }, SLOW)).toBeInTheDocument();
    expect(stub.requests.find((request) => request.path === '/scenarios/validate')?.body).toEqual(JSON.parse(small?.text ?? '{}'));
    expect(screen.getByText(/hash/)).toHaveTextContent(HASH_1.slice(0, 19));

    await user.click(screen.getByRole('button', { name: 'Save as a new scenario' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/scenarios/${SCENARIO_ID}?saved=1`);
    });
    expect(stub.requests.find((request) => request.method === 'POST' && request.path === '/scenarios')?.body).toEqual(JSON.parse(small?.text ?? '{}'));
    expect(await screen.findByText('Saved as version 1.')).toBeInTheDocument();
  });

  test('offers every scenario file of the repository and a blank document', () => {
    stubApi([]);
    renderApp('/scenarios/new');
    const options = within(screen.getByLabelText('Start from'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Choose…', 'A blank document', ...SCENARIO_TEMPLATES.map((template) => template.name)]);
    expect(SCENARIO_TEMPLATES.map((template) => template.name)).toEqual(expect.arrayContaining(['ecommerce-small', 'ecommerce-standard']));
    for (const template of SCENARIO_TEMPLATES) expect((JSON.parse(template.text) as { name: string }).name).toBe(template.name);
  });

  test('a syntax error is shown with its line and column, nothing is sent, and Save stays off', async () => {
    const stub = stubApi([]);
    renderApp('/scenarios/new');
    type('{\n  "formatVersion": 1,\n  "name": }\n');
    expect(await screen.findByText(/Not valid JSON\./)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('(line 3, column 11)');
    expect(screen.getByRole('button', { name: 'Save as a new scenario' })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(stub.requests).toEqual([]);
  });

  test('the API\'s problems are listed with their paths, and Save stays off', async () => {
    stubApi([
      {
        method: 'POST',
        path: '/scenarios/validate',
        respond: () => apiErrorResponse(400, 'Bad Request', ['customers.count: Invalid input: expected number, received string', 'Unrecognized key: "colour"']),
      },
    ]);
    renderApp('/scenarios/new');
    type('{"formatVersion": 1, "name": "x", "customers": {"count": "many"}, "colour": "blue"}');
    expect(await screen.findByRole('heading', { name: '2 problems in the scenario' }, SLOW)).toBeInTheDocument();
    const problems = screen.getAllByRole('listitem');
    expect(within(problems[0] as HTMLElement).getByText('customers.count')).toBeInTheDocument();
    expect(problems[0]).toHaveTextContent('Invalid input: expected number, received string');
    expect(problems[1]).toHaveTextContent('Unrecognized key: "colour"');
    expect(screen.getByRole('button', { name: 'Save as a new scenario' })).toBeDisabled();
  });

  test('Save is enabled only for text the API has just accepted: a change turns it off until the new text is checked', async () => {
    let release: (() => void) | undefined;
    stubApi([
      {
        method: 'POST',
        path: '/scenarios/validate',
        respond: (_url, body) => {
          if ((body as { name: string }).name === 'first') return jsonResponse(valid(HASH_1, 'first'));
          return new Promise<Response>((resolve) => {
            release = () => {
              resolve(jsonResponse(valid(HASH_2, 'second')));
            };
          });
        },
      },
    ]);
    renderApp('/scenarios/new');
    type('{"formatVersion": 1, "name": "first"}');
    expect(await screen.findByRole('heading', { name: 'Valid' }, SLOW)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save as a new scenario' });
    expect(save).toBeEnabled();

    type('{"formatVersion": 1, "name": "second"}');
    expect(await screen.findByText(/Checking with the API/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await waitFor(() => {
      expect(release).toBeDefined();
    }, SLOW);
    release?.();
    expect(await screen.findByText('second', { selector: 'strong' })).toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  test('a name that is taken is shown at the editor, and the editor stays', async () => {
    stubApi([
      { method: 'POST', path: '/scenarios/validate', respond: () => jsonResponse(valid(HASH_1)) },
      { method: 'POST', path: '/scenarios', respond: () => apiErrorResponse(409, 'Conflict', `A scenario named "ecommerce-small" already exists (id ${SCENARIO_ID}).`) },
    ]);
    const user = userEvent.setup();
    renderApp('/scenarios/new');
    type('{"formatVersion": 1, "name": "ecommerce-small"}');
    await screen.findByRole('heading', { name: 'Valid' }, SLOW);
    await user.click(screen.getByRole('button', { name: 'Save as a new scenario' }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/scenarios/new');
    expect(screen.getByRole('button', { name: 'Save as a new scenario' })).toBeEnabled();
  });

  test('Format re-indents valid text', async () => {
    const user = userEvent.setup();
    stubApi([{ method: 'POST', path: '/scenarios/validate', respond: () => jsonResponse(valid(HASH_1)) }]);
    renderApp('/scenarios/new');
    type('{"formatVersion":1,"name":"x"}');
    await user.click(screen.getByRole('button', { name: 'Format' }));
    expect(textarea().value).toBe('{\n  "formatVersion": 1,\n  "name": "x"\n}\n');
  });
});

describe('a new version', () => {
  test('starts from the latest definition, says in advance when the text equals a version, and a 200 stores nothing', async () => {
    const user = userEvent.setup();
    const stub = stubApi([
      ...scenarioRoutes(),
      { method: 'POST', path: '/scenarios/validate', respond: () => jsonResponse(valid(HASH_2)) },
      { method: 'POST', path: `/scenarios/${SCENARIO_ID}/versions`, respond: () => jsonResponse(version(2, HASH_2), 200) },
    ]);
    renderApp(`/scenarios/${SCENARIO_ID}/versions/new`);
    expect(await screen.findByRole('heading', { name: 'New version of ecommerce-small' })).toBeInTheDocument();
    expect(JSON.parse(textarea().value)).toEqual({ formatVersion: 1, name: 'ecommerce-small', description: 'the second' });
    expect(screen.queryByLabelText('Start from')).not.toBeInTheDocument();

    expect(await screen.findByText(/identical to/, { selector: 'p' }, SLOW)).toHaveTextContent('version 2');
    await user.click(screen.getByRole('button', { name: 'Save as a new version' }));
    expect(await screen.findByText(/so nothing new was stored/)).toHaveTextContent('identical to version 2');
    expect(screen.getByTestId('location')).toHaveTextContent(`/scenarios/${SCENARIO_ID}/versions/new`);
    expect(stub.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/versions'))).toHaveLength(1);
  });

  test('a changed document becomes the next version and opens it', async () => {
    const user = userEvent.setup();
    let saved = false;
    const withThird = { ...scenario(), latestVersion: 3, versions: [...scenario().versions, { version: 3, scenarioHash: HASH_3, createdAt: '2026-11-23T12:00:00.000Z' }] };
    stubApi([
      ...scenarioRoutes().map((route) =>
        route.path === `/scenarios/${SCENARIO_ID}` ? { ...route, respond: () => jsonResponse(saved ? withThird : scenario()) } : route,
      ),
      { path: `/scenarios/${SCENARIO_ID}/versions/3`, respond: ok(version(3, HASH_3, { description: 'the third' })) },
      { method: 'POST', path: '/scenarios/validate', respond: () => jsonResponse(valid(HASH_3)) },
      {
        method: 'POST',
        path: `/scenarios/${SCENARIO_ID}/versions`,
        respond: () => {
          saved = true;
          return jsonResponse(version(3, HASH_3), 201);
        },
      },
    ]);
    renderApp(`/scenarios/${SCENARIO_ID}/versions/new`);
    await screen.findByRole('heading', { name: 'New version of ecommerce-small' });
    type('{"formatVersion": 1, "name": "ecommerce-small", "description": "the third"}');
    await screen.findByRole('heading', { name: 'Valid' }, SLOW);
    expect(screen.queryByText(/identical to/, { selector: 'p' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save as a new version' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/scenarios/${SCENARIO_ID}?saved=3`);
    });
    expect(await screen.findByText('Saved as version 3.')).toBeInTheDocument();
  });
});

describe('chaos profiles', () => {
  const summary = { id: PROFILE_ID, name: 'spec-example', createdAt: '2026-11-23T10:00:00.000Z', latestVersion: 1 };

  test('are listed and lead to a new execution', async () => {
    stubApi([
      { path: '/chaos-profiles', respond: ok({ chaosProfiles: [summary] }) },
      { path: `/chaos-profiles/${PROFILE_ID}`, respond: ok({ ...summary, versions: [{ version: 1, profileHash: HASH_1, createdAt: summary.createdAt }] }) },
      {
        path: `/chaos-profiles/${PROFILE_ID}/versions/1`,
        respond: ok({ version: 1, createdAt: summary.createdAt, chaosProfileId: PROFILE_ID, chaosProfileName: 'spec-example', profileHash: HASH_1, definition: { formatVersion: 1, name: 'spec-example' } }),
      },
    ]);
    renderApp('/chaos-profiles');
    const link = await screen.findByRole('link', { name: 'spec-example' });
    expect(link).toHaveAttribute('href', `/chaos-profiles/${PROFILE_ID}`);
    await userEvent.setup().click(link);
    expect(await screen.findByRole('link', { name: 'New execution' })).toHaveAttribute('href', `/executions/new?chaosProfileId=${PROFILE_ID}`);
    expect(screen.getByRole('link', { name: 'New version' })).toHaveAttribute('href', `/chaos-profiles/${PROFILE_ID}/versions/new`);
  });

  test('the editor offers the repository\'s profiles and checks them with the profile endpoint', async () => {
    const user = userEvent.setup();
    const stub = stubApi([
      {
        method: 'POST',
        path: '/chaos-profiles/validate',
        respond: () => apiErrorResponse(400, 'Bad Request', ['faults.transientFailure.failures.max: cannot exceed maxRetries (2) unless allowLoss is true']),
      },
    ]);
    renderApp('/chaos-profiles/new');
    expect(CHAOS_PROFILE_TEMPLATES.map((template) => template.name)).toEqual(expect.arrayContaining(['none', 'spec-example', 'lossy', 'late-data']));
    await user.selectOptions(screen.getByLabelText('Start from'), 'lossy');
    expect(await screen.findByRole('heading', { name: '1 problem in the chaos profile' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('faults.transientFailure.failures.max')).toBeInTheDocument();
    expect(stub.requests[0]?.path).toBe('/chaos-profiles/validate');
    expect(screen.getByRole('button', { name: 'Save as a new chaos profile' })).toBeDisabled();
  });
});

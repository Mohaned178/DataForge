import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtures } from '../test/fixtures';
import { apiErrorResponse, jsonResponse, ok, renderApp, stubApi, type StubRoute } from '../test/support';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SCENARIO_ID = '01a20000-0000-7000-8000-0000000000a1';
const PROFILE_ID = '01a20000-0000-7000-8000-0000000000b1';
const run = fixtures.run;

const scenarioList = { scenarios: [{ id: SCENARIO_ID, name: 'ecommerce-small', createdAt: '2026-11-23T10:00:00.000Z', latestVersion: 2 }] };
const scenarioDetail = {
  ...scenarioList.scenarios[0],
  versions: [
    { version: 1, scenarioHash: 'sha256:1', createdAt: '2026-11-23T10:00:00.000Z' },
    { version: 2, scenarioHash: 'sha256:2', createdAt: '2026-11-23T11:00:00.000Z' },
  ],
};
const profileList = { chaosProfiles: [{ id: PROFILE_ID, name: 'spec-example', createdAt: '2026-11-23T10:00:00.000Z', latestVersion: 2 }] };
const profileDetail = {
  ...profileList.chaosProfiles[0],
  versions: [
    { version: 1, profileHash: 'sha256:a', createdAt: '2026-11-23T10:00:00.000Z' },
    { version: 2, profileHash: 'sha256:b', createdAt: '2026-11-23T11:00:00.000Z' },
  ],
};

const queuedRun = { ...run, status: 'queued', startedAt: null, finishedAt: null, eventCount: null, files: null, summary: null, eventsByType: null };
const noExecutions = { executions: [], total: 0, limit: 10, offset: 0 };

function runFormRoutes(extra: StubRoute[] = []): StubRoute[] {
  return [
    { path: '/scenarios', respond: ok(scenarioList) },
    { path: `/scenarios/${SCENARIO_ID}`, respond: ok(scenarioDetail) },
    ...extra,
  ];
}

describe('the run form', () => {
  test('starts a run with the scenario, its latest version and the seed as typed, then opens the run', async () => {
    const user = userEvent.setup();
    const stub = stubApi(
      runFormRoutes([
        { method: 'POST', path: '/runs', respond: () => jsonResponse(queuedRun, 202) },
        { path: `/runs/${run.id}`, respond: ok(queuedRun) },
        { path: '/executions', respond: ok(noExecutions) },
      ]),
    );
    renderApp('/runs/new');
    expect(await screen.findByRole('heading', { name: 'New run' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Latest (v2)' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Seed'), '9007199254740993');
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/runs/${run.id}`);
    });
    const post = stub.requests.find((request) => request.method === 'POST');
    expect(post).toEqual({ method: 'POST', path: '/runs', body: { scenarioId: SCENARIO_ID, seed: '9007199254740993' } });
    expect(await screen.findByText(/has not finished \(queued\)/)).toBeInTheDocument();
  });

  test('a chosen version is sent as a number, and ?scenarioId= preselects the scenario', async () => {
    const user = userEvent.setup();
    const stub = stubApi(runFormRoutes([{ method: 'POST', path: '/runs', respond: () => jsonResponse(queuedRun, 202) }, { path: `/runs/${run.id}`, respond: ok(queuedRun) }, { path: '/executions', respond: ok(noExecutions) }]));
    renderApp(`/runs/new?scenarioId=${SCENARIO_ID}`);
    expect(await screen.findByLabelText('Scenario')).toHaveValue(SCENARIO_ID);
    await screen.findByRole('option', { name: 'v1' });
    await user.selectOptions(screen.getByLabelText('Version'), 'v1');
    await user.type(screen.getByLabelText('Seed'), 'spring');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      expect(stub.requests.some((request) => request.method === 'POST')).toBe(true);
    });
    expect(stub.requests.find((request) => request.method === 'POST')?.body).toEqual({ scenarioId: SCENARIO_ID, version: 1, seed: 'spring' });
  });

  test('a missing seed is explained at the form and nothing is sent', async () => {
    const user = userEvent.setup();
    const stub = stubApi(runFormRoutes());
    renderApp('/runs/new');
    await screen.findByLabelText('Seed');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByRole('heading', { name: 'Complete the form' })).toBeInTheDocument();
    expect(screen.getByText('seed')).toBeInTheDocument();
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  test('the API\'s refusal is shown at the form with its paths, and the form can be corrected and sent again', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    stubApi(
      runFormRoutes([
        {
          method: 'POST',
          path: '/runs',
          respond: () => {
            attempts += 1;
            return attempts === 1 ? apiErrorResponse(400, 'Bad Request', ['seed: seed must be a safe integer or a string']) : jsonResponse(queuedRun, 202);
          },
        },
        { path: `/runs/${run.id}`, respond: ok(queuedRun) },
        { path: '/executions', respond: ok(noExecutions) },
      ]),
    );
    renderApp('/runs/new');
    await user.type(await screen.findByLabelText('Seed'), '1.5');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByRole('heading', { name: 'The API refused the run' })).toBeInTheDocument();
    expect(screen.getByText('seed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
    await user.clear(screen.getByLabelText('Seed'));
    await user.type(screen.getByLabelText('Seed'), '42');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/runs/${run.id}`);
    });
  });

  test('a double submit starts one run: the button is disabled and the second request is never made', async () => {
    let release: (() => void) | undefined;
    const stub = stubApi(
      runFormRoutes([
        {
          method: 'POST',
          path: '/runs',
          respond: () =>
            new Promise<Response>((resolve) => {
              release = () => {
                resolve(jsonResponse(queuedRun, 202));
              };
            }),
        },
        { path: `/runs/${run.id}`, respond: ok(queuedRun) },
        { path: '/executions', respond: ok(noExecutions) },
      ]),
    );
    renderApp('/runs/new');
    fireEvent.change(await screen.findByLabelText('Seed'), { target: { value: '42' } });
    const form = screen.getByRole('button', { name: 'Start run' }).closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(stub.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/runs/${run.id}`);
    });
    expect(stub.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  test('with no scenario it says what to do first', async () => {
    stubApi([{ path: '/scenarios', respond: ok({ scenarios: [] }) }]);
    renderApp('/runs/new');
    expect(await screen.findByText(/A run needs a scenario/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create one first' })).toHaveAttribute('href', '/scenarios/new');
  });

  test('the run list and the empty state lead to the form', async () => {
    stubApi([{ path: '/runs', respond: ok({ runs: [], total: 0, limit: 25, offset: 0 }) }]);
    renderApp('/runs');
    expect(await screen.findByText(/No runs yet/)).toHaveTextContent('POST /runs');
    expect(screen.getByRole('link', { name: 'New run' })).toHaveAttribute('href', '/runs/new');
    expect(screen.getByRole('link', { name: 'start one here' })).toHaveAttribute('href', '/runs/new');
  });
});

function executionFormRoutes(extra: StubRoute[] = [], runs: unknown = fixtures.runs): StubRoute[] {
  return [
    { path: '/runs', respond: ok(runs) },
    { path: '/chaos-profiles', respond: ok(profileList) },
    { path: `/chaos-profiles/${PROFILE_ID}`, respond: ok(profileDetail) },
    ...extra,
  ];
}

const startedExecution = { ...fixtures.execution.pass, status: 'queued', verdict: null, deliveredAt: null, finishedAt: null, attemptCount: null, findingCount: null, delivery: null, targetResult: null, files: {} };
const executionRoutes = (): StubRoute[] => [
  { method: 'POST', path: '/executions', respond: () => jsonResponse(startedExecution, 202) },
  { path: `/executions/${startedExecution.id}`, respond: ok(startedExecution) },
];

async function startExecution(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Start execution' }));
}

describe('the execution form', () => {
  test('offers the succeeded runs and the profiles, and starts a reference target in memory with no Kafka option', async () => {
    const user = userEvent.setup();
    const stub = stubApi(executionFormRoutes(executionRoutes()));
    renderApp('/executions/new');
    expect(await screen.findByRole('heading', { name: 'New execution' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Run')).toHaveValue(run.id);
    expect(screen.getByRole('option', { name: /ecommerce-small v1 · seed 42/ })).toBeInTheDocument();
    expect(stub.calls[0]).toBe('/runs?status=succeeded&limit=200');
    await screen.findByRole('option', { name: 'Latest (v2)' });
    await user.type(screen.getByLabelText('Chaos seed'), '7');
    await startExecution(user);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/executions/${startedExecution.id}`);
    });
    expect(stub.requests.find((request) => request.method === 'POST')?.body).toEqual({
      runId: run.id,
      chaosProfileId: PROFILE_ID,
      chaosSeed: '7',
      target: { type: 'reference', name: 'correct', transport: 'memory' },
    });
  });

  test('a naive target through Kafka sends the options that were filled in, and a chosen profile version', async () => {
    const user = userEvent.setup();
    const stub = stubApi(executionFormRoutes(executionRoutes()));
    renderApp(`/executions/new?runId=${run.id}&chaosProfileId=${PROFILE_ID}`);
    await screen.findByRole('option', { name: 'v1' });
    await user.selectOptions(screen.getByLabelText('Profile version'), 'v1');
    await user.type(screen.getByLabelText('Chaos seed'), '7');
    await user.click(screen.getByRole('radio', { name: /Reference target: naive/ }));
    await user.selectOptions(screen.getByLabelText('Transport'), 'kafka');
    await user.type(screen.getByLabelText('Partitions'), '3');
    await user.type(screen.getByLabelText('Speed'), '5000');
    await user.type(screen.getByLabelText('Timeout (seconds)'), '120');
    await startExecution(user);
    await waitFor(() => {
      expect(stub.requests.some((request) => request.method === 'POST')).toBe(true);
    });
    expect(stub.requests.find((request) => request.method === 'POST')?.body).toEqual({
      runId: run.id,
      chaosProfileId: PROFILE_ID,
      chaosProfileVersion: 1,
      chaosSeed: '7',
      target: { type: 'reference', name: 'naive', transport: 'kafka', partitions: 3, speed: 5000, timeoutSeconds: 120 },
    });
  });

  test('going back to memory drops the Kafka options that were typed', async () => {
    const user = userEvent.setup();
    const stub = stubApi(executionFormRoutes(executionRoutes()));
    renderApp('/executions/new');
    await screen.findByRole('option', { name: 'Latest (v2)' });
    await user.type(screen.getByLabelText('Chaos seed'), '7');
    await user.selectOptions(screen.getByLabelText('Transport'), 'kafka');
    await user.type(screen.getByLabelText('Partitions'), '4');
    await user.selectOptions(screen.getByLabelText('Transport'), 'memory');
    expect(screen.queryByLabelText('Partitions')).not.toBeInTheDocument();
    await startExecution(user);
    await waitFor(() => {
      expect(stub.requests.some((request) => request.method === 'POST')).toBe(true);
    });
    expect((stub.requests.find((request) => request.method === 'POST')?.body as { target: object }).target).toEqual({ type: 'reference', name: 'correct', transport: 'memory' });
  });

  test('an external pipeline asks for its topic and group, and says what they must be', async () => {
    const user = userEvent.setup();
    const stub = stubApi(executionFormRoutes(executionRoutes()));
    renderApp('/executions/new');
    await screen.findByRole('option', { name: 'Latest (v2)' });
    await user.type(screen.getByLabelText('Chaos seed'), '7');
    await user.click(screen.getByRole('radio', { name: /Your own pipeline/ }));
    expect(screen.queryByLabelText('Transport')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Partitions')).not.toBeInTheDocument();
    await startExecution(user);
    expect(await screen.findByRole('heading', { name: 'Complete the form' })).toBeInTheDocument();
    expect(screen.getByText('target.topic')).toBeInTheDocument();
    expect(screen.getByText('target.groupId')).toBeInTheDocument();
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText('Topic'), 'shop-orders');
    await user.type(screen.getByLabelText('Consumer group'), 'shop-pipeline');
    await user.type(screen.getByLabelText('Speed'), 'max');
    await startExecution(user);
    await waitFor(() => {
      expect(stub.requests.some((request) => request.method === 'POST')).toBe(true);
    });
    expect(stub.requests.find((request) => request.method === 'POST')?.body).toEqual({
      runId: run.id,
      chaosProfileId: PROFILE_ID,
      chaosSeed: '7',
      target: { type: 'external', topic: 'shop-orders', groupId: 'shop-pipeline', speed: 'max' },
    });
  });

  test('a run that has not succeeded can still be asked for by link: the form lists it and the API\'s refusal is shown', async () => {
    const user = userEvent.setup();
    stubApi(
      executionFormRoutes([
        { path: `/runs/${queuedRun.id}`, respond: ok(queuedRun) },
        {
          method: 'POST',
          path: '/executions',
          respond: () => apiErrorResponse(409, 'Conflict', `Run ${queuedRun.id} is queued: only a succeeded run can be tested.`),
        },
      ], { runs: [], total: 0, limit: 200, offset: 0 }),
    );
    renderApp(`/executions/new?runId=${queuedRun.id}`);
    expect(await screen.findByRole('option', { name: /ecommerce-small v1 · seed 42 · .* · queued/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Chaos seed'), '7');
    await startExecution(user);
    expect(await screen.findByRole('heading', { name: 'The API cannot do this now' })).toBeInTheDocument();
    expect(screen.getByText(/only a succeeded run can be tested/)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/executions/new');
  });

  test('says what is missing when there is no run or no profile', async () => {
    stubApi([
      { path: '/runs', respond: ok({ runs: [], total: 0, limit: 200, offset: 0 }) },
      { path: '/chaos-profiles', respond: ok({ chaosProfiles: [] }) },
    ]);
    renderApp('/executions/new');
    expect(await screen.findByText(/needs a run that has succeeded and a chaos profile/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a run' })).toHaveAttribute('href', '/runs/new');
    expect(screen.getByRole('link', { name: 'create a chaos profile' })).toHaveAttribute('href', '/chaos-profiles/new');
  });

  test('the execution list leads to the form, and a run page leads to it with the run chosen', async () => {
    stubApi([
      { path: '/executions', respond: ok({ executions: [], total: 0, limit: 25, offset: 0 }) },
      { path: `/runs/${run.id}`, respond: ok(run) },
      { path: `/runs/${run.id}/events`, respond: ok(fixtures.runEvents) },
    ]);
    renderApp('/executions');
    expect(await screen.findByText(/No executions yet/)).toHaveTextContent('POST /executions');
    expect(screen.getByRole('link', { name: 'New execution' })).toHaveAttribute('href', '/executions/new');
    expect(screen.getByRole('link', { name: 'start one here' })).toHaveAttribute('href', '/executions/new');
    renderApp(`/runs/${run.id}`);
    const links = await screen.findAllByRole('link', { name: 'New execution' });
    expect(links.some((link) => link.getAttribute('href') === `/executions/new?runId=${run.id}`)).toBe(true);
  });
});

describe('a run that is still moving', () => {
  test('follows itself from queued to succeeded, shows its events once it is, and stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answers = 0;
      const stub = stubApi([
        {
          path: `/runs/${run.id}`,
          respond: () => {
            answers += 1;
            if (answers === 1) return jsonResponse(queuedRun);
            if (answers === 2) return jsonResponse({ ...queuedRun, status: 'running', startedAt: run.startedAt });
            return jsonResponse(run);
          },
        },
        { path: '/executions', respond: ok(noExecutions) },
        { path: `/runs/${run.id}/events`, respond: ok(fixtures.runEvents) },
      ]);
      renderApp(`/runs/${run.id}`);
      expect(await screen.findByText(/has not finished \(queued\)/)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Stored canonical events' })).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(await screen.findByText(/has not finished \(running\)/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(await screen.findByRole('heading', { name: 'Stored canonical events' })).toBeInTheDocument();
      expect(screen.queryByText(/has not finished/)).not.toBeInTheDocument();
      const asked = () => stub.calls.filter((call) => call === `/runs/${run.id}`).length;
      expect(asked()).toBe(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(asked()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps its last data while the API is down and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answers = 0;
      stubApi([
        {
          path: `/runs/${run.id}`,
          respond: () => {
            answers += 1;
            return answers === 2 ? new Response(null, { status: 502, headers: { 'content-type': 'text/plain' } }) : jsonResponse(queuedRun);
          },
        },
        { path: '/executions', respond: ok(noExecutions) },
      ]);
      renderApp(`/runs/${run.id}`);
      expect(await screen.findByText(/has not finished \(queued\)/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(await screen.findByText(/The latest refresh failed/)).toBeInTheDocument();
      expect(screen.getByText(/has not finished \(queued\)/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an execution waiting for an external pipeline', () => {
  const awaiting = (delivery: unknown = fixtures.execution.pass.delivery) => ({
    ...fixtures.execution.pass,
    status: 'awaiting_actual_state',
    verdict: null,
    finishedAt: null,
    findingCount: null,
    windowFindingCount: null,
    targetResult: null,
    files: {},
    delivery,
    target: { type: 'external', topic: 'shop-orders', groupId: 'shop-pipeline', speed: 'max', timeoutSeconds: 60 },
  });
  const id = fixtures.execution.pass.id;
  const file = (name: string, text: string) => new File([text], name, { type: 'application/json' });

  function completedAfterSubmit() {
    let submitted = false;
    const routes: StubRoute[] = [
      { path: `/executions/${id}`, respond: () => jsonResponse(submitted ? fixtures.execution.pass : awaiting()) },
      { path: `/executions/${id}/report`, respond: ok(fixtures.report.pass) },
      { path: `/executions/${id}/findings`, respond: ok({ executionId: id, findings: [], total: 0, limit: 25, offset: 0 }) },
      {
        method: 'POST',
        path: `/executions/${id}/actual-state`,
        respond: () => {
          submitted = true;
          return jsonResponse(fixtures.execution.pass);
        },
      },
    ];
    return routes;
  }

  test('submits the two files the pipeline wrote and follows the execution to its report', async () => {
    const user = userEvent.setup();
    const stub = stubApi(completedAfterSubmit());
    renderApp(`/executions/${id}`);
    expect(await screen.findByText(/Waiting for the pipeline's final state/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit and validate' })).toBeDisabled();
    await user.upload(screen.getByLabelText(/^actual-state\.json/), file('actual-state.json', '{"formatVersion":1,"orders":[]}'));
    await user.upload(screen.getByLabelText(/^actual-windows\.json/), file('actual-windows.json', '{"windows":[]}'));
    await user.click(screen.getByRole('button', { name: 'Submit and validate' }));
    expect(await screen.findByRole('heading', { name: 'Validation report' })).toBeInTheDocument();
    expect(stub.requests.find((request) => request.method === 'POST')?.body).toEqual({
      actualState: { formatVersion: 1, orders: [] },
      actualWindows: { windows: [] },
    });
    expect(screen.queryByText(/Waiting for the pipeline's final state/)).not.toBeInTheDocument();
  });

  test('sends no windows when none were chosen, and says when a windowed profile needs them', async () => {
    const user = userEvent.setup();
    const stub = stubApi(completedAfterSubmit());
    renderApp(`/executions/${id}`);
    await screen.findByText(/Waiting for the pipeline's final state/);
    expect(screen.getByLabelText(/^actual-windows\.json/).closest('label')).toHaveTextContent('only for a windowed profile');
    await user.upload(screen.getByLabelText(/^actual-state\.json/), file('actual-state.json', '{"orders":[]}'));
    await user.click(screen.getByRole('button', { name: 'Submit and validate' }));
    await screen.findByRole('heading', { name: 'Validation report' });
    expect(stub.requests.find((request) => request.method === 'POST')?.body).toEqual({ actualState: { orders: [] } });
  });

  test('says a windowed profile needs the windows file', async () => {
    stubApi([{ path: `/executions/${id}`, respond: ok(awaiting(fixtures.execution.late.delivery)) }]);
    renderApp(`/executions/${id}`);
    await screen.findByText(/Waiting for the pipeline's final state/);
    expect(screen.getByLabelText(/^actual-windows\.json/).closest('label')).toHaveTextContent('this profile has windows: required');
  });

  test('a file that is not JSON is reported by name and nothing is sent', async () => {
    const user = userEvent.setup();
    const stub = stubApi(completedAfterSubmit());
    renderApp(`/executions/${id}`);
    await screen.findByText(/Waiting for the pipeline's final state/);
    await user.upload(screen.getByLabelText(/^actual-state\.json/), file('actual-state.json', '{"orders": ['));
    await user.click(screen.getByRole('button', { name: 'Submit and validate' }));
    const refusal = await screen.findByRole('heading', { name: 'These files cannot be sent' });
    const problems = within(refusal.closest('section') as HTMLElement);
    expect(problems.getByText('actual-state.json')).toBeInTheDocument();
    expect(problems.getByText(/not valid JSON/)).toBeInTheDocument();
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  test('the API\'s refusal is listed with its paths and the execution keeps waiting', async () => {
    const user = userEvent.setup();
    stubApi([
      { path: `/executions/${id}`, respond: ok(awaiting()) },
      {
        method: 'POST',
        path: `/executions/${id}/actual-state`,
        respond: () => apiErrorResponse(400, 'Bad Request', ['actualState.customers[0].orderCount: Invalid input: expected number, received string']),
      },
    ]);
    renderApp(`/executions/${id}`);
    await screen.findByText(/Waiting for the pipeline's final state/);
    await user.upload(screen.getByLabelText(/^actual-state\.json/), file('actual-state.json', '{}'));
    await user.click(screen.getByRole('button', { name: 'Submit and validate' }));
    const refusal = await screen.findByRole('heading', { name: 'The API refused the state' });
    expect(within(refusal.closest('section') as HTMLElement).getByText('actualState.customers[0].orderCount')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the pipeline's final state/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit and validate' })).toBeEnabled();
  });
});


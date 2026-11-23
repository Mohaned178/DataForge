import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtures } from '../test/fixtures';
import { jsonResponse, ok, renderApp, stubApi } from '../test/support';

afterEach(() => {
  vi.unstubAllGlobals();
});

const { runId } = fixtures.index;

function rowsOf(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole('row').slice(1);
}

describe('run history', () => {
  test('lists the runs the API holds, linking each to its page', async () => {
    const stub = stubApi([{ path: '/runs', respond: ok(fixtures.runs) }]);
    renderApp('/runs');
    const table = await screen.findByRole('table', { name: /runs, newest first/i });
    const [row] = rowsOf(table);
    expect(within(row as HTMLElement).getByText('ecommerce-small')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('succeeded')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('472')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole('link')).toHaveAttribute('href', `/runs/${runId}`);
    expect(stub.calls).toEqual(['/runs?limit=25&offset=0']);
  });

  test('the status filter comes from the address and a change of it asks the API again', async () => {
    const user = userEvent.setup();
    const stub = stubApi([{ path: '/runs', respond: ok(fixtures.runs) }]);
    renderApp('/runs?status=failed');
    expect(await screen.findByLabelText('Status')).toHaveValue('failed');
    await user.selectOptions(screen.getByLabelText('Status'), 'queued');
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/runs?status=queued');
    });
    expect(stub.calls).toEqual(['/runs?status=failed&limit=25&offset=0', '/runs?status=queued&limit=25&offset=0']);
  });

  test('pages of a long history are followed with the offset in the address', async () => {
    const user = userEvent.setup();
    const stub = stubApi([
      {
        path: '/runs',
        respond: (url) => jsonResponse({ ...fixtures.runs, total: 60, limit: Number(url.searchParams.get('limit')), offset: Number(url.searchParams.get('offset')) }),
      },
    ]);
    renderApp('/runs');
    expect(await screen.findByText('Showing 1–25 of 60')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Next' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/runs?offset=25');
    });
    expect(stub.calls.at(-1)).toBe('/runs?limit=25&offset=25');
    expect(await screen.findByText('Showing 26–50 of 60')).toBeInTheDocument();
  });

  test('an empty history says how to make a run, and a filter with no match says so', async () => {
    stubApi([{ path: '/runs', respond: ok({ runs: [], total: 0, limit: 25, offset: 0 }) }]);
    renderApp('/runs');
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
    expect(screen.getByText('POST /runs')).toBeInTheDocument();
  });

  test('a scenario filter from a link is a chip that can be removed', async () => {
    const user = userEvent.setup();
    const stub = stubApi([{ path: '/runs', respond: ok(fixtures.runs) }]);
    renderApp('/runs?scenarioId=01a2085b-c221-77eb-80f4-aaaaaaaaaaaa');
    await user.click(await screen.findByRole('link', { name: 'Remove the Scenario filter' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/runs$/);
    });
    expect(stub.calls[0]).toContain('scenarioId=01a2085b-c221-77eb-80f4-aaaaaaaaaaaa');
  });
});

describe('execution history', () => {
  test('lists every execution with its target, status, verdict and findings', async () => {
    stubApi([{ path: '/executions', respond: ok(fixtures.executions) }]);
    renderApp('/executions');
    const table = await screen.findByRole('table', { name: /test executions, newest first/i });
    const rows = rowsOf(table).map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(5);
    expect(rows.some((text) => text.includes('naive · kafka') && text.includes('FAIL') && text.includes('48'))).toBe(true);
    expect(rows.some((text) => text.includes('correct · memory') && text.includes('PASS'))).toBe(true);
    expect(rows.some((text) => text.includes('0 + 7 windows'))).toBe(true);
  });

  test('a run and a verdict filter reach the API, and the run filter links back to the run', async () => {
    const stub = stubApi([{ path: '/executions', respond: ok(fixtures.executions) }]);
    renderApp(`/executions?runId=${runId}&verdict=FAIL`);
    expect(await screen.findByLabelText('Verdict')).toHaveValue('FAIL');
    expect(screen.getByRole('link', { name: 'Remove the Run filter' })).toBeInTheDocument();
    expect(stub.calls).toEqual([`/executions?verdict=FAIL&runId=${runId}&limit=25&offset=0`]);
  });

  test('an empty history says how to start an execution', async () => {
    stubApi([{ path: '/executions', respond: ok({ executions: [], total: 0, limit: 25, offset: 0 }) }]);
    renderApp('/executions');
    expect(await screen.findByText(/No executions yet/)).toBeInTheDocument();
    expect(screen.getByText('POST /executions')).toBeInTheDocument();
  });

  test('an external target shows its topic and group, and an unfinished execution has no verdict or counts', async () => {
    const waiting = {
      ...fixtures.executions.executions[0],
      status: 'awaiting_actual_state',
      verdict: null,
      findingCount: null,
      target: { type: 'external', topic: 'shop-orders', groupId: 'shop-pipeline', speed: 'max', timeoutSeconds: 60 },
    };
    stubApi([{ path: '/executions', respond: ok({ ...fixtures.executions, executions: [waiting], total: 1 }) }]);
    renderApp('/executions');
    const table = await screen.findByRole('table');
    const row = rowsOf(table)[0] as HTMLElement;
    expect(within(row).getByText('external · shop-orders / shop-pipeline')).toBeInTheDocument();
    expect(within(row).getByText('awaiting actual state')).toBeInTheDocument();
  });
});

describe('run detail', () => {
  const run = fixtures.run;
  const routes = (eventsFor?: (url: URL) => Response) => [
    { path: `/runs/${runId}`, respond: ok(run) },
    { path: '/executions', query: { runId }, respond: ok(fixtures.executions) },
    { path: `/runs/${runId}/events`, respond: eventsFor ?? ok(fixtures.runEvents) },
  ];

  test('shows what was generated, the expected state, the files and the executions of the run', async () => {
    stubApi(routes());
    renderApp(`/runs/${runId}`);
    expect(await screen.findByRole('heading', { name: 'What was generated' })).toBeInTheDocument();
    expect(screen.getByText('ecommerce-small v1')).toBeInTheDocument();
    expect(screen.getByText('Orders')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'manifest.json' })).toHaveAttribute('href', `/api/runs/${runId}/files/manifest.json`);
    const executions = await screen.findByRole('table', { name: /latest executions of this run/i });
    expect(rowsOf(executions)).toHaveLength(5);
  });

  test('lists stored events, and choosing an aggregate filters them', async () => {
    const user = userEvent.setup();
    const stub = stubApi(
      routes((url) =>
        jsonResponse({
          ...fixtures.runEvents,
          events: fixtures.runEvents.events.filter((event) => (url.searchParams.get('aggregateId') ?? event.aggregateId) === event.aggregateId),
        }),
      ),
    );
    renderApp(`/runs/${runId}`);
    const table = await screen.findByRole('table', { name: /canonical events of the run/i });
    const firstAggregate = fixtures.runEvents.events[0]?.aggregateId ?? '';
    await user.click(within(table).getAllByRole('link', { name: firstAggregate })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`aggregateId=${firstAggregate}`);
    });
    expect(stub.calls.at(-1)).toContain(`aggregateId=${firstAggregate}`);
  });

  test('a failed run shows its error and no event list', async () => {
    stubApi([
      { path: `/runs/${runId}`, respond: ok({ ...run, status: 'failed', error: 'Engine exploded', eventCount: null, files: null, summary: null, eventsByType: null }) },
      { path: '/executions', respond: ok({ executions: [], total: 0, limit: 10, offset: 0 }) },
    ]);
    renderApp(`/runs/${runId}`);
    expect(await screen.findByText(/This run failed: Engine exploded/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Stored canonical events' })).not.toBeInTheDocument();
  });

  test('a run that has not finished says so', async () => {
    stubApi([
      { path: `/runs/${runId}`, respond: ok({ ...run, status: 'running', finishedAt: null, eventCount: null, files: null, summary: null, eventsByType: null }) },
      { path: '/executions', respond: ok({ executions: [], total: 0, limit: 10, offset: 0 }) },
    ]);
    renderApp(`/runs/${runId}`);
    expect(await screen.findByText(/has not finished \(running\)/)).toBeInTheDocument();
  });
});

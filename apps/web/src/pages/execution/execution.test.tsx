import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtures } from '../../test/fixtures';
import { apiErrorResponse, jsonResponse, ok, pagedRoute, proxyDownResponse, renderApp, stubApi, type StubRoute } from '../../test/support';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ids = fixtures.index.executions;

function completedRoutes(label: 'pass' | 'fail' | 'late' | 'lossy' | 'kafka'): StubRoute[] {
  const id = ids[label];
  const routes: StubRoute[] = [
    { path: `/executions/${id}`, respond: ok(fixtures.execution[label]) },
    { path: `/executions/${id}/report`, respond: ok(fixtures.report[label]) },
  ];
  if (label === 'fail') routes.push(pagedRoute(`/executions/${id}/findings`, fixtures.findings.fail));
  else routes.push({ path: `/executions/${id}/findings`, respond: ok({ executionId: id, findings: [], total: 0, limit: 25, offset: 0 }) });
  if (label === 'late') routes.push(pagedRoute(`/executions/${id}/window-findings`, fixtures.windowFindings.late));
  return routes;
}

function findingsTable() {
  return screen.findByRole('table', { name: /findings, in report order/i });
}

describe('a failing execution', () => {
  test('shows the verdict, what the delivery did, the counts per category and the root causes', async () => {
    stubApi(completedRoutes('fail'));
    renderApp(`/executions/${ids.fail}`);
    expect(await screen.findByRole('heading', { name: 'Validation report' })).toBeInTheDocument();
    const facts = within(screen.getByRole('heading', { name: 'Summary' }).closest('section') as HTMLElement);
    expect(facts.getByText('FAIL')).toBeInTheDocument();
    expect(facts.getByText('naive · memory')).toBeInTheDocument();

    const delivery = within(screen.getByRole('heading', { name: 'Delivery' }).closest('section') as HTMLElement);
    expect(delivery.getByText('Delivery attempts').nextElementSibling).toHaveTextContent('486');
    expect(delivery.getByText('Events out of order').nextElementSibling).toHaveTextContent('10');
    const faults = delivery.getByRole('table', { name: /configured rate against what was observed/i });
    const duplicate = within(faults).getByRole('row', { name: /duplicate/ });
    expect(duplicate).toHaveTextContent('3.0%');
    expect(duplicate).toHaveTextContent('14 extra deliveries');

    const validation = within(await screen.findByRole('heading', { name: 'Validation report' }).then((heading) => heading.closest('section') as HTMLElement));
    expect(await validation.findByText(/48 findings: 48 explained by a delivery fault, 0 not explained by delivery\./)).toBeInTheDocument();
    expect(validation.getByRole('link', { name: 'double-processing' }).closest('li')).toHaveTextContent('8');
    expect(validation.getByText('missing-entity').closest('li')).toHaveTextContent('0');
    const rootCauses = validation.getByRole('table', { name: /root causes of the findings/i });
    expect(rootCauses).toHaveTextContent('evt_ord_000045_1');
    expect(rootCauses).toHaveTextContent('overtaken by evt_ord_000045_2');
  });

  test('lists the findings a page at a time, in report order', async () => {
    const stub = stubApi(completedRoutes('fail'));
    renderApp(`/executions/${ids.fail}`);
    const table = await findingsTable();
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(25);
    expect(screen.getByText('Showing 1–25 of 48')).toBeInTheDocument();
    expect(stub.calls).toContain(`/executions/${ids.fail}/findings?limit=25&offset=0`);
  });

  test('opening a finding shows its differences and causes and puts it in the address', async () => {
    const user = userEvent.setup();
    stubApi(completedRoutes('fail'));
    renderApp(`/executions/${ids.fail}`);
    const first = fixtures.findings.fail.findings[0];
    await user.click(await screen.findByRole('button', { name: new RegExp(`Show finding 1: ${first?.entityId}`) }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('open=0');
    });
    const detail = within((await findingsTable()).querySelector('.finding-detail') as HTMLElement);
    expect(detail.getByText(first?.message ?? '')).toBeInTheDocument();
    expect(detail.getByRole('table', { name: /expected against actual/i })).toHaveTextContent('totalPaidMinor');
    const links = detail.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links[0]).toBe(`/executions/${ids.fail}/aggregates/${first?.entityId}?finding=0`);
    expect(links.length).toBeGreaterThan(1);
    expect(links.every((href) => href?.includes('?finding=0'))).toBe(true);

    await user.click(screen.getByRole('button', { name: /Hide finding 1/ }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).not.toHaveTextContent('open=');
    });
  });

  test('a finding opened from a link is already open, and the page stays where it was', async () => {
    stubApi(completedRoutes('fail'));
    renderApp(`/executions/${ids.fail}?offset=25&open=30`);
    const table = await findingsTable();
    expect(within(table).getByRole('button', { name: /Hide finding 31/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Showing 26–48 of 48')).toBeInTheDocument();
  });

  test('filtering by category asks the API and returns to the first page', async () => {
    const user = userEvent.setup();
    const stub = stubApi([
      ...completedRoutes('fail').filter((route) => !route.path.endsWith('/findings')),
      {
        path: `/executions/${ids.fail}/findings`,
        respond: (url) => {
          const category = url.searchParams.get('category');
          const matching = fixtures.findings.fail.findings.filter((finding) => category === null || finding.category === category);
          const offset = Number(url.searchParams.get('offset'));
          const limit = Number(url.searchParams.get('limit'));
          return jsonResponse({ ...fixtures.findings.fail, findings: matching.slice(offset, offset + limit), total: matching.length, limit, offset });
        },
      },
    ]);
    renderApp(`/executions/${ids.fail}?offset=25`);
    await findingsTable();
    await user.selectOptions(screen.getByLabelText('Category'), 'status-mismatch');
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/executions/${ids.fail}?category=status-mismatch`);
    });
    expect(stub.calls.at(-1)).toBe(`/executions/${ids.fail}/findings?category=status-mismatch&limit=25&offset=0`);
    const rows = within(await findingsTable()).getAllByRole('row').slice(1);
    expect(rows.every((row) => row.textContent?.includes('status-mismatch'))).toBe(true);
  });

  test('the category counts link to the findings of that category', async () => {
    const user = userEvent.setup();
    stubApi(completedRoutes('fail'));
    renderApp(`/executions/${ids.fail}`);
    await user.click(await screen.findByRole('link', { name: 'status-mismatch' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('category=status-mismatch');
    });
  });

  test('a root cause links to the timeline of its event', async () => {
    stubApi(completedRoutes('fail'));
    renderApp(`/executions/${ids.fail}`);
    const table = await screen.findByRole('table', { name: /root causes of the findings/i });
    expect(within(table).getAllByRole('link')[0]).toHaveAttribute('href', expect.stringMatching(new RegExp(`^/executions/${ids.fail}/aggregates/ord_\\d+\\?event=evt_ord_\\d+_\\d+$`)));
  });
});

describe('a passing execution', () => {
  test('says the target ended in the expected state and has no findings table rows', async () => {
    stubApi(completedRoutes('pass'));
    renderApp(`/executions/${ids.pass}`);
    expect(await screen.findByText('The target ended in the expected state.')).toBeInTheDocument();
    expect(await screen.findByText('No findings: the target ended in the expected state.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Window findings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Root causes' })).not.toBeInTheDocument();
  });
});

describe('a windowed execution with late data', () => {
  test('shows the window arrivals and the window findings, with the events behind them', async () => {
    const user = userEvent.setup();
    stubApi(completedRoutes('late'));
    renderApp(`/executions/${ids.late}`);
    const delivery = within((await screen.findByRole('heading', { name: 'Windows', level: 3 })).closest('section') as HTMLElement);
    expect(delivery.getByText('After its window closed').nextElementSibling).toHaveTextContent('9');

    const table = await screen.findByRole('table', { name: /window findings, in report order/i });
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(7);
    await user.click(within(table).getByRole('button', { name: /Show window finding 1/ }));
    const detail = within(table.querySelector('.finding-detail') as HTMLElement);
    expect(detail.getByText('after-close')).toBeInTheDocument();
    expect(detail.getByRole('link', { name: 'timeline' })).toHaveAttribute('href', `/executions/${ids.late}/events/${fixtures.index.lateWindowEventId}?windowFinding=0`);
    expect(screen.getByTestId('location')).toHaveTextContent('wopen=0');
  });

  test('window findings page and filter independently of the entity findings', async () => {
    const user = userEvent.setup();
    stubApi(completedRoutes('late'));
    renderApp(`/executions/${ids.late}?offset=0`);
    await screen.findByRole('table', { name: /window findings, in report order/i });
    await user.selectOptions(screen.getByLabelText('Category', { selector: '#window-findings select' }), 'window-undercount');
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('wcategory=window-undercount');
    });
  });
});

describe('an execution through Kafka', () => {
  test('shows the topic and offers every file it has, including the Kafka ones', async () => {
    stubApi(completedRoutes('kafka'));
    renderApp(`/executions/${ids.kafka}`);
    const kafka = within((await screen.findByRole('heading', { name: 'Kafka' })).closest('section') as HTMLElement);
    expect(kafka.getByText('Topic').nextElementSibling).toHaveTextContent('dataforge.');
    expect(kafka.getByText('Records sent').nextElementSibling).toHaveTextContent('486');
    expect(await screen.findByRole('link', { name: 'delivery-log.jsonl' })).toHaveAttribute('href', `/api/executions/${ids.kafka}/files/delivery-log.jsonl`);
    expect(screen.getByRole('link', { name: 'validation-report.json' })).toBeInTheDocument();
  });
});

describe('an execution that has not completed', () => {
  const unfinished = (overrides: Record<string, unknown>) => ({
    ...fixtures.execution.pass,
    verdict: null,
    deliveredAt: null,
    finishedAt: null,
    attemptCount: null,
    findingCount: null,
    delivery: null,
    targetResult: null,
    files: {},
    ...overrides,
  });

  test('a running execution says so, makes no report request, follows itself to the report and then stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answers = 0;
      const stub = stubApi([
        {
          path: `/executions/${ids.pass}`,
          respond: () => {
            answers += 1;
            return jsonResponse(answers < 3 ? unfinished({ status: 'running' }) : fixtures.execution.pass);
          },
        },
        ...completedRoutes('pass').slice(1),
      ]);
      renderApp(`/executions/${ids.pass}`);
      expect(await screen.findByText(/This execution is running/)).toBeInTheDocument();
      expect(screen.getByText(/this page updates by itself until it ends/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
      expect(stub.calls).toEqual([`/executions/${ids.pass}`]);
      expect(screen.queryByRole('heading', { name: 'Validation report' })).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(await screen.findByRole('heading', { name: 'Validation report' })).toBeInTheDocument();
      expect(screen.queryByText(/This execution is running/)).not.toBeInTheDocument();
      const asked = () => stub.calls.filter((call) => call === `/executions/${ids.pass}`).length;
      expect(asked()).toBe(3);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(asked()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a refresh that fails keeps the last data on screen, says so, and recovers by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answers = 0;
      stubApi([
        {
          path: `/executions/${ids.pass}`,
          respond: () => {
            answers += 1;
            return answers === 2 ? proxyDownResponse() : jsonResponse(unfinished({ status: 'running' }));
          },
        },
      ]);
      renderApp(`/executions/${ids.pass}`);
      expect(await screen.findByText(/This execution is running/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(await screen.findByText(/The latest refresh failed/)).toBeInTheDocument();
      expect(screen.getByText(/This execution is running/)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'The API is not reachable' })).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      await waitFor(() => {
        expect(screen.queryByText(/The latest refresh failed/)).not.toBeInTheDocument();
      });
      expect(screen.getByText(/This execution is running/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('an execution waiting for a pipeline says what it needs and how to give it', async () => {
    stubApi([
      {
        path: `/executions/${ids.pass}`,
        respond: ok(
          unfinished({ status: 'awaiting_actual_state', target: { type: 'external', topic: 'shop-orders', groupId: 'shop-pipeline', speed: 'max', timeoutSeconds: 60 } }),
        ),
      },
    ]);
    renderApp(`/executions/${ids.pass}`);
    expect(await screen.findByText(/Waiting for the pipeline's final state/)).toBeInTheDocument();
    expect(screen.getByText('shop-orders')).toBeInTheDocument();
    expect(screen.getByText('shop-pipeline')).toBeInTheDocument();
    expect(screen.getByText(`POST /executions/${fixtures.execution.pass.id}/actual-state`)).toBeInTheDocument();
  });

  test('a failed execution shows why it could not complete and that it has no verdict', async () => {
    stubApi([{ path: `/executions/${ids.pass}`, respond: ok(unfinished({ status: 'failed', error: 'Kafka is not reachable at localhost:9092' })) }]);
    renderApp(`/executions/${ids.pass}`);
    expect(await screen.findByText('Kafka is not reachable at localhost:9092')).toBeInTheDocument();
    expect(screen.getByText(/has no verdict/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('when something cannot be shown', () => {
  test('an unknown execution is "not found"', async () => {
    stubApi([{ path: '/executions/nope', respond: () => apiErrorResponse(404, 'Not Found', 'Execution nope does not exist') }]);
    renderApp('/executions/nope');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByText('Execution nope does not exist')).toBeInTheDocument();
  });

  test('an unreachable API says what to start, and Try again asks again', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const stub = stubApi([
      {
        path: '/executions',
        respond: () => {
          attempts += 1;
          return attempts === 1 ? proxyDownResponse() : jsonResponse(fixtures.executions);
        },
      },
    ]);
    renderApp('/executions');
    expect(await screen.findByRole('heading', { name: 'The API is not reachable' })).toBeInTheDocument();
    expect(screen.getByText('pnpm api')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(stub.calls).toHaveLength(2);
  });

  test('a report that is not ready is "not available yet", not an error', async () => {
    stubApi([
      { path: `/executions/${ids.fail}`, respond: ok(fixtures.execution.fail) },
      { path: `/executions/${ids.fail}/report`, respond: () => apiErrorResponse(409, 'Conflict', 'Execution is not completed') },
      pagedRoute(`/executions/${ids.fail}/findings`, fixtures.findings.fail),
    ]);
    renderApp(`/executions/${ids.fail}`);
    expect(await screen.findByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
    expect(screen.getByText('Execution is not completed')).toBeInTheDocument();
  });

  test('a tampered execution is reported as an integrity error, never as an ordinary failure', async () => {
    stubApi([
      { path: `/executions/${ids.fail}`, respond: ok(fixtures.execution.fail) },
      { path: `/executions/${ids.fail}/report`, respond: () => apiErrorResponse(500, 'Execution Integrity Error', 'validation-report.json does not match its checksum') },
      pagedRoute(`/executions/${ids.fail}/findings`, fixtures.findings.fail),
    ]);
    renderApp(`/executions/${ids.fail}`);
    expect(await screen.findByRole('heading', { name: /Integrity error: stored data no longer matches its checksum/ })).toBeInTheDocument();
    expect(screen.getByText('validation-report.json does not match its checksum')).toBeInTheDocument();
    expect(screen.queryByText(/The API failed/)).not.toBeInTheDocument();
  });

  test('a response the UI does not understand names the field', async () => {
    stubApi([{ path: `/executions/${ids.fail}`, respond: ok({ ...fixtures.execution.fail, status: 'exploded' }) }]);
    renderApp(`/executions/${ids.fail}`);
    expect(await screen.findByRole('heading', { name: 'Unexpected response from the API' })).toBeInTheDocument();
    expect(screen.getByText(/status: /)).toBeInTheDocument();
  });

  test('an unknown address is a page, not a blank screen', async () => {
    renderApp('/no/such/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  test('the root address goes to the executions', async () => {
    stubApi([{ path: '/executions', respond: ok(fixtures.executions) }]);
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Executions' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/executions');
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtures, type AggregateFixture } from '../../test/fixtures';
import { apiErrorResponse, jsonResponse, ok, renderApp, stubApi, type StubRoute } from '../../test/support';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Label = 'pass' | 'fail' | 'late' | 'lossy' | 'kafka';

function aggregateRoutes(label: Label, fixture: AggregateFixture): StubRoute[] {
  const executionId = fixture.executionId;
  return [
    { path: `/executions/${executionId}`, respond: ok(fixtures.execution[label]) },
    { path: `/runs/${fixtures.index.runId}/events`, query: { aggregateId: fixture.aggregateId }, respond: ok(fixture.runEvents) },
    { path: `/executions/${executionId}/attempts`, query: { aggregateId: fixture.aggregateId }, respond: ok(fixture.attempts) },
  ];
}

function open(label: Label, fixture: AggregateFixture, search = '') {
  const stub = stubApi(aggregateRoutes(label, fixture));
  renderApp(`/executions/${fixture.executionId}/aggregates/${fixture.aggregateId}${search}`);
  return stub;
}

const canonical = () => screen.findByRole('table', { name: /canonical events of the aggregate/i });
const delivery = () => screen.findByRole('table', { name: /delivery attempts of the aggregate/i });
const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);

describe('the two timelines of an aggregate', () => {
  test('shows the canonical events in version order beside the deliveries in delivery order', async () => {
    const stub = open('fail', fixtures.aggregate.reorder);
    const events = bodyRows(await canonical());
    const deliveries = bodyRows(await delivery());
    expect(events.map((row) => row.getAttribute('data-event-id'))).toEqual([1, 2, 3, 4].map((version) => `evt_ord_000088_${version}`));
    expect(deliveries.map((row) => row.getAttribute('data-event-id'))).toEqual(['evt_ord_000088_1', 'evt_ord_000088_3', 'evt_ord_000088_2', 'evt_ord_000088_4']);
    expect(screen.getByRole('heading', { name: /Order ord_000088/ })).toBeInTheDocument();
    expect(stub.calls).toContain(`/runs/${fixtures.index.runId}/events?aggregateId=ord_000088&fromSequence=1&limit=1000`);
    expect(stub.calls).toContain(`/executions/${fixtures.aggregate.reorder.executionId}/attempts?aggregateId=ord_000088&fromSequence=1&limit=1000`);
  });

  test('a reordered event is marked out of order, with the event that overtook it', async () => {
    open('fail', fixtures.aggregate.reorder);
    const events = bodyRows(await canonical());
    const payment = events[1] as HTMLElement;
    expect(within(payment).getByText('out of order')).toBeInTheDocument();
    expect(within(payment).getByText('reordered')).toBeInTheDocument();
    expect(payment).toHaveTextContent('overtaken by evt_ord_000088_3');
    expect(events[0]).toHaveTextContent('delivered once, in order');
    const summary = within(screen.getByRole('heading', { name: 'Summary' }).closest('section') as HTMLElement);
    expect(summary.getByText('Out of order').nextElementSibling).toHaveTextContent('1');
  });

  test('says in words what each fault did to the delivery', async () => {
    open('fail', fixtures.aggregate.reorder);
    const reordered = bodyRows(await delivery())[2] as HTMLElement;
    expect(reordered).toHaveTextContent(/Reordered behind evt_ord_000088_3, the next event of its aggregate/);
    expect(reordered).toHaveTextContent(/after the event/);
  });

  test('a duplicate is a second delivery of the same event, with its own attempt and the one it copies', async () => {
    open('fail', fixtures.aggregate.duplicate);
    const rows = bodyRows(await delivery());
    const copies = rows.filter((row) => row.getAttribute('data-event-id') === 'evt_ord_000018_3');
    expect(copies).toHaveLength(2);
    expect(copies[1]).toHaveTextContent('duplicate');
    expect(copies[1]).toHaveTextContent('Extra copy 1 of 1');
    expect(copies[1]).toHaveTextContent('Redelivered 26.4 s after att_ord_000018_3_1');
    const events = bodyRows(await canonical());
    expect(within(events[2] as HTMLElement).getByText('duplicated')).toBeInTheDocument();
    expect(within(events[3] as HTMLElement).getByText('delayed')).toBeInTheDocument();
    expect(screen.queryByText('out of order')).not.toBeInTheDocument();
  });

  test('a lost event shows its failed attempts, none of them delivered', async () => {
    open('lossy', fixtures.aggregate.lost);
    const rows = bodyRows(await delivery());
    const attempts = rows.filter((row) => row.getAttribute('data-event-id') === 'evt_ord_000041_3');
    expect(attempts).toHaveLength(3);
    for (const row of attempts) expect(row).toHaveTextContent('failed, never sent');
    const events = bodyRows(await canonical());
    const payment = events[2] as HTMLElement;
    expect(within(payment).getByText('lost')).toBeInTheDocument();
    expect(within(payment).getByText('retried')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Version 3, PaymentCompleted, lost/ })).toBeInTheDocument();
  });

  test('a late event is marked late and out of order', async () => {
    open('late', fixtures.aggregate.late);
    const payment = bodyRows(await canonical())[1] as HTMLElement;
    expect(within(payment).getByText('late')).toBeInTheDocument();
    expect(within(payment).getByText('out of order')).toBeInTheDocument();
    expect(bodyRows(await delivery())[2]).toHaveTextContent(/Late: held until after its window closed/);
  });

  test('through Kafka the partition and offset of each delivery are shown', async () => {
    open('kafka', fixtures.aggregate.kafka);
    const rows = bodyRows(await delivery());
    expect(within(await delivery()).getByRole('columnheader', { name: 'Kafka' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('partition 0, offset 57');
  });

  test('in memory there is no Kafka column', async () => {
    open('fail', fixtures.aggregate.reorder);
    expect(within(await delivery()).queryByRole('columnheader', { name: 'Kafka' })).not.toBeInTheDocument();
  });
});

describe('the lanes diagram', () => {
  test('draws one dot per event and per delivery and a line from each event to each of its deliveries', async () => {
    open('fail', fixtures.aggregate.reorder);
    const lanes = await screen.findByRole('group', { name: /Event lanes/ });
    expect(within(lanes).getAllByRole('button')).toHaveLength(8);
    expect(lanes.querySelectorAll('line.lane-line')).toHaveLength(4);
  });

  test('a duplicate adds a second, dashed line to the same event', async () => {
    open('fail', fixtures.aggregate.duplicate);
    const lanes = await screen.findByRole('group', { name: /Event lanes/ });
    expect(lanes.querySelectorAll('line.lane-line')).toHaveLength(6);
    expect(lanes.querySelectorAll('line.lane-line--duplicate')).toHaveLength(1);
  });

  test('an event that was reordered crosses the line of the event that overtook it', async () => {
    open('fail', fixtures.aggregate.reorder);
    const lanes = await screen.findByRole('group', { name: /Event lanes/ });
    const lines = [...lanes.querySelectorAll('line.lane-line')].map((line) => ({
      from: Number(line.getAttribute('x1')),
      to: Number(line.getAttribute('x2')),
    }));
    const crossings = lines.flatMap((a, i) => lines.slice(i + 1).filter((b) => (a.from - b.from) * (a.to - b.to) < 0));
    expect(crossings).toHaveLength(1);
  });

  test('a lost event is drawn in the flagged style, and has no line because nothing of it reached the target', async () => {
    open('lossy', fixtures.aggregate.lost);
    const lanes = await screen.findByRole('group', { name: /Event lanes/ });
    expect(lanes.querySelectorAll('.lane-dot--flagged')).toHaveLength(1);
    expect(within(lanes).getAllByRole('button')).toHaveLength(4 + 3);
    const lines = [...lanes.querySelectorAll('line.lane-line')];
    expect(lines).toHaveLength(3);
    const lostDot = within(lanes).getByRole('button', { name: /Version 3, PaymentCompleted, lost/ });
    const lostX = lostDot.querySelector('circle')?.getAttribute('cx');
    expect(lines.map((line) => line.getAttribute('x1'))).not.toContain(lostX);
    expect(bodyRows(await delivery())).toHaveLength(6);
  });
});

describe('following one event through both timelines', () => {
  test('selecting an event highlights it on both sides and in the diagram, and is in the address', async () => {
    const user = userEvent.setup();
    open('fail', fixtures.aggregate.reorder);
    const events = bodyRows(await canonical());
    await user.click(within(events[1] as HTMLElement).getByRole('button', { name: 'PaymentCompleted' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('?event=evt_ord_000088_2');
    });
    const highlighted = document.querySelectorAll('tr.is-active');
    expect([...highlighted].map((row) => row.getAttribute('data-event-id'))).toEqual(['evt_ord_000088_2', 'evt_ord_000088_2']);
    const lanes = screen.getByRole('group', { name: /Event lanes/ });
    expect(lanes.querySelectorAll('line.lane-line.is-active')).toHaveLength(1);
    expect(lanes.querySelectorAll('line.lane-line.is-dim')).toHaveLength(3);
  });

  test('selecting it again releases the focus', async () => {
    const user = userEvent.setup();
    open('fail', fixtures.aggregate.reorder, '?event=evt_ord_000088_2');
    const events = bodyRows(await canonical());
    expect(events[1]).toHaveClass('is-active');
    await user.click(within(events[1] as HTMLElement).getByRole('button', { name: 'PaymentCompleted' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).not.toHaveTextContent('event=');
    });
  });

  test('a delivery in the diagram can be selected from the keyboard', async () => {
    const user = userEvent.setup();
    open('fail', fixtures.aggregate.reorder);
    await canonical();
    const dot = screen.getByRole('button', { name: /Delivery 58: version 2, original, delivered/ });
    dot.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('event=evt_ord_000088_2');
    });
  });

  test('hovering a delivery row highlights its event without changing the address', async () => {
    const user = userEvent.setup();
    open('fail', fixtures.aggregate.reorder);
    const rows = bodyRows(await delivery());
    await user.hover(rows[2] as HTMLElement);
    expect(document.querySelectorAll('tr.is-active')).toHaveLength(2);
    expect(screen.getByTestId('location')).not.toHaveTextContent('event=');
    await user.unhover(rows[2] as HTMLElement);
    expect(document.querySelectorAll('tr.is-active')).toHaveLength(0);
  });
});

describe('the finding a timeline was opened from', () => {
  test('shows the finding, its differences and its causes above the timelines', async () => {
    const finding = fixtures.findings.fail.findings[0];
    const aggregate = fixtures.aggregate.reorder;
    const stub = stubApi([
      ...aggregateRoutes('fail', aggregate),
      { path: `/executions/${aggregate.executionId}/findings`, query: { offset: '0', limit: '1' }, respond: ok({ ...fixtures.findings.fail, findings: [finding], limit: 1 }) },
    ]);
    renderApp(`/executions/${aggregate.executionId}/aggregates/${aggregate.aggregateId}?finding=0`);
    const context = within((await screen.findByRole('heading', { name: 'Opened from finding 1' })).closest('section') as HTMLElement);
    expect(await context.findByText(finding?.message ?? '')).toBeInTheDocument();
    expect(context.getByRole('table', { name: /expected against actual/i })).toBeInTheDocument();
    expect(stub.calls).toContain(`/executions/${aggregate.executionId}/findings?offset=0&limit=1`);
  });

  test('a finding number the execution does not have is said plainly', async () => {
    const aggregate = fixtures.aggregate.reorder;
    stubApi([
      ...aggregateRoutes('fail', aggregate),
      { path: `/executions/${aggregate.executionId}/findings`, respond: ok({ ...fixtures.findings.fail, findings: [], limit: 1, offset: 99 }) },
    ]);
    renderApp(`/executions/${aggregate.executionId}/aggregates/${aggregate.aggregateId}?finding=99`);
    expect(await screen.findByText('This execution has no finding 100.')).toBeInTheDocument();
  });

  test('a window finding shows the events behind the window', async () => {
    const aggregate = fixtures.aggregate.late;
    const window = fixtures.windowFindings.late.findings[0];
    stubApi([
      ...aggregateRoutes('late', aggregate),
      { path: `/executions/${aggregate.executionId}/window-findings`, query: { offset: '0', limit: '1' }, respond: ok({ ...fixtures.windowFindings.late, findings: [window], limit: 1 }) },
    ]);
    renderApp(`/executions/${aggregate.executionId}/aggregates/${aggregate.aggregateId}?windowFinding=0`);
    const context = within((await screen.findByRole('heading', { name: 'Opened from window finding 1' })).closest('section') as HTMLElement);
    expect(await context.findByText('after-close')).toBeInTheDocument();
  });
});

describe('an event link without an aggregate', () => {
  test('is resolved through the delivery attempts and ends on the aggregate timeline with the event focused', async () => {
    const aggregate = fixtures.aggregate.late;
    const eventId = fixtures.index.lateWindowEventId;
    const attemptOfEvent = fixtures.aggregate.late.attempts.attempts.find((attempt) => attempt.eventId === eventId);
    const stub = stubApi([
      ...aggregateRoutes('late', aggregate),
      { path: `/executions/${aggregate.executionId}/attempts`, query: { eventId }, respond: ok({ ...fixtures.aggregate.late.attempts, attempts: [attemptOfEvent] }) },
    ]);
    renderApp(`/executions/${aggregate.executionId}/events/${eventId}?windowFinding=0`);
    await canonical();
    expect(screen.getByTestId('location')).toHaveTextContent(`/executions/${aggregate.executionId}/aggregates/ord_000012?windowFinding=0&event=${eventId}`);
    expect(stub.calls[0]).toBe(`/executions/${aggregate.executionId}/attempts?eventId=${eventId}&limit=1`);
  });

  test('an event the execution never planned is reported', async () => {
    const aggregate = fixtures.aggregate.late;
    stubApi([{ path: `/executions/${aggregate.executionId}/attempts`, respond: ok({ ...fixtures.aggregate.late.attempts, attempts: [], nextSequence: null }) }]);
    renderApp(`/executions/${aggregate.executionId}/events/evt_nothing_1`);
    expect(await screen.findByText(/no delivery attempt for/)).toBeInTheDocument();
  });
});

describe('when a timeline cannot be shown', () => {
  test('an execution that has not delivered yet is "not available yet"', async () => {
    const aggregate = fixtures.aggregate.reorder;
    stubApi([
      { path: `/executions/${aggregate.executionId}`, respond: ok(fixtures.execution.fail) },
      { path: `/runs/${fixtures.index.runId}/events`, respond: ok(aggregate.runEvents) },
      { path: `/executions/${aggregate.executionId}/attempts`, respond: () => apiErrorResponse(409, 'Conflict', 'Execution has not delivered yet') },
    ]);
    renderApp(`/executions/${aggregate.executionId}/aggregates/${aggregate.aggregateId}`);
    expect(await screen.findByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
  });

  test('an aggregate the run does not have says so instead of showing empty tables', async () => {
    const aggregate = fixtures.aggregate.reorder;
    stubApi([
      { path: `/executions/${aggregate.executionId}`, respond: ok(fixtures.execution.fail) },
      { path: `/runs/${fixtures.index.runId}/events`, respond: ok({ runId: fixtures.index.runId, events: [], nextSequence: null }) },
      { path: `/executions/${aggregate.executionId}/attempts`, respond: ok({ executionId: aggregate.executionId, attempts: [], nextSequence: null }) },
    ]);
    renderApp(`/executions/${aggregate.executionId}/aggregates/ord_999999`);
    expect(await screen.findByText(/no stored events for/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('a tampered run is an integrity error on the timeline too', async () => {
    const aggregate = fixtures.aggregate.reorder;
    stubApi([
      { path: `/executions/${aggregate.executionId}`, respond: ok(fixtures.execution.fail) },
      { path: `/runs/${fixtures.index.runId}/events`, respond: () => apiErrorResponse(500, 'Run Integrity Error', 'A stored event is not a canonical event') },
      { path: `/executions/${aggregate.executionId}/attempts`, respond: ok(aggregate.attempts) },
    ]);
    renderApp(`/executions/${aggregate.executionId}/aggregates/${aggregate.aggregateId}`);
    expect(await screen.findByRole('heading', { name: /Integrity error/ })).toBeInTheDocument();
  });

  test('the timeline of an event is also reachable for an aggregate whose events span several pages', async () => {
    const aggregate = fixtures.aggregate.reorder;
    let page = 0;
    stubApi([
      { path: `/executions/${aggregate.executionId}`, respond: ok(fixtures.execution.fail) },
      {
        path: `/runs/${fixtures.index.runId}/events`,
        respond: () => {
          page += 1;
          const events = page === 1 ? aggregate.runEvents.events.slice(0, 2) : aggregate.runEvents.events.slice(2);
          return jsonResponse({ runId: fixtures.index.runId, events, nextSequence: page === 1 ? 9999 : null });
        },
      },
      { path: `/executions/${aggregate.executionId}/attempts`, respond: ok(aggregate.attempts) },
    ]);
    renderApp(`/executions/${aggregate.executionId}/aggregates/${aggregate.aggregateId}`);
    expect(bodyRows(await canonical())).toHaveLength(4);
  });
});

import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import type { Run } from '../api/schemas';
import { StatusBadge, VerdictBadge } from '../components/Badges';
import { Facts, Section } from '../components/Controls';
import { ResourceView } from '../components/ResourceView';
import { useResource } from '../hooks/use-resource';
import { formatCount, formatMoney, formatSimTime, formatSpan, formatTimestamp, shortId } from '../lib/format';
import { summarizePayload } from '../lib/payload';
import { paramOf, withParams, wholeParamOf } from '../lib/query';
import { describeTarget } from '../lib/target';

const EVENT_PAGE = 25;

function RunSummary({ run }: { run: Run }) {
  return (
    <Section title="What was generated">
      <Facts
        items={[
          { label: 'Status', value: <StatusBadge status={run.status} /> },
          { label: 'Scenario', value: `${run.scenario.name} v${run.scenario.version}` },
          { label: 'Scenario hash', value: <code title={run.scenario.scenarioHash}>{run.scenario.scenarioHash.slice(0, 19)}&hellip;</code> },
          { label: 'Seed', value: <code>{run.seed}</code> },
          { label: 'Engine version', value: run.engineVersion },
          { label: 'Requested', value: formatTimestamp(run.requestedAt) },
          { label: 'Took', value: formatSpan(run.startedAt, run.finishedAt) },
          { label: 'Events', value: run.eventCount === null ? '—' : formatCount(run.eventCount) },
        ]}
      />
      {run.error ? (
        <p role="alert" className="panel panel--bad">
          This run failed: {run.error}
        </p>
      ) : null}
      {run.status === 'queued' || run.status === 'running' ? (
        <p role="status" className="muted">
          This run has not finished ({run.status}). Reload the page to refresh it.
        </p>
      ) : null}
      {run.summary ? (
        <>
          <h3>Expected final state</h3>
          <Facts
            items={[
              { label: 'Customers', value: formatCount(run.summary.customers) },
              { label: 'Products', value: formatCount(run.summary.products) },
              { label: 'Orders', value: formatCount(run.summary.orders) },
              { label: 'Payments', value: formatCount(run.summary.payments) },
              { label: 'Shipments', value: formatCount(run.summary.shipments) },
              { label: 'Revenue', value: formatMoney(run.summary.revenueMinor) },
              ...Object.entries(run.summary.ordersByStatus).map(([status, count]) => ({ label: `Orders ${status}`, value: formatCount(count) })),
            ]}
          />
        </>
      ) : null}
      {run.eventsByType ? (
        <>
          <h3>Events by type</h3>
          <Facts items={Object.entries(run.eventsByType).map(([type, count]) => ({ label: type, value: formatCount(count) }))} />
        </>
      ) : null}
      {run.files ? (
        <>
          <h3>Files</h3>
          <table>
            <caption className="sr-only">Files of the run, with checksums</caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col" className="num">
                  Bytes
                </th>
                <th scope="col">SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(run.files).map(([name, entry]) => (
                <tr key={name}>
                  <td>
                    <a href={api.runFileUrl(run.id, name)} download={name}>
                      {name}
                    </a>
                  </td>
                  <td className="num">{formatCount(entry.bytes)}</td>
                  <td>
                    <code title={entry.sha256}>{entry.sha256.slice(0, 16)}&hellip;</code>
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <a href={api.runFileUrl(run.id, 'manifest.json')} download="manifest.json">
                    manifest.json
                  </a>
                </td>
                <td className="num muted">&mdash;</td>
                <td className="muted">holds the checksums above</td>
              </tr>
            </tbody>
          </table>
        </>
      ) : null}
    </Section>
  );
}

function RunExecutions({ runId }: { runId: string }) {
  const resource = useResource(`run-executions:${runId}`, (signal) => api.executions({ runId, limit: 10 }, signal));
  return (
    <Section title="Executions of this run">
      <ResourceView resource={resource} what="the executions of this run">
        {(list) =>
          list.executions.length === 0 ? (
            <p className="empty">Nothing has been tested on this run yet.</p>
          ) : (
            <>
              <table>
                <caption className="sr-only">The latest executions of this run</caption>
                <thead>
                  <tr>
                    <th scope="col">Execution</th>
                    <th scope="col">Chaos profile</th>
                    <th scope="col">Target</th>
                    <th scope="col">Status</th>
                    <th scope="col">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {list.executions.map((execution) => (
                    <tr key={execution.id}>
                      <td>
                        <Link to={`/executions/${execution.id}`} title={execution.id}>
                          <code>{shortId(execution.id)}</code>
                        </Link>
                      </td>
                      <td>
                        {execution.chaosProfile.name} <span className="muted">v{execution.chaosProfile.version}</span>, seed {execution.chaosSeed}
                      </td>
                      <td>{describeTarget(execution.target)}</td>
                      <td>
                        <StatusBadge status={execution.status} />
                      </td>
                      <td>
                        <VerdictBadge verdict={execution.verdict} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.total > list.executions.length ? (
                <p>
                  <Link to={`/executions?runId=${runId}`}>All {list.total} executions of this run</Link>
                </p>
              ) : null}
            </>
          )
        }
      </ResourceView>
    </Section>
  );
}

function AggregateFilter({ initial }: { initial: string | undefined }) {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(initial ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setParams(withParams(params, { aggregateId: text.trim() || undefined }, 'fromSequence'));
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="field">
        <span>Aggregate</span>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="ord_000018" />
      </label>
      <button type="submit">Filter</button>
    </form>
  );
}

function RunEvents({ run }: { run: Run }) {
  const [params, setParams] = useSearchParams();
  const type = paramOf(params, 'type');
  const aggregateId = paramOf(params, 'aggregateId');
  const fromSequence = wholeParamOf(params, 'fromSequence') ?? 1;
  const resource = useResource(`run-events:${run.id}?${params.toString()}`, (signal) =>
    api.runEvents(run.id, { type, aggregateId, fromSequence, limit: EVENT_PAGE }, signal),
  );
  const types = Object.keys(run.eventsByType ?? {});
  return (
    <Section title="Stored canonical events">
      <div className="filters">
        <label className="field">
          <span>Type</span>
          <select
            value={type ?? ''}
            onChange={(event) => {
              setParams(withParams(params, { type: event.target.value }, 'fromSequence'));
            }}
          >
            <option value="">All</option>
            {types.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <AggregateFilter key={aggregateId ?? ''} initial={aggregateId} />
      </div>
      <ResourceView resource={resource} what="the stored events">
        {(page) =>
          page.events.length === 0 ? (
            <p className="empty">No stored events match these filters.</p>
          ) : (
            <>
              <table>
                <caption className="sr-only">Canonical events of the run, in sequence order</caption>
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      Seq
                    </th>
                    <th scope="col">Event</th>
                    <th scope="col">Type</th>
                    <th scope="col">Aggregate</th>
                    <th scope="col">Event time</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {page.events.map((event) => (
                    <tr key={event.eventId}>
                      <td className="num">{event.sequence}</td>
                      <td>
                        <code>{event.eventId}</code>
                      </td>
                      <td>{event.type}</td>
                      <td>
                        <Link to={{ search: withParams(params, { aggregateId: event.aggregateId }, 'fromSequence').toString() }}>
                          <code>{event.aggregateId}</code>
                        </Link>{' '}
                        <span className="muted">v{event.aggregateVersion}</span>
                      </td>
                      <td>
                        <code>{formatSimTime(event.eventTimeMs)}</code>
                      </td>
                      <td className="muted">{summarizePayload(event.payload).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <nav className="pager" aria-label="Pages">
                <span>
                  From sequence {page.events[0]?.sequence} to {page.events[page.events.length - 1]?.sequence}
                </span>
                {fromSequence > 1 ? <Link to={{ search: withParams(params, { fromSequence: undefined }, 'fromSequence').toString() }}>First page</Link> : null}
                {page.nextSequence !== null ? (
                  <Link to={{ search: withParams(params, { fromSequence: String(page.nextSequence) }, 'fromSequence').toString() }}>Next page</Link>
                ) : (
                  <span className="pager__off">Next page</span>
                )}
              </nav>
            </>
          )
        }
      </ResourceView>
    </Section>
  );
}

export function RunPage() {
  const { runId = '' } = useParams();
  const resource = useResource(`run:${runId}`, (signal) => api.run(runId, signal));
  return (
    <>
      <p className="crumbs">
        <Link to="/runs">Runs</Link> / <code>{shortId(runId)}</code>
      </p>
      <h1>Run</h1>
      <ResourceView resource={resource} what="this run">
        {(run) => (
          <>
            <RunSummary run={run} />
            <RunExecutions runId={run.id} />
            {run.status === 'succeeded' ? <RunEvents run={run} /> : null}
          </>
        )}
      </ResourceView>
    </>
  );
}

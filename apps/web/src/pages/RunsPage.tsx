import { Link, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import { RUN_STATUSES } from '../api/schemas';
import { StatusBadge } from '../components/Badges';
import { FilterChip, FilterSelect, Pager } from '../components/Controls';
import { ResourceView } from '../components/ResourceView';
import { formatCount, formatSpan, formatTimestamp, shortId } from '../lib/format';
import { PAGE_SIZE, offsetOf, paramOf } from '../lib/query';
import { useResource } from '../hooks/use-resource';

export function RunsPage() {
  const [params] = useSearchParams();
  const status = paramOf(params, 'status');
  const scenarioId = paramOf(params, 'scenarioId');
  const offset = offsetOf(params);
  const resource = useResource(`runs?${params.toString()}`, (signal) => api.runs({ status, scenarioId, limit: PAGE_SIZE, offset }, signal));

  return (
    <>
      <div className="title-row">
        <h1>Runs</h1>
        <Link className="button primary" to="/runs/new">
          New run
        </Link>
      </div>
      <p className="lede">Simulated worlds: one scenario version generated with one seed. Newest first.</p>
      <div className="filters">
        <FilterSelect label="Status" name="status" options={RUN_STATUSES} />
        {scenarioId ? <FilterChip label="Scenario" name="scenarioId" value={shortId(scenarioId)} /> : null}
      </div>
      <ResourceView resource={resource} what="the run history">
        {(list) =>
          list.runs.length === 0 ? (
            <p className="empty">
              No runs{status || scenarioId ? ' match these filters' : ' yet'}. Generate one through the API: <code>POST /runs</code> with a scenario
              and a seed, or <Link to="/runs/new">start one here</Link>.
            </p>
          ) : (
            <>
              <table>
                <caption className="sr-only">Runs, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Scenario</th>
                    <th scope="col">Seed</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Events
                    </th>
                    <th scope="col">Requested</th>
                    <th scope="col">Took</th>
                  </tr>
                </thead>
                <tbody>
                  {list.runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link to={`/runs/${run.id}`} title={run.id}>
                          <code>{shortId(run.id)}</code>
                        </Link>
                      </td>
                      <td>
                        {run.scenario.name} <span className="muted">v{run.scenario.version}</span>
                      </td>
                      <td>
                        <code>{run.seed}</code>
                      </td>
                      <td>
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="num">{run.eventCount === null ? '—' : formatCount(run.eventCount)}</td>
                      <td>{formatTimestamp(run.requestedAt)}</td>
                      <td>{formatSpan(run.startedAt, run.finishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager total={list.total} limit={list.limit} offset={list.offset} />
            </>
          )
        }
      </ResourceView>
    </>
  );
}

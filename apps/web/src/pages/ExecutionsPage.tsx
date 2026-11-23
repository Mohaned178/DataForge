import { Link, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import { EXECUTION_STATUSES, VERDICTS } from '../api/schemas';
import { StatusBadge, VerdictBadge } from '../components/Badges';
import { FilterChip, FilterSelect, Pager } from '../components/Controls';
import { ResourceView } from '../components/ResourceView';
import { useResource } from '../hooks/use-resource';
import { formatCount, formatTimestamp, shortId } from '../lib/format';
import { PAGE_SIZE, offsetOf, paramOf } from '../lib/query';
import { describeTarget } from '../lib/target';

export function ExecutionsPage() {
  const [params] = useSearchParams();
  const status = paramOf(params, 'status');
  const verdict = paramOf(params, 'verdict');
  const runId = paramOf(params, 'runId');
  const chaosProfileId = paramOf(params, 'chaosProfileId');
  const offset = offsetOf(params);
  const resource = useResource(`executions?${params.toString()}`, (signal) =>
    api.executions({ status, verdict, runId, chaosProfileId, limit: PAGE_SIZE, offset }, signal),
  );
  const filtered = Boolean(status ?? verdict ?? runId ?? chaosProfileId);

  return (
    <>
      <h1>Executions</h1>
      <p className="lede">
        Test executions: one run, delivered under one chaos profile and seed to one target, then validated. Newest first.
      </p>
      <div className="filters">
        <FilterSelect label="Status" name="status" options={EXECUTION_STATUSES} />
        <FilterSelect label="Verdict" name="verdict" options={VERDICTS} />
        {runId ? <FilterChip label="Run" name="runId" value={shortId(runId)} /> : null}
        {chaosProfileId ? <FilterChip label="Chaos profile" name="chaosProfileId" value={shortId(chaosProfileId)} /> : null}
      </div>
      <ResourceView resource={resource} what="the execution history">
        {(list) =>
          list.executions.length === 0 ? (
            <p className="empty">
              No executions{filtered ? ' match these filters' : ' yet'}. Start one through the API: <code>POST /executions</code> with a run, a chaos
              profile, a chaos seed and a target.
            </p>
          ) : (
            <>
              <table>
                <caption className="sr-only">Test executions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Execution</th>
                    <th scope="col">Run</th>
                    <th scope="col">Chaos profile</th>
                    <th scope="col">Seed</th>
                    <th scope="col">Target</th>
                    <th scope="col">Status</th>
                    <th scope="col">Verdict</th>
                    <th scope="col" className="num">
                      Attempts
                    </th>
                    <th scope="col" className="num">
                      Findings
                    </th>
                    <th scope="col">Requested</th>
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
                        <Link to={`/runs/${execution.run.id}`} title={execution.run.id}>
                          {execution.run.scenario.name}
                        </Link>{' '}
                        <span className="muted">seed {execution.run.seed}</span>
                      </td>
                      <td>
                        {execution.chaosProfile.name} <span className="muted">v{execution.chaosProfile.version}</span>
                      </td>
                      <td>
                        <code>{execution.chaosSeed}</code>
                      </td>
                      <td>{describeTarget(execution.target)}</td>
                      <td>
                        <StatusBadge status={execution.status} />
                      </td>
                      <td>
                        <VerdictBadge verdict={execution.verdict} />
                      </td>
                      <td className="num">{execution.attemptCount === null ? '—' : formatCount(execution.attemptCount)}</td>
                      <td className="num">
                        {execution.findingCount === null
                          ? '—'
                          : execution.windowFindingCount
                            ? `${formatCount(execution.findingCount)} + ${formatCount(execution.windowFindingCount)} windows`
                            : formatCount(execution.findingCount)}
                      </td>
                      <td>{formatTimestamp(execution.requestedAt)}</td>
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

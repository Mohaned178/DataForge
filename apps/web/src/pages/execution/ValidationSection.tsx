import { Link, useSearchParams } from 'react-router';
import { api } from '../../api/endpoints';
import type { DeliveryCause } from '../../api/schemas';
import { VerdictBadge, Tag } from '../../components/Badges';
import { Facts, Section } from '../../components/Controls';
import { ResourceView } from '../../components/ResourceView';
import { useResource } from '../../hooks/use-resource';
import { formatCount, formatDuration } from '../../lib/format';
import { withParams } from '../../lib/query';

/** One delivery cause in a sentence: which event, what was done to its delivery. */
export function CauseSummary({ cause }: { cause: DeliveryCause }) {
  const facts: string[] = [];
  if (cause.lost) facts.push('lost');
  if (cause.faults.length > 0) facts.push(cause.faults.join(', '));
  if (cause.deliveries > 1) facts.push(`delivered ${cause.deliveries} times`);
  if (cause.failedAttempts > 0) facts.push(`${cause.failedAttempts} failed attempt${cause.failedAttempts === 1 ? '' : 's'}`);
  if (cause.delayMs !== null) facts.push(`delayed ${formatDuration(cause.delayMs)}`);
  if (cause.overtakenBy.length > 0) facts.push(`overtaken by ${cause.overtakenBy.join(', ')}`);
  return (
    <>
      <code>{cause.eventId}</code> <span className="muted">{cause.eventType}</span>
      {facts.length > 0 ? <>: {facts.join('; ')}</> : null}
    </>
  );
}

export function ValidationSection({ executionId }: { executionId: string }) {
  const [params] = useSearchParams();
  const resource = useResource(`report:${executionId}`, (signal) => api.report(executionId, signal));

  return (
    <Section title="Validation report">
      <ResourceView resource={resource} what="the validation report">
        {(report) => {
          const categories = Object.entries(report.counts.byCategory);
          return (
            <>
              <p>
                Verdict <VerdictBadge verdict={report.verdict} />{' '}
                <span className="muted">
                  {report.counts.findings === 0
                    ? 'The target ended in the expected state.'
                    : `${formatCount(report.counts.findings)} finding${report.counts.findings === 1 ? '' : 's'}: ${formatCount(report.counts.explained)} explained by a delivery fault, ${formatCount(report.counts.unexplained)} not explained by delivery.`}
                </span>
              </p>
              {report.target?.editedAfterDelivery ? (
                <p role="alert" className="panel panel--warn">
                  The actual state was edited after the delivery, so these findings may not come from the target.
                </p>
              ) : null}

              <h3>Entities checked</h3>
              <table>
                <caption className="sr-only">Entities compared between the expected and the actual state</caption>
                <thead>
                  <tr>
                    <th scope="col">Entity</th>
                    <th scope="col" className="num">
                      Expected
                    </th>
                    <th scope="col" className="num">
                      Actual
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(report.checked.entities).map(([type, counts]) => (
                    <tr key={type}>
                      <th scope="row">{type}</th>
                      <td className="num">{formatCount(counts.expected)}</td>
                      <td className="num">{formatCount(counts.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">{report.checked.invariants} state invariants checked on the actual state.</p>

              <h3>Findings by category</h3>
              <ul className="category-list">
                {categories.map(([category, count]) => (
                  <li key={category}>
                    {count > 0 ? (
                      <Link to={{ search: withParams(params, { category }).toString(), hash: '#findings' }}>{category}</Link>
                    ) : (
                      <span className="muted">{category}</span>
                    )}{' '}
                    <strong>{formatCount(count)}</strong>
                  </li>
                ))}
              </ul>

              {report.rootCauses.length > 0 ? (
                <>
                  <h3>Root causes</h3>
                  <p className="muted">Findings grouped by the first delivery cause named for each. Open its timeline to see what happened to the event.</p>
                  <table>
                    <caption className="sr-only">Root causes of the findings</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="num">
                          Findings
                        </th>
                        <th scope="col">Cause</th>
                        <th scope="col">Timeline</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.rootCauses.map((root, index) => (
                        <tr key={root.cause?.eventId ?? `none-${index}`}>
                          <td className="num">{formatCount(root.findings)}</td>
                          <td>
                            {root.cause ? <CauseSummary cause={root.cause} /> : <Tag tone="warn">not explained by delivery</Tag>}
                          </td>
                          <td>
                            {root.cause ? (
                              <Link to={`/executions/${executionId}/aggregates/${root.cause.aggregateId}?event=${root.cause.eventId}`}>
                                {root.cause.aggregateId}
                              </Link>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}

              {report.windows ? (
                <>
                  <h3>Windows</h3>
                  <Facts
                    items={[
                      { label: 'Window size', value: formatDuration(report.windows.windowing.sizeMs) },
                      { label: 'Allowed lateness', value: formatDuration(report.windows.windowing.allowedLatenessMs) },
                      { label: 'Windows expected', value: formatCount(report.windows.checked.expected) },
                      { label: 'Windows reported', value: formatCount(report.windows.checked.actual) },
                      { label: 'Window findings', value: formatCount(report.windows.counts.findings) },
                      { label: 'Explained', value: formatCount(report.windows.counts.explained) },
                      { label: 'Not explained', value: formatCount(report.windows.counts.unexplained) },
                    ]}
                  />
                </>
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Section>
  );
}

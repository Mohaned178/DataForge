import { Link } from 'react-router';
import type { Finding, WindowFinding } from '../../api/schemas';
import { Tag } from '../../components/Badges';
import { aggregateOfEntity } from '../../lib/entity';
import { formatDuration, formatSimTime, formatValue } from '../../lib/format';
import { CauseSummary } from './ValidationSection';

function Differences({ differences }: { differences: readonly { field: string; expected: unknown; actual: unknown }[] }) {
  if (differences.length === 0) return null;
  return (
    <table className="compact">
      <caption className="sr-only">Expected against actual</caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Expected</th>
          <th scope="col">Actual</th>
        </tr>
      </thead>
      <tbody>
        {differences.map((difference) => (
          <tr key={difference.field}>
            <th scope="row">{difference.field}</th>
            <td>{formatValue(difference.expected)}</td>
            <td>{formatValue(difference.actual)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The aggregates a finding points to: its entity's own first, then the aggregate of each cause. */
export function findingAggregates(finding: Finding): { aggregateId: string; eventId: string | undefined; why: string }[] {
  const links: { aggregateId: string; eventId: string | undefined; why: string }[] = [];
  const own = aggregateOfEntity(finding.entityType, finding.entityId);
  if (own !== null) links.push({ aggregateId: own, eventId: undefined, why: `${finding.entityType} ${finding.entityId}` });
  for (const cause of finding.causes) {
    if (!links.some((link) => link.aggregateId === cause.aggregateId)) {
      links.push({ aggregateId: cause.aggregateId, eventId: cause.eventId, why: `cause ${cause.eventId}` });
    }
  }
  return links;
}

export function FindingDetail({ finding, executionId }: { finding: Finding; executionId: string }) {
  const links = findingAggregates(finding);
  return (
    <div className="finding-detail">
      <p>
        <strong>{finding.message}</strong> <span className="muted">(check: {finding.check})</span>
      </p>
      <Differences differences={finding.differences} />
      <h4>Causes</h4>
      {finding.causes.length === 0 ? (
        <p>
          <Tag tone="warn">not explained by delivery</Tag> <span className="muted">No abnormal delivery touched the events behind this entity.</span>
        </p>
      ) : (
        <ul>
          {finding.causes.map((cause) => (
            <li key={cause.eventId}>
              <CauseSummary cause={cause} />
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 ? (
        <>
          <h4>Timelines</h4>
          <ul>
            {links.map((link) => (
              <li key={link.aggregateId}>
                <Link
                  to={`/executions/${executionId}/aggregates/${link.aggregateId}?finding=${finding.ordinal}${link.eventId ? `&event=${link.eventId}` : ''}`}
                >
                  {link.aggregateId}
                </Link>{' '}
                <span className="muted">({link.why})</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function WindowFindingDetail({ finding, executionId }: { finding: WindowFinding; executionId: string }) {
  return (
    <div className="finding-detail">
      <p>
        <strong>{finding.message}</strong>
      </p>
      <Differences differences={finding.differences} />
      <h4>Causes</h4>
      {finding.causes.length === 0 ? (
        <p>
          <Tag tone="warn">not explained by delivery</Tag> <span className="muted">No abnormal delivery touched the events of this window.</span>
        </p>
      ) : (
        <ul>
          {finding.causes.map((cause) => (
            <li key={cause.eventId}>
              <code>{cause.eventId}</code> <span className="muted">{cause.eventType}</span>, event time <code>{formatSimTime(cause.eventTimeMs)}</code>, arrived{' '}
              <Tag tone={cause.arrival === 'on-time' ? 'neutral' : 'warn'}>{cause.arrival}</Tag>
              {cause.faults.length > 0 ? <>, faults: {cause.faults.join(', ')}</> : null}
              {cause.deliveries !== 1 ? <>, delivered {cause.deliveries} times</> : null}
              {cause.streamTimeMs !== null && cause.arrival !== 'on-time' ? (
                <>
                  , stream time {formatDuration(cause.streamTimeMs)} against a close at {formatDuration(cause.windowCloseMs)}
                </>
              ) : null}{' '}
              <Link to={`/executions/${executionId}/events/${cause.eventId}?windowFinding=${finding.ordinal}`}>timeline</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

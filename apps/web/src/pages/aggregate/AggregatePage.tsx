import { useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { api, loadAggregateAttempts, loadAggregateEvents } from '../../api/endpoints';
import { VerdictBadge } from '../../components/Badges';
import { Facts, Section } from '../../components/Controls';
import { ErrorPanel } from '../../components/ErrorPanel';
import { ResourceView } from '../../components/ResourceView';
import { useResource } from '../../hooks/use-resource';
import { aggregateKind } from '../../lib/entity';
import { shortId } from '../../lib/format';
import { paramOf, wholeParamOf, withParams } from '../../lib/query';
import { buildTimeline } from '../../lib/timeline';
import { describeTarget } from '../../lib/target';
import { FindingDetail, WindowFindingDetail } from '../execution/FindingDetail';
import { LanesDiagram } from './LanesDiagram';
import { CanonicalTimeline, DeliveryTimeline } from './Timelines';

function FindingContext({ executionId, ordinal }: { executionId: string; ordinal: number }) {
  const resource = useResource(`finding:${executionId}:${ordinal}`, (signal) => api.findings(executionId, { offset: ordinal, limit: 1 }, signal));
  return (
    <Section title={`Opened from finding ${ordinal + 1}`}>
      <ResourceView resource={resource} what="the finding">
        {(list) => {
          const finding = list.findings[0];
          return finding ? (
            <>
              <p>
                <span className="muted">{finding.entityType}</span> <code>{finding.entityId}</code> &middot; {finding.category}
              </p>
              <FindingDetail finding={finding} executionId={executionId} />
            </>
          ) : (
            <p className="empty">This execution has no finding {ordinal + 1}.</p>
          );
        }}
      </ResourceView>
    </Section>
  );
}

function WindowFindingContext({ executionId, ordinal }: { executionId: string; ordinal: number }) {
  const resource = useResource(`window-finding:${executionId}:${ordinal}`, (signal) =>
    api.windowFindings(executionId, { offset: ordinal, limit: 1 }, signal),
  );
  return (
    <Section title={`Opened from window finding ${ordinal + 1}`}>
      <ResourceView resource={resource} what="the window finding">
        {(list) => {
          const finding = list.findings[0];
          return finding ? (
            <>
              <p>{finding.category}</p>
              <WindowFindingDetail finding={finding} executionId={executionId} />
            </>
          ) : (
            <p className="empty">This execution has no window finding {ordinal + 1}.</p>
          );
        }}
      </ResourceView>
    </Section>
  );
}

export function AggregatePage() {
  const { executionId = '', aggregateId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const focused = paramOf(params, 'event');
  const finding = wholeParamOf(params, 'finding');
  const windowFinding = wholeParamOf(params, 'windowFinding');
  const [hovered, setHovered] = useState<string | undefined>(undefined);

  const resource = useResource(`aggregate:${executionId}:${aggregateId}`, async (signal) => {
    const execution = await api.execution(executionId, signal);
    const [events, attempts] = await Promise.all([
      loadAggregateEvents(execution.run.id, aggregateId, signal),
      loadAggregateAttempts(executionId, aggregateId, signal),
    ]);
    return { execution, events, attempts };
  });
  const loaded = resource.data;
  const timeline = useMemo(() => (loaded ? buildTimeline(loaded.events, loaded.attempts) : undefined), [loaded]);

  const select = (eventId: string) => {
    setParams(withParams(params, { event: focused === eventId ? undefined : eventId }, null), { replace: true });
  };
  const active = hovered ?? focused;

  return (
    <>
      <p className="crumbs">
        <Link to="/executions">Executions</Link> / <Link to={`/executions/${executionId}`}>{shortId(executionId)}</Link> / <code>{aggregateId}</code>
      </p>
      <h1>
        {aggregateKind(aggregateId)} <code>{aggregateId}</code>
      </h1>
      <ResourceView resource={resource} what="the timelines of this aggregate">
        {({ execution }) =>
          timeline === undefined ? null : (
            <>
              <p>
                Execution <Link to={`/executions/${execution.id}`}>{shortId(execution.id)}</Link> &middot; {describeTarget(execution.target)} &middot;{' '}
                {execution.chaosProfile.name}, chaos seed {execution.chaosSeed} &middot; <VerdictBadge verdict={execution.verdict} />
              </p>
              {finding !== undefined ? <FindingContext executionId={executionId} ordinal={finding} /> : null}
              {windowFinding !== undefined ? <WindowFindingContext executionId={executionId} ordinal={windowFinding} /> : null}

              {timeline.events.length === 0 && timeline.deliveries.length === 0 ? (
                <p className="empty">
                  This run has no stored events for <code>{aggregateId}</code>. Check the identifier.
                </p>
              ) : (
                <>
                  <Section title="Summary">
                    <Facts
                      items={[
                        { label: 'Events', value: timeline.events.length },
                        { label: 'Delivery attempts', value: timeline.deliveries.length },
                        { label: 'Out of order', value: timeline.outOfOrderEvents },
                        { label: 'Lost', value: timeline.events.filter((entry) => entry.flags.lost).length },
                        { label: 'Duplicated', value: timeline.events.filter((entry) => entry.flags.duplicated).length },
                        { label: 'Retried', value: timeline.events.filter((entry) => entry.flags.retried).length },
                      ]}
                    />
                  </Section>
                  <Section title="Event lanes">
                    <p className="muted">
                      A line joins each event to each of its deliveries. Crossing lines are events that reached the target out of order; an event
                      with no line was lost. Select an event to follow it through both timelines.
                    </p>
                    <LanesDiagram timeline={timeline} activeEventId={active} onSelect={select} onHover={setHovered} />
                  </Section>
                  <div className="two-columns">
                    <CanonicalTimeline timeline={timeline} activeEventId={active} onSelect={select} onHover={setHovered} />
                    <DeliveryTimeline timeline={timeline} activeEventId={active} onSelect={select} onHover={setHovered} />
                  </div>
                </>
              )}
            </>
          )
        }
      </ResourceView>
    </>
  );
}

/** A link to an event, whose aggregate the URL does not name (window causes carry an event ID only). */
export function EventRedirect() {
  const { executionId = '', eventId = '' } = useParams();
  const [params] = useSearchParams();
  const resource = useResource(`event:${executionId}:${eventId}`, (signal) => api.attempts(executionId, { eventId, limit: 1 }, signal));

  if (resource.status === 'error') return <ErrorPanel error={resource.error} what={`the event ${eventId}`} onRetry={resource.reload} />;
  const attempt = resource.status === 'ready' ? resource.data?.attempts[0] : undefined;
  if (resource.status === 'ready' && attempt === undefined) {
    return (
      <p className="panel" role="alert">
        This execution has no delivery attempt for <code>{eventId}</code>.
      </p>
    );
  }
  if (attempt) {
    const search = new URLSearchParams(params);
    search.set('event', eventId);
    return <Navigate replace to={{ pathname: `/executions/${executionId}/aggregates/${attempt.aggregateId}`, search: search.toString() }} />;
  }
  return (
    <p role="status" className="muted">
      Finding the timeline of {eventId}&hellip;
    </p>
  );
}

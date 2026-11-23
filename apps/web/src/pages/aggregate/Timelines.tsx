import { Tag } from '../../components/Badges';
import { formatDuration, formatSimTime } from '../../lib/format';
import { describeAttempt } from '../../lib/faults';
import { summarizePayload } from '../../lib/payload';
import { activeFlags, type EventFlags, type Timeline } from '../../lib/timeline';

interface Shared {
  readonly timeline: Timeline;
  readonly activeEventId: string | undefined;
  readonly onSelect: (eventId: string) => void;
  readonly onHover: (eventId: string | undefined) => void;
}

const FLAG_TONE: Readonly<Record<keyof EventFlags, 'bad' | 'warn' | 'info' | 'neutral'>> = {
  outOfOrder: 'bad',
  lost: 'bad',
  duplicated: 'warn',
  retried: 'warn',
  delayed: 'info',
  late: 'warn',
  reordered: 'info',
};

export function CanonicalTimeline({ timeline, activeEventId, onSelect, onHover }: Shared) {
  return (
    <section aria-labelledby="canonical-heading" className="timeline">
      <h2 id="canonical-heading">Canonical timeline</h2>
      <p className="muted">What happened in the simulated world, in version order. Never changed by the chaos profile.</p>
      <table>
        <caption className="sr-only">Canonical events of the aggregate in version order</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Event</th>
            <th scope="col">Event time</th>
            <th scope="col">What happened to it</th>
          </tr>
        </thead>
        <tbody>
          {timeline.events.map((entry) => {
            const flags = activeFlags(entry.flags);
            return (
              <tr
                key={entry.event.eventId}
                className={activeEventId === entry.event.eventId ? 'is-active' : undefined}
                data-event-id={entry.event.eventId}
                onMouseEnter={() => {
                  onHover(entry.event.eventId);
                }}
                onMouseLeave={() => {
                  onHover(undefined);
                }}
              >
                <td>v{entry.event.aggregateVersion}</td>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    aria-pressed={activeEventId === entry.event.eventId}
                    onClick={() => {
                      onSelect(entry.event.eventId);
                    }}
                  >
                    {entry.event.type}
                  </button>
                  <br />
                  <code className="small">{entry.event.eventId}</code>
                  <br />
                  <span className="muted small">{summarizePayload(entry.event.payload).join(', ')}</span>
                  <details>
                    <summary>Payload</summary>
                    <pre>{JSON.stringify(entry.event.payload, null, 2)}</pre>
                  </details>
                </td>
                <td>
                  <code>{formatSimTime(entry.event.eventTimeMs)}</code>
                </td>
                <td>
                  {flags.length === 0 ? (
                    <span className="muted">delivered once, in order</span>
                  ) : (
                    flags.map((flag) => (
                      <Tag key={flag.key} tone={FLAG_TONE[flag.key]}>
                        {flag.label}
                      </Tag>
                    ))
                  )}
                  {entry.overtakenBy.length > 0 ? (
                    <div className="small muted">overtaken by {entry.overtakenBy.join(', ')}</div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function DeliveryTimeline({ timeline, activeEventId, onSelect, onHover }: Shared) {
  const versionOf = new Map(timeline.events.map((entry) => [entry.event.eventId, entry.event.aggregateVersion]));
  const hasKafka = timeline.deliveries.some((attempt) => attempt.kafka !== null);
  return (
    <section aria-labelledby="delivery-heading" className="timeline">
      <h2 id="delivery-heading">Delivery timeline</h2>
      <p className="muted">What reached the target, in the order it was delivered. Failed attempts never reach it.</p>
      <table>
        <caption className="sr-only">Delivery attempts of the aggregate in delivery order</caption>
        <thead>
          <tr>
            <th scope="col" className="num">
              #
            </th>
            <th scope="col">Event</th>
            <th scope="col">Attempt</th>
            <th scope="col">Delivery time</th>
            <th scope="col">Faults</th>
            <th scope="col">Outcome</th>
            {hasKafka ? <th scope="col">Kafka</th> : null}
          </tr>
        </thead>
        <tbody>
          {timeline.deliveries.map((attempt) => {
            const notes = describeAttempt(attempt);
            const shift = attempt.scheduledDeliveryTimeMs - attempt.eventTimeMs;
            return (
              <tr
                key={attempt.attemptId}
                className={activeEventId === attempt.eventId ? 'is-active' : undefined}
                data-event-id={attempt.eventId}
                onMouseEnter={() => {
                  onHover(attempt.eventId);
                }}
                onMouseLeave={() => {
                  onHover(undefined);
                }}
              >
                <td className="num">{attempt.deliverySequence}</td>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    aria-pressed={activeEventId === attempt.eventId}
                    onClick={() => {
                      onSelect(attempt.eventId);
                    }}
                  >
                    v{versionOf.get(attempt.eventId) ?? attempt.aggregateVersion} {attempt.eventType}
                  </button>
                </td>
                <td>
                  <code className="small" title={attempt.attemptId}>
                    #{attempt.attemptNumber}
                  </code>{' '}
                  {attempt.kind}
                </td>
                <td>
                  <code>{formatSimTime(attempt.scheduledDeliveryTimeMs)}</code>
                  <div className="small muted">{shift === 0 ? 'at event time' : `+${formatDuration(shift)} after the event`}</div>
                </td>
                <td>
                  {notes.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    <ul className="plain">
                      {notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  {attempt.plannedOutcome === 'delivered' ? 'delivered' : <Tag tone="bad">failed, never sent</Tag>}
                </td>
                {hasKafka ? (
                  <td>
                    {attempt.kafka === null || attempt.kafka.partition === null ? (
                      <span className="muted">not sent</span>
                    ) : (
                      <>
                        partition {attempt.kafka.partition}, offset {attempt.kafka.offset}
                        {attempt.kafka.driftMs !== null ? <div className="small muted">drift {attempt.kafka.driftMs} ms</div> : null}
                      </>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

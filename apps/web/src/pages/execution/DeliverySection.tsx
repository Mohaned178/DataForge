import { Facts, Section } from '../../components/Controls';
import type { Execution } from '../../api/schemas';
import { FAULT_TYPES } from '../../api/schemas';
import { formatCount, formatDuration, formatPercent } from '../../lib/format';

const FAULT_ORDER: readonly string[] = FAULT_TYPES;

/** What the faulty delivery did: the plan's summary, and what the target and Kafka made of it. */
export function DeliverySection({ execution }: { execution: Execution }) {
  const { delivery, targetResult, kafka } = execution;
  if (delivery === null) return null;
  const faults = Object.entries(delivery.faults).sort(([a], [b]) => FAULT_ORDER.indexOf(a) - FAULT_ORDER.indexOf(b));

  return (
    <Section title="Delivery">
      <p className="muted">
        What the chaos profile did to the stream before it reached the target. The canonical events never change; only their deliveries do.
      </p>
      <Facts
        items={[
          { label: 'Events', value: formatCount(delivery.events) },
          { label: 'Delivery attempts', value: formatCount(delivery.attempts) },
          { label: 'Original', value: formatCount(delivery.attemptsByKind.original) },
          { label: 'Duplicate', value: formatCount(delivery.attemptsByKind.duplicate) },
          { label: 'Retry', value: formatCount(delivery.attemptsByKind.retry) },
          { label: 'Planned failures', value: formatCount(delivery.attemptsByOutcome.failed) },
          { label: 'Events lost', value: formatCount(delivery.eventsLost) },
          { label: 'Events out of order', value: formatCount(delivery.ordering.outOfOrderEvents) },
          { label: 'Aggregates affected', value: formatCount(delivery.ordering.aggregatesAffected) },
          { label: 'Inversion pairs', value: formatCount(delivery.ordering.inversionPairs) },
          { label: 'Last delivery at', value: formatDuration(delivery.lastScheduledDeliveryTimeMs) },
        ]}
      />

      <h3>Faults</h3>
      <table>
        <caption className="sr-only">Each fault type: configured rate against what was observed</caption>
        <thead>
          <tr>
            <th scope="col">Fault</th>
            <th scope="col" className="num">
              Configured rate
            </th>
            <th scope="col" className="num">
              Observed rate
            </th>
            <th scope="col" className="num">
              Faulted events
            </th>
            <th scope="col" className="num">
              Eligible events
            </th>
            <th scope="col">Other</th>
          </tr>
        </thead>
        <tbody>
          {faults.map(([type, stats]) => (
            <tr key={type}>
              <th scope="row">{type}</th>
              <td className="num">{formatPercent(stats.rate)}</td>
              <td className="num">{stats.eligibleEvents === 0 ? '—' : formatPercent(stats.faultedEvents / stats.eligibleEvents)}</td>
              <td className="num">{formatCount(stats.faultedEvents)}</td>
              <td className="num">{formatCount(stats.eligibleEvents)}</td>
              <td className="muted">
                {[
                  stats.extraDeliveries !== undefined ? `${stats.extraDeliveries} extra deliveries` : null,
                  stats.failedAttempts !== undefined ? `${stats.failedAttempts} failed attempts` : null,
                  stats.lostEvents !== undefined ? `${stats.lostEvents} events lost` : null,
                ]
                  .filter((part) => part !== null)
                  .join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {delivery.windowing ? (
        <>
          <h3>Windows</h3>
          <p className="muted">
            Tumbling event-time windows of {formatDuration(delivery.windowing.sizeMs)} with {formatDuration(delivery.windowing.allowedLatenessMs)} of allowed
            lateness. Each counted event arrived:
          </p>
          <Facts
            items={[
              { label: 'On time', value: formatCount(delivery.windowing.arrivals.onTime) },
              { label: 'Within the allowed lateness', value: formatCount(delivery.windowing.arrivals.withinLateness) },
              { label: 'After its window closed', value: formatCount(delivery.windowing.arrivals.afterClose) },
              { label: 'Lost', value: formatCount(delivery.windowing.arrivals.lost) },
            ]}
          />
        </>
      ) : null}

      {targetResult ? (
        <>
          <h3>What the reference target received</h3>
          <Facts
            items={[
              { label: 'Messages', value: formatCount(targetResult.delivery.messages) },
              { label: 'Distinct events', value: formatCount(targetResult.delivery.distinctEvents) },
              { label: 'Redeliveries', value: formatCount(targetResult.delivery.redeliveries) },
              { label: 'Failed attempts (never sent)', value: formatCount(targetResult.delivery.failedAttempts) },
              { label: 'Events parked', value: formatCount(targetResult.parkedEvents) },
              ...Object.entries(targetResult.counters).map(([name, value]) => ({ label: name, value: formatCount(value) })),
            ]}
          />
        </>
      ) : null}

      {kafka ? (
        <>
          <h3>Kafka</h3>
          <Facts
            items={[
              { label: 'Topic', value: <code>{kafka.topic}</code> },
              { label: 'Consumer group', value: <code>{kafka.groupId}</code> },
              { label: 'Partitions', value: kafka.partitions },
              { label: 'Records sent', value: formatCount(kafka.sent) },
              { label: 'Planned failures (not sent)', value: formatCount(kafka.plannedFailures) },
              { label: 'Delivery took', value: formatDuration(kafka.durationMs) },
              { label: 'Zero lag after', value: formatDuration(kafka.lagZeroAfterMs) },
            ]}
          />
        </>
      ) : null}
    </Section>
  );
}

import type { KeyboardEvent } from 'react';
import type { Timeline } from '../../lib/timeline';

const SHORT_TYPE: Readonly<Record<string, string>> = {
  ProductCreated: 'created',
  CustomerRegistered: 'registered',
  OrderCreated: 'created',
  PaymentCompleted: 'paid',
  PaymentFailed: 'pay failed',
  OrderCancelled: 'cancelled',
  ShipmentCreated: 'shipped',
  ShipmentDelivered: 'delivered',
};

const PAD = 70;
const MIN_WIDTH = 560;
const SPACING = 120;
const EVENT_Y = 70;
const DELIVERY_Y = 190;
const HEIGHT = 270;

function positionOf(index: number, count: number, width: number): number {
  return count <= 1 ? width / 2 : PAD + (index * (width - 2 * PAD)) / (count - 1);
}

interface Props {
  readonly timeline: Timeline;
  readonly activeEventId: string | undefined;
  readonly onSelect: (eventId: string) => void;
  readonly onHover: (eventId: string | undefined) => void;
}

/**
 * Events on the top lane in the order they happened, deliveries on the bottom lane in the order they
 * reached the target, a line from each event to each of its deliveries. A failed attempt never reached
 * the target, so it is not on the bottom lane: an event whose attempts all failed (a lost event) has no
 * line, and its failed attempts are in the delivery table. Positions are by order, not by time, so an
 * inversion shows as crossing lines however many hours a delay moved it; the tables carry the exact times.
 */
export function LanesDiagram({ timeline, activeEventId, onSelect, onHover }: Props) {
  const arrivals = timeline.deliveries.filter((attempt) => attempt.plannedOutcome === 'delivered');
  const eventCount = timeline.events.length;
  const deliveryCount = arrivals.length;
  const width = Math.max(MIN_WIDTH, SPACING * Math.max(eventCount, deliveryCount) + 2 * PAD);
  const eventIndex = new Map(timeline.events.map((entry, index) => [entry.event.eventId, index]));
  const versionOf = new Map(timeline.events.map((entry) => [entry.event.eventId, entry.event.aggregateVersion]));

  const keyboard = (eventId: string) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(eventId);
    }
  };

  return (
    <svg
      className="lanes"
      viewBox={`0 0 ${width} ${HEIGHT}`}
      style={{ maxWidth: `${width}px` }}
      role="group"
      aria-label="Event lanes: events in the order they happened on top, deliveries in the order they reached the target below, a line from each event to its deliveries"
    >
      <text className="lane-title" x={8} y={22}>
        Events, in the order they happened
      </text>
      <text className="lane-title" x={8} y={HEIGHT - 10}>
        Deliveries, in the order they reached the target
      </text>

      {arrivals.map((attempt, deliveryIdx) => {
        const from = eventIndex.get(attempt.eventId);
        if (from === undefined) return null;
        const classes = ['lane-line', `lane-line--${attempt.kind}`];
        if (activeEventId === attempt.eventId) classes.push('is-active');
        else if (activeEventId !== undefined) classes.push('is-dim');
        return (
          <line
            key={attempt.attemptId}
            className={classes.join(' ')}
            x1={positionOf(from, eventCount, width)}
            y1={EVENT_Y + 9}
            x2={positionOf(deliveryIdx, deliveryCount, width)}
            y2={DELIVERY_Y - 9}
          />
        );
      })}

      {timeline.events.map((entry, index) => {
        const x = positionOf(index, eventCount, width);
        const flagged = entry.flags.outOfOrder || entry.flags.lost;
        const state = [entry.flags.outOfOrder ? 'out of order' : null, entry.flags.lost ? 'lost' : null].filter(Boolean).join(', ');
        const label = `Version ${entry.event.aggregateVersion}, ${entry.event.type}${state ? `, ${state}` : ''}`;
        return (
          <g
            key={entry.event.eventId}
            className={`lane-dot${flagged ? ' lane-dot--flagged' : ''}${activeEventId === entry.event.eventId ? ' is-active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={activeEventId === entry.event.eventId}
            onClick={() => {
              onSelect(entry.event.eventId);
            }}
            onKeyDown={keyboard(entry.event.eventId)}
            onMouseEnter={() => {
              onHover(entry.event.eventId);
            }}
            onMouseLeave={() => {
              onHover(undefined);
            }}
            onFocus={() => {
              onHover(entry.event.eventId);
            }}
            onBlur={() => {
              onHover(undefined);
            }}
          >
            <title>{label}</title>
            <circle cx={x} cy={EVENT_Y} r={9} />
            <text className="dot-label" x={x} y={EVENT_Y - 30} textAnchor="middle">
              v{entry.event.aggregateVersion}
            </text>
            <text className="dot-sub" x={x} y={EVENT_Y - 16} textAnchor="middle">
              {SHORT_TYPE[entry.event.type] ?? entry.event.type}
            </text>
          </g>
        );
      })}

      {arrivals.map((attempt, index) => {
        const x = positionOf(index, deliveryCount, width);
        const version = versionOf.get(attempt.eventId);
        const label = `Delivery ${attempt.deliverySequence}: version ${version ?? '?'}, ${attempt.kind}, ${attempt.plannedOutcome}`;
        return (
          <g
            key={attempt.attemptId}
            className={`lane-dot lane-dot--delivery${activeEventId === attempt.eventId ? ' is-active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={activeEventId === attempt.eventId}
            onClick={() => {
              onSelect(attempt.eventId);
            }}
            onKeyDown={keyboard(attempt.eventId)}
            onMouseEnter={() => {
              onHover(attempt.eventId);
            }}
            onMouseLeave={() => {
              onHover(undefined);
            }}
            onFocus={() => {
              onHover(attempt.eventId);
            }}
            onBlur={() => {
              onHover(undefined);
            }}
          >
            <title>{label}</title>
            <circle cx={x} cy={DELIVERY_Y} r={9} />
            <text className="dot-label" x={x} y={DELIVERY_Y + 28} textAnchor="middle">
              #{attempt.deliverySequence}
            </text>
            <text className="dot-sub" x={x} y={DELIVERY_Y + 42} textAnchor="middle">
              v{version ?? '?'} {attempt.kind === 'original' ? '' : attempt.kind}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

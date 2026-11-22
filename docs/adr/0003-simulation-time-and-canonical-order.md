# ADR-0003: Integer simulation time and a total canonical order

Status: Accepted (Milestone 1)

## Context

Business timestamps must not come from the machine clock, and the spec distinguishes event time,
delivery time and processing time. Ordering must not depend on object iteration, database or worker
order.

## Decision

- **Event time** is `eventTimeMs`: integer milliseconds since the scenario's `simulation.epoch`, a
  UTC instant ("Z" required, other offsets rejected). Absolute timestamps are derived only for
  display and, later, for messages sent to targets.
- The simulation window is `[0, durationMs)`. Events at or after the horizon are not generated, so
  orders can end mid-lifecycle, as in a real snapshot.
- All configured delays are at least 1 ms, so causally related events always have strictly
  increasing event times.
- The canonical log is totally ordered by **(eventTimeMs, aggregateId, aggregateVersion)**, with
  string comparison by UTF-16 code unit (never `localeCompare`). Because causal dependencies have
  distinct times, the tie-breakers only order independent events.
- `sequence` (1..N) is assigned after sorting. Replay rejects any log that is not in this order.
- Delivery time (Milestone 2) and processing time (Milestone 4) are separate fields on delivery
  attempts and outcomes; they never overwrite `eventTimeMs`.

## Consequences

Event time is unambiguous across time zones and machines. Each event's `sequence` depends on the
whole log (adding an order shifts later sequence numbers), so cross-run comparisons of one entity
use `eventId` and `aggregateVersion`, not `sequence`.

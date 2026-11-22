# ADR-0007: Chaos delivery planning: an independent chaos seed, per-event fault streams, anchored reorder

Status: Accepted (Milestone 2). Decisions 5 (unbounded reorder) and 6 (loss opt-in) were confirmed by
the product owner on 2026-11-22.

## Context

Delivery chaos must be reproducible, explainable per attempt, and must never touch the canonical
log (spec 4.2, 4.3). The roadmap left four questions open: how the chaos seed relates to the
simulation seed, how faults are selected, what "reorder" means as opposed to reordering caused by a
delay, and whether events may be lost by default.

## Decisions

1. **A separate, pure package.** `@dataforge/chaos` turns `(canonical log, chaos profile, chaos
   seed)` into a list of delivery attempts. Like the core, it does no I/O and is under the same
   ESLint determinism guard. It only reads canonical events. Kafka delivery (Milestone 4) will
   execute a plan; it will not make chaos decisions.

2. **The chaos seed is independent of the simulation seed.** One world can be delivered under many
   fault patterns, and one fault pattern can be replayed on another world. The plan records both
   seeds and the SHA-256 of the canonical log it was made for.

3. **One random stream per (chaos seed, fault type, eventId)**, purpose `chaos.<fault type>`. The
   selection (`float() < rate`) is always the stream's first draw, and the fault's parameters are
   drawn after it. Consequences, all tested:
   - enabling or tuning one fault type never changes which events another fault type selects, or
     the parameters it draws;
   - raising a rate only adds faulted events (the draw does not depend on the rate);
   - the chaos decisions for an event do not depend on any other event.

   The *schedule* still composes: a delay moves the anchor of a reorder, and retries move the base
   of a duplicate. Only the *decisions* are isolated.

4. **Composition order for one event**, giving each attempt a time that its fault records explain
   exactly (the tests recompute every attempt's time from its records):
   1. `delay`: the original attempt is held back by `delayMs`.
   2. `reorder`: the original attempt is moved to 1 ms after the first delivery of the k-th later
      event of the same aggregate (`shiftMs` records the extra wait, 0 if a delay already put it
      there). Aggregates are planned from their latest version down, so that anchor is final.
   3. `transientFailure`: the first `failures` attempts fail; each is retried `backoff` ms after the
      previous one. Failed attempts never reach the target.
   4. `duplicate`: `copies` extra attempts of the first delivered attempt, each `offset` ms after
      it, with the same `eventId` and their own `attemptId`.

5. **Reorder is anchored, not a swap.** A delay may or may not overtake a later event, depending on
   the gap. A reorder always does: it guarantees a per-aggregate inversion, which is what an
   out-of-order test needs. It only applies to events with a later event in their aggregate (today:
   order lifecycle events), and its observed rate is reported against those eligible events. The
   summary counts inversions as the target sees them, whatever caused them.

   A side effect is that a reorder can hold an event back for a long time: it waits for the next
   event of its aggregate, which may be hours later in simulation time.

6. **Loss is opt-in.** An event is lost when it fails more often than it is retried
   (`failures > maxRetries`). A profile can only allow that with `allowLoss: true`; otherwise it is
   rejected with the path `faults.transientFailure.failures.max`. A lost event gets no duplicates.

7. **Delivery order is total**: `(scheduledDeliveryTimeMs, eventSequence, attemptNumber)`. A
   profile without faults therefore delivers exactly the canonical order, at event time, whatever
   the chaos seed.

8. **Attempt identity**: `att_<aggregateId>_<aggregateVersion>_<attemptNumber>`. Attempt numbers
   follow delivery time within an event (original, retries, then duplicates ordered by offset).

9. **The plan has its own directory**, bound to its run by the canonical log's SHA-256, with
   checksums of its own files. `explain` refuses a plan that was edited or that belongs to another
   run, and planning refuses a run whose `events.jsonl` no longer matches its manifest.

## Alternatives considered

- **One stream for the whole plan**: simpler, but adding an event or enabling a fault reshuffles
  every later decision, so two plans could not be compared fault by fault.
- **Chaos seed derived from the simulation seed**: one less input, but then a world could only be
  tested under one fault pattern per seed.
- **Loss on by default**: realistic, but a test that silently loses events is hard to tell apart
  from a target bug. Opting in makes "missing entity" findings deliberate.

## Consequences

`PLANNER_VERSION` names the planning algorithm. Stream purposes, draw order and composition order
are part of its output contract: a change requires a version bump, which the golden plan test
enforces. Cross-aggregate races (an order delivered before its customer) arise only from delays
today. A dedicated fault for them can be added later without changing existing streams.

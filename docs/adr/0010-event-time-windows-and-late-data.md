# ADR-0010: Event-time windows and late data: a windowing contract in the profile, stream-time close, an anchored late fault

Status: Accepted (Milestone 5). Decision 4 (expected windows are the truth) was confirmed by the product
owner on 2026-11-22 (D-5.1).

## Context

Late data only exists relative to a window: an event is late when it arrives after the window it
belongs to has been finalized (spec section 2, "an event may arrive after a processing window has
already closed"; spec 6, late-event injection). Milestone 5 adds a second kind of output to the
pipeline under test: per-window business metrics, next to the entity state. DataForge must know the
true values, inject events that arrive after their window closed, and explain every wrong window.
The roadmap left open where the window definition lives, what "closed" means, how a late fault is
planned, and what the expected value of a window is when some of its events arrive too late.

## Decisions

1. **Tumbling event-time windows, three metrics, one definition.** A windowing contract is
   `{ sizeMs, allowedLatenessMs }`: windows `[start, start + sizeMs)` aligned to the scenario epoch
   (simulation time 0). Per window: `ordersCreated` (OrderCreated events), `paymentsCompleted`
   (PaymentCompleted events) and `revenueMinor` (their amounts, integer minor units). The metrics are
   defined once, in core (`windowContribution`), and used by the expected windows and by both
   reference targets, so there is no second copy of the rule.

2. **The contract lives in the chaos profile, as an optional `windowing` section.** It describes the
   pipeline under test, not the business world, so it does not belong in the scenario; the late
   fault is measured against it; and `deliver` and `validate` read it from the plan they are already
   bound to by hash, so there is one source for three commands. A separate windowing file was
   rejected: three commands would each need it and could disagree. Without `windowing`, nothing about
   windows is planned, delivered or validated.

3. **A window closes in stream time.** Stream time is the largest event time the target has
   received. A window closes when stream time reaches its end plus the allowed lateness; an event
   of a closed window that arrives later is too late. This is the grace-period rule of Kafka Streams,
   and a correctly configured event-time pipeline follows it without any DataForge header. Since the
   plan totally orders deliveries, `classifyArrivals` computes every event's first arrival exactly:
   `on-time` (window not ended), `within-lateness` (ended, not closed), `after-close`, or `lost`. It
   is the one definition, used by the plan summary, `explain`, the validator and the tests of the
   correct target. Two alternatives were rejected: a close on the delivery clock (a DataForge header
   no real pipeline has), and a watermark with an out-of-orderness bound (one more parameter with
   the same effect as the allowed lateness).

4. **Expected windows are the truth** (confirmed, D-5.1): every counted event in the window of
   its event time, exactly once, computed from the canonical log. A window that is short because
   the target dropped an event that arrived after close is a finding, linked to that event, in the
   same way a lost event explains the findings of the correct target (D-3.1). The alternative was a
   "contract" value that leaves out the events that arrived after close. It would have made the
   expected value depend on the plan, and the verdict on `--plan`. The validator still separates
   the two cases in its explanation: an event dropped after close is "dropped by a pipeline with
   this lateness"; an event dropped within the lateness is a bug ("still to be counted").

5. **The late fault is anchored, like reorder.** `faults.late: { rate, lateByMs }` holds the
   event's original attempt until 1 ms after the first delivery of an event whose event time is at
   least `lateByMs` past the close of the late event's window. When the log ends sooner, the last
   delivered event is the anchor. When no delivered event lies past the close (the last windows of
   the log), the event is not eligible. So a late fault always produces an arrival after close in
   stream time, which the tests check for every late event. A fixed delay past the close on the
   delivery clock was rejected because it gives no such guarantee in a sparse stream. Every anchor
   (late or reorder) has a larger event time than the event it holds back, so the planner now plans
   from the last canonical event to the first. That makes every anchor final when it is used, and
   plans without late faults are byte-identical (golden test unchanged). Composition order: delay,
   late, reorder, transient failure, duplicate. The selection stream is `chaos.late`, per event, and
   the selection is drawn first, so late faults are isolated from the other fault types and raising
   the rate only adds late events.

6. **Reference targets.** `correct` counts each event once (by `eventId`) in its event-time window
   and drops, and counts in `windowEventsDropped`, an event whose window stream time has already
   closed. `naive` uses processing-time windows: every message, copies included, is counted in the
   window of the moment it arrives. That is the classic bug: a delayed or late event lands in the
   next window, so one window is short and another long. The roadmap had also described the naive
   target as dropping late events; dropping after close is now the correct target's documented
   behaviour, and a pipeline that drops too early (within the lateness) is caught by the validator,
   which is tested with such a pipeline. The reference targets take processing time from the
   delivery clock (`scheduledDeliveryTimeMs`), so their windows are deterministic and identical in
   process and through Kafka at any `--speed`.

7. **Separate output and report section.** A windowed target writes `actual-windows.json`
   (`dataforge.actual-windows`, format version 1); the actual-state contract is unchanged. Findings
   are one per (window, category): `window-undercount`, `window-overcount`, `duplicate-window`,
   `misaligned-window`. They go in a `windows` section of the result and report, beside the entity
   findings, and make the verdict FAIL. Their causes are the counted events whose delivery was
   abnormal: for a short window, its own events that were lost, arrived after close, arrived within
   the lateness, or were delivered during another window; for a long window, its own events
   delivered more than once and events of other windows delivered during it. A difference no
   delivery explains is reported as unexplained.

8. **Inputs without windowing are unaffected.** The new profile sections are optional (absent when
   not given), and the new summary, target-run, consumer-report and report keys only appear for a
   windowed plan. Profiles, plans, actual states, target runs and reports of Milestones 2 to 4 are
   byte-identical, so `PLANNER_VERSION` stays 0.1.0 and every golden hash is unchanged. A new golden
   pins the `late-data` plan.

## Consequences

- `validate` checks windows whenever the actual state comes with windows or the plan has a windowing
  contract, and refuses one without the other (exit code 2). The contract comes from the plan, or
  from `target-run.json` without `--plan`, so the verdict never depends on `--plan`; only the causes do.
- With several Kafka partitions, cross-partition interleaving can advance the reference target's
  stream time ahead of the plan's, so it may close windows earlier than the plan predicts. Kafka
  Streams keeps stream time per partition. One partition, the default, matches the plan exactly.
- The metrics and their event types are e-commerce specific (`WINDOW_METRIC_EVENT_TYPE`); a new
  metric is one entry there plus its contribution.

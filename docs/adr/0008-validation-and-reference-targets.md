# ADR-0008: Validation engine and reference targets

Status: Accepted (Milestone 3). Decisions 1 (unknown fields rejected) and 7 (loss keeps the verdict
FAIL) were confirmed by the product owner on 2026-11-22.

## Context

Milestone 3 closes the loop offline: a target consumes a delivery plan, reports the state it ended
in, and DataForge must say whether that state is right and, if not, why. The spec asks for missing
entities, duplicate processing, business invariants, referential integrity and structured results
(spec 6, Validation Engine), and for every failure to be explainable by the delivery attempts behind
it (spec 4.3). The validator must judge any target, not only DataForge's own.

## Decisions

1. **The actual-state contract lives in core** (`dataforge.actual-state`, format version 1), next to
   the expected state it mirrors: the same five collections and record shapes, records in any order.
   Targets produce it, the validator reads it, and neither depends on the other. The schema checks
   shape and vocabulary (types, enums, unknown fields), not business values: a negative counter is a
   finding, not a format error. A record listed twice is kept, so the validator can report it.

2. **State invariants live in core beside the event rules** (`ECOMMERCE_INVARIANTS`). Event rules
   check one event against the state before it; a final state needs whole-state properties
   (references resolve, at most one completed payment, status consistent with payments and shipment,
   counters consistent with records). They reuse the same definitions as the rules: the order state
   machine (`PAID_ORDER_STATUSES` and `SHIPPED_ORDER_STATUSES` are derived from `ORDER_TRANSITIONS`) and
   the total formula (`orderLinesTotalMinor`, now shared with `order.total-matches-lines`). Every
   expected state satisfies every invariant (tested over 20 seeds), so a violation is always the
   target's. Synthesizing events to replay through the event rules was rejected: only half of the
   rules make sense outside the moment an event is applied.

3. **One finding per (entity, category)**, listing each differing field with expected and actual
   values. Categories: `missing-entity`, `unexpected-entity`, `duplicate-record`, `status-mismatch`,
   `field-mismatch`, `double-processing`, `referential-integrity`, `invariant-violation`. A counter or
   amount above its expected value (`orderCount`, `totalPaidMinor`, `amountPaidMinor`,
   `paymentAttempts`, `failedPaymentAttempts`) is `double-processing`, the signature of a redelivery
   applied twice; below it, it is a `field-mismatch` (a lost update). Each invariant carries its own
   category (for example `order.paid-within-total` is `double-processing`).

4. **Root-cause hints come from the delivery plan, by dependency.** An entity depends on its own
   aggregate's events (a payment's or shipment's: its order's); a customer also on the
   `OrderCreated` and `PaymentCompleted` events of its orders; an order also on its customer and
   products, but only when one of those was lost (the one way they change an order's outcome). Among
   those, the events whose delivery was abnormal (any fault, not exactly one delivery, or overtaken
   within the aggregate) are the causes. They are ranked: duplicates first for `double-processing`,
   lost events first for missing entities and broken references, lost or out-of-order events first
   otherwise, then events that can write the differing field. A finding with no cause is reported as
   not explained by delivery: a processing bug, or a state edited by hand. Hints are hints: they say
   which faults could have produced the difference, not that they did.

5. **Targets are a separate package from validation** (`@dataforge/targets`), so the validator never
   knows target internals and the Milestone 4 consumer process can reuse the targets alone. The
   in-memory transport hands every *delivered* attempt to the target, in delivery order, as a
   `DeliveryMessage` (key = `aggregateId`, value = the canonical event, headers = `attemptId`,
   `attemptNumber`, `deliverySequence`, `scheduledDeliveryTimeMs`), the shape Kafka will carry.
   Failed attempts never reach the target. The headers deliberately omit the attempt kind: a real
   consumer cannot tell a duplicate from an original except by `eventId`.

6. **The `correct` reference target uses the core projection.** It is the control group: idempotent
   by `eventId`, applying each aggregate in version order (parking an event that arrives before its
   predecessor), and parking an order until its customer and products exist. Since its business
   logic is the projection that defines the expected state, any difference it shows comes from what
   was delivered. The `naive` target has its own projection, written as if delivery were perfect:
   upserts on create, last arrival wins for status, counters incremented per message, and updates of
   missing rows silently lost. With perfect delivery both produce exactly the expected state.

7. **Lost events are explained, not tolerated.** No consumer can rebuild an event it never received,
   so under a profile that allows loss the `correct` target fails too; the requirement is that every
   one of its findings points at a lost event. Its state stays consistent (no invariant breaks), only
   incomplete, which is itself a useful contrast with `naive`.

8. **A delivery is bound to its plan.** `dataforge deliver` writes `target-run.json` next to
   `actual-state.json`: target, run (by the canonical log's SHA-256), plan (by `delivery-plan.jsonl`'s
   SHA-256), message counts, target counters, events still parked, and the actual state's checksum.
   `validate --plan` refuses a plan other than the one the target consumed, and refuses an actual state
   delivered from another run. The checksum is not enforced: editing the actual state is a legitimate
   test, so `validate` only reports that it was edited. The expected state is re-derived by replaying
   the intact canonical log and must equal `expected-state.json`.

## Consequences

- The report (`validation-report.json`) is deterministic: same run, plan and actual state, same
  bytes. A golden test pins it for `naive` under `spec-example`.
- Adding an invariant is appending one entry; adding a reference target is implementing `Target`.
- The dependency model in decision 4 is written for the e-commerce domain. A new event type that
  touches another aggregate's record must be added to it, or its findings will be under-explained.
- Processing time (spec 4.4) is not modelled in process: the transport does not wait for simulation
  time, only the order matters. Milestone 4 plays the plan in wall-clock time.

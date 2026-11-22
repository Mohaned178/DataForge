# ADR-0006: Generation by per-entity lifecycle planning, verified by rule-checked replay

Status: Accepted (Milestone 1)

## Context

The engine needs event scheduling, a simulation clock and cross-entity business constraints. Two
designs fit:

- **A. Discrete-event simulation**: a priority queue of future actions processed in time order
  against shared mutable state.
- **B. Per-entity lifecycle planning**: each entity plans its own timeline from its own random
  streams; the timelines are merged into one canonical order and then checked against every rule.

## Decision

Use **B** for the Milestone 1 domain:

1. Products are created at the epoch; customers register at uniform times in the window.
2. Each order picks a uniform placement time after the first registration and a customer among
   those already registered at that moment (binary search over registration times). It then plans
   its own lines and lifecycle: optional customer cancellation, payment attempts with retries,
   cancellation after the last failure, or shipment and delivery.
3. All drafts are merged, sorted into canonical order, and given sequence numbers.
4. The log is **replayed through every business rule and log-integrity check**. A violation means a
   generator bug and stops generation. The same replay produces the expected state.

## Why

The current constraints (customer registered before ordering, products exist, the payment-shipment
order within an order) are temporal and per-order, so B satisfies them by construction. B also gives
perfect randomness isolation (an order's events depend only on its own streams and its customer's
registration time), is simple to reason about and test, and is fast (5,000 orders in about 0.4 s).
The rule-checked replay makes cross-entity consistency an enforced property, not an assumption.

## When to revisit

When a constraint involves a **shared, contended resource**, such as inventory stock or a credit
limit, an order's outcome would depend on other orders. Then a discrete-event scheduler (design A)
becomes necessary. The rule registry and projection stay as they are; only the generator changes.

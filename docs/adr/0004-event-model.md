# ADR-0004: Event model: Order aggregate, readable IDs, ProductCreated

Status: Accepted (Milestone 1). The `ProductCreated` addition was approved by the product owner on
2026-11-22.

## Context

The spec lists seven events and five entities (Customer, Product, Order, Payment, Shipment), and
says expected state is derived from replaying the canonical log, which is the source of truth for the
simulated world.

## Decisions

1. **Order is the aggregate for payments and shipments.** `PaymentFailed`, `PaymentCompleted`,
   `OrderCancelled`, `ShipmentCreated` and `ShipmentDelivered` all carry the order's `aggregateId`
   and a contiguous `aggregateVersion`. One stream per order gives each order's lifecycle a total
   order. That is exactly what out-of-order delivery breaks, and `aggregateId` is the natural Kafka
   partition key. Payments and shipments still have their own IDs and expected-state records.

2. **`ProductCreated` is added as an eighth event type.** Without it, products would be reference
   data outside the log, and the rule "an order must reference an existing product" could not be
   checked by replaying the log. It also lets targets receive the catalog the same way as everything
   else, and lets chaos testing expose reference-data races (an order arriving before its product).
   All products are created at the epoch. The alternative, a side-loaded catalog file, was
   considered and rejected by the product owner.

3. **IDs are readable and derived from position**: `prd_000001`, `cus_000001`, `ord_000001`,
   `pay_000001_2` (order 1, attempt 2), `shp_000001`, and `evt_<aggregateId>_<version>`. They are
   deterministic, unique by construction, and readable in failure reports. Deterministic UUIDs can be
   added later as an output option if targets need UUID columns.

4. **Envelope**: `eventId`, `type`, `schemaVersion` (1), `sequence`, `eventTimeMs`, `aggregateType`,
   `aggregateId`, `aggregateVersion`, `payload`. Unknown fields and unknown schema versions are
   rejected when parsing.

5. **Order state machine** is one table (`ORDER_TRANSITIONS`) used by the rules and by the
   projection. A paid order cannot be cancelled, because there is no refund event yet.

## Consequences

Replay needs nothing but the log. A double charge is impossible in a canonical log (a second
`PaymentCompleted` on a `PAID` order violates `order.valid-transition`). That makes the
expected-state fields `amountPaidMinor` and `totalPaidMinor` reliable reference values for detecting
duplicate processing in targets.

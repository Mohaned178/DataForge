# DataForge Data Formats

All files are UTF-8 without a byte order mark and use `\n` line endings on every operating system.
JSON is written in canonical form: object keys sorted by UTF-16 code unit at every level. Identical
content is therefore identical bytes, and SHA-256 checksums are meaningful.

## Run directory (`dataforge generate --out <dir>`)

| File | Content |
| --- | --- |
| `events.jsonl` | The canonical event log, one event per line, in canonical order. |
| `expected-state.json` | The final business state, derived by replaying `events.jsonl`. |
| `scenario.resolved.json` | The scenario with every default filled in. Regenerating from this file and the seed reproduces the run. |
| `manifest.json` | Run metadata and SHA-256 checksums of the three files above. Contains no timestamps or machine details, so it is reproducible too. |

## Scenario file (input)

```jsonc
{
  "formatVersion": 1,                     // required
  "name": "my-store",                     // required
  "description": "optional text",
  "simulation": { "epoch": "2026-01-01T00:00:00Z", "durationMs": 604800000 },
  "catalog":    { "productCount": 50, "currency": "USD", "priceMinor": { "min": 500, "max": 25000 } },
  "customers":  { "count": 100 },
  "orders": {
    "count": 500,
    "itemsPerOrder":   { "min": 1, "max": 4 },
    "quantityPerItem": { "min": 1, "max": 3 },
    "customerCancellationRate": 0.05,
    "customerCancellationDelayMs": { "min": 60000, "max": 3600000 },
    "paymentDelayMs":              { "min": 1000,  "max": 600000 }
  },
  "payments": {
    "failureRate": 0.1,
    "maxAttempts": 3,
    "retryDelayMs":        { "min": 60000, "max": 1800000 },
    "cancellationDelayMs": { "min": 1000,  "max": 60000 }
  },
  "shipments": {
    "fulfillmentDelayMs": { "min": 3600000,  "max": 86400000 },
    "deliveryDelayMs":    { "min": 86400000, "max": 432000000 }
  }
}
```

Every field except `formatVersion` and `name` has the default shown. Unknown fields are rejected, so
a typo is an error rather than a silently ignored setting. Money is in integer minor units (cents).
Rates are probabilities in `[0, 1]`. Delays are integer milliseconds, at least 1, so causally related
events always have strictly increasing times.

Limits: 10,000 products, 100,000 customers, 100,000 orders, 20 lines per order, a 366-day window.

## Canonical event (`events.jsonl`, one per line)

```json
{"aggregateId":"ord_000007","aggregateType":"Order","aggregateVersion":2,"eventId":"evt_ord_000007_2",
 "eventTimeMs":115630657,"payload":{"amountMinor":19458,"attempt":1,"orderId":"ord_000007",
 "paymentId":"pay_000007_1"},"schemaVersion":1,"sequence":284,"type":"PaymentCompleted"}
```

(Shown wrapped; in the file each event is a single line.)

| Field | Meaning |
| --- | --- |
| `eventId` | Unique business identity: `evt_<aggregateId>_<aggregateVersion>`. Duplicated deliveries (Milestone 2) keep this value. |
| `type` | One of the event types below. |
| `schemaVersion` | Event schema version, currently `1`. Parsers reject versions they do not know. |
| `sequence` | 1-based position in the canonical log. Contiguous. |
| `eventTimeMs` | Event time: integer milliseconds since `manifest.simulation.epoch` (UTC). Not Unix time. |
| `aggregateType` | `Product`, `Customer` or `Order`. |
| `aggregateId` | The aggregate the event belongs to; equals the payload's `productId`, `customerId` or `orderId`. |
| `aggregateVersion` | 1-based, contiguous position of the event within its aggregate. |
| `payload` | Event-specific data (below). |

Canonical order: `eventTimeMs`, then `aggregateId` (code-unit order), then `aggregateVersion`.

| Type | Aggregate | Payload |
| --- | --- | --- |
| `ProductCreated` | Product | `productId`, `sku`, `name`, `priceMinor`, `currency` |
| `CustomerRegistered` | Customer | `customerId`, `name`, `email`, `country` |
| `OrderCreated` | Order | `orderId`, `customerId`, `currency`, `lines[] {productId, quantity, unitPriceMinor}`, `totalMinor` |
| `PaymentFailed` | Order | `orderId`, `paymentId`, `attempt`, `amountMinor`, `reason` (`CARD_DECLINED`, `INSUFFICIENT_FUNDS`, `PROCESSOR_TIMEOUT`) |
| `PaymentCompleted` | Order | `orderId`, `paymentId`, `attempt`, `amountMinor` |
| `OrderCancelled` | Order | `orderId`, `reason` (`CUSTOMER_REQUEST`, `PAYMENT_FAILED`) |
| `ShipmentCreated` | Order | `orderId`, `shipmentId`, `carrier` (`STANDARD_POST`, `EXPRESS_COURIER`, `FREIGHT`) |
| `ShipmentDelivered` | Order | `orderId`, `shipmentId` |

### Order state machine

```
OrderCreated ──▶ PENDING_PAYMENT ──PaymentFailed──▶ PENDING_PAYMENT
                       │  │
                       │  └──OrderCancelled──▶ CANCELLED
                       └──PaymentCompleted──▶ PAID ──ShipmentCreated──▶ SHIPPED ──ShipmentDelivered──▶ DELIVERED
```

A paid order cannot be cancelled (there is no refund event yet). Events at or after the end of the
simulation window are not generated, so some orders end mid-lifecycle, as in a real snapshot.

## Expected state (`expected-state.json`)

```jsonc
{
  "format": "dataforge.expected-state",
  "formatVersion": 1,
  "lastSequence": 472,
  "lastEventTimeMs": 172431337,
  "summary": { "products": 12, "customers": 25, "orders": 120, "payments": 137, "shipments": 98,
               "ordersByStatus": { "PENDING_PAYMENT": 1, "PAID": 10, ... }, "revenueMinor": 2525664 },
  "products":  [ { "productId", "sku", "name", "priceMinor", "currency", "createdAtMs" } ],
  "customers": [ { "customerId", "name", "email", "country", "registeredAtMs", "orderCount", "totalPaidMinor" } ],
  "orders":    [ { "orderId", "customerId", "status", "currency", "lines", "totalMinor", "amountPaidMinor",
                   "paymentAttempts", "failedPaymentAttempts", "cancellationReason", "shipmentId",
                   "createdAtMs", "updatedAtMs" } ],
  "payments":  [ { "paymentId", "orderId", "attempt", "status", "amountMinor", "failureReason", "occurredAtMs" } ],
  "shipments": [ { "shipmentId", "orderId", "carrier", "status", "createdAtMs", "deliveredAtMs" } ]
}
```

Each list is sorted by ID. Absent values are `null`, never missing. `totalPaidMinor` and
`amountPaidMinor` are the fields a double-charge bug will disagree with.

## Chaos profile (input to `dataforge chaos plan --profile`)

```jsonc
{
  "formatVersion": 1,                      // required
  "name": "flaky-network",                 // required
  "description": "optional text",
  "faults": {
    "delay":     { "rate": 0, "delayMs": { "min": 1000, "max": 300000 } },
    "reorder":   { "rate": 0, "distance": { "min": 1, "max": 1 } },
    "duplicate": { "rate": 0, "copies": { "min": 1, "max": 1 }, "redeliveryOffsetMs": { "min": 0, "max": 60000 } },
    "transientFailure": {
      "rate": 0,
      "failures": { "min": 1, "max": 1 },
      "maxRetries": 3,
      "retryBackoffMs": { "min": 1000, "max": 30000 },
      "allowLoss": false
    }
  }
}
```

Every field except `formatVersion` and `name` has the default shown, so **every fault type is off
unless its rate is above 0**. Unknown fields are rejected. Rates are per-event probabilities in
`[0, 1]`; durations are integer milliseconds.

| Fault | Applies to | Effect |
| --- | --- | --- |
| `delay` | every event | The original attempt is delivered `delayMs` after event time. It may or may not end up behind later events. |
| `reorder` | events with a later event in their aggregate | The original attempt is delivered 1 ms after the first delivery of the `distance`-th later event of the same aggregate (fewer if the aggregate has fewer). Always produces an inversion. |
| `duplicate` | events that are delivered | `copies` extra deliveries of the first delivered attempt, each `redeliveryOffsetMs` after it (0 is allowed). Same `eventId`, new `attemptId`. |
| `transientFailure` | every event | The first `failures` attempts fail and are retried after `retryBackoffMs` each. With `failures > maxRetries` the sender gives up and the event is lost, which requires `allowLoss: true`. |

Limits: delays and offsets up to 30 days, `distance` up to 50, `copies` up to 10, `failures` and
`maxRetries` up to 20. Example profiles are in `chaos-profiles/`.

## Plan directory (`dataforge chaos plan --out <dir>`)

| File | Content |
| --- | --- |
| `delivery-plan.jsonl` | Every delivery attempt, one per line, in delivery order. |
| `chaos-profile.resolved.json` | The profile with every default filled in. |
| `delivery-summary.json` | Seeds, the run the plan belongs to, counts, configured versus observed rates, ordering, checksums of the two files above. No timestamps or paths, so it is reproducible. |

A plan is bound to its run by `source.eventsSha256`, the SHA-256 of `events.jsonl`; the canonical
run directory is never written to.

## Delivery attempt (`delivery-plan.jsonl`, one per line)

```json
{"aggregateId":"ord_000088","aggregateVersion":2,"attemptId":"att_ord_000088_2_1","attemptNumber":1,
 "deliverySequence":58,"derivedFrom":null,"eventId":"evt_ord_000088_2","eventSequence":28,
 "eventTimeMs":27672863,"eventType":"PaymentCompleted",
 "faults":[{"behindEventId":"evt_ord_000088_3","distance":1,"shiftMs":11295521,"type":"reorder"}],
 "kind":"original","plannedOutcome":"delivered","scheduledDeliveryTimeMs":38968384}
```

| Field | Meaning |
| --- | --- |
| `attemptId` | Unique attempt identity: `att_<aggregateId>_<aggregateVersion>_<attemptNumber>`. |
| `deliverySequence` | 1-based position in delivery order. Contiguous; equals the line number. |
| `attemptNumber` | 1-based position among the event's attempts, in time order: original, retries, duplicates. |
| `kind` | `original` (the first attempt), `retry` (after a failed attempt) or `duplicate` (an extra copy). |
| `plannedOutcome` | `delivered` (reaches the target) or `failed` (does not; a retry may follow). |
| `scheduledDeliveryTimeMs` | Delivery time, in milliseconds since the scenario epoch, the same clock as `eventTimeMs`. Never earlier than event time. |
| `eventId` … `aggregateVersion` | The canonical event this attempt delivers: `eventId`, `eventSequence` (its `sequence`), `eventType`, `eventTimeMs`, `aggregateId`, `aggregateVersion`. Duplicates and retries keep the event's `eventId`. |
| `derivedFrom` | `null` for an original. For a retry: the failed attempt it retries and the backoff. For a duplicate: the delivered attempt it copies and the redelivery offset. |
| `faults` | The faults that shaped this attempt, below. Empty when none did. |

| Fault record | Meaning |
| --- | --- |
| `{"type":"delay","delayMs"}` | Held back by `delayMs`. |
| `{"type":"reorder","behindEventId","distance","shiftMs"}` | Moved behind `behindEventId`, `shiftMs` later than it would otherwise have been. |
| `{"type":"transientFailure","failure","failures"}` | This attempt is failure `failure` of the `failures` planned for the event. |
| `{"type":"duplicate","copy","copies"}` | This attempt is copy `copy` of `copies`. |

An attempt's time is always explained by its records: an original is at
`eventTimeMs + delayMs + shiftMs`; a retry or duplicate is at its `derivedFrom` attempt's time plus
`offsetMs`. Delivery order is `scheduledDeliveryTimeMs`, then `eventSequence`, then
`attemptNumber`.

## Delivery summary (`delivery-summary.json`)

```jsonc
{
  "format": "dataforge.delivery-plan",
  "formatVersion": 1,
  "plannerVersion": "0.1.0",
  "chaosSeed": "7",
  "profile": { "name": "spec-example", "hash": "sha256:abd6..." },
  "source": { "engineVersion": "0.1.0", "seed": "42", "scenarioName": "ecommerce-small",
              "scenarioHash": "sha256:3afb...", "eventsSha256": "01b57d64..." },
  "summary": {
    "events": 472, "attempts": 486,
    "attemptsByKind": { "original": 472, "retry": 0, "duplicate": 14 },
    "attemptsByOutcome": { "delivered": 486, "failed": 0 },
    "eventsDelivered": 472, "eventsLost": 0,
    "faults": {
      "delay":            { "rate": 0.05, "eligibleEvents": 472, "faultedEvents": 26 },
      "reorder":          { "rate": 0.02, "eligibleEvents": 315, "faultedEvents": 8 },
      "duplicate":        { "rate": 0.03, "eligibleEvents": 472, "faultedEvents": 14, "extraDeliveries": 14 },
      "transientFailure": { "rate": 0,    "eligibleEvents": 472, "faultedEvents": 0, "failedAttempts": 0, "lostEvents": 0 }
    },
    "ordering": { "outOfOrderEvents": 10, "inversionPairs": 11, "aggregatesAffected": 9 },
    "lastScheduledDeliveryTimeMs": 172303920
  },
  "files": { "delivery-plan.jsonl": { "sha256": "...", "bytes": 167512 },
             "chaos-profile.resolved.json": { "sha256": "...", "bytes": 831 } }
}
```

The observed rate of a fault is `faultedEvents / eligibleEvents`. `ordering` compares each event's
first delivered attempt with the other events of its aggregate. An event is out of order when a
later version of its aggregate reaches the target first. It counts whatever caused it (delay,
reorder or retries). Lost events are left out.

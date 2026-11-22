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

### Windowing contract and late fault (optional, Milestone 5)

```jsonc
{
  "formatVersion": 1,
  "name": "late-data",
  "windowing": { "sizeMs": 3600000, "allowedLatenessMs": 600000 },   // allowedLatenessMs defaults to 0
  "faults": {
    "late": { "rate": 0.05, "lateByMs": { "min": 60000, "max": 1800000 } }   // needs "windowing"
  }
}
```

`windowing` is the contract of the pipeline under test: tumbling event-time windows of `sizeMs`
(1 s to 30 days), aligned to the scenario epoch, and how long after its end a window still accepts
events (`allowedLatenessMs`, 0 to 30 days). A window `[start, start + sizeMs)` **closes** when the
target's *stream time* (the largest event time it has received) reaches `start + sizeMs +
allowedLatenessMs`. Both sections are optional and absent unless given, so a profile without them
resolves exactly as before Milestone 5.

| Fault | Applies to | Effect |
| --- | --- | --- |
| `late` | events whose window closes before the last delivered event | The original attempt is delivered 1 ms after the first delivery of an event whose event time is at least `lateByMs` past the close of this event's window (the last delivered event, if the log ends sooner). So the event always arrives after its window has closed. Applied after `delay` and before `reorder`. |

Example profiles: `windowed-none` (windows, no faults), `windowed-delays` (delays within the
lateness, duplicates), `late-data` (5% late events).

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
| `{"type":"late","windowCloseMs","behindEventId","shiftMs"}` | Held until just after `behindEventId`, an event past `windowCloseMs` (the close of this event's window), `shiftMs` later than it would otherwise have been. |
| `{"type":"reorder","behindEventId","distance","shiftMs"}` | Moved behind `behindEventId`, `shiftMs` later than it would otherwise have been. |
| `{"type":"transientFailure","failure","failures"}` | This attempt is failure `failure` of the `failures` planned for the event. |
| `{"type":"duplicate","copy","copies"}` | This attempt is copy `copy` of `copies`. |

An attempt's time is always explained by its records: an original is at
`eventTimeMs + delayMs + shiftMs` (late, then reorder); a retry or duplicate is at its `derivedFrom` attempt's time plus
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

For a profile with a windowing contract the summary has two more entries (absent otherwise):

```jsonc
"faults": { ..., "late": { "rate": 0.05, "eligibleEvents": 456, "faultedEvents": 21 } },   // only when the profile has "late"
"windowing": {
  "sizeMs": 3600000, "allowedLatenessMs": 600000,
  "arrivals": { "onTime": 219, "withinLateness": 0, "afterClose": 9, "lost": 0 }
}
```

`arrivals` classifies the first arrival of every event the windows count (OrderCreated and
PaymentCompleted) by the stream time just before it: `onTime` (its window had not ended),
`withinLateness` (ended, not closed), `afterClose` (closed: a pipeline with this lateness drops it),
`lost`. Any fault can make an event arrive after close, not only `late` (a long delay or a reorder
can too).

## Actual state (what a target reports; input to `dataforge validate --actual`)

```jsonc
{
  "format": "dataforge.actual-state",
  "formatVersion": 1,
  "products":  [ ... ],   // same record shapes as expected-state.json
  "customers": [ ... ],
  "orders":    [ ... ],
  "payments":  [ ... ],
  "shipments": [ ... ]
}
```

The contract a target hands back, whatever its technology: the five entity collections of the
expected state, with exactly the same record fields (see above), in any order. There is no `summary`,
`lastSequence` or `lastEventTimeMs`; the validator computes what it needs. Unknown fields, unknown
enum values (`status`, `carrier`, reasons) and non-integer numbers are rejected with the path of each
problem (`orders.3.status`), so a mapping mistake is an error instead of a silent mismatch. Business
values are not checked by the format: a doubled amount or a negative counter is a validation
finding. A record listed twice is accepted by the format and reported as `duplicate-record`. A UTF-8
byte order mark is accepted.

`dataforge deliver` writes it sorted by ID in canonical JSON, like `expected-state.json`.

## Actual windows (what a windowed target reports; `actual-windows.json`)

```jsonc
{
  "format": "dataforge.actual-windows",
  "formatVersion": 1,
  "windows": [
    { "windowStartMs": 18000000, "windowEndMs": 21600000, "ordersCreated": 4, "paymentsCompleted": 3, "revenueMinor": 63540 }
  ]
}
```

Per-window metrics in simulation milliseconds since the epoch, in any order: `ordersCreated` (the
window's OrderCreated events), `paymentsCompleted` (its PaymentCompleted events) and `revenueMinor`
(their amounts, in minor units of the catalog currency). A window missing from the list counts as
zeros. Like the actual state, the format checks shape (unknown fields and non-integers are rejected
with their path), not correctness: a misaligned window or a window listed twice is a finding.

The **expected windows** are not a file: `validate` computes them from the canonical log for the
plan's window size. Every counted event is in the window of its event time, exactly once, whatever
its delivery. They add up to the expected state's orders and revenue.

## Delivery directory (`dataforge deliver --out <dir>`, either transport)

| File | Content |
| --- | --- |
| `actual-state.json` | The state the target ended in, in the actual-state format. |
| `actual-windows.json` | Only for a plan with a windowing contract: the target's per-window metrics. |
| `target-run.json` | Which target consumed which plan of which run, and what happened. |

```jsonc
{
  "format": "dataforge.target-run",
  "formatVersion": 1,
  "target": { "name": "correct", "description": "idempotent by eventId, ..." },
  "source": { "seed": "42", "scenarioName": "ecommerce-small", "eventsSha256": "01b57d64..." },
  "plan": { "plannerVersion": "0.1.0", "chaosSeed": "7", "profile": { "name": "spec-example", "hash": "sha256:..." },
            "planSha256": "0c08d623..." },                  // SHA-256 of delivery-plan.jsonl
  "delivery": { "messages": 486, "distinctEvents": 472, "redeliveries": 14, "failedAttempts": 0 },
  "counters": { "duplicatesIgnored": 14, "eventsParked": 11 },   // naive: { "updatesLost": 6 }
  "parkedEventIds": [],                                     // received but never applied
  "files": { "actual-state.json": { "sha256": "...", "bytes": 135176 } }
}
```

For a windowed plan, `target-run.json` also has `"windowing": { "sizeMs", "allowedLatenessMs" }`, an
`actual-windows.json` entry in `files`, and, for the correct target, the counter
`windowEventsDropped` (events not counted because they arrived after their window closed).

`validate` uses it when it sits next to an `actual-state.json`: it refuses an actual state delivered
from another run, refuses `--plan` when it is not the plan the target consumed, and reports
(without refusing) an actual state edited since it was written.

## Kafka delivery directory (`dataforge deliver --transport kafka --out <dir>`)

The same `actual-state.json` and `target-run.json` as the in-memory transport (with one partition,
byte-identical to it for the same run, plan and target), plus what really happened on Kafka. The
files below hold wall-clock times, so they differ from one execution to the next.

| File | Written by | Content |
| --- | --- | --- |
| `actual-state.json` | consumer process | The target's final state (actual-state format). |
| `target-run.json` | delivering process | Same format and meaning as above, built from the consumer's report. |
| `delivery-log.jsonl` | delivering process | One entry per planned attempt, in delivery order: sent (partition, offset, times) or planned failure. |
| `processing-log.jsonl` | consumer process | One entry per record the consumer handled, in the order it handled them. |
| `consumer-report.json` | consumer process | What the consumer saw: target, topic, group, partitions, message counts, target counters. |
| `kafka-run.json` | delivering process | The execution: broker, topic, group, consumer process, pacing, completion, checksums. |
| `producer.log`, `consumer.log` | both | The Kafka client log of each process (JSON lines), and the consumer's console output. |

### Kafka record (`dataforge.delivery-record`, format version 1)

One record per delivered attempt, in delivery order, on topic `dataforge.<execution id>`. A planned
failure is never sent.

| Part | Content |
| --- | --- |
| key | The event's `aggregateId` (UTF-8). Every event of an aggregate is in one partition, in plan order. |
| value | Canonical JSON: `{"event":{...canonical event...},"eventTime":"2026-01-01T00:00:00.000Z","format":"dataforge.delivery-record","formatVersion":1}`. `eventTime` is the event time as an ISO-8601 UTC instant. |
| headers | `attemptId`, `attemptNumber`, `deliverySequence`, `scheduledDeliveryTimeMs` (decimal strings) and `scheduledDeliveryTime` (ISO-8601). |
| timestamp | Kafka's own `CreateTime`: when the producer sent the record (wall clock). |

Redeliveries of one event (duplicates, a retry after a failed attempt) have the same key and value
and different headers. The reference consumer rejects a record with a missing or extra field, a
malformed header, or a key other than the event's `aggregateId`, and stops with the path of each
problem.

### Delivery log entry (`delivery-log.jsonl`)

```json
{"ackedAtMs":132,"aggregateId":"prd_000002","attemptId":"att_prd_000002_1_1","deliverySequence":2,"driftMs":null,
 "dueAtMs":null,"eventId":"evt_prd_000002_1","offset":"1","outcome":"sent","partition":0,
 "scheduledDeliveryTimeMs":0,"startedAtMs":127}
```

| Field | Meaning |
| --- | --- |
| `outcome` | `sent` (produced and acknowledged) or `planned-failure` (never sent). |
| `dueAtMs` | When the attempt was due, in wall-clock ms since the execution started: `(scheduledDeliveryTimeMs - first attempt's) / speed`. `null` at `--speed max`. |
| `startedAtMs`, `ackedAtMs` | When sending started and when the broker acknowledged it (ms since the start). `ackedAtMs` is `null` for a planned failure. |
| `driftMs` | `startedAtMs - dueAtMs`: how late the attempt was. `null` at `--speed max`. |
| `partition`, `offset` | Where the broker stored the record (`offset` is a decimal string: Kafka offsets are 64-bit). `null` for a planned failure. |

### Processing log entry (`processing-log.jsonl`)

```json
{"aggregateId":"prd_000002","attemptId":"att_prd_000002_1_1","deliverySequence":2,"eventId":"evt_prd_000002_1",
 "kafkaTimestamp":"2026-11-22T17:37:02.151Z","offset":"1","partition":0,"processedAt":"2026-11-22T17:37:02.537Z",
 "processingSequence":2}
```

`processedAt` is processing time (spec 4.4): when the consumer handed the record to its target.
With one partition, `processingSequence` follows `deliverySequence` of the sent attempts exactly;
with several, only within each partition.

### Consumer report (`consumer-report.json`)

```jsonc
{
  "format": "dataforge.consumer-report",
  "formatVersion": 1,
  "target": { "name": "naive", "description": "applies every message as it arrives: ..." },
  "kafka": { "topic": "dataforge.20261122T173656506Z-b6ed1f", "groupId": "dataforge-consumer.20261122T173656506Z-b6ed1f", "partitions": [0] },
  "startedAt": "2026-11-22T17:36:56.965Z", "finishedAt": "2026-11-22T17:37:08.021Z",
  "messages": 486, "distinctEvents": 472, "redeliveries": 14,
  "kafkaRedeliveries": 0,          // records Kafka handed over twice (same partition and offset)
  "counters": { "updatesLost": 6 }, "parkedEventIds": [],
  "files": { "actual-state.json": { "sha256": "a47f...", "bytes": 135126 }, "processing-log.jsonl": { ... } }
}
```

The consumer knows nothing of runs or plans; the delivering process checks the actual state's
checksum against this report and binds both to the run and plan in `target-run.json`. Started with
`--window-size-ms` (and `--allowed-lateness-ms`), the consumer also writes `actual-windows.json`, and
the report gains `windowing` and an `actual-windows.json` entry in `files`.

### Kafka run (`kafka-run.json`)

```jsonc
{
  "format": "dataforge.kafka-run",
  "formatVersion": 1,
  "executionId": "20261122T173656506Z-b6ed1f",
  "client": "kafkajs 2.2.4",
  "kafka": { "brokers": ["localhost:9092"], "clusterId": "5L6g...", "topic": "dataforge.2026...", "partitions": 1,
             "groupId": "dataforge-consumer.2026..." },
  "consumer": { "pid": 19688, "target": "naive", "joinedAfterMs": 5003, "assignedPartitions": [0],
                "startedAt": "...", "finishedAt": "...", "exitCode": 0 },
  "execution": { "speed": "max", "startedAt": "...", "durationMs": 980, "sent": 486, "plannedFailures": 0,
                 "maxDriftMs": null },          // speed: "max" or the factor, for example 40000
  "completion": { "lagZeroAfterMs": 16, "polls": 1 },   // after the last record was sent
  "consumed": { "messages": 486, "kafkaRedeliveries": 0 },
  "files": { "delivery-log.jsonl": { "sha256": "...", "bytes": 125837 } }
}
```

## Validation report (`dataforge validate --report <file>`)

```jsonc
{
  "format": "dataforge.validation-report",
  "formatVersion": 1,
  "source": { "seed": "42", "scenarioName": "ecommerce-small", "eventsSha256": "01b57d64..." },
  "target": { "name": "naive", "editedAfterDelivery": false },   // null without target-run.json
  "plan": { "chaosSeed": "7", "profile": { ... }, "planSha256": "..." },  // null without --plan
  "verdict": "FAIL",                                             // PASS exactly when there is no finding
  "hints": true,                                                 // a plan was given
  "checked": { "entities": { "order": { "expected": 120, "actual": 120 }, ... }, "invariants": 16 },
  "counts": { "findings": 48, "byCategory": { "missing-entity": 0, ... }, "explained": 48, "unexplained": 0 },
  "rootCauses": [ { "cause": { ...a delivery cause... }, "findings": 7 }, { "cause": null, "findings": 2 } ],
  "findings": [
    {
      "category": "double-processing",
      "entityType": "order",
      "entityId": "ord_000018",
      "check": "compare",                     // or "duplicate-record", or the ID of an invariant
      "message": "amountPaidMinor is 7000, expected 3500 (2x); paymentAttempts is 3, expected 2",
      "differences": [ { "field": "amountPaidMinor", "expected": 3500, "actual": 7000 }, ... ],
      "causes": [
        { "eventId": "evt_ord_000018_3", "eventType": "PaymentCompleted", "aggregateId": "ord_000018",
          "aggregateVersion": 3, "faults": ["duplicate"], "deliveries": 2, "failedAttempts": 0,
          "lost": false, "delayMs": null, "overtakenBy": [] }
      ]
    }
  ]
}
```

| Category | Meaning |
| --- | --- |
| `missing-entity` | Expected, but not in the actual state. |
| `unexpected-entity` | In the actual state, but not expected. |
| `duplicate-record` | The same ID listed more than once. |
| `status-mismatch` | An order, payment or shipment ends in the wrong status. |
| `field-mismatch` | Any other field differs, including a counter or amount below its expected value (a lost update). |
| `double-processing` | A counter or amount above its expected value (`orderCount`, `totalPaidMinor`, `amountPaidMinor`, `paymentAttempts`, `failedPaymentAttempts`), or an invariant that only double processing breaks (`order.paid-within-total`, `order.single-completed-payment`). |
| `referential-integrity` | A reference to an entity that does not exist (order to customer or product, payment or shipment to order, order to shipment). |
| `invariant-violation` | The actual state contradicts itself (status against payments or shipment, counters against records, totals against lines). |

Findings are sorted by entity type, entity ID, category and check. `causes` are the abnormal
deliveries (any fault, not exactly one delivery, or overtaken within the aggregate) of the events the
entity depends on, most likely first; an empty list with `hints: true` means no delivery fault
explains the finding. `rootCauses` groups findings by their first cause. The report contains no
timestamps or paths, so it is reproducible byte for byte.

### Windows section (only when windows were validated)

`validate` checks windows when the actual state comes with `actual-windows.json` (or `--windows`)
and the plan, or `target-run.json`, has a windowing contract; one without the other is refused
(exit code 2). The report then has a `windows` key, and `target.windowsEditedAfterDelivery`:

```jsonc
"windows": {
  "windowing": { "sizeMs": 3600000, "allowedLatenessMs": 600000 },
  "hints": true,
  "checked": { "expected": 41, "actual": 41 },          // windows with a counted event; windows the target listed
  "counts": { "findings": 7, "byCategory": { "window-undercount": 7, "window-overcount": 0, "duplicate-window": 0,
              "misaligned-window": 0 }, "explained": 7, "unexplained": 0 },
  "findings": [
    {
      "category": "window-undercount",
      "windowStartMs": 50400000, "windowEndMs": 54000000,
      "message": "paymentsCompleted is 3, expected 4; revenueMinor is 61320, expected 83806",
      "differences": [ { "field": "paymentsCompleted", "expected": 4, "actual": 3 }, ... ],
      "causes": [
        { "eventId": "evt_ord_000012_2", "eventType": "PaymentCompleted", "eventTimeMs": 50730532,
          "windowStartMs": 50400000, "windowCloseMs": 54600000, "arrival": "after-close",
          "firstDeliveryTimeMs": 55773887, "streamTimeMs": 55773886, "deliveries": 1,
          "arrivalWindowStartsMs": [54000000], "faults": ["late"] }
      ]
    }
  ]
}
```

| Category | Meaning |
| --- | --- |
| `window-undercount` | A metric below its true value: events dropped (after close, or too early), lost, or counted in another window. |
| `window-overcount` | A metric above its true value: events counted more than once, or events of another window counted here. |
| `duplicate-window` | The same window start listed more than once (the first is compared). |
| `misaligned-window` | A window that is not `[k * sizeMs, (k + 1) * sizeMs)`; its values are not compared. |

Window causes are the counted events whose delivery was abnormal (any fault, not exactly one
delivery, an arrival other than on time, or a copy delivered during another window). For a short
window: its own events, lost or after close first, then within the lateness (a pipeline must still
count those), then delivered during another window. For a long window: its own events delivered more
than once, then events of other windows delivered during it. `arrival` and `streamTimeMs` are
computed from the plan exactly as described for `arrivals` in the delivery summary. Window findings
make the verdict `FAIL` like entity findings.

### State invariants

| ID | Category | Property |
| --- | --- | --- |
| `ref.order-customer` | referential-integrity | An order references an existing customer. |
| `ref.order-products` | referential-integrity | Every order line references an existing product. |
| `ref.order-shipment` | referential-integrity | An order's `shipmentId` references an existing shipment of that order. |
| `ref.payment-order` | referential-integrity | A payment references an existing order. |
| `ref.shipment-order` | referential-integrity | A shipment references an existing order. |
| `order.paid-within-total` | double-processing | An order is never paid more than its total. |
| `order.single-completed-payment` | double-processing | An order has at most one completed payment. |
| `order.total-matches-lines` | invariant-violation | The total equals the sum of quantity x unit price. |
| `order.paid-status` | invariant-violation | PAID, SHIPPED or DELIVERED exactly when a payment is completed, and then paid in full. |
| `order.shipment-status` | invariant-violation | A shipment exactly when SHIPPED or DELIVERED; DELIVERED exactly when the shipment is. |
| `order.payment-counters` | invariant-violation | `paymentAttempts` and `failedPaymentAttempts` count the payment records. |
| `order.cancellation` | invariant-violation | A cancellation reason exactly when CANCELLED. |
| `payment.amount-matches-order` | invariant-violation | Every payment charges the order total. |
| `shipment.delivered-time` | invariant-violation | A delivery time exactly when DELIVERED. |
| `customer.order-count` | invariant-violation | `orderCount` is the number of the customer's orders. |
| `customer.total-paid` | invariant-violation | `totalPaidMinor` is the sum paid on the customer's orders. |

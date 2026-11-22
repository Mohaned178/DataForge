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

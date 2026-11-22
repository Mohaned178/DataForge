# ADR-0009: Kafka delivery: KafkaJS behind one package, a consumer process, one partition by default, completion by lag

Status: Accepted (Milestone 4). Decisions 4 (one partition by default) and 7 (topics kept) were
confirmed by the product owner on 2026-11-22.

## Context

Milestone 4 replaces the in-memory transport with a real Kafka broker and a consumer running in its
own process (spec section 3, steps 6 and 7). The roadmap left open which Kafka client to use (KafkaJS
has had no release since 2.2.4, February 2023), and the milestone has to show that the Kafka run is
the same test as the offline run of Milestone 3, not a different one.

## Decisions

1. **KafkaJS 2.2.4, the spec's client, kept behind `@dataforge/kafka`.** A spike on 2026-11-22
   against the pinned broker (`apache/kafka:4.3.2`, KRaft, single node) sent 5,000 keyed records
   with headers through each candidate, one acknowledged send at a time, into three partitions, and
   consumed them with a consumer group:

   | Client | Per-key order, headers, zero lag | Send time | Notes |
   | --- | --- | --- | --- |
   | `kafkajs` 2.2.4 | yes | about 6 s | Pure JavaScript. A `TimeoutNegativeWarning` on Node 24 and self-retried "coordinator loading" errors on a fresh broker. |
   | `@confluentinc/kafka-javascript` 1.11.0 | yes | about 78 s | Native librdkafka binding (75 MB, install script that pnpm must allow). `createTopics({ waitForLeaders })` not implemented in its KafkaJS-compatible API. |
   | `@platformatic/kafka` 2.17.0 | yes | about 6 s | Pure TypeScript and fast, but documents support for Kafka 3.5 to 4.2 only, and its lag helper returned `-1` here. |

   KafkaJS works with the pinned broker and needs no native build, so the spec's choice stands. Its
   maintenance status is handled by containment: `@dataforge/kafka` is the only package that imports
   a Kafka client (the four pure packages reject `kafkajs` imports in ESLint), and the rest of the
   code sees `RecordSender`, `ConsumerRunner` and plain records. The Confluent client's
   KafkaJS-compatible API is the fallback if KafkaJS stops working with a future broker.

   Two KafkaJS behaviours are handled explicitly: its log goes to a file per process (`producer.log`,
   `consumer.log`) instead of the console, and the Node 24 `TimeoutNegativeWarning` (KafkaJS arms a
   timer with a negative delay; Node uses 1 ms, which is what it meant) is filtered from process
   warnings by the two entry points; every other warning is still printed.

2. **The record contract** (`dataforge.delivery-record`, format version 1). Key: the `aggregateId`,
   so every event of an aggregate lands in one partition and keeps its order. Value: canonical JSON
   of `{format, formatVersion, event, eventTime}`, where `event` is the canonical event unchanged and
   `eventTime` its ISO-8601 instant (event time stays in the value, never in Kafka's timestamp).
   Headers: `attemptId`, `attemptNumber`, `deliverySequence`, `scheduledDeliveryTimeMs` and its ISO
   form `scheduledDeliveryTime`, as UTF-8 strings. As in Milestone 3, the headers do not say whether
   an attempt is a duplicate: a consumer can only tell by `eventId`. Decoding validates every part
   with Zod and reports every problem with its path; a record that breaks the contract stops the
   reference consumer instead of being skipped.

3. **The executor plays the plan; it makes no chaos decision.** Attempts are sent one at a time in
   delivery order by an idempotent producer with one request in flight and `acks: -1`, so the broker
   stores the records of each key exactly in plan order, once. A planned failure is **not sent** and
   is logged as `planned-failure`: a failed attempt is one that never reaches the target, and
   simulating a broker error would be a fake. Pacing compresses plan time: an attempt is due at
   `(scheduledDeliveryTimeMs - first attempt's time) / speed` wall-clock milliseconds after the start;
   `--speed max` (the default) sends without waiting, since Milestone 4 needs the order, not the
   timing (windows in Milestone 5 will). Lateness against the due time is recorded as drift, never
   corrected by skipping. The clock and the sender are injected, so pacing is unit-tested without a
   broker; the executor, the record contract and the lag arithmetic are under the determinism guard.

   The producer's retries are bounded (KafkaJS then logs "Limiting retries for the idempotent
   producer may invalidate EoS guarantees" in `producer.log`). That is safe here: with one request in
   flight and no resend after a failed send, a bounded retry cannot create a duplicate, while
   unbounded retries would turn a dead broker into a hang. A failed send stops the delivery with exit
   code 3.

4. **One partition by default.** Kafka orders records only within a partition. With one partition
   the consumer receives exactly the planned delivery order, so the Kafka delivery is the offline
   delivery played through a real broker: same `actual-state.json`, same `target-run.json`, same
   validation report, byte for byte (tested for two seeds, four profiles and both targets).
   `--partitions <n>` spreads aggregates over partitions: per-key order still holds and the correct
   target still passes, but events of different aggregates interleave according to fetch timing,
   which the plan does not describe. The naive target can then show more findings than offline (for
   example an order's payment applied before its customer arrived from another partition). That is
   a real effect of partitioning, not of the chaos profile.

5. **The consumer is a separate process that knows only Kafka and its target.** `@dataforge/consumer`
   reads records, decodes them into the Milestone 3 `DeliveryMessage`, hands them to a reference
   target and writes `actual-state.json`, `consumer-report.json` and `processing-log.jsonl`. It has
   no access to the run or the plan; the delivering process binds its output to them in
   `target-run.json`. The two processes talk over Node IPC with three messages: `ready` (joined the
   group, with its partitions), `finish` (from the parent), `finished` or `failed`. The consumer also
   finishes when its parent goes away. Ctrl+C finishes it too when started by hand; that path is not
   covered by the automated tests, since Windows cannot send it programmatically.

6. **Completion is zero consumer-group lag.** After the last send, the parent polls the group's lag
   (log end offsets minus committed offsets, over every partition) until it is zero, then asks the
   consumer to finish. The consumer commits a batch's offsets only after the target has handled
   every record in it, so a committed offset means "handled". Lag works for any consumer group without
   its cooperation, which is what testing a user's own pipeline will need. A lag that does not reach
   zero within `--timeout`, or a consumer that exits, ends the delivery with exit code 3 instead of a
   hang. A record Kafka hands over twice (same partition and offset, for example after a rebalance) is
   counted and reported as at-least-once redelivery; it would make the run differ from the plan.

7. **A topic and a consumer group per execution**, named `dataforge.<execution id>` and
   `dataforge-consumer.<execution id>` (UTC timestamp plus a random suffix), created with the
   requested partition count; broker-side auto-creation is disabled. Every execution starts from an
   empty topic, reading from the beginning. Topics are kept so records can be inspected; the broker has
   no volume, so `docker compose down` removes them.

8. **`deliver --transport kafka`, not a new command.** Same inputs, same two shared output files,
   same output-directory rules as `--transport memory` (the default); Kafka adds
   `delivery-log.jsonl`, `kafka-run.json` and the two client logs. The roadmap's working name
   `dataforge run` was dropped: it would have read `dataforge run --run <dir>`, and a separate
   command would have hidden that the two deliveries are the same thing.

9. **Infrastructure failures are exit code 3**, a new code next to 0 (success), 1 (check failed) and
   2 (invalid input): Kafka unreachable (with the command that starts it), the consumer failing or not
   joining, lag not reaching zero, a send failing. Option errors are still checked before any
   connection and exit with 2. `pnpm test:integration` runs only against a real broker and fails as a
   whole, with the same instruction, when it is unreachable; `pnpm check` needs no broker.

## Alternatives considered

- **End-of-stream marker records** for completion: simple, but they put DataForge's control data into
  the topic a user's pipeline reads, and they need one marker per partition.
- **Several partitions by default**: closer to production, but the Kafka run would no longer equal
  the plan, so a difference between the offline and the Kafka run could not be told apart from a bug.
- **Sending planned failures and dropping them at the consumer**: the consumer would have to know
  the plan, which a real pipeline never does.
- **The consumer as a `dataforge consume` subcommand**: one package less, but the consumer would then
  carry the planner and the validator; a separate app makes the boundary real.

## Consequences

- `actual-state.json` and `target-run.json` mean the same thing whatever the transport, so
  `dataforge validate` is unchanged.
- The Kafka-specific files (`delivery-log.jsonl`, `processing-log.jsonl`, `kafka-run.json`,
  `consumer-report.json`) hold wall-clock times and are not reproducible byte for byte; the shared
  files are.
- Delivery is sequential, about 1 ms per record on a local broker (19,050 records in about 20 s).
  Batching would be faster but needs per-message offsets reconstructed from batch results; it is
  left for Milestone 10 if profiling asks for it.
- Root-cause hints still come from the plan. With several partitions, a finding caused by
  cross-partition interleaving can be reported as not explained by delivery.

# DataForge Roadmap

DataForge is built one milestone at a time. Each milestone ends with automated tests, a manual
verification guide, and an explicit approval before the next one starts. This file is updated
whenever implementation changes the plan. The workflow is driven by the `/dataforge` command
(`.claude/skills/dataforge/`): `/dataforge status`, `/dataforge start milestone <n>`,
`/dataforge verify milestone <n>`, `/dataforge fix <report>`, `/dataforge approve milestone <n>`.

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Deterministic simulation core + CLI | **Approved 2026-11-22** |
| 2 | Chaos delivery planner | **Approved 2026-11-22** |
| 3 | Validation engine + reference targets (offline end-to-end) | **Approved 2026-11-22** |
| 4 | Kafka delivery + out-of-process target | **Approved 2026-11-22** |
| 5 | Event-time windows and late data | **Approved 2026-11-22** |
| 6 | Persistence (PostgreSQL + Prisma) + API foundation (NestJS) | Planned |
| 7 | Test executions through the API | Planned |
| 8 | Web UI: run history and report explorer | Planned |
| 9 | Web UI: configure and launch + Playwright end-to-end | Planned |
| 10 | Hardening and scale | Planned |

## Why this order

1. **Determinism first.** Every later feature (fault injection, validation, run history) is only
   trustworthy if the same inputs always produce the same canonical world. Milestone 1 proves that
   in isolation, where it is cheap to test.
2. **Prove the product value offline, before infrastructure.** Milestones 2 and 3 deliver the full
   loop (simulate, inject faults, run a target, detect the bug) entirely in-process, so the core
   idea is validated in seconds, without Docker.
3. **Then make it real.** Milestone 4 replaces the in-process transport with Kafka and an external
   consumer. Because the delivery plan is already deterministic, the Kafka run must produce the same
   findings as the offline run, which gives a strong equivalence test.
4. **Then make it a platform.** Persistence, API and UI come after the engine works, as the spec
   requires, so they wrap proven behaviour instead of shaping it.

---

## Milestone 1: Deterministic simulation core + CLI

**Objective.** Generate a reproducible e-commerce world (canonical event log + expected state) from a
scenario file and a seed, and let a user verify every claim the output makes.

**Included.**

- pnpm workspace, strict TypeScript, Jest, ESLint with a determinism guard for `packages/core`, CI.
- `@dataforge/core`: seeded random streams (SHA-256 derived, xoshiro128**), simulation clock,
  scenario schema (Zod), deterministic IDs, catalog/customer/order generation, the canonical event
  schema, canonical ordering, the order state machine, 16 business rules + 5 log-integrity checks,
  projection to expected state, JSONL serialization.
- `@dataforge/cli`: `generate`, `verify` (checksums, schema, rules, state, reproducibility),
  `timeline`.
- Docs: README, architecture, data formats, ADRs 0001-0006.

**Decisions.** ADR-0001 (workspace and boundaries), ADR-0002 (randomness), ADR-0003 (time and
ordering), ADR-0004 (event model, including the `ProductCreated` addition), ADR-0005 (toolchain),
ADR-0006 (generation strategy).

**Automated tests.** PRNG reference vectors; stream derivation and isolation; distribution checks;
scenario validation; byte-level determinism; randomness isolation by entity and purpose; 20-seed
invariant sweep; each business rule and log check rejecting a crafted bad log; JSONL round trip;
golden hashes; CLI behaviour, including tampering detection and exit codes.

**Acceptance criteria.**

- Same scenario + seed + engine version produces byte-identical `events.jsonl`, `expected-state.json`,
  `scenario.resolved.json` and `manifest.json`.
- Replaying `events.jsonl` reproduces `expected-state.json` byte for byte.
- Every generated log satisfies every business rule (checked on every generation).
- Adding an order does not change any existing order; changing one concern (e.g. quantities) does not
  change unrelated decisions (e.g. timing, payment outcomes).
- Invalid scenarios and seeds are rejected with the path of each problem.
- `verify` detects edited events, an edited expected state, and an edited scenario.

**Manual verification.** `docs/manual-verification/milestone-1.md` (MV-1.1 to MV-1.12:
generation, determinism by checksum, different seeds, replay verification, tampering, invalid input,
entity isolation, order timelines, reproduction from the resolved scenario, the specification's
example size, the determinism lint guard). Self-check: `scripts/verification/milestone-1.ps1`,
14 of 14 cases passing in PowerShell 7.6 and Windows PowerShell 5.1 on 2026-11-22.

**Product-owner decisions.** `ProductCreated` stays as an eighth event type, so the catalog lives in
the canonical log (ADR-0004; decided 2026-11-22).

**Approved** 2026-11-22.

---

## Milestone 2: Chaos delivery planner

**Objective.** Turn a canonical log, a chaos profile and a chaos seed into a deterministic,
explainable delivery plan: which delivery attempts happen, when, in what order, with which faults,
and with what planned outcome. The canonical log is never changed.

**Included.**

- `@dataforge/chaos` (new package, deterministic and I/O-free like the core, same ESLint guard):
  - chaos profile schema (Zod) with four fault types, each disabled by default (`rate: 0`):
    - `delay`: rate, `delayMs` range; adds the drawn delay to the original attempt.
    - `reorder`: rate, `distance` range k; the original attempt is delivered just after the k-th
      later event of the same aggregate (k clamped to the events that exist). Guarantees a
      per-aggregate inversion.
    - `duplicate`: rate, `copies` range, `redeliveryOffsetMs` range; extra copies of the first
      successful attempt, same `eventId`, new `attemptId`.
    - `transientFailure`: rate, `failures` range, `maxRetries`, `retryBackoffMs` range,
      `allowLoss`. The first `failures` attempts fail and each is retried after a backoff; when
      `failures > maxRetries` the event is lost, which is only possible with `allowLoss: true`.
  - delivery attempt model: `attemptId`, `deliverySequence`, `attemptNumber`, `kind`
    (`original`, `retry`, `duplicate`), `scheduledDeliveryTimeMs`, `plannedOutcome` (`delivered`,
    `failed`), `derivedFrom` (the attempt a retry or duplicate follows, with its offset), `faults`
    (structured records), plus the event's identity and position.
  - planner (`planDelivery`), summary (configured versus observed rates, losses, per-aggregate
    inversions), `delivery-plan.jsonl` serialization and parsing, and `explainEvent`.
- CLI: `dataforge chaos plan --run <dir> --profile <file> --chaos-seed <seed> --out <dir>` writes
  `delivery-plan.jsonl`, `chaos-profile.resolved.json` and `delivery-summary.json` (with checksums
  and the SHA-256 of the canonical log the plan belongs to). `dataforge explain --run <dir> --plan
  <dir> --event <eventId>` prints the event, every attempt, the faults behind it and its order within
  its aggregate.
- Example profiles in `chaos-profiles/`: `none`, `spec-example` (5% delay, 3% duplicate, 2%
  reorder), `flaky-network` (all four faults, no loss), `lossy` (loss allowed).

**Architectural decisions** (ADR-0007).

| Question | Options | Choice |
| --- | --- | --- |
| Chaos seed | derived from the simulation seed; independent | **Independent.** One world, many fault patterns; the plan records both seeds. |
| Fault selection | one stream for the whole plan; one stream per (chaos seed, fault type, eventId) | **Per (seed, fault type, eventId)**, with the selection drawn first. Enabling one fault type does not reshuffle another, and raising a rate only adds faulted events. |
| Reorder versus delay | reorder as a random swap with a neighbour in delivery order; reorder anchored after a later event of the same aggregate | **Anchored.** A delay may or may not cause an inversion; a reorder always does, and both are reported separately. |
| Loss | allowed by default; opt-in | **Opt-in** (`allowLoss`). Without it, a profile that could exhaust retries is rejected. |
| Delivery order | by time only; by time with a total tie-break | **(scheduledDeliveryTimeMs, eventSequence, attemptNumber)**, so a zero-fault plan is exactly canonical order. |
| Where the plan lives | inside the run directory; its own directory bound to the run by hash | **Own directory**, bound by the canonical log's SHA-256, so the canonical run stays untouched and one run can have many plans. |

**Dependencies.** `@dataforge/core`: `CanonicalEvent`, `RandomStream`, `normalizeSeed`,
`canonicalJson`, `serializeEventLog`, `sha256Hex`. CLI: the run directory and its manifest.

**Code and documentation changes.** New `packages/chaos`; CLI commands `chaos plan` and `explain`;
ESLint guard extended to `packages/chaos/src`; Jest mapping; `chaos-profiles/`; ADR-0007;
`data-formats.md` (profile, plan, summary); `ARCHITECTURE.md`; README; manual verification guide and
self-check.

**Automated tests.** Profile validation (defaults, unknown fields, paths, loss rule); byte-level
determinism; canonical log unchanged (hash before and after, frozen events); a different chaos seed
changes the plan; observed rates within tolerance on the specification-sized scenario; fault-type
isolation and monotonic rates; duplicates keep the `eventId` and get distinct `attemptId`s; every
reorder fault produces a per-aggregate inversion; zero-fault plan equals canonical order; retries,
backoff and loss; every attempt's time is explained by its recorded faults; plan JSONL round trip;
golden plan hash; CLI behaviour, exit codes, tampering and mismatched-run detection.

**Acceptance criteria.**

- Same log, profile and chaos seed produce byte-identical `delivery-plan.jsonl`,
  `chaos-profile.resolved.json` and `delivery-summary.json`.
- A different chaos seed changes the plan, never `events.jsonl`; the run still passes
  `dataforge verify`.
- A zero-fault profile yields exactly one delivered original attempt per event, in canonical order,
  at event time.
- Duplicates keep the `eventId` and get distinct `attemptId`s; each reorder fault produces a
  per-aggregate inversion; events are lost only when the profile allows loss.
- Observed fault rates on the specification-sized scenario are within 0.5 percentage points of
  the configured rates.
- Enabling one fault type does not change which events another fault type selects.
- `explain` accounts for every attempt of an event: time, kind, faults, outcome, aggregate order.
- Invalid profiles and chaos seeds are rejected with the path of each problem; a plan whose files
  were edited, or that belongs to a different run, is refused.

**Manual verification.** `docs/manual-verification/milestone-2.md` (MV-2.1 to MV-2.13: the spec's
example plan, determinism by checksum, a different chaos seed over the same world, the zero-fault
baseline, duplicates, reorders, retries and loss, fault-type isolation, rates at the spec's example
size, invalid input, edited and mismatched runs and plans, the determinism guard). Self-check:
`scripts/verification/milestone-2.ps1`, 13 of 13 cases passing in PowerShell 7.6 and 12 of 12 in
Windows PowerShell 5.1 (`-SkipInstall`) on 2026-11-22.

**Implementation notes.** A reorder waits for the next event of its aggregate, so it can hold an
event back for hours of simulation time (ADR-0007). The Milestone 1 commit had accidentally tracked
`outmvrun-a/`, a copy of the seed-42 run (`out\mv\run-a` with its backslashes lost); it is
removed.

**Product-owner decisions** (2026-11-22, the recommendations accepted):

- D-2.1: loss stays opt-in. `allowLoss` is false by default, and a profile that could lose events
  without it is rejected (ADR-0007, decision 6).
- D-2.2: a reorder stays unbounded. It waits for the next event of its aggregate however long that
  takes; a maximum wait may be added later as an optional setting that leaves existing plans
  unchanged (ADR-0007, decision 5).

**Approved** 2026-11-22.

---

## Milestone 3: Validation engine + reference targets (offline end-to-end)

**Objective.** The first complete demonstration of the product, in-process: simulate a world, plan
faulty delivery, let a target pipeline consume it, compare the target's final state with the
expected state, and explain every difference by the delivery faults that caused it.

**Included.**

- **Actual-state contract** in `@dataforge/core` (`dataforge.actual-state`, format version 1): the
  five entity collections of the expected state with the same record shapes, in any order,
  Zod-validated with the path of each problem, unknown fields rejected. It is what a target hands
  back, whatever its technology.
- **State invariants** in `@dataforge/core` (`ECOMMERCE_INVARIANTS`), beside the event rules and
  built on the same definitions (the order state machine, the order-total formula): referential
  integrity (order to customer and products, payment and shipment to order, order to its shipment)
  and consistency (paid amount within the total, status consistent with payments and shipment,
  counters consistent with records). Every expected state satisfies them.
- **`@dataforge/validation`** (new, deterministic, I/O-free): compares an actual state with the
  expected state by entity ID and checks the invariants on the actual state. Finding categories:
  `missing-entity`, `unexpected-entity`, `duplicate-record`, `status-mismatch`, `field-mismatch`,
  `double-processing` (a counter or amount above the expected value, or more paid than the order
  total), `referential-integrity`, `invariant-violation`. Each finding carries root-cause hints:
  the abnormal deliveries (delay, reorder, duplicate, transient failure, loss, out of order) of
  the events of the aggregates behind the entity, or an explicit "no delivery fault explains this".
  JSON report (`validation-report.json`) with a PASS/FAIL verdict and counts per category.
- **`@dataforge/targets`** (new, deterministic, I/O-free): the target interface, the delivery
  message (key = `aggregateId`, the canonical event, attempt headers; the shape Kafka will carry in
  Milestone 4), an in-memory transport that hands every *delivered* attempt to the target in
  delivery order (failed attempts never reach it), and two reference targets:
  - `correct`: idempotent by `eventId`, applies each aggregate's events in version order (parks an
    early event until its predecessor arrives) and parks an order until its customer and products
    exist; it uses the core projection, so any difference it shows comes from delivery.
  - `naive`: applies every message as it arrives: creates overwrite (upsert), status is the last
    arrival's, counters and amounts are incremented on every copy, and an update of a row that does
    not exist yet is silently lost.
- **CLI.** `dataforge deliver --run <dir> --plan <dir> --target correct|naive --out <dir>` writes
  `actual-state.json` and `target-run.json` (target, the plan and run it consumed, message counts,
  events still parked, checksum). `dataforge validate --run <dir> --actual <file> [--plan <dir>]
  [--report <file>]` prints a console summary (verdict, counts per category, findings with their
  hints) and optionally writes the JSON report. Exit 0 pass, 1 findings, 2 invalid input.
- Example profiles `chaos-profiles/duplicates-only.json` and `reorders-only.json`, so one fault
  type can be tested in isolation.

**Architectural decisions** (ADR-0008).

| Question | Options | Choice |
| --- | --- | --- |
| Where the actual-state contract lives | validation; targets; core | **Core**, next to the expected state it mirrors. Targets produce it and validation reads it without depending on each other. |
| How invariants reuse the core rules | replay synthetic events through the event rules; separate state invariants | **State invariants in core** sharing the rule definitions (state machine, total formula). Event rules check one event against the state before it; a final state needs whole-state checks, and synthesizing events would only fit half the rules. |
| Finding granularity | one per differing field; one per entity and category | **One per (entity, category)**, listing every differing field, so one doubled payment is one `double-processing` finding per entity, not five lines. |
| Over-counted versus under-counted | both `field-mismatch`; over-counting is `double-processing` | **Over-counting is `double-processing`** (the duplicate signature); under-counting stays `field-mismatch` (a lost update). |
| Targets and validation | one package; two packages | **Two.** The validator must judge any target, including the user's, and never know target internals; the Milestone 4 consumer process reuses the targets alone. |
| Correct target's projection | its own; the core projection | **Core projection.** The reference target is the control group: it isolates the delivery-handling logic (dedupe, version order, dependencies). |
| Lost events | correct target expected to pass anyway; findings explained by loss | **Explained by loss.** No consumer can rebuild an event it never received; with a lossy profile every finding of the correct target must point at a lost event. |
| Binding an actual state to its plan | none; `target-run.json` next to the actual state | **`target-run.json`.** `validate --plan` refuses a plan other than the one the target consumed, so hints never come from the wrong plan. |

**Dependencies.** `@dataforge/core`: world-state records, `applyEvent`, the state machine,
`canonicalJson`. `@dataforge/chaos`: `DeliveryAttempt`, `parseDeliveryPlan`,
`firstDeliveriesByAggregate`. CLI: run and plan directories (`readIntactCanonicalLog`,
`readPlanForRun`).

**Code and documentation changes.** Core: `actual-state` contract and `ECOMMERCE_INVARIANTS`;
new `packages/validation` and `packages/targets`; CLI commands `deliver` and `validate`; ESLint
determinism guard and Jest mapping extended to both packages; two example profiles; ADR-0008;
`data-formats.md` (actual state, target run, validation report); `ARCHITECTURE.md`; README;
manual verification guide and self-check.

**Automated tests.** Actual-state schema (paths, unknown fields, round trip); every invariant holds
on the expected state of 20 seeds and rejects a crafted bad state; validating the expected state
as actual gives no finding; hand-mutated states (dropped order, doubled payment, wrong status,
dangling reference, extra entity, duplicate record, changed field) are each detected with the right
category; hints name the faulted event, and an unfaulted difference is reported as unexplained;
the report is deterministic; both targets reproduce the expected state with zero faults; `naive` +
duplicates gives a double charge; `naive` + reorders gives a wrong status; `correct` passes every
example profile without loss and extreme profiles (rate 1 per fault type) over several chaos seeds;
`correct` + `lossy` fails with every finding linked to a lost event; correct-target idempotency and
parking; golden actual-state hashes; CLI behaviour, exit codes, tampered and mismatched inputs.

**Acceptance criteria.**

- With zero faults, both targets produce exactly the expected state and `validate` passes.
- `correct` passes under every example profile that does not allow loss, on the small and the
  specification-sized scenario.
- `naive` under duplicates produces `double-processing` findings (a customer charged twice), and
  under reorders produces `status-mismatch` findings; each finding names the faulted event.
- Hand-mutated actual states are detected with the right category: dropped order
  (`missing-entity`), doubled payment (`double-processing`), wrong status (`status-mismatch`),
  dangling reference (`referential-integrity`).
- Under a lossy profile, every finding of the `correct` target is linked to a lost event; a
  difference no fault touched is reported as unexplained.
- Same run, plan and target produce byte-identical `actual-state.json` and
  `validation-report.json`.
- An invalid actual state is rejected with the path of each problem (exit 2); an actual state
  validated against a plan it was not produced from is refused.

**Manual verification.** `docs/manual-verification/milestone-3.md` (MV-3.1 to MV-3.13: install
and checks, the zero-fault baseline, the spec's example, double charges under duplicates, wrong
status under reorders, the correct target under every lossless profile, loss explained, determinism
by checksum, hand-mutated actual states, bad input, mismatched and edited inputs, the spec's example
size, the determinism guard). Self-check: `scripts/verification/milestone-3.ps1`, 13 of 13 cases
passing in PowerShell 7.6 and 12 of 12 in Windows PowerShell 5.1 (`-SkipInstall`) on 2026-11-22.

**Implementation notes.**

- Hint ranking needed field awareness: a redelivered create (`CustomerRegistered`, `OrderCreated`)
  resets counters in a naive target, so for an over-count only the incrementing events
  (`OrderCreated` for `orderCount`, `PaymentCompleted` for amounts) rank first.
- The dependency model behind hints (ADR-0008, decision 4) is specific to the e-commerce domain; a new
  event type that touches another aggregate's record must be added to it.
- `orderLinesTotalMinor` is now shared by the event rule `order.total-matches-lines` and the state
  invariant of the same name. Generation output is unchanged (golden hashes and `ENGINE_VERSION`
  unchanged).
- `samePath` moved from the `chaos plan` command to `run-directory.ts`, so `deliver` and
  `validate` can share it.

**Product-owner decisions** (2026-11-22, the recommendations accepted):

- D-3.1: under a profile that allows loss, `validate` keeps the verdict `FAIL` for the correct
  target; the requirement is that every one of its findings is linked to a lost event. A separate
  verdict (for example `PASS (explained by loss)`) may be added later without changing the report
  format (ADR-0008, decision 7).
- D-3.2: unknown fields in an actual state stay rejected with their path. An explicit opt-in (for
  example `--ignore-extra-fields`) may be added from Milestone 4 if a real pipeline needs it
  (ADR-0008, decision 1).

**Approved** 2026-11-22.

---

## Milestone 4: Kafka delivery + out-of-process target

**Objective.** Run the same test through a real Kafka broker and a separately running consumer
process, and prove that it is the same test: for the same run, plan and target, the consumer ends in
the same state, with the same findings, as the offline delivery of Milestone 3.

**Included.**

- **Local infrastructure.** `compose.yaml` with one Kafka broker in KRaft mode (pinned image
  `apache/kafka:4.3.2`, no ZooKeeper, a health check, no volume, so `docker compose down` resets it).
  Configuration through environment variables (`KAFKA_BROKERS`, `KAFKA_HOST_PORT`), documented in
  `.env.example`; the CLI reads an optional `.env`.
- **`@dataforge/kafka`** (new; the event delivery layer of spec section 6, and the only package that
  imports a Kafka client):
  - the **Kafka record contract**: key = `aggregateId`; value = canonical JSON
    `{format, formatVersion, event, eventTime}` (the canonical event plus its ISO-8601 event time);
    headers = the attempt metadata (`attemptId`, `attemptNumber`, `deliverySequence`,
    `scheduledDeliveryTimeMs`, `scheduledDeliveryTime`). Encoding and Zod-validated decoding are pure
    functions; a consumer turns a record back into exactly the `DeliveryMessage` of Milestone 3.
  - the **plan executor**: plays a delivery plan in delivery order, in wall-clock time compressed by
    `--speed <factor>` (simulation ms per wall ms) or as fast as possible (`--speed max`). A delivered
    attempt is produced to Kafka and acknowledged by the broker before the next one; a planned failure
    is not sent and is recorded as such. Clock and sender are injected, so pacing is unit-tested
    without a broker.
  - the **delivery log** of real outcomes: per attempt, sent or planned failure, partition, offset,
    planned and actual send time (wall clock), drift.
  - **completion detection**: the consumer group's lag (log end offsets minus committed offsets,
    summed over partitions) reaching zero after the last send, with a timeout.
  - the **consumer runner**: joins a consumer group, decodes each record, hands it to a `Target`,
    records a processing log (partition, offset, Kafka timestamp, processing time), and commits after
    every batch, so a committed offset always means "handled".
- **`@dataforge/consumer`** (new app): the reference consumer as a standalone process
  (`dataforge-consumer --brokers --topic --group --target correct|naive --out`). It knows nothing of
  runs or plans: it reads Kafka records and writes `actual-state.json`, `consumer-report.json` and
  `processing-log.jsonl`. It finishes when its parent asks (IPC) or on Ctrl+C.
- **CLI.** `dataforge deliver --transport kafka` (default `memory`, the Milestone 3 behaviour), with
  `--brokers`, `--speed`, `--partitions`, `--timeout`. It creates a fresh topic and consumer group per
  execution, starts the consumer process, waits until the consumer has joined, executes the plan,
  waits for zero lag, asks the consumer to finish, and writes the same `actual-state.json` and
  `target-run.json` as the in-memory transport, plus `delivery-log.jsonl`, `kafka-run.json` and the
  two processes' logs. Kafka or consumer unavailable: exit code 3 with what to start.
- `pnpm test:integration`: a separate Jest project against the real broker, which fails with a clear
  message (and the command to start Kafka) when Kafka is unreachable. CI gains a job that starts the
  Compose broker and runs it.

**Architectural decisions** (ADR-0009).

| Question | Options | Choice |
| --- | --- | --- |
| Kafka client | KafkaJS 2.2.4 (spec); `@confluentinc/kafka-javascript` 1.11; `@platformatic/kafka` 2.17 | **KafkaJS**, behind `@dataforge/kafka`. Spike on 2026-11-22 against `apache/kafka:4.3.2`, 5,000 keyed messages each: all three kept per-key order and headers and reached zero lag. KafkaJS: pure JavaScript, about 6 s, only a Node 24 timer warning and self-retried coordinator errors. Confluent: native binding (75 MB, install script to allow), 78 s with one awaited send at a time, part of the KafkaJS API unimplemented. Platformatic: fast, but documents Kafka up to 4.2 only. KafkaJS is unmaintained since 2023, so all client code stays in one package; Confluent's KafkaJS-compatible API is the fallback. |
| Where Kafka code lives | in `apps/cli`; in `apps/api` (planned NestJS app); its own package | **Its own package**, `@dataforge/kafka`. Both the CLI now and the API in Milestone 7 drive deliveries, and a client swap touches one package. The four pure packages keep rejecting `kafkajs` imports. |
| Command | a new `dataforge run`; `deliver --transport kafka` | **`deliver --transport kafka`.** Same inputs and the same output files as the in-memory transport, so equivalence is a file comparison; `run --run <dir>` would also clash with the simulation run directory. |
| Partitions | many by default; one by default | **One by default** (`--partitions` to change). Kafka orders only within a partition. With one, the consumer sees exactly the planned delivery order, so the Kafka run equals the offline run byte for byte. With several, per-key order still holds and the correct target must still pass, but events of different aggregates interleave by fetch timing, which the plan does not describe. |
| Planned failures | send and drop; do not send | **Not sent**, logged as `planned-failure`. A failed attempt is one that never reaches the target; pretending a broker error would be a fake. |
| Pacing | fixed rate; plan time compressed by a factor | **Compressed plan time** relative to the first attempt, `--speed max` by default (order is what Milestone 4 needs; pacing matters for windows in Milestone 5). Drift is recorded, not hidden. |
| Completion | end-of-stream marker; consumer counts messages; consumer-group lag | **Lag reaches zero.** It works for any consumer group without its cooperation, which is what a user's own pipeline needs later. Then the parent asks the consumer to finish. |
| Offsets | auto-commit on an interval; commit after every batch | **After every batch**, after the target has handled it, so zero lag means every message was handled. A redelivery by Kafka itself (at-least-once after a rebalance) is counted and reported. |
| Topics | one shared topic; a topic per execution | **A topic and a group per execution** (`dataforge.<execution id>`), so every execution starts empty. Topics are kept for inspection; `docker compose down` removes them. |

**Dependencies.** `@dataforge/core` (`CanonicalEvent`, `canonicalEventSchema`, `canonicalJson`,
`parseUtcInstant`, `simTimeToIso`). `@dataforge/chaos` (`DeliveryAttempt`). `@dataforge/targets`
(`Target`, `DeliveryMessage`, `createReferenceTarget`). CLI: run and plan directories,
`target-run.json` (shared with the in-memory path). New dependency: `kafkajs` 2.2.4 (the Kafka
client). Docker Desktop for the broker.

**Code and documentation changes.** New `packages/kafka` and `apps/consumer`; `deliver --transport`
with a shared target-run builder; asynchronous command support in the CLI dispatcher; exit code 3;
`compose.yaml`, `.env.example`, `jest.integration.config.js`, `test:integration`; ESLint determinism
guard on the pure parts of `@dataforge/kafka` (record contract, executor); CI integration job;
ADR-0009; `data-formats.md` (Kafka record, delivery log, processing log, consumer report, Kafka run);
`ARCHITECTURE.md`; README; manual verification guide and self-check.

**Automated tests.**

- Unit (`pnpm test`, no broker): record encode/decode round trip, header and value validation with
  paths, key must equal `aggregateId`; executor pacing with a fake clock (due times at a speed,
  `max`, drift), planned failures never sent, order preserved, sender errors surfaced; lag
  arithmetic; `deliver` option validation (transport, speed, partitions, Kafka options without
  `--transport kafka`).
- Integration (`pnpm test:integration`, real broker): records round-trip through Kafka with key and
  headers; duplicates arrive with the same `eventId` and distinct `attemptId` headers; per-key
  order equals the plan's per-aggregate order with three partitions, so unfaulted events arrive in
  version order; zero lag only after every message was handled; **equivalence**: for two seeds and
  the profiles `none`, `spec-example`, `flaky-network` and `lossy`, the Kafka delivery (separate
  consumer process) writes `actual-state.json` and `target-run.json` byte-identical to the in-memory
  delivery, for both targets, so `validate` gives the same findings; the correct target passes with
  three partitions; an unreachable broker gives exit code 3.

**Acceptance criteria.**

- `docker compose up -d --wait` starts a healthy single-node KRaft broker from a pinned image.
- `deliver --transport kafka` sends every delivered attempt as one Kafka record (key `aggregateId`,
  event and ISO event time in the value, attempt metadata in the headers) and never sends a planned
  failure; the delivery log records partition, offset and send times for every attempt.
- The consumer runs as its own process, knows only Kafka and its target, and writes an actual state
  in the Milestone 3 format.
- Completion is detected by zero consumer-group lag; the command fails with exit code 3, not a hang,
  when Kafka is unreachable, the consumer fails, or lag does not reach zero within the timeout.
- With one partition, the Kafka delivery produces byte-identical `actual-state.json` and
  `target-run.json` to the in-memory delivery for the same run, plan and target, so `validate` gives
  the same verdict and findings.
- Duplicates reach the consumer with the same `eventId` and distinct `attemptId` headers; per-key
  order is preserved with several partitions, and the correct target still passes.
- With `--speed <factor>`, attempts are sent at their compressed plan times, and the drift is
  reported.
- `pnpm check` needs no broker; `pnpm test:integration` reports clearly when Kafka is unavailable.

**Manual verification.** `docs/manual-verification/milestone-4.md` (MV-4.1 to MV-4.13: install and
checks; start Kafka and run the integration suite; zero faults through Kafka; equivalence with the
offline delivery under the spec's example; the real records on Kafka (key, headers, value, a
duplicate); the delivery log and planned failures; paced delivery; three partitions; loss through
Kafka; the spec's example size through Kafka; Kafka unavailable; invalid options; the Kafka client
kept out of the pure packages). Self-check: `scripts/verification/milestone-4.ps1`, 13 of 13 cases passing in PowerShell 7.6 and 12 of 12 in
Windows PowerShell 5.1 (`-SkipInstall`) on 2026-11-22, with Docker Desktop and the Compose broker.

**Implementation notes** (changes to the plan above, with the reason).

- The command is `deliver --transport kafka`, not the planned `dataforge run` (ADR-0009, decision 8).
- The roadmap's "value = event + ISO timestamps" became the event plus its ISO event time in the
  value, and the scheduled delivery time (also as ISO) in the headers: it describes the attempt, not
  the event.
- The CLI dispatcher now accepts asynchronous commands; the in-memory path stays synchronous, and
  `target-run.json` is built by one shared function for both transports
  (`buildTargetRun`), which also keeps them byte-identical. `DeliveryMessage` construction moved to
  `deliveryMessageFor` in `@dataforge/targets`, shared by the in-memory transport and the executor.
- The consumer's fetch wait is 200 ms instead of KafkaJS's 5 s, because leaving the group waited for
  the long poll (5.8 s per delivery before, about 0.1 s after).
- The very first delivery on a fresh broker takes about 5 s longer: the broker creates its internal
  offsets topic for the first consumer group. Later deliveries join in about 0.3 s.
- `.env` is loaded by the CLI entry point when it exists (Node's `--env-file-if-exists` printed a
  notice on every command when it did not).
- The ESLint determinism guard covers all of `@dataforge/kafka` except `client.ts` and
  `consumer-runner.ts`, so a new file there is guarded by default.

**Product-owner decisions** (2026-11-22, the recommendations accepted):

- D-4.1: one partition stays the default, so a Kafka delivery equals the plan and the offline run
  byte for byte; `--partitions <n>` remains for realism (ADR-0009, decision 4).
- D-4.2: delivery topics are kept for inspection; `docker compose down` removes them (ADR-0009,
  decision 7).
- D-4.3: testing a consumer DataForge did not start (produce to Kafka, wait for zero lag on the
  user's consumer group, read the actual state the user's pipeline writes) is planned into
  Milestone 7.

**Approved** 2026-11-22.

---

## Milestone 5: Event-time windows and late data

**Objective.** Detect bugs caused by events that arrive after a processing window has closed: a
target that also computes revenue and order counts per event-time window is checked against the
true per-window values, and every wrong window is explained by the late, delayed or duplicated
deliveries behind it.

**Included.**

- **Windowing contract** in `@dataforge/core` (`windows/`): tumbling event-time windows aligned to
  the scenario epoch, `{ sizeMs, allowedLatenessMs }`; window math (`windowStartOf`, window end,
  close = end + allowed lateness); the three window metrics, defined once (`windowContribution`):
  `ordersCreated` (OrderCreated events), `paymentsCompleted` (PaymentCompleted events) and
  `revenueMinor` (their amounts); **expected windows** computed from the canonical log (the truth:
  every event, whatever its delivery); the **actual-windows contract** (`dataforge.actual-windows`,
  format version 1, `actual-windows.json`), Zod-validated with paths, beside the actual state, which
  stays unchanged.
- **Chaos profile** (optional sections, so every existing profile resolves exactly as before):
  - `windowing: { sizeMs, allowedLatenessMs }`: the windowing contract the target is tested against;
  - `faults.late: { rate, lateByMs }` (requires `windowing`): the event's original attempt arrives
    after its window has closed, at least `lateByMs` past the close in *stream time* (the largest
    event time the target has received). Anchored like reorder: 1 ms after the first delivery of an
    event whose event time is at least close + `lateByMs`, so a late fault always produces an arrival
    after close. Composition order: delay, late, reorder, transient failure, duplicate.
  - the summary of a windowed plan adds the `late` tally and the **arrivals** of every event by
    stream time: on time, within the allowed lateness, after close, lost. `classifyArrivals` is the
    one definition, shared by the summary, `explain` and the validator.
- **Reference targets** compute windows when the plan has a windowing contract:
  - `correct`: event-time windows, idempotent by `eventId`, a window closes when stream time reaches
    its close, and an event arriving after that is dropped and counted (`windowEventsDropped`), the
    behaviour of a correctly configured Kafka Streams or Flink job with that grace period;
  - `naive`: processing-time windows (each message counted in the window of the moment it arrives,
    the delivery clock), every copy counted.
- **Validation of windows** (`@dataforge/validation`), in its own section of the result: compare by
  window start, a window absent on one side counts as zeros; categories `window-undercount`,
  `window-overcount`, `duplicate-window`, `misaligned-window`, one finding per (window, category)
  listing the differing metrics; causes per finding: the counted events of the window (lost, after
  close, within lateness, arrived in another processing window) and, for over-counts, duplicates and
  events of other windows that arrived during it. Verdict FAIL when any entity or window finding exists.
- **CLI**: `chaos plan` prints the windowing, the late tally and the arrivals; `explain` shows the
  event's window, close and arrival; `deliver` (both transports) writes `actual-windows.json` for a
  windowed plan, recorded in `target-run.json`; `validate` reads `actual-windows.json` next to the
  actual state (or `--windows <file>`), takes the contract from the plan, prints a windows section and
  adds `windows` to the report. The consumer process takes `--window-size-ms` and
  `--allowed-lateness-ms`.
- Example profiles `chaos-profiles/windowed-none.json` (hourly windows, 10 minutes of allowed
  lateness, no faults), `windowed-delays.json` (the same windows, 30% of events delayed by up to
  9 minutes, 5% duplicated) and `late-data.json` (the same windows, 5% late events, 10% delayed).

**Architectural decisions** (ADR-0010).

| Question | Options | Choice |
| --- | --- | --- |
| Where the windowing contract lives | the scenario; a separate file passed to three commands; the chaos profile | **Chaos profile**, optional. It describes the pipeline under test, not the business world, the late fault is measured against it, and `deliver` and `validate` read it from the plan they are already bound to by hash. One world can be tested against several window settings without regenerating it. |
| When a window closes | delivery clock (a DataForge header); watermark with an out-of-orderness bound; stream time = largest event time received | **Stream time**, closed when it reaches end + allowed lateness (Kafka Streams grace semantics). A real event-time pipeline can follow it without any DataForge header, and the plan order fixes it exactly. |
| Late fault | a fixed delay past close on the delivery clock; anchored behind an event past the close | **Anchored**: guaranteed after close in stream time, like reorder guarantees an inversion. All anchors point to larger event times, so planning in descending canonical order makes them final; existing plans are unchanged. |
| Expected windows | the truth (every event); the "contract" value (minus events that arrived after close) | **The truth.** A dropped late event is a wrong window, explained by its late arrival, as a lost event is (D-3.1). The verdict never depends on `--plan`. Open decision D-5.1. |
| Naive windowing | processing-time buckets; event-time windows that close at window end with no lateness | **Processing-time buckets**, the classic bug: a late or delayed event lands in the wrong window, so one window is short and another long. Closing too early is caught by the validator too (tested with a crafted output). The roadmap's "drops late events" moves to the correct target's documented behaviour after close. |
| Processing time of the reference targets | wall clock; Kafka record timestamp; delivery clock (`scheduledDeliveryTimeMs` header) | **Delivery clock**: deterministic, and the same in process and through Kafka at any `--speed`. |
| Output and report shape | extend actual state and categories; separate file and section | **Separate** `actual-windows.json` and a `windows` section, present only for windowed plans. Inputs without windowing give byte-identical outputs (existing golden hashes and self-checks unchanged). |

**Dependencies.** `@dataforge/core` (canonical events, `canonicalJson`, `compareCodeUnits`,
`simTimeToIso`). `@dataforge/chaos` (profile, planner, summary, explain). `@dataforge/targets`
(reference targets, `TargetResult`). `@dataforge/validation`. `@dataforge/kafka` (consumer report)
and `apps/consumer` (options, outputs). CLI: plan directory (`LoadedPlan.profile`), `target-run.json`.
No new third-party dependency.

**Code and documentation changes.** Core `windows/` module; chaos profile, fault record, planner,
summary, arrivals, explain; both reference targets and `createReferenceTarget` options; validation
`windows` section; CLI `chaos plan`, `explain`, `deliver`, `deliver --transport kafka`, `validate`;
consumer options and outputs, consumer report; two example profiles; ADR-0010; `data-formats.md`
(windowing, late fault record, summary additions, actual windows, report `windows`);
`ARCHITECTURE.md`; README; manual verification guide and self-check.

**Automated tests.**

- Unit: windowing schema and window math (alignment, end, close, lateness 0); expected windows sum
  to the expected state's orders and revenue; actual-windows schema (paths, unknown fields, round
  trip); profile rules (late requires windowing, existing profiles resolve unchanged); planner golden
  hashes unchanged; every late fault arrives after close in stream time, by at least `lateByMs` when
  an anchor exists, and every attempt's time is recomputed from its fault records; late fault-type
  isolation and monotonic rate; arrivals classification; correct target drops exactly the events the
  plan classifies as after close, and with no fault, delays within the lateness or duplicates both
  targets' windows match the truth (correct) or show the expected errors (naive); naive counts every
  copy in its arrival window; window validation categories and causes on crafted outputs (dropped
  within lateness, misplaced, doubled, misaligned, listed twice, unexplained edit); deterministic
  report; golden hashes for the windowed plan, actual windows and report; CLI behaviour, exit codes,
  missing or extra windows files, a windowed plan without windows.
- Integration (Kafka): the equivalence test also covers `late-data` and `windowed-delays`, for both
  targets: `actual-windows.json` byte-identical to the in-memory delivery.

**Acceptance criteria.**

- Profiles, plans, actual states, target runs and reports without windowing are byte-identical to
  Milestone 4 (golden hashes unchanged).
- With a windowing contract, expected windows are the true per-window `ordersCreated`,
  `paymentsCompleted` and `revenueMinor`, summing to the expected state's orders and revenue.
- Every late fault delivers its event after the event's window has closed (stream time at least
  close + `lateByMs`, or the latest delivered event time when the log ends sooner); the plan reports
  every event's arrival class.
- `correct` matches the expected windows under `none` and `windowed-delays`; under `late-data` it
  drops exactly the events that arrived after close, and every window finding names one of them.
- `naive` under `windowed-delays` shows under- and over-counted windows explained by events that
  arrived in another window and by duplicates.
- Window findings for crafted outputs have the right category, and an edit no delivery explains is
  reported as unexplained.
- Same run, plan and target give byte-identical `actual-windows.json` and report, in process and
  through Kafka (one partition).
- A windowed plan without a windows file, a windows file without a windowing contract, and an
  invalid windows file are refused with exit code 2 and the reason.

**Manual verification.** `docs/manual-verification/milestone-5.md` (MV-5.1 to MV-5.13: install and
checks; nothing changes without windows (the Milestone 4 hashes); a windowed plan with late events;
zero faults; delays within the lateness; late data; explain a late event; same bytes; a hand-edited
windows file; windows through Kafka; the spec's example size; bad input; the determinism guard).
Self-check: `scripts/verification/milestone-5.ps1`, 13 of 13 cases passing in PowerShell 7.6 and
12 of 12 in Windows PowerShell 5.1 (`-SkipInstall`) on 2026-11-22, with Docker Desktop and the
Compose broker; the guide's command blocks were run once, literally, in Windows PowerShell 5.1.

**Implementation notes** (changes to the plan above, with the reason).

- A third example profile, `windowed-none`: a windowed baseline without faults, so a hand edit is
  reported as unexplained (under `windowed-delays` nearly every window has a delayed event that
  becomes a hint).
- `validate` also takes the windowing contract from `target-run.json` when no `--plan` is given, so
  windows are checked with the same verdict with or without `--plan`; only the causes need the plan.
- A `deliver --force` with a plan without windows removes an `actual-windows.json` left by an
  earlier windowed delivery, so `validate` never checks stale windows.
- The planner now plans events from the last canonical event to the first, instead of aggregate by
  aggregate (latest version first). Both make every reorder anchor final; the new order also does it
  for late anchors. Every existing plan is unchanged (golden hashes), so `PLANNER_VERSION` stays
  0.1.0.
- The late fault applies to every event, like the other faults. The summary's `arrivals` count only
  the events windows count (OrderCreated, PaymentCompleted), which is why `late-data` has 21 late
  events but 9 arrivals after close.
- On a sparse stream (the small scenario, about 10 events an hour), a delayed event rarely arrives
  after its hour has ended *in stream time*, so `windowed-delays` shows 0 arrivals within the
  lateness there; at the specification's size it shows 179. The naive target is still wrong in both,
  because it buckets by delivery time.
- The Milestone 4 self-check's MV-4.2 expected 25 integration tests; there are now 33 (8 windowed
  equivalence cases). Its other cases, including the pinned Milestone 4 hashes, pass on this code.

**Product-owner decisions** (2026-11-22, the recommendations accepted):

- D-5.1: expected windows stay the true values. When events arrive after their window closed, the
  correct target keeps the verdict `FAIL`, every window finding linked to the late event, the same
  rule as for lost events (D-3.1). A separate verdict such as `PASS (explained by lateness)` may be
  added later without changing the report format (ADR-0010, decision 4).
- D-5.2: MV-4.2 in `scripts/verification/milestone-4.ps1` now expects 33 integration tests, so the
  Milestone 4 self-check stays runnable (12 of 12 passing in PowerShell 7.6 on 2026-11-22).

Self-check re-run before approval: 13 of 13 in PowerShell 7.6, 12 of 12 in Windows PowerShell 5.1
(`-SkipInstall`), on 2026-11-22.

**Approved** 2026-11-22.

---

## Milestone 6: Persistence + API foundation

**Objective.** Durable, queryable scenarios and simulation runs behind a NestJS API.

**Included.** PostgreSQL in Compose; Prisma schema and migrations (scenario, immutable scenario
version, simulation run, canonical event `(run_id, sequence)`, expected-state snapshot); NestJS
modules for scenarios and simulation runs; Zod validation pipe; JSONL export.

**Decisions to make.** Prisma version (the `latest` npm tag currently points to an 8.0 release
candidate; 7.10.x is the newest stable); bulk insert strategy; in-process background runs with
database-backed status.

**Automated tests.** Prisma integration tests against real PostgreSQL; API tests (supertest); events
exported from the database are byte-identical to CLI output for the same inputs.

---

## Milestone 7: Test executions through the API

Chaos profiles, test executions, delivery attempts, validation reports and findings, persisted and
queryable; an in-process execution runner with recovery of interrupted executions after restart.
An execution can also target an external consumer group (D-4.3): DataForge produces to Kafka, waits
for zero lag on the user's consumer group, and validates the actual state the user's pipeline
reports.

## Milestone 8: Web UI: run history and report explorer

React + Vite. Run list, report findings, and a per-entity drill-down that shows the canonical
timeline next to the delivery timeline (where the explanation of each failure lives). Vitest + React
Testing Library.

## Milestone 9: Web UI: configure and launch

Scenario and chaos profile editors (reusing the Zod schemas), launch and live monitoring, Playwright
end-to-end tests of the full flow.

## Milestone 10: Hardening and scale

Profiling at the scenario limits (100k orders), streaming generation and serialization if profiling
calls for it, event schema versioning and upcasting, reproducible Compose environment, documentation.

---

## Open decisions

Questions waiting for the product owner. `/dataforge approve milestone <n>` asks the ones that
belong to milestone *n* before recording the approval.

None at the moment.

## Open risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| KafkaJS has had no release since 2.2.4 (February 2023). | A future broker could break it; unfixed bugs (a Node 24 timer warning is filtered). | Spiked in Milestone 4: works with `apache/kafka:4.3.2` (ADR-0009). Only `@dataforge/kafka` imports it (lint-enforced); `@confluentinc/kafka-javascript` (KafkaJS-compatible API) is the fallback. Re-run the integration suite whenever the broker image changes. |
| TypeScript 7 is current, but ts-jest and typescript-eslint do not support it yet. | Toolchain lock-in. | Pinned to TypeScript 6.0.3 (ADR-0005). Revisit when both support 7. |
| Prisma `latest` is a release candidate. | Unstable persistence layer. | Pin a stable 7.x in Milestone 6 unless 8.0 is final by then. |
| Kafka-backed checks need Docker Desktop running. | Without it, `deliver --transport kafka` and `pnpm test:integration` cannot run (exit code 3 and a clear message, never a silent pass). | `pnpm check` needs no Docker; CI runs the integration suite against the Compose broker on every push. Milestone 6 adds PostgreSQL to the same Compose file. |
| Root-cause hints rely on a hand-written dependency model of the e-commerce domain. | New event types could leave findings under-explained (reported as "not explained by delivery"). | ADR-0008 names the rule; the end-to-end tests assert that every naive finding is explained under four profiles and on the spec-sized scenario, so a gap shows up as a failing test. |
| The in-memory transport ignores wall-clock time (only order matters). | A user's pipeline that uses wall-clock processing time cannot be tested offline. | The reference targets take processing time from the delivery clock (`scheduledDeliveryTimeMs` header), so windows are tested the same in process and through Kafka (ADR-0010). Kafka delivery can also play the plan in compressed wall-clock time (`--speed`). |
| Windows with several Kafka partitions. | Cross-partition interleaving can move the reference target's stream time ahead of the plan's, so it may close windows earlier than the plan predicts; Kafka Streams keeps stream time per partition. | One partition is the default and matches the plan exactly; the integration tests check windows with one partition only (ADR-0010). |
| Window metrics are specific to the e-commerce domain. | A new metric or event type needs code. | One definition in core (`windowContribution`, `WINDOW_METRIC_EVENT_TYPE`), used by the expected windows, both targets and the validator. |
| Kafka delivery is sequential (one acknowledged record at a time, about 1 ms each locally). | The spec-sized scenario takes about 20 s; the scenario limits would take minutes. | Exact per-record offsets and order are worth it for now; batching is a Milestone 10 profiling item (ADR-0009). |
| With several partitions, root-cause hints still come from the plan. | A naive-target finding caused by cross-partition interleaving can be reported as "not explained by delivery". | One partition is the default, which equals the plan exactly. Hints from the consumer's processing log are a possible later addition. |
| Plans are built in memory (about 19,000 attempts for the spec-sized scenario, planned in about 0.4 s). | Memory use near the scenario limits (100,000 orders, a few hundred thousand attempts). | Profile with generation in Milestone 10. |
| In-memory generation. | Memory use near the scenario limits. | Limits enforced by the schema; profile in Milestone 10 before optimizing. |

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
| 6 | Persistence (PostgreSQL + Prisma) + API foundation (NestJS) | **Approved 2026-11-23** |
| 7 | Test executions through the API | **Approved 2026-11-23** |
| 8 | Web UI: run history and report explorer | **Approved 2026-11-23** |
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

## Milestone 6: Persistence (PostgreSQL + Prisma) + API foundation (NestJS)

**Objective.** Make scenarios and simulation runs durable and queryable behind an HTTP API: register a
scenario, start a run with a seed, follow its status, browse run history and the stored canonical
events, and download a run that is byte-identical to `dataforge generate` for the same inputs and
passes `dataforge verify`. The engine is unchanged; the API wraps it.

**Included.**

- **Local infrastructure.** A `postgres` service in `compose.yaml` (pinned `postgres:18.7-alpine`,
  `pg_isready` health check, a named volume so run history survives `docker compose down`;
  `docker compose down -v` resets it), published on host port 5433 by default
  (`POSTGRES_HOST_PORT`), because a local PostgreSQL install commonly holds 5432 on Windows.
  `DATABASE_URL`, `API_HOST`, `API_PORT` in `.env.example`.
- **The run files, shared.** The four files of a run directory (`events.jsonl`,
  `expected-state.json`, `scenario.resolved.json`, `manifest.json`) and the manifest schema move from
  the CLI into `@dataforge/core` (`buildRunFiles`, pure), so the CLI and the API produce them with one
  function. CLI output is unchanged (golden hashes).
- **`@dataforge/api`** (new app, NestJS 12, Express):
  - **Prisma schema and migrations** (`apps/api/prisma/`): `scenario` (unique name),
    `scenario_version` (immutable: resolved definition, scenario hash, version number; unique
    per scenario by number and by hash), `simulation_run` (scenario version, seed, engine version,
    status `queued`/`running`/`succeeded`/`failed`, error, timestamps, event count, manifest),
    `canonical_event` (primary key `(run_id, sequence)`, unique `(run_id, event_id)`, the envelope as
    columns, the payload as JSONB, indexed by aggregate and by type), `expected_state_snapshot`
    (one per run, JSONB plus its SHA-256).
  - **Scenarios:** `POST /scenarios` (body = a scenario file, exactly as in `scenarios/`; version 1),
    `GET /scenarios`, `GET /scenarios/:id`, `POST /scenarios/:id/versions` (a new immutable version,
    or the existing one when the resolved definition is identical), `GET
    /scenarios/:id/versions/:version`.
  - **Runs:** `POST /runs` (`{ scenarioId, version?, seed }`, answers `202` with a queued run),
    `GET /runs` (history, newest first, filters `scenarioId` and `status`, `limit`/`offset`),
    `GET /runs/:id` (inputs, status, timestamps, counts, checksums, error),
    `GET /runs/:id/events` (a page of stored events, filters `type`, `aggregateId`,
    `fromSequence`, `limit`), `GET /runs/:id/files/<name>` (the four run files, exact bytes, checked
    against the stored checksums before they are sent).
  - **In-process background runner:** one run at a time, status in the database; a run's events,
    snapshot and final status are written in one transaction, so a run is either complete or absent;
    a run is claimed with a conditional update, so it is never processed twice; on start-up, runs left
    `queued` or `running` by a stopped API are processed again (generation is deterministic, so the
    result is the same).
  - **Validation:** Zod schemas through Nest 12's built-in `StandardSchemaValidationPipe`; the
    scenario body is validated by the core `scenarioSchema`, so the API reports the same paths as
    the CLI (`400` with one message per problem). Configuration validated with Zod at start-up.
  - **Health and failure:** `GET /health` (database reachable, engine version). The API refuses to
    start, with exit code 3 and the command to run, when PostgreSQL is unreachable or not migrated.
- Root scripts: `pnpm db:migrate` (apply migrations), `pnpm api` (start the built API).
- `pnpm test:integration` now needs PostgreSQL as well as Kafka (one `docker compose up -d --wait`
  starts both); it uses its own database (`dataforge_test`), so manual-test data is never touched.

**Architectural decisions** (ADR-0011).

| Question | Options | Choice |
| --- | --- | --- |
| Prisma version | 8.0.0-rc.34 (`latest` tag); 7.10.1 (newest stable) | **7.10.1**, pinned. 8.0 is still a release candidate. Prisma 7's TypeScript client (`prisma-client` generator, CommonJS output, `@prisma/adapter-pg` driver adapter, no Rust query engine) spiked on 2026-11-23 against `postgres:18.7-alpine`. |
| NestJS version | 11.2 (`legacy` tag, CommonJS); 12.6 (current, ESM-only) | **12.6.** Node 24 loads ESM from CommonJS natively, so the repo stays CommonJS; Nest 12 has a built-in Standard Schema pipe that takes Zod schemas, so no extra validation dependency. Under Jest, Nest 12 and Prisma 7 both need `--experimental-vm-modules` (Prisma 7 needs it with Nest 11 too), so `pnpm test` passes that flag. |
| Where Prisma lives | its own `packages/persistence`; inside `apps/api` | **Inside `apps/api`.** The API is its only user (the CLI stays file-based); a package would add wiring without a second consumer. The ESLint guard keeps Prisma out of the pure packages. |
| Bulk insert of canonical events | `createMany` in chunks; one `INSERT ... SELECT FROM unnest(arrays)` per chunk; `COPY` | **`unnest`, 5,000 events per statement.** Spike, 20,000 events: `createMany` about 3.6 s at any chunk size, `unnest` about 0.9 s. `COPY` needs another dependency and its own connection. The raw SQL lives in one repository function, and the export checksum test proves the round trip. |
| Run files from the database | store the four files as text; store rows and rebuild the files | **Rows, rebuilt, then checked.** Events are queryable columns plus JSONB; the export rebuilds each file with the core serializers and refuses to send it unless it matches the checksum recorded at generation (a modified row is an integrity error, not silently served). |
| Background runs | a queue library (BullMQ, Redis); in-process queue with database status | **In-process**, the roadmap's plan (spec 5: no Redis without a need). Generation is synchronous and deterministic, so recovery is "run it again". |
| Database for integration tests | the development database; a separate one | **Separate** (`dataforge_test`), created and migrated by the integration global setup. |
| IDs | deterministic; UUIDv7 | **UUIDv7** for scenarios, versions and runs. They are application records, not simulation data (nothing in a run's files contains them), and v7 sorts by creation time. |

**Dependencies.** `@dataforge/core` (`simulate`, `scenarioSchema`, `parseScenario`, `normalizeSeed`,
`canonicalEventSchema`, `serializeEventLog`, `serializeExpectedState`, `canonicalJson`, `sha256Hex`,
`ENGINE_VERSION`). CLI: `run-directory.ts` (manifest schema, moved to core) and `generate`. New
third-party dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` 12.6.0
(the API framework), `reflect-metadata` 0.2.2 and `rxjs` 7.8.2 (Nest's required peers),
`@prisma/client` and `@prisma/adapter-pg` 7.10.1 (database access), `prisma` 7.10.1 (migrations and
client generation, dev), `@nestjs/testing` 12.6.0, `supertest` 7.3.2 and `@types/supertest` 7.2.1
(API tests, dev), `pg` 8.23.1 (integration global setup creates the test database, dev; already a
dependency of the Prisma adapter). Docker Desktop for PostgreSQL.

**Code and documentation changes.** Core `run/run-files.ts`; CLI `generate` and `run-directory.ts`
use it; new `apps/api` (Prisma schema, migration, modules for database, health, scenarios, runs);
`compose.yaml`, `.env.example`; root scripts `test` (VM-modules flag), `db:migrate`, `api`;
`jest.config.js` (API path mappings), `tsconfig.jest.json` (decorators), integration global setup
(PostgreSQL and the test database); ESLint ignores the generated client; CI integration job;
ADR-0011; `data-formats.md` (database tables, API resources); `ARCHITECTURE.md`; README; manual
verification guide and self-check.

**Automated tests.**

- Unit (`pnpm test`, no database): `buildRunFiles` equals the CLI's files (golden hashes unchanged);
  configuration validation; request schemas (seed normalisation, version, paging, unknown fields);
  event row to canonical event mapping round trip; the background runner with in-memory
  collaborators (status order, a failing run ends `failed` with its error, recovery order, a run
  claimed twice is processed once).
- Integration (`pnpm test:integration`, real PostgreSQL): migrations apply to an empty database;
  constraints (`(run_id, sequence)`, `(run_id, event_id)`, unique scenario name and version hash);
  API through supertest: scenario create, invalid body with paths, duplicate name, new and identical
  versions, name mismatch, unknown IDs (`404`); run lifecycle `queued` to `succeeded`; history
  filters and paging; event queries by aggregate and type; **equivalence**: for two seeds of the small
  scenario and the specification-sized scenario, the four downloaded files are byte-identical to the
  CLI's `generate` output, and the built CLI's `verify` passes on them; a row modified in the
  database makes the export fail with an integrity error; a run left `running` is completed after a
  restart; health with the database up.

**Acceptance criteria.**

- `docker compose up -d --wait` starts a healthy PostgreSQL from a pinned image next to Kafka;
  `pnpm db:migrate` creates the schema from the committed migration.
- A scenario file posted to the API becomes scenario version 1; an invalid one is rejected with
  `400` and the path of each problem; a changed definition becomes a new immutable version, an
  identical one returns the existing version.
- `POST /runs` answers `202` at once; the run moves `queued` to `running` to `succeeded` in the
  database, and its events, expected-state snapshot and manifest are stored.
- `GET /runs` lists run history newest first with filters; `GET /runs/:id/events` returns stored
  events by aggregate, type and sequence range.
- The four files downloaded from the API are byte-identical to `dataforge generate` for the same
  scenario and seed (small and specification-sized scenarios) and pass `dataforge verify`.
- A modified stored event is never exported: the download fails with an integrity error.
- Runs survive an API restart; a run interrupted by a stop is completed on the next start.
- The API exits with code 3 and the command to run when PostgreSQL is unreachable or not migrated.
- `pnpm check` needs no database; `pnpm test:integration` reports clearly when PostgreSQL or Kafka
  is unavailable.

**Manual verification.** `docs/manual-verification/milestone-6.md` (MV-6.1 to MV-6.16: install and
checks; PostgreSQL and the migration; the integration suite; start the API and its health; register
a scenario; invalid and duplicate scenarios; immutable versions; a run from `queued` to
`succeeded`; download a run, the same bytes as `generate`, `verify` passes; the specification's
example size; run history, the same inputs twice, event queries; invalid run requests; a tampered
stored event; restart and a killed API's runs; the API without PostgreSQL or migrations; the engine
kept free of NestJS and Prisma). Self-check: `scripts/verification/milestone-6.ps1` (own database
`dataforge_selfcheck`, own API on port 3106), 16 of 16 cases passing in PowerShell 7.6 and 15 of 15 in Windows PowerShell 5.1 (`-SkipInstall`) on 2026-11-23, with Docker Desktop and the Compose services; the guide's command blocks were run once, literally, in Windows PowerShell 5.1.

**Implementation notes** (changes to the plan above, with the reason).

- The run-file format (`RUN_FILES`, the manifest schema, `buildRunFiles`) moved from
  `apps/cli/src/run-directory.ts` into `@dataforge/core` (`run/run-files.ts`); the CLI re-exports it.
  The four files of both example scenarios are pinned in a new core test with the hashes `generate`
  wrote before the move, and are unchanged.
- Added beyond the plan, for spec 4.2 ("never modify the canonical event history"): a trigger that
  refuses every `UPDATE` of `scenario_version` and `canonical_event`, and a unique
  `(run_id, aggregate_id, aggregate_version)`. The trigger raises PL/pgSQL's default error code:
  Prisma reports `restrict_violation` as "Foreign key constraint violated", which misleads.
- Event pages (`GET /runs/:id/events`) validate each row against the event schema; only a full file
  download can compare with the recorded checksum, so a modified row that is still a valid event is
  caught by the download (MV-6.13), not by the page.
- `apps/api/scripts/recreate-database.js` drops and recreates scratch databases (names ending in
  `_test` or `_selfcheck` only), for the integration suite and the self-check, which therefore never
  touch the development database.
- `pnpm test:integration` has one global setup (`jest.integration.setup.js`) that checks Kafka and
  PostgreSQL together and reports every missing service. The in-band integration run prints one
  `ExperimentalWarning` line for the VM-modules flag; `pnpm test` prints none.
- The API turns Prisma's driver errors into one line (`connection refused (ECONNREFUSED)`,
  PostgreSQL's own message for a wrong password or a missing database) instead of Prisma's
  multi-line message.
- Windows PowerShell 5.1's `Invoke-WebRequest` is many times slower with its progress bar on; the
  guide sets `$ProgressPreference = 'SilentlyContinue'` before the downloads.

**Product-owner decisions** (2026-11-23, the recommendations accepted):

- D-6.1: the same scenario version and seed requested twice give two runs. A run is a history entry
  (when it was asked for, by which engine), and two identical checksums make the determinism
  visible (MV-6.11). Returning an existing succeeded run instead may be added later as an option.
- D-6.2: the API is reachable from this machine only (`API_HOST=127.0.0.1` by default) until a
  milestone needs more, because the specification excludes authentication from the MVP;
  `API_HOST=0.0.0.0` remains an explicit opt-in without protection (ADR-0011, decision 8).
- D-6.3: PostgreSQL keeps run history across `docker compose down` (named volume; `down -v`
  resets it), unlike Kafka, whose topics are scratch data per delivery (ADR-0011, decision 9).

**Approved** 2026-11-23.

---

## Milestone 7: Test executions through the API

**Objective.** Run the whole test through the API: register a chaos profile, start a test execution
of a stored run (plan the faulty delivery, deliver it to a target, validate the target's state), follow
it, and query what happened: every delivery attempt, the verdict, every finding with its causes. The
files an execution produces are byte-identical to `dataforge chaos plan`, `deliver` and `validate
--report` for the same inputs. An execution can also test the user's own pipeline (D-4.3): DataForge
produces to the user's Kafka topic, waits for zero lag on the user's consumer group, and validates the
actual state the user submits.

**Included.**

- **`@dataforge/execution`** (new package; the test-execution steps shared by the CLI and the API):
  - the step formats, moved from the CLI unchanged: the delivery summary file (`delivery-summary.json`,
    schema and builder), the target run (`target-run.json`), the validation report
    (`validation-report.json`, `buildValidationReport`);
  - `planExecution` (plan + the three plan files), `deliverInProcess` (in-memory transport + target run),
    `validateExecution` (expected windows, validation, report);
  - Kafka delivery, moved from the CLI: topic, consumer process, executor, zero lag, finish, the
    delivery log and `kafka-run.json`; and new, delivery to an **external consumer group**: the topic
    must exist, the group must have an active member and zero lag before the first record, completion
    is zero lag after the last one, and there is no consumer process.
  - The CLI's `chaos plan`, `deliver` (both transports) and `validate` use it; their output is unchanged.
- **Chaos profiles in the API**, like scenarios: `POST /chaos-profiles` (body = a chaos profile file, as
  in `chaos-profiles/`; version 1), `GET /chaos-profiles`, `GET /chaos-profiles/:id`, `POST
  /chaos-profiles/:id/versions` (a new immutable version, or the identical one), `GET
  /chaos-profiles/:id/versions/:version`. Validated by the chaos `chaosProfileSchema`, so the API reports
  the same paths as the CLI, the loss rule included.
- **Test executions:**
  - `POST /executions` `{ runId, chaosProfileId, chaosProfileVersion?, chaosSeed, target, timeoutSeconds? }`,
    `202` with a queued execution. `target` is `{ type: "reference", name: "correct"|"naive",
    transport?: "memory"|"kafka", partitions?, speed? }` or `{ type: "external", topic, groupId, speed? }`.
    The run must have succeeded (`409` otherwise).
  - Lifecycle `queued` → `running` → `completed` (with a verdict `PASS`/`FAIL`) or `failed` (with the
    error); an external execution waits in `awaiting_actual_state` after its delivery.
  - `POST /executions/:id/actual-state` `{ actualState, actualWindows? }` (the files a pipeline writes, in
    the Milestone 3 and 5 formats): validated with the paths of each problem, then validated against the
    run in the request; `409` unless the execution awaits it.
  - `GET /executions` (history, newest first; filters `runId`, `chaosProfileId`, `status`, `verdict`;
    paging), `GET /executions/:id`, `GET /executions/:id/attempts` (the delivery plan with the real Kafka
    outcome of each attempt; filters `eventId`, `aggregateId`, `kind`, `fault`, `plannedOutcome`,
    `fromSequence`, `limit`), `GET /executions/:id/report` (verdict, counts, root causes),
    `GET /executions/:id/findings` and `/window-findings` (filters `category`, `entityType`, `entityId`;
    paging), `GET /executions/:id/files/<name>` (`delivery-plan.jsonl`, `chaos-profile.resolved.json`,
    `delivery-summary.json`, `actual-state.json`, `actual-windows.json`, `target-run.json`,
    `validation-report.json`, and for Kafka `kafka-run.json`, `delivery-log.jsonl`; exact bytes, checked).
- **Persistence** (one migration): `chaos_profile`, `chaos_profile_version` (immutable), `test_execution`,
  `delivery_attempt` (one row per planned attempt, plus its Kafka outcome), `execution_file` (the JSON
  documents with their SHA-256), `validation_report`, `validation_finding`, `window_finding`. Attempts,
  findings and reports are immutable once written.
- **In-process execution runner**, one execution at a time, beside the run runner (the queue mechanics
  shared). A reference-target execution writes everything and `completed` in one transaction. On start-up,
  queued executions are processed and reference executions left `running` are processed again from
  scratch (deterministic; a new Kafka topic); an external execution left `running` becomes `failed`,
  because the user's pipeline may already have consumed part of the stream.
- **Configuration:** `KAFKA_BROKERS` (Kafka executions; Kafka is not needed to start the API) and
  `EXECUTION_WORK_DIR` (consumer output and Kafka client logs of each Kafka execution). JSON bodies up to
  64 MB (an actual state of the specification-sized scenario).

**Architectural decisions** (ADR-0012).

| Question | Options | Choice |
| --- | --- | --- |
| Where the execution steps live | the API runs the CLI as a child process; copy the steps into the API; a shared package | **A new `@dataforge/execution` package.** Today the steps live in CLI commands mixed with file and console I/O. A child process would make the database a copy of files and errors a parsing problem; a copy would drift. One package means "same inputs, same bytes" holds by construction, and the equivalence tests prove it. It cannot be `@dataforge/kafka`: it starts the consumer process, and `@dataforge/consumer` depends on `@dataforge/kafka`. |
| Chaos profiles | the profile document inside each execution request; named profiles with immutable versions | **Named profiles with immutable versions**, exactly like scenarios (ADR-0011): an execution names a version, so its history stays readable, and two documents that resolve to the same settings are one version. |
| How an execution is stored | the step files as text; rows for what is queried, documents for the rest, files rebuilt and checked | **Rows and documents, files rebuilt and checked** (the ADR-0011 rule): attempts and findings are rows (queried by event, aggregate, fault, category, entity), the other outputs are JSONB documents with the SHA-256 recorded when they were made; a download rebuilds each file and refuses to send it when it does not match. |
| When it is written | step by step; at the end in one transaction | **At the end, in one transaction**, like runs: an execution is complete or has no results, so recovery is "run it again". An external execution writes its plan and delivery when it starts waiting, and its report when the state arrives. |
| The reference consumer through Kafka | run the target in the API process; fork the consumer process | **Fork the consumer process**, as the CLI does: the target still knows only Kafka, and the API and CLI share one code path. |
| External actual state | DataForge reads a file the pipeline writes; DataForge fetches it from a URL; the user submits it | **Submitted** (`POST /executions/:id/actual-state`): it works for any pipeline and any machine, needs no file path or endpoint convention, and keeps the API the only interface. A pull adapter can be added later. |
| External topic and group | DataForge creates a topic per execution; the user's existing topic | **The user's topic, which must exist**, with checks before the first record: the group has an active member (otherwise nothing would ever reach zero lag) and zero lag (records already waiting could not be told apart). Completion is zero lag after the last record, as in Milestone 4. |
| Recovery of an external execution | deliver again; fail it | **Fail it** with the reason: DataForge cannot reset the user's pipeline, and a second delivery would show up as duplicates. |
| Status and verdict | one field (`passed`/`failed`/`error`); two fields | **Two fields.** The status says whether the execution ran to the end; the verdict says whether the target was right. `failed` with an error is an execution that could not complete (Kafka down, an invalid submission is refused with `400` and changes nothing). |

**Dependencies.** `@dataforge/core` (run files, expected windows, actual-state and actual-windows
contracts, `canonicalJson`). `@dataforge/chaos` (`chaosProfileSchema`, `chaosProfileHash`,
`planDelivery`, `serializeDeliveryPlan`, `deliveryAttemptSchema`). `@dataforge/targets` (reference
targets, `deliverInMemory`). `@dataforge/validation` (`validate`). `@dataforge/kafka` (executor, lag,
client). `@dataforge/consumer` (the process). CLI: `chaos-plan.ts`, `deliver.ts`, `deliver-kafka.ts`,
`consumer-process.ts`, `delivery-directory.ts`, `plan-directory.ts`, `validate.ts`. API (Milestone 6):
the run runner, stored runs (events rebuilt and checked), the Prisma module. No new third-party
dependency.

**Code and documentation changes.** New `packages/execution`; the CLI's step code moved there; new API
modules `chaos-profiles` and `executions`; a shared background queue for runs and executions; one
migration; API configuration (`KAFKA_BROKERS`, `EXECUTION_WORK_DIR`, body limit); ESLint determinism
guard for the pure parts of `@dataforge/execution`; Jest mapping; integration support; ADR-0012;
`data-formats.md` (tables, API resources, the external `kafka-run.json`); `ARCHITECTURE.md`; README;
manual verification guide and self-check.

**Automated tests.**

- Unit (`pnpm test`, no infrastructure): every existing CLI test and golden hash unchanged after the move;
  execution request schemas (target union and defaults, Kafka-only options, topic and group names, seed
  rules, unknown fields), chaos-profile requests, configuration (`KAFKA_BROKERS`, `EXECUTION_WORK_DIR`);
  attempt and finding rows to documents and back (the rebuilt plan and report are byte-identical); the
  external pre-checks on described groups and lags; the execution runner with in-memory collaborators
  (status order, a failure ends `failed`, an external execution waits, recovery: queued processed,
  reference requeued, external failed, awaiting untouched, claimed once).
- Integration (`pnpm test:integration`, real PostgreSQL and Kafka): chaos profiles (create, invalid with
  paths and the loss rule, duplicate name, new and identical versions); execution lifecycle; `409` for a
  run that has not succeeded; **equivalence**: for the small scenario and several profiles (`none`,
  `spec-example`, `lossy`, `late-data`) and both targets, the files of an in-memory execution are
  byte-identical to the CLI's `chaos plan` + `deliver` + `validate --report`; the same through Kafka for a
  subset; the specification-sized scenario once; attempt, finding and window-finding queries; a modified
  attempt or finding row makes the download fail with an integrity error; recovery after a restart; an
  external pipeline (a separately started consumer process on its own topic and group): `awaiting_actual_state`,
  submission, report equal to the CLI's validation of the same state; external pre-checks (missing topic,
  no active member) and submission errors; Kafka unreachable ends the execution `failed` with the command to
  start it.

**Acceptance criteria.**

- A chaos profile file posted to the API becomes version 1; an invalid one is rejected with `400` and
  the path of each problem; a changed definition is a new immutable version, an identical one returns the
  existing version.
- `POST /executions` answers `202` at once; the execution moves `queued` → `running` → `completed` with
  a verdict, or `failed` with the error; it refuses a run that has not succeeded.
- For the same run, profile, chaos seed and target, the downloaded plan, delivery and report files are
  byte-identical to `dataforge chaos plan`, `deliver` and `validate --report`, in memory and through Kafka.
- Every delivery attempt is stored and can be queried by event, aggregate, kind, fault and outcome, with
  partition and offset for Kafka; every finding and window finding can be queried by category and entity.
- A modified stored attempt or finding is never exported: the download fails with an integrity error.
- An external execution produces to the user's topic, waits for zero lag on the user's group, waits for
  the submitted state and validates it; it fails early, with the reason, when the topic does not exist or
  the group has no active member.
- Executions survive an API restart: queued ones run, interrupted reference executions run again,
  interrupted external ones are failed with the reason, waiting ones still accept their state.
- `pnpm check` needs no infrastructure; the CLI's outputs and golden hashes are unchanged.

**Manual verification.** `docs/manual-verification/milestone-7.md` (MV-7.1 to MV-7.17: install and checks;
services, the migration and the integration suite; start the API and generate a run; chaos profiles
(register, invalid and duplicate, versions); a passing execution; a failing execution with its report,
findings and causes; the same bytes as the CLI; an order's canonical timeline next to its delivery timeline;
windows and late data; an execution through Kafka; an external pipeline; external failures; invalid
execution requests; a tampered attempt or finding; restart recovery; history; the determinism guard).
Self-check: `scripts/verification/milestone-7.ps1` (own database `dataforge_selfcheck`, own API on port
3107, own work directory), 17 of 17 cases passing in PowerShell 7.6 and 16 of 16 (plus MV-7.1 skipped by
`-SkipInstall`) in Windows PowerShell 5.1 on 2026-11-23, with Docker Desktop and the Compose services. The
guide's command blocks were run once, literally, in one Windows PowerShell 5.1 session: the API and the
pipeline ran as background processes and were stopped by killing them, because a background process cannot
receive Ctrl+C, so the "interrupted by the stop" log line of MV-7.15 was not observed there (the unit test of
the runner covers the stop).

**Implementation notes** (changes to the plan above, with the reason).

- The steps moved from the CLI into `@dataforge/execution` without a change of output: every CLI test and
  golden hash passes before and after, and the integration suite compares the API's files with the CLI's byte
  for byte (in memory and through Kafka).
- An execution is requested for one planner version and refused (failed with the reason) by a runner of
  another, so a stored execution never mixes plans from two planners (ADR-0012, decision 8).
- A stop reaches the delivery in progress (an abort signal now goes to the executor and the lag wait) and
  leaves the execution `running` for the next start, so a stop is never recorded as a failure.
- The report of an external execution has `target: null`: no delivery log recorded what the pipeline
  received. It is otherwise the report `dataforge validate --plan` gives for the same file (MV-7.11: equal
  checksum).
- The guide's first draft printed nested objects after a table, which PowerShell shows as blank lines; the
  lines now end in `| Format-List`.
- Dry-run values worth knowing: the spec example (chaos seed 7) plans 486 attempts for the small scenario
  (14 duplicates); the naive target fails it with 48 findings, all explained; `late-data` gives 19 findings,
  13 of them window findings; an execution through Kafka takes about half a second, a paced one
  (`speed 5000`) about 35 s.

**Product-owner decisions** (2026-11-23, the recommendations accepted):

- D-7.1: the external pipeline's state is submitted (`POST /executions/:id/actual-state`), not read from a
  file or fetched from a URL. It works for any pipeline on any machine and keeps the API the only
  interface; a pull adapter can be added later without changing the submission (ADR-0012, decision 6).
- D-7.2: an external execution interrupted by an API stop is failed with the reason, not delivered again.
  DataForge cannot reset the user's pipeline, and a second delivery would arrive as duplicates (ADR-0012,
  decision 8).

**Approved** 2026-11-23.

---

## Milestone 8: Web UI: run history and report explorer

**Objective.** See in a browser what the API stores, and understand a failed test without reading
JSON: browse run and execution history, open an execution's report (verdict, counts, root causes,
findings, window findings) and, from any finding, drill down to one aggregate with its **canonical
timeline next to its delivery timeline**, the place where the explanation of a wrong result lives
(an event that arrived before its predecessor, a delayed or duplicated delivery, a lost event). The UI
is **read-only** and **the API does not change**: every page reads endpoints Milestones 6 and 7 built.

**Included.**

- **`@dataforge/web`** (new app, `apps/web`): React 19, TypeScript (strict, as everywhere), Vite 8,
  React Router 8, plain CSS (custom properties, light and dark by `prefers-color-scheme`), no UI kit.
  The URL is the state: filters, paging and the open finding live in the query string, so every view
  is a link that can be pasted, bookmarked and reloaded.
- **API client** (`src/api`): the one module that knows endpoint paths and response shapes. It reads
  `/api/...` (the dev and preview servers proxy it to the API), turns failures into three kinds the
  pages show differently, and validates every response with Zod schemas that describe **only what the
  pages read** (unknown fields are ignored, so an API that adds a field does not break the UI; a
  changed or missing field fails with its path):
  - `ApiUnreachable`: the API cannot be reached (network failure, or the proxy's `502`);
  - `ApiError`: the API answered `4xx`/`5xx` with its error shape (`404` unknown id, `409` not ready,
    `500` integrity error shown as a distinct panel: stored data no longer matches its checksum);
  - `ResponseShapeError`: the API answered, but not with what this UI version expects.
- **`useResource`**: a small data-loading hook (loading, data, error, reload; the previous request is
  aborted when its inputs change). No polling (live monitoring is Milestone 9); a Reload button
  refreshes a queued or running execution.
- **Pages** (routes):
  - `/runs`: run history, newest first (scenario and version, seed, status, events, requested at,
    duration); filters `status`, `scenarioId`; paging.
  - `/runs/:runId`: inputs and engine version, status and error, file checksums, events by type,
    the expected-state summary, the executions of this run (link), and the stored canonical events
    (filters `type`, `aggregateId`; paged by sequence); choosing an event's aggregate filters the table to
    it (a timeline needs an execution, which a run page does not have).
  - `/executions`: execution history, newest first (run, profile and version, chaos seed, target,
    status, verdict, attempts, findings); filters `status`, `verdict`, `runId`, `chaosProfileId`; paging.
  - `/executions/:executionId`: **the report explorer.** Header (status, verdict, error, target,
    timings); what the delivery did (attempts by kind and outcome, each fault's configured against
    observed rate, ordering, windowing arrivals, losses; the reference target's result and the Kafka
    run when present); the validation report (entities checked, findings per category, each linking to the
    findings of that category; root causes, each linking to the timeline of its event); the findings table (filters `category`, `entityType`,
    `entityId`; paged), each finding expandable to its message, expected-against-actual differences and
    causes, with links into the timeline; the window findings the same way; the downloadable files with
    their checksums. Each status has its own view: `queued` and `running` (status and Reload),
    `awaiting_actual_state` (what DataForge waits for and the request that completes it), `failed`
    (the error), `completed`.
  - `/executions/:executionId/aggregates/:aggregateId`: **the drill-down.** Two timelines of one
    aggregate (an order with its payments and shipment, a customer, a product), joined by `eventId`:
    - *canonical*: its events in version order (version, type, event time as time since the scenario
      epoch, a summary of the payload, the full payload on demand), from `GET /runs/:id/events`;
    - *delivery*: its attempts in delivery order (delivery position, attempt, kind, scheduled time
      and the shift from the event time, the faults in words, planned outcome and, through Kafka,
      partition, offset and drift), from `GET /executions/:id/attempts`;
    - a **lanes diagram** (events on one lane in version order, deliveries on the other in delivery
      order, a line from each event to each of its deliveries): crossing lines are inversions, an event
      without a line is lost, several lines are duplicates or retries; focusing or hovering an event
      highlights it in both timelines and the diagram;
    - per event: *out of order* (a later version reached the target first, the definition of the
      delivery summary's `ordering`), *lost*, *duplicated*, *retried*, *delayed*, *late*;
    - the finding it was opened from (`?finding=<ordinal>` or `?windowFinding=<ordinal>`, the API's
      0-based `ordinal`, shown 1-based), with its
      differences and causes, and `?event=<eventId>` to focus an event.
    From a finding the links go to the entity's own aggregate first (an order for an order, a payment or
    a shipment; the customer or product itself), then to the aggregate of each cause event.
- **Configuration:** `WEB_HOST` (default `127.0.0.1`), `WEB_PORT` (default `5173`) and `WEB_API_URL`
  (default `http://<API_HOST>:<API_PORT>`, so a `.env` that configures the API configures the UI), read
  from the repository's `.env`, documented in `.env.example`. Root scripts: `pnpm web` (serves the
  built UI, `vite preview`), `pnpm web:dev` (development server with hot reload).
- **Out of scope:** polling and live monitoring, launching runs or executions, creating or editing
  scenarios and profiles (Milestone 9); charts and React Flow (spec section 5 says "when needed", and
  nothing here needs them); the API serving the built UI, production hosting, authentication
  (Milestone 10 and beyond). No API change.

**Architectural decisions** (ADR-0013).

| Question | Options | Choice |
| --- | --- | --- |
| Front-end toolchain | the spec's React + Vite + Vitest + React Testing Library at the versions available | **React 19.3.1, Vite 8.3.8 with `@vitejs/plugin-react` 6.3.0, React Router 8.5.2, Vitest 5.1.1, jsdom 31.0.1, React Testing Library 16.3.3, jest-dom 8.0.0, user-event 14.6.13**, all pinned. Spike on 2026-11-23 in this repository: `pnpm install` needs no build-script approval, `tsc` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` kept), `vite build`, Vitest in jsdom and type-aware ESLint on `.tsx` all pass. TypeScript stays 6.0.3 (ADR-0005). |
| How the browser reaches the API | CORS on the API; the API serves the built UI; a Vite proxy | **A Vite proxy under `/api`** (dev server and preview), the prefix removed before the API sees the path. No API change, no CORS, so the API stays reachable from this machine only (D-6.2). The prefix is needed: the API's paths (`/runs`, `/executions/:id`) are also the UI's routes, and a proxy by bare path would send a reload of `/executions/<id>` to the API. Spike: deep links answer with the app shell; with the API stopped the proxy answers `502 text/plain` with no body, which the client tells apart from the API's JSON errors. |
| Types of API responses | `import type` from the packages and the API's view files; Zod schemas in the web app | **Zod schemas in the web app**, lenient and validated at runtime (spec 10: validate external inputs), with a **contract test** in the integration suite that parses real API responses with the same schemas. Spike: importing the packages' types pulls in `core` sources that need Node's types (`node:crypto`, `Buffer`), which would let browser code use `process` unnoticed, and the run and execution views declare `Date` where JSON carries strings. A lint rule keeps `@dataforge/*`, `node:*`, NestJS, Prisma and KafkaJS out of the web app. |
| Data loading | TanStack Query; a small hook | **A small `useResource` hook** (about 50 lines): this milestone reads a handful of endpoints, with no cache sharing, mutation or polling to justify a dependency. Milestone 9 (launch and live monitoring) may adopt TanStack Query and replace one file. |
| Routing | React Router; hash routing; none | **React Router, browser history**, filters in the query string, because the roadmap's views are meant to be linked (a failing finding sent to a colleague). |
| Styling and charts | Tailwind, a component kit, a chart library, React Flow; plain CSS and hand-written SVG | **Plain CSS and one hand-written SVG** (the lanes diagram). No dependency for what a table, a badge and a few lines do; revisit when a chart or the entity dependency graph is needed. |
| Aligning the two timelines | by time on one axis; each in its own order, joined by `eventId` | **Each in its own order, joined by `eventId`.** Delays and reorders move deliveries by hours, so a true time axis crushes the events minutes apart; the two orders make an inversion a visible crossing, with exact times in the tables. |
| What "out of order" means | any attempt before a predecessor's; the summary's definition | **The delivery summary's definition**: an event whose *first delivered* attempt is later than that of a later version of its aggregate; failed attempts do not count, lost events are left out. The contract test sums the UI's classification over every aggregate of a real execution and requires it to equal the summary's `outOfOrderEvents`. |
| Entity to aggregate | add an endpoint; read it off the causes; derive from the ID | **Derive from the ID, tested:** `ord_n`, `cus_n`, `prd_n` are their own aggregates; `pay_n_k` and `shp_n` belong to `ord_n` (ADR-0004). An unexplained finding has no causes to read it from. Window causes carry an `eventId` only, so their aggregate comes from `GET .../attempts?eventId=`, not from parsing the ID. |
| UI tests | mock modules; stub `fetch`; run against the API | **Stub `fetch` at the boundary** in Vitest, with fixtures captured from real executions (deterministic seeds), so the client, schemas and pages run unmodified; the contract test then holds the fixtures' shape to the real API. Browser end-to-end tests are Milestone 9 (Playwright). |
| Running the tests | a third root command; fold into `pnpm test` | **`pnpm test` = `pnpm test:node` (Jest) + `pnpm test:web` (Vitest).** `pnpm check` and CI cover the UI without a new step; Jest ignores `apps/web`. The Jest totals pinned by the self-checks do not change. |

**Dependencies.** The Milestone 6 and 7 HTTP API, unchanged: `GET /runs`, `/runs/:id`,
`/runs/:id/events`, `/executions`, `/executions/:id`, `/executions/:id/attempts`, `/report`,
`/findings`, `/window-findings`, `/files/<name>`. New third-party dependencies and why: `react`,
`react-dom` 19.3.1 (the UI), `react-router` 8.5.2 (routes as links), `vite` 8.3.8 and
`@vitejs/plugin-react` 6.3.0 (dev server, bundler, proxy), `vitest` 5.1.1 and `jsdom` 31.0.1 (component
tests), `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2 (its peer),
`@testing-library/jest-dom` 8.0.0 and `@testing-library/user-event` 14.6.13 (queries, matchers and
real user input), `@types/react` and `@types/react-dom` 19.3.0 (types), `eslint-plugin-react-hooks`
7.1.1 (the rules of hooks, root dev dependency). `zod` 4.6.7 is already used by the other packages.

**Code and documentation changes.** New `apps/web` (client, schemas, hook, pages, components, styles,
fixtures); root `package.json` (`test`, `test:node`, `test:web`, `web`, `web:dev`); `jest.config.js`
(ignores `apps/web`); `eslint.config.mjs` (hooks rules and the import boundary for `apps/web/src`);
`.env.example`; the integration suite gains the contract test; ADR-0013; `ARCHITECTURE.md` (the
`apps/web` module, the dependency arrow, the data flow); `data-formats.md` (the UI's routes and
query parameters); README; manual verification guide and self-check. The self-checks of Milestones 4, 6
and 7 pin the integration totals, which the contract test changes; they are updated as D-5.2 did for
Milestone 4.

**Automated tests.**

- Unit and component (`pnpm test:web`, Vitest, jsdom, no API): the client (every failure kind: network
  error, `502` without a body, API error shapes, `500` integrity error, a response with a missing
  field reported by path, extra fields ignored); schemas against the fixtures; entity to aggregate;
  the fault descriptions; the out-of-order classification (reorder, late, delay, duplicate, retry,
  lost; equals the fixtures' `ordering` summary); the timeline join; time formatting; query string
  to filters and back. Pages with a stubbed `fetch`: run history (rows, status filter in the URL,
  paging, empty), run detail, execution history, the report explorer for a passing, a failing, a
  windowed, a queued, a running, an awaiting and a failed execution, findings filter by category, root
  causes linking to their timelines, a finding expanding to differences and causes, window findings, the drill-down (both
  timelines, focus highlights the event on both sides, out-of-order and lost markers, Kafka outcome,
  the finding it was opened from), and the error states (API unreachable, unknown id, not ready,
  integrity error).
- Integration (`pnpm test:integration`, real PostgreSQL and Kafka): the contract test. For a
  run and executions started through the API (the small scenario; `none`, `spec-example` with the
  naive target, `late-data` for window findings, one through Kafka), every response the UI reads parses
  with the web schemas; the UI's out-of-order classification summed over every aggregate equals the
  delivery summary's `outOfOrderEvents`; every finding's entity maps to an aggregate that has events.

**Acceptance criteria.**

- `pnpm web` serves the UI; a reload of any route (for example `/executions/<id>`) shows that page,
  not API JSON; `/api/health` answers through the same server.
- Run history and execution history list what the API holds, newest first, with working filters and
  paging, kept in the URL.
- The report explorer shows, for a failing execution, the verdict, the findings per category, the
  root causes and every finding with its differences and causes; filtering by category changes the
  table and the URL, and each root cause links to its timeline; window findings appear for a windowed
  execution.
- From a finding, the drill-down shows the canonical and the delivery timeline of the entity's own
  aggregate and of each cause's aggregate, joined by event, with out-of-order, lost, duplicated, delayed
  and late events marked; the UI's out-of-order count over a real execution equals the delivery
  summary's.
- Every execution status has a view that says what it means; an unreachable API, an unknown id, a
  not-ready resource and an integrity error are each reported distinctly, with what to do.
- Every response the UI reads is validated; the contract test holds the schemas to the real API.
- The web app imports nothing from the engine, Node or the server frameworks (lint-enforced);
  `pnpm check` runs the UI's tests; the API and the CLI are unchanged.

**Manual verification.** `docs/manual-verification/milestone-8.md` (MV-8.1 to MV-8.15: install and
checks; services, the migration and the integration suite; start the API and the UI, deep links and the
`/api` proxy; create the data; run history and run detail; execution history and filters; a passing
execution; a failing execution (the spec's example, naive target), its report, findings and root causes; the
drill-down of a reordered order and of a double charge; window findings under late data; an execution through
Kafka (partition and offset); a lost event; failure states (unknown and malformed id, tampered data, API
stopped); the import boundary; a running execution and its refused timeline). Self-check: `scripts/verification/milestone-8.ps1` (own database, own ports
3108 and 5208, own work directory). A script cannot click, so for each page it opens the page in headless
Microsoft Edge or Google Chrome, lets it load its data and checks the text it rendered; layout, colour and
the diagram are left to the "Look for" lines of the guide (`-NoBrowser` skips the rendered checks). 15 of 15 cases
passing in PowerShell 7.6 and 14 of 14 (MV-8.1 skipped by `-SkipInstall`) in Windows PowerShell 5.1 on 2026-11-23, with
Docker Desktop, the Compose services and headless Microsoft Edge. The guide's command blocks were run once,
literally, in one Windows PowerShell 5.1 session, with three substitutions that protect your data: a scratch
database instead of `dataforge`, no `docker compose down -v`, and `Start-Process` recording the URLs instead of opening
tabs (the two servers ran as background processes). The Milestone 7 self-check still passes with its updated pins (16
of 16, MV-7.1 skipped); the Milestone 4 and 6 self-checks had only the same two numbers edited and were not re-run.

**Implementation notes** (changes to the plan above, with the reason).

- Root causes link to their timelines instead of filtering the findings: the API has no root-cause filter,
  filtering would mean loading every finding into the browser, and the validator already groups findings by
  their first cause. The category counts link to the findings of that category.
- On a run page, an event's aggregate filters the events table. A timeline needs an execution, and a run page
  has none.
- Facts the real API showed while the UI was built: a malformed ID is `400` ("must be a ... UUID"), only a
  well-formed unknown ID is `404` (the UI handles both); a run's `files` map does not list `manifest.json`, so
  the page adds it; finding `ordinal` is 0-based; a late fault can be anchored behind an event of *another*
  order (`ord_000012`'s late payment waits behind `evt_ord_000013_3`).
- Vite's configuration is `vite.config.mts` and the web package has no `"type": "module"`, so the API's Jest
  integration test can load the UI's pure modules (`src/api/schemas.ts`, `src/lib/*`) without file extensions in
  their imports. `apps/web/*.config.mts` is excluded from type-aware ESLint (the project service knows only the
  browser tsconfig); `tsc -p tsconfig.node.json` checks it.
- The two timelines stack below 1,400 px of window width and the lanes diagram is capped at 820 px: both
  changes came from looking at the pages rendered by Edge, where the delivery table's last column was clipped
  and the diagram's text scaled to twice its size.
- The Chrome extension was not connected during the dry run, so the pages were viewed through headless Edge
  (screenshots, which showed the system's dark theme only, and the rendered text); the light theme and a
  phone-width layout were not looked at.
- The integration run is now 10 suites and 112 tests (the contract test adds one suite and 16 tests). The
  self-checks of Milestones 4, 6 and 7 pin those totals and were updated, as D-5.2 did for Milestone 4. `pnpm
  check` runs Jest (38 suites, 451 tests, unchanged) and then Vitest (7 files, 108 tests).

**Product-owner decisions** (2026-11-23, the recommendations accepted):

- D-8.1: the UI stays on its own web server with a proxy under `/api`, the API unchanged (no CORS, still reachable
  from this machine only). Serving the UI from the API is a question for Milestone 10 (ADR-0013, decision 2).
- D-8.2: pages show stored data after checking that each row is still a valid event, attempt or finding; only the
  file downloads compare with the recorded checksums. A "verify integrity" action may be added later (ADR-0013,
  decision 10).
- D-8.3: no chart library and no React Flow for now: tables and one hand-written diagram. Revisit for a per-window
  chart or the entity dependency graph (ADR-0013, decision 6).

Self-check re-run before approval: 15 of 15 in PowerShell 7.6 (full), 14 of 14 in Windows PowerShell 5.1
(`-SkipInstall`, MV-8.1 skipped), on 2026-11-23, after `pnpm build`.

**Approved** 2026-11-23.

---

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
| Prisma `latest` (8.0) is still a release candidate. | An upgrade to 8.0 may change the client or the migration tooling. | Pinned to 7.10.1 (ADR-0011). Upgrade in its own change once 8.0 is final, with the integration suite as the check. |
| Jest runs with Node's `--experimental-vm-modules` (NestJS 12 is ESM-only; the Prisma 7 client uses a dynamic import). | A Node or Jest release could change that support and break the API tests. | One flag, set in the two root scripts (ADR-0011). The production API does not use it (Node's `require` of ES modules is stable). Fallback: Nest 11 and an ESM-capable test transform. |
| Generation runs on the API's event loop. | The API answers nothing while a large run is simulated (about 0.6 s for the specification-sized scenario, much longer at the scenario limits). | Spec 5: no worker threads before profiling proves the need; profile in Milestone 10. |
| A run download is built in memory. | About 6 MB for the specification-sized run; far more at the scenario limits. | Streaming the export is a Milestone 10 profiling item. |
| One API process per database is assumed. | A second API on the same database would requeue the first one's running runs on start-up. | Documented (ADR-0011); a lease or heartbeat on `running` runs if several instances are ever needed. |
| An execution plans, delivers in memory and validates on the API's event loop. | The API answers nothing else meanwhile; not measured at the specification's size through the API. | Spec 5: no worker threads before profiling; Kafka delivery is asynchronous. Profile in Milestone 10 (ADR-0012). |
| An external pipeline must commit offsets after handling a record. | Zero lag would not mean "done"; its state could be incomplete when submitted. | Documented with the external API; DataForge checks for an active member and zero lag before the first record (ADR-0012, decision 7). |
| Execution work directories and Kafka topics accumulate. | Disk use grows with every Kafka execution. | Kept on purpose for inspection (D-4.2); `docker compose down` removes the topics, the work directories are removed by hand. A clean-up command is a Milestone 10 candidate. |
| The web UI is served by `vite preview`. | Fine on this machine; not a production server, no authentication. | The API stays on 127.0.0.1 (D-6.2) and the UI is reachable only from this machine by default (`WEB_HOST`). Serving the UI from the API and production hosting are Milestone 10 questions (D-8.1). |
| The UI and the API change together. | A changed response makes a page say "Unexpected response from the API". | Zod schemas of only what the pages read, and a contract test against the real API in the integration suite (ADR-0013, decision 3). |
| The UI derives an entity's aggregate from its ID (`pay_n_k` is in `ord_n`). | A new entity type or ID scheme would leave findings without a timeline link. | One tested function (`src/lib/entity.ts`); the contract test requires every finding of two executions to map to an aggregate that has events. |
| The self-check's rendered-page checks need Microsoft Edge or Google Chrome. | Without one they fail (or are skipped with `-NoBrowser`). | Edge ships with Windows; the script looks in the usual folders of both. |
| Docker-backed checks need Docker Desktop running. | Without it, `deliver --transport kafka`, the API and `pnpm test:integration` cannot run (exit code 3 and a clear message, never a silent pass). | `pnpm check` needs no Docker; CI runs the integration suite against the Compose services (Kafka and PostgreSQL) on every push. |
| Root-cause hints rely on a hand-written dependency model of the e-commerce domain. | New event types could leave findings under-explained (reported as "not explained by delivery"). | ADR-0008 names the rule; the end-to-end tests assert that every naive finding is explained under four profiles and on the spec-sized scenario, so a gap shows up as a failing test. |
| The in-memory transport ignores wall-clock time (only order matters). | A user's pipeline that uses wall-clock processing time cannot be tested offline. | The reference targets take processing time from the delivery clock (`scheduledDeliveryTimeMs` header), so windows are tested the same in process and through Kafka (ADR-0010). Kafka delivery can also play the plan in compressed wall-clock time (`--speed`). |
| Windows with several Kafka partitions. | Cross-partition interleaving can move the reference target's stream time ahead of the plan's, so it may close windows earlier than the plan predicts; Kafka Streams keeps stream time per partition. | One partition is the default and matches the plan exactly; the integration tests check windows with one partition only (ADR-0010). |
| Window metrics are specific to the e-commerce domain. | A new metric or event type needs code. | One definition in core (`windowContribution`, `WINDOW_METRIC_EVENT_TYPE`), used by the expected windows, both targets and the validator. |
| Kafka delivery is sequential (one acknowledged record at a time, about 1 ms each locally). | The spec-sized scenario takes about 20 s; the scenario limits would take minutes. | Exact per-record offsets and order are worth it for now; batching is a Milestone 10 profiling item (ADR-0009). |
| With several partitions, root-cause hints still come from the plan. | A naive-target finding caused by cross-partition interleaving can be reported as "not explained by delivery". | One partition is the default, which equals the plan exactly. Hints from the consumer's processing log are a possible later addition. |
| Plans are built in memory (about 19,000 attempts for the spec-sized scenario, planned in about 0.4 s). | Memory use near the scenario limits (100,000 orders, a few hundred thousand attempts). | Profile with generation in Milestone 10. |
| In-memory generation. | Memory use near the scenario limits. | Limits enforced by the schema; profile in Milestone 10 before optimizing. |

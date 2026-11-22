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
| 4 | Kafka delivery + out-of-process target | Planned |
| 5 | Event-time windows and late data | Planned |
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

**Objective.** Run the same test through a real Kafka broker and a separately running consumer.

**Included.** Docker Compose with Kafka in KRaft mode (pinned image); Kafka client spike and decision
(see risks); a delivery executor that plays the plan in wall-clock time with a time-compression
factor; message contract (key = `aggregateId`, value = event + ISO timestamps, headers = delivery
attempt metadata); delivery log of real outcomes (partition, offset, time); completion detection by
consumer-group lag reaching zero; the reference consumer as a standalone process; `dataforge run`.

**Automated tests.** Integration tests against the real broker (separate `pnpm test:integration`,
which reports clearly when Kafka is unavailable); per-key ordering preserved for unfaulted events;
duplicates arrive with the same `eventId` and distinct attempt headers; **equivalence**: the Kafka run
produces the same findings as the offline run for the same seeds.

---

## Milestone 5: Event-time windows and late data

**Objective.** Detect bugs caused by events that arrive after a processing window has closed.

**Included.** Expected windowed aggregates (for example revenue and order counts per event-time
window); a "late" fault defined relative to window close and allowed lateness; validation of windowed
aggregates; a naive windowing reference target (processing-time windows, drops late events).

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
| KafkaJS has had no release since 2.2.4 (February 2023). | Compatibility with current Kafka, unfixed bugs. | Keep Kafka behind a narrow delivery port; in Milestone 4 spike KafkaJS against the pinned broker and compare with `@confluentinc/kafka-javascript` (Confluent-supported, KafkaJS-compatible API, native) and `@platformatic/kafka` (pure TypeScript). Decide with evidence. |
| TypeScript 7 is current, but ts-jest and typescript-eslint do not support it yet. | Toolchain lock-in. | Pinned to TypeScript 6.0.3 (ADR-0005). Revisit when both support 7. |
| Prisma `latest` is a release candidate. | Unstable persistence layer. | Pin a stable 7.x in Milestone 6 unless 8.0 is final by then. |
| Docker Desktop is installed but its engine was not running during Milestones 1-3. | Blocks Milestones 4 and 6. | Start Docker Desktop before Milestone 4. Milestones 1-3 need no infrastructure. |
| Root-cause hints rely on a hand-written dependency model of the e-commerce domain. | New event types could leave findings under-explained (reported as "not explained by delivery"). | ADR-0008 names the rule; the end-to-end tests assert that every naive finding is explained under four profiles and on the spec-sized scenario, so a gap shows up as a failing test. |
| The in-memory transport ignores delivery time (only order matters). | Processing-time effects (Milestone 5 windows) are not exercised offline. | By design (ADR-0008); Milestone 4 plays the plan in wall-clock time, Milestone 5 adds windows. |
| Plans are built in memory (about 19,000 attempts for the spec-sized scenario, planned in about 0.4 s). | Memory use near the scenario limits (100,000 orders, a few hundred thousand attempts). | Profile with generation in Milestone 10. |
| In-memory generation. | Memory use near the scenario limits. | Limits enforced by the schema; profile in Milestone 10 before optimizing. |

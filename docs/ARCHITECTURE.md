# DataForge Architecture

DataForge is a **modular monolith** in a pnpm workspace. The simulation engine is a plain
TypeScript library with no framework or infrastructure dependencies; everything that does I/O lives
in `apps/*`, or in `packages/kafka`, the one infrastructure adapter, and depends on the engine, never
the other way around.

## Modules

```text
packages/
  core/          @dataforge/core         Simulation core (Milestone 1)
  chaos/         @dataforge/chaos        Chaos delivery planner (Milestone 2)
  validation/    @dataforge/validation   Expected-vs-actual comparison, invariants, root-cause hints (Milestone 3)
  targets/       @dataforge/targets      Reference target pipelines + in-memory transport (Milestone 3)
  kafka/         @dataforge/kafka        Kafka delivery: record contract, plan executor, lag, consumer runner (Milestone 4)
apps/
  cli/           @dataforge/cli          Command-line interface (Milestone 1)
  consumer/      @dataforge/consumer     The reference consumer as a standalone process (Milestone 4)
  api/           @dataforge/api          NestJS + Prisma (Milestones 6, 7, planned)
  web/           @dataforge/web          React + Vite (Milestones 8-9, planned)
scenarios/                               Example scenario definitions
chaos-profiles/                          Example chaos profiles
scripts/verification/                    Per-milestone self-checks of the manual verification
compose.yaml                             Local infrastructure: one Kafka broker in KRaft mode
docs/                                    Specification, architecture, roadmap, formats, ADRs
```

Dependency direction (enforced by package dependencies, plus ESLint for the four `packages/*`):

```text
apps/web            ──HTTP──▶ apps/api (planned)
apps/cli            ──▶ kafka, validation, targets, chaos, core   (starts apps/consumer as a child process)
apps/consumer       ──▶ kafka, targets, core
packages/kafka      ──▶ targets, chaos, core, kafkajs
packages/validation ──▶ chaos (delivery attempts), core
packages/targets    ──▶ chaos (delivery attempts), core
packages/chaos      ──▶ core
packages/core       ──▶ zod only
```

`packages/validation` and `packages/targets` both read delivery attempts from `packages/chaos` and
state records from `packages/core`, but never depend on each other: the validator judges any
target, including one the user wrote. (Validation's end-to-end tests use the targets as a dev
dependency.)

`packages/core`, `packages/chaos`, `packages/validation` and `packages/targets` may not import file
system, network, process, NestJS, Prisma, Kafka or React modules, and may not call `Math.random`,
`Date.now`, `new Date()`, `localeCompare` or `toLocaleString`. `pnpm lint` fails if they do.
`packages/kafka` is the one package allowed to import a Kafka client (only `client.ts` and
`consumer-runner.ts` do); its record contract, executor, lag arithmetic, log formats and process
protocol are held to the same rules, and the executor reads time only from an injected clock.

## Inside `@dataforge/core`

| Folder | Responsibility |
| --- | --- |
| `random/` | `xoshiro128**` generator and `RandomStream`: one stream per (seed, purpose, entity), derived with SHA-256. |
| `time/` | Simulation clock helpers: UTC parsing, simulation time to ISO conversion. |
| `scenario/` | Scenario schema (Zod), defaults, cross-field validation, scenario hash, seed rules. |
| `domain/` | Deterministic IDs and the order state machine (`ORDER_TRANSITIONS`), the single source of lifecycle rules. |
| `events/` | Canonical event schemas, event drafts, canonical ordering, JSONL serialization. |
| `generation/` | Catalog, customer and order lifecycle generators, plus `simulate()`. |
| `rules/` | The business rule registry (`defineRule`, `ECOMMERCE_RULES`) and the state invariants (`ECOMMERCE_INVARIANTS`), which check a whole final state. |
| `projection/` | World state, `applyEvent`, strict replay with log-integrity checks, expected-state output, and the actual-state contract a target reports (`parseActualState`). |
| `serialization/` | Canonical JSON (sorted keys) and locale-independent string comparison. |
| `windows/` | The windowing contract (`windowingSpecSchema`), window math (start, close), the window metrics (`windowContribution`, the one definition of what a window counts), the expected windows of a canonical log, and the actual-windows contract (`parseActualWindows`). |

## Inside `@dataforge/chaos`

| Folder | Responsibility |
| --- | --- |
| `profile/` | Chaos profile schema (Zod), defaults, the loss rule, profile hash. |
| `plan/` | Delivery attempt model and JSONL format, `planDelivery()`, the summary (rates, losses, per-aggregate inversions, arrivals), `explainEvent()`, and `classifyArrivals()`: when each event first reached the target relative to its window's close, in stream time. |

The package only reads canonical events. It never changes them and never delivers anything: it
decides *what* is delivered, *when*, and *with which faults*. Milestone 4 executes a plan through
Kafka.

## Inside `@dataforge/validation` and `@dataforge/targets`

| Module | Responsibility |
| --- | --- |
| `validation/src/validate.ts` | Compares actual with expected state by entity ID, checks the invariants on the actual state, ranks root-cause hints, builds the result. |
| `validation/src/delivery-index.ts` | Reduces a delivery plan to the events whose delivery was abnormal, per aggregate. |
| `validation/src/windows.ts` | `validateWindows`: compares per-window metrics with the true windows and links each wrong window to the late, lost, misplaced or duplicated events behind it. |
| `targets/src/transport/in-memory.ts` | Plays a plan into a target in delivery order; failed attempts never reach it. |
| `targets/src/reference/correct.ts` | Idempotent, version-ordered, dependency-aware consumer built on the core projection; with a windowing contract, event-time windows that close in stream time and drop what arrives later. |
| `targets/src/reference/naive.ts` | A consumer that assumes perfect delivery: upserts, last arrival wins, counts every copy; with a windowing contract, processing-time windows. |

A target implements `Target` (`handle(message)`, `finish()`). A `DeliveryMessage` is what a target
receives from any transport: key `aggregateId`, the canonical event, attempt headers.

## Inside `@dataforge/kafka` and `@dataforge/consumer`

| Module | Responsibility |
| --- | --- |
| `kafka/src/record.ts` | The Kafka record contract: `encodeDeliveryRecord` (message to key, value, headers) and the Zod-validated `decodeDeliveryRecord`. |
| `kafka/src/executor.ts` | `executePlan`: plays a plan in delivery order through a `RecordSender`, paced by an injected `WallClock`; planned failures are logged, never sent. |
| `kafka/src/lag.ts` | Consumer-group lag from end and committed offsets. |
| `kafka/src/client.ts` | KafkaJS adapters: client with file logging, admin connect (Kafka unavailable), topic creation, lag polling, the idempotent producer and `KafkaRecordSender`. |
| `kafka/src/consumer-runner.ts` | `ConsumerRunner`: joins a group, decodes records, hands them to a `Target`, commits after each handled batch, keeps the processing log. |
| `kafka/src/process-protocol.ts` | The IPC messages between the delivering process and the consumer process. |
| `consumer/src/main.ts` | The consumer process: options, `ConsumerRunner` with a reference target, finish on IPC or Ctrl+C, output files. |
| `cli/src/commands/deliver-kafka.ts` | Topic and group per execution, consumer process, executor, zero lag, finish, output files. |

## Data flow (Milestone 1)

```text
scenario.json ─parseScenario─▶ ScenarioConfig ─┐
seed ─────────────normalizeSeed───────────────┤
                                               ▼
                      generateCatalog / generateCustomers / generateOrders
                      (each entity draws only from its own RandomStreams)
                                               │ event drafts
                                               ▼
                      sequenceDrafts: sort by (eventTimeMs, aggregateId, aggregateVersion),
                                      assign sequence 1..N, freeze
                                               │ canonical events
                                               ▼
                      replayCanonicalLog: for each event
                          log-integrity checks + every business rule ─▶ violation = engine bug
                          applyEvent (projection)
                                               │
                                               ▼
                      expected state ─▶ expected-state.json
                      canonical log  ─▶ events.jsonl
```

The same `replayCanonicalLog` is used by `simulate()` and by `dataforge verify`, so "the expected
state is derived by replaying the canonical log" is checked directly, not assumed.

## Data flow (Milestone 2)

```text
run directory ── events.jsonl (checksum must match manifest.json) ─┐
chaos profile ── parseChaosProfile ────────────────────────────────┤
chaos seed ───── normalizeSeed ────────────────────────────────────┤
                                                                    ▼
          for each event, each fault type draws from its own stream
          (chaos seed, "chaos.<fault type>", eventId): selected? parameters?
                                                                    │ decisions
                                                                    ▼
          per aggregate, latest version first:
            original at eventTimeMs + delay, then behind the k-th later event (reorder),
            failed attempts + retries after backoff (transient failure; loss if allowed),
            copies of the first delivered attempt (duplicate)
                                                                    │ attempts
                                                                    ▼
          sort by (scheduledDeliveryTimeMs, eventSequence, attemptNumber), number 1..N
                                                                    │
                                                                    ▼
          delivery-plan.jsonl + delivery-summary.json (+ resolved profile), in their own directory
```

`dataforge explain` reads the run and the plan back (both checksum-verified, and the plan must
belong to the run) and accounts for every attempt of one event.

## Data flow (Milestone 3)

```text
run (events.jsonl, intact) ──┬──────────────────────────────────────────────┐
plan (delivery-plan.jsonl) ──┤                                              │
                             ▼                                              │
     deliverInMemory: every delivered attempt, in delivery order,           │
     becomes a DeliveryMessage { key, event, headers } ─▶ target.handle()   │
                             │ target.finish()                              │
                             ▼                                              │
     actual-state.json + target-run.json (bound to run and plan by hash)    │
                             │                                              ▼
                             ▼
     validate: expected state (replayed from the intact log) vs actual state, by entity ID
               + ECOMMERCE_INVARIANTS on the actual state
               + for each finding: abnormal deliveries of the events its entity depends on
                             │
                             ▼
     console summary + validation-report.json   (exit 0 PASS, 1 findings)
```

## Data flow (Milestone 4)

```text
dataforge deliver --transport kafka                        dataforge-consumer (child process)
  run + plan (intact, bound by hash)
  connect admin ── Kafka unreachable? exit 3
  create topic dataforge.<execution id> (1 partition)
  fork consumer ──────────────────────────────────────────▶ join group dataforge-consumer.<id>
                ◀───────────────────────────── IPC "ready"   (read from the beginning)
  executePlan: each attempt in delivery order
    planned failure ─▶ delivery-log only
    delivered ─▶ produce {key, value, headers}, acked ──▶ Kafka ──▶ fetch batch
                 delivery-log: partition, offset, times              decode ─▶ target.handle()
                                                                     processing-log
                                                                     commit offsets of the batch
  poll lag (end - committed) until 0
  IPC "finish" ───────────────────────────────────────────▶ target.finish()
                                                             actual-state.json, consumer-report.json,
                ◀──────────────────────────── IPC "finished"  processing-log.jsonl; exit 0
  target-run.json (same as in memory), delivery-log.jsonl, kafka-run.json
```

With one partition the consumer sees exactly the planned order, so `actual-state.json` and
`target-run.json` are byte-identical to `--transport memory`; `dataforge validate` reads them the
same way.

## Data flow (Milestone 5)

```text
chaos profile ── windowing { sizeMs, allowedLatenessMs }, faults.late (optional)
                             │
chaos plan: planned from the last canonical event to the first, so every anchor is final:
  late:    original attempt 1 ms after the first delivery of an event at least lateByMs past
           the close of its window (close = window end + allowed lateness)
  summary: arrivals of OrderCreated/PaymentCompleted by stream time (classifyArrivals)
                             │
deliver (memory or Kafka): the target is created with the plan's windowing
  correct: count each eventId once in its event-time window, unless stream time
           (largest event time received) already passed the window's close
  naive:   count every message in the window of its delivery time
  ─▶ actual-state.json + actual-windows.json + target-run.json (records the windowing)
                             │
validate: expected windows = computeExpectedWindows(canonical log, sizeMs)   (the truth)
          compare by window start ─▶ window-undercount / window-overcount / duplicate / misaligned
          causes: the window's events lost, after close, within lateness, or delivered elsewhere;
                  duplicates and events of other windows delivered during it
          ─▶ console windows section + report "windows"
```

Inputs without a windowing contract take none of these paths, and produce the same bytes as in
Milestone 4.

## Key concepts

- **Canonical event**: a business fact in the simulated world, identified by `eventId`, positioned
  by `sequence`, stamped with `eventTimeMs`. Canonical events are frozen and never modified.
- **Aggregate**: the consistency and ordering unit. `Product`, `Customer` and `Order` are
  aggregates; payments and shipments are entities inside the `Order` aggregate, so every lifecycle
  event of an order carries the order's `aggregateId` and a contiguous `aggregateVersion`. This is
  also the future Kafka partition key.
- **Event time / delivery time / processing time**: event time is when the business fact happened
  (`eventTimeMs`, milliseconds since the scenario epoch). Delivery time is when an attempt is
  scheduled to reach the target (`scheduledDeliveryTimeMs`, same clock, never earlier). Processing time is when the target handled it
  (`processedAt` in the consumer's processing log, wall clock, from Milestone 4). All three are distinct fields; machine time is never used for event time.
- **Business event vs delivery attempt**: one canonical event can have several delivery attempts
  (duplicates, retries). Attempts reference the event's `eventId`, have their own `attemptId`, and
  never alter the event.
- **Chaos seed**: independent of the simulation seed, so one world can be tested under many fault
  patterns. **Planner version** (`PLANNER_VERSION`) plays the role of the engine version for plans.
- **Actual state**: what a target reports at the end, in the same shape as the expected state. The
  validator compares the two; it never looks inside the target.
- **Finding and cause**: a finding is one way the actual state is wrong (one entity, one category);
  its causes are the delivery faults that could have produced it, most likely first.
- **Window, stream time, close**: a window is a tumbling event-time interval `[start, start +
  sizeMs)`, aligned to the scenario epoch. Stream time is the largest event time a target has
  received. A window closes when stream time reaches its end plus the allowed lateness; an event of
  that window arriving later arrives *after close*. Expected windows are the true values (every
  event counted once in the window of its event time); dropping a late event is a finding, explained
  by its late arrival.
- **Engine version**: `ENGINE_VERSION` names the generation algorithm. Any change in output for the
  same scenario and seed requires a version bump; the golden test enforces this.

See [data-formats.md](data-formats.md) for the file contracts and [adr/](adr/) for the reasoning
behind each decision.

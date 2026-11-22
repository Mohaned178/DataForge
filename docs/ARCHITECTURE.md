# DataForge Architecture

DataForge is a **modular monolith** in a pnpm workspace. The simulation engine is a plain
TypeScript library with no framework or infrastructure dependencies; everything that does I/O lives
in `apps/*` and depends on the engine, never the other way around.

## Modules

```text
packages/
  core/          @dataforge/core         Simulation core (Milestone 1)
  chaos/         @dataforge/chaos        Chaos delivery planner (Milestone 2)
  validation/    @dataforge/validation   Expected-vs-actual comparison, invariants, root-cause hints (Milestone 3)
  targets/       @dataforge/targets      Reference target pipelines + in-memory transport (Milestone 3)
apps/
  cli/           @dataforge/cli          Command-line interface (Milestone 1)
  api/           @dataforge/api          NestJS + Prisma + Kafka delivery (Milestones 4, 6, 7, planned)
  web/           @dataforge/web          React + Vite (Milestones 8-9, planned)
scenarios/                               Example scenario definitions
chaos-profiles/                          Example chaos profiles
scripts/verification/                    Per-milestone self-checks of the manual verification
docs/                                    Specification, architecture, roadmap, formats, ADRs
```

Dependency direction (enforced by package dependencies, plus ESLint for the four `packages/*`):

```text
apps/web            ──HTTP──▶ apps/api (planned)
apps/cli            ──▶ validation, targets, chaos, core
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

## Inside `@dataforge/chaos`

| Folder | Responsibility |
| --- | --- |
| `profile/` | Chaos profile schema (Zod), defaults, the loss rule, profile hash. |
| `plan/` | Delivery attempt model and JSONL format, `planDelivery()`, the summary (rates, losses, per-aggregate inversions), `explainEvent()`. |

The package only reads canonical events. It never changes them and never delivers anything: it
decides *what* is delivered, *when*, and *with which faults*. Milestone 4 executes a plan through
Kafka.

## Inside `@dataforge/validation` and `@dataforge/targets`

| Module | Responsibility |
| --- | --- |
| `validation/src/validate.ts` | Compares actual with expected state by entity ID, checks the invariants on the actual state, ranks root-cause hints, builds the result. |
| `validation/src/delivery-index.ts` | Reduces a delivery plan to the events whose delivery was abnormal, per aggregate. |
| `targets/src/transport/in-memory.ts` | Plays a plan into a target in delivery order; failed attempts never reach it. |
| `targets/src/reference/correct.ts` | Idempotent, version-ordered, dependency-aware consumer built on the core projection. |
| `targets/src/reference/naive.ts` | A consumer that assumes perfect delivery: upserts, last arrival wins, counts every copy. |

A target implements `Target` (`handle(message)`, `finish()`). A `DeliveryMessage` is the record
Kafka will carry in Milestone 4: key `aggregateId`, the canonical event, attempt headers.

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
  (Milestone 4). All three are distinct fields; machine time is never used for event time.
- **Business event vs delivery attempt**: one canonical event can have several delivery attempts
  (duplicates, retries). Attempts reference the event's `eventId`, have their own `attemptId`, and
  never alter the event.
- **Chaos seed**: independent of the simulation seed, so one world can be tested under many fault
  patterns. **Planner version** (`PLANNER_VERSION`) plays the role of the engine version for plans.
- **Actual state**: what a target reports at the end, in the same shape as the expected state. The
  validator compares the two; it never looks inside the target.
- **Finding and cause**: a finding is one way the actual state is wrong (one entity, one category);
  its causes are the delivery faults that could have produced it, most likely first.
- **Engine version**: `ENGINE_VERSION` names the generation algorithm. Any change in output for the
  same scenario and seed requires a version bump; the golden test enforces this.

See [data-formats.md](data-formats.md) for the file contracts and [adr/](adr/) for the reasoning
behind each decision.

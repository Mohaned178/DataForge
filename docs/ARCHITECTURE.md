# DataForge Architecture

DataForge is a **modular monolith** in a pnpm workspace. The simulation engine is a plain
TypeScript library with no framework or infrastructure dependencies; everything that does I/O lives
in `apps/*` and depends on the engine, never the other way around.

## Modules

```text
packages/
  core/          @dataforge/core         Simulation core (Milestone 1)
  chaos/         @dataforge/chaos        Chaos delivery planner (Milestone 2)
  validation/    @dataforge/validation   Expected-vs-actual comparison (Milestone 3, planned)
apps/
  cli/           @dataforge/cli          Command-line interface (Milestone 1)
  api/           @dataforge/api          NestJS + Prisma + Kafka delivery (Milestones 4, 6, 7, planned)
  web/           @dataforge/web          React + Vite (Milestones 8-9, planned)
scenarios/                               Example scenario definitions
chaos-profiles/                          Example chaos profiles
scripts/verification/                    Per-milestone self-checks of the manual verification
docs/                                    Specification, architecture, roadmap, formats, ADRs
```

Dependency direction (enforced by package dependencies, plus ESLint for `packages/core` and
`packages/chaos`):

```text
           apps/web ──HTTP──▶ apps/api
                                 │
apps/cli ────────┐               │
                 ▼               ▼
        packages/validation  packages/chaos
                 │               │
                 └──────▶ packages/core ◀── (no dependencies except zod)
```

`apps/cli` depends on `packages/chaos` and `packages/core` today; `packages/validation` arrives in
Milestone 3.

`packages/core` and `packages/chaos` may not import file system, network, process, NestJS, Prisma,
Kafka or React modules, and may not call `Math.random`, `Date.now`, `new Date()`, `localeCompare`
or `toLocaleString`. `pnpm lint` fails if they do.

## Inside `@dataforge/core`

| Folder | Responsibility |
| --- | --- |
| `random/` | `xoshiro128**` generator and `RandomStream`: one stream per (seed, purpose, entity), derived with SHA-256. |
| `time/` | Simulation clock helpers: UTC parsing, simulation time to ISO conversion. |
| `scenario/` | Scenario schema (Zod), defaults, cross-field validation, scenario hash, seed rules. |
| `domain/` | Deterministic IDs and the order state machine (`ORDER_TRANSITIONS`), the single source of lifecycle rules. |
| `events/` | Canonical event schemas, event drafts, canonical ordering, JSONL serialization. |
| `generation/` | Catalog, customer and order lifecycle generators, plus `simulate()`. |
| `rules/` | The business rule registry (`defineRule`, `ECOMMERCE_RULES`). |
| `projection/` | World state, `applyEvent`, strict replay with log-integrity checks, expected-state output. |
| `serialization/` | Canonical JSON (sorted keys) and locale-independent string comparison. |

## Inside `@dataforge/chaos`

| Folder | Responsibility |
| --- | --- |
| `profile/` | Chaos profile schema (Zod), defaults, the loss rule, profile hash. |
| `plan/` | Delivery attempt model and JSONL format, `planDelivery()`, the summary (rates, losses, per-aggregate inversions), `explainEvent()`. |

The package only reads canonical events. It never changes them and never delivers anything: it
decides *what* is delivered, *when*, and *with which faults*. Milestone 4 executes a plan through
Kafka.

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
- **Engine version**: `ENGINE_VERSION` names the generation algorithm. Any change in output for the
  same scenario and seed requires a version bump; the golden test enforces this.

See [data-formats.md](data-formats.md) for the file contracts and [adr/](adr/) for the reasoning
behind each decision.

# DataForge

**A data pipeline chaos testing platform.** DataForge simulates a realistic business, produces the
canonical stream of events that happened and the final state a correct pipeline must reach, then
plans how those events are delivered late, duplicated, reordered or after failed attempts, delivers
them to a target pipeline, and checks whether the pipeline still gets the right answer, explaining
every wrong result by the delivery faults that most likely caused it.

The value is not the generated data. It is finding data-processing bugs in a reproducible way.

> **Status:** Milestones 1 (deterministic simulation core + CLI), 2 (chaos delivery planner), 3
> (validation engine + reference targets, offline end to end), 4 (Kafka delivery + out-of-process
> target), 5 (event-time windows and late data), 6 (persistence with PostgreSQL + Prisma, and the
> API foundation with NestJS), 7 (test executions through the API), 8 (web UI: run history and report
> explorer) and 9 (web UI: configure and launch, with Playwright end-to-end tests) of 10 are approved.
> Milestone 10 (hardening and scale: profiling at the scenario limits, event schema versioning and
> upcasting, a checked Compose environment, the demo) is implemented and awaits approval; its manual
> verification was waived at the product owner's request. See [docs/ROADMAP.md](docs/ROADMAP.md) and
> [docs/performance.md](docs/performance.md).

## Requirements

- Node.js 24 LTS
- pnpm 11 (`corepack enable` or `npm install -g pnpm`)
- Docker Desktop with Docker Compose: for the Kafka broker (`deliver --transport kafka`),
  PostgreSQL (the API) and `pnpm test:integration`; the CLI and `pnpm check` run without it

## Try it with examples (PowerShell, about five minutes)

DataForge runs on your machine (the API listens on 127.0.0.1 only and has no authentication, by design), so
"the link" is this repository. From a clone, with Docker Desktop running:

```powershell
git clone https://github.com/Mohaned178/DataForge.git
cd DataForge
pnpm install
pnpm build
docker compose up -d --wait      # Kafka and PostgreSQL
pnpm db:migrate                  # create the tables
pnpm api                         # window 1: the API on http://127.0.0.1:3000 (leave it running)
pnpm web                         # window 2: the web UI on http://127.0.0.1:5173 (leave it running)
pnpm demo:seed                   # window 3: fill it with examples (about 15 seconds)
```

Then open <http://127.0.0.1:5173/executions>. `pnpm demo:seed` registers the example scenarios and chaos
profiles, simulates two worlds (the small scenario, 472 events, and the specification's example size, 18,479
events, both seed 42) and runs five tests. Open each one:

| Test | Verdict | What to look at |
| --- | --- | --- |
| `correct` target, profile `none` | PASS | The baseline: 472 attempts, no faults, no findings. |
| `naive` target, profile `spec-example` (5% delayed, 3% duplicated, 2% reordered; chaos seed 7) | FAIL, 48 findings, all explained | 8 `double-processing` (customers charged twice), 8 `status-mismatch` (orders in the wrong status), 14 `field-mismatch` and 18 `invariant-violation`. Open a finding: it names the delayed, duplicated or reordered event that caused it, and links to the order's canonical timeline next to its delivery timeline. |
| `correct` target, same profile and seed | PASS | The same 486 attempts with the same faults, handled correctly: the faults are not the failure, the pipeline's handling is. |
| `naive` target, profile `duplicates-only` | FAIL, 58 findings | Every duplicated payment is counted twice. |
| `correct` target, profile `late-data` on the 18,479-event world (hourly windows, 10 minutes of allowed lateness) | FAIL, 160 window findings | Revenue and order counts per event-time window are short wherever an event arrived after its window closed; each window finding names the late event. |

Then start your own test from the UI (`/executions/new`: pick a run, a chaos profile, a chaos seed and a
target) or edit a scenario or profile (`/scenarios`, `/chaos-profiles`). The same worlds are available without
Docker or the UI, from the command line:

```powershell
pnpm dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out/try
pnpm dataforge chaos plan --run out/try --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out/try-plan
pnpm dataforge deliver --run out/try --plan out/try-plan --target naive --out out/try-naive
pnpm dataforge validate --run out/try --actual out/try-naive/actual-state.json --plan out/try-plan
```

The last command exits with code 1 (findings) and prints the double charges and wrong statuses, each with the
faulted events behind it. Change `--target naive` to `--target correct` and it passes. To test your own
pipeline instead of the reference targets, see the HTTP API section (`target.type: "external"`).

## Quick start (PowerShell)

```powershell
pnpm install
pnpm build
pnpm dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out/run-42
pnpm dataforge verify --run out/run-42
pnpm dataforge timeline --run out/run-42 --aggregate ord_000007

pnpm dataforge chaos plan --run out/run-42 --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out/plan-42-7
pnpm dataforge explain --run out/run-42 --plan out/plan-42-7 --event evt_ord_000088_2

pnpm dataforge deliver --run out/run-42 --plan out/plan-42-7 --target naive --out out/naive-42-7
pnpm dataforge validate --run out/run-42 --actual out/naive-42-7/actual-state.json --plan out/plan-42-7 --report out/naive-42-7-report.json
```

`generate` writes four files to the output directory:

| File | What it is |
| --- | --- |
| `events.jsonl` | The canonical event log: what happened in the simulated store, in order. |
| `expected-state.json` | The final state a correct pipeline must produce from those events. |
| `scenario.resolved.json` | Your scenario with every default filled in. |
| `manifest.json` | Seed, engine version, counts and SHA-256 checksums. |

`verify` re-checks a run from scratch: checksums, the event schema, every business rule, that
replaying the events reproduces the expected state, and that regenerating from the scenario and seed
reproduces the same events.

`chaos plan` turns a run, a chaos profile (`chaos-profiles/`) and a chaos seed into a delivery
plan in its own directory, without touching the run:

| File | What it is |
| --- | --- |
| `delivery-plan.jsonl` | Every delivery attempt in delivery order: original, retry or duplicate; when; delivered or failed; which faults (delay, reorder, duplicate, transient failure). |
| `delivery-summary.json` | Seeds, the run it belongs to (by hash), configured versus observed fault rates, losses, out-of-order counts, checksums. |
| `chaos-profile.resolved.json` | Your profile with every default filled in. |

`explain` shows every attempt of one event, why it was scheduled when it was, whether it is
delivered, and whether the target receives it out of order within its aggregate.

`deliver` plays a plan, in delivery order, into a reference target, and writes the state the target
ends in. With `--transport memory` (the default) the target runs in process; with
`--transport kafka` every delivered attempt is produced to a real Kafka broker and the target runs
as a separate consumer process (see "Through Kafka" below):

| Target | Behaviour |
| --- | --- |
| `correct` | Ignores an `eventId` it already has, applies each order's events in version order (waiting for a late predecessor), and waits for an order's customer and products. Passes under every profile that does not lose events. |
| `naive` | Applies every message as it arrives: creates overwrite, the last message decides the status, every copy is counted, an update of a row that does not exist yet is lost. Passes only when nothing goes wrong. |

| File | What it is |
| --- | --- |
| `actual-state.json` | The target's final state, in the same shape as `expected-state.json`. Your own pipeline can write this format too. |
| `target-run.json` | Which target consumed which plan of which run, message counts, events it never applied. |

### Through Kafka

```powershell
docker compose up -d --wait        # one Kafka broker (apache/kafka:4.3.2, KRaft); docker compose down removes it
pnpm dataforge deliver --run out/run-42 --plan out/plan-42-7 --target naive --out out/kafka-naive-42-7 --transport kafka
pnpm dataforge validate --run out/run-42 --actual out/kafka-naive-42-7/actual-state.json --plan out/plan-42-7
```

A new topic and consumer group per delivery; the consumer process joins, the plan is played in
delivery order (`--speed max` by default, or `--speed <factor>` simulated milliseconds per real
millisecond), and the consumer is told to finish once its consumer group's lag is zero. Planned
failures are never sent. With the default single partition, `actual-state.json` and
`target-run.json` are byte-identical to the in-memory delivery; `--partitions <n>` keeps per-key
order only. Besides the two shared files the output directory holds `delivery-log.jsonl` (every
attempt: partition, offset, send times), `processing-log.jsonl` (every record the consumer handled,
with processing time), `consumer-report.json`, `kafka-run.json` and the two processes' Kafka client
logs. Brokers: `--brokers`, else `KAFKA_BROKERS` (see `.env.example`), else `localhost:9092`. Exit
code 3 means Kafka or the consumer was unavailable.

`validate` compares an actual state with the run's expected state, entity by entity, and checks 16
state invariants (references resolve, nothing paid twice, status consistent with payments and
shipment, counters consistent with records). Every finding has a category (`missing-entity`,
`double-processing`, `status-mismatch`, ...) and, with `--plan`, the delivery faults that most
likely caused it. Exit code 0 means the state is correct, 1 means findings.

### Windows and late data

A chaos profile can also carry the **windowing contract** of the pipeline under test: tumbling
event-time windows and how long after its end a window still accepts events. A window *closes* when
the pipeline's stream time (the largest event time it has received) passes its end plus that allowed
lateness. The `late` fault makes events arrive after their window has closed:

```powershell
pnpm dataforge chaos plan --run out/run-42 --profile chaos-profiles/late-data.json --chaos-seed 7 --out out/plan-late
pnpm dataforge deliver --run out/run-42 --plan out/plan-late --target correct --out out/late-correct
pnpm dataforge validate --run out/run-42 --actual out/late-correct/actual-state.json --plan out/plan-late
```

For a windowed plan, the targets also write `actual-windows.json`: `ordersCreated`,
`paymentsCompleted` and `revenueMinor` per window. `correct` counts each event once in its event-time
window and drops events that arrive after the close; `naive` counts every copy in the window it
arrives in (processing time). `validate` compares them with the true per-window values from the
canonical log and explains each short or long window by the events behind it: arrived after close,
within the allowed lateness, during another window, or more than once. Profiles: `windowed-none`,
`windowed-delays` (delays within the lateness and duplicates: `correct` passes), `late-data`.

## HTTP API (PostgreSQL)

The API stores scenarios, immutable scenario versions and simulation runs in PostgreSQL, generates
runs in the background, and gives back exactly the files `dataforge generate` writes:

```powershell
docker compose up -d --wait      # Kafka and PostgreSQL (host port 5433)
pnpm db:migrate                  # apply the database migrations
pnpm build
pnpm api                         # http://127.0.0.1:3000; Ctrl+C stops it
```

In a second window:

```powershell
$api = 'http://127.0.0.1:3000'
$scenario = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
$run = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $scenario.id; seed = 42 } | ConvertTo-Json)
Invoke-RestMethod "$api/runs/$($run.id)"                                   # queued, running, then succeeded
(Invoke-RestMethod "$api/runs/$($run.id)/events?aggregateId=ord_000088").events
Invoke-WebRequest -UseBasicParsing "$api/runs/$($run.id)/files/events.jsonl" -OutFile out\events.jsonl
```

The four files (`events.jsonl`, `expected-state.json`, `scenario.resolved.json`, `manifest.json`)
downloaded into one directory form a run directory that `dataforge verify` and every other command
accept. Endpoints and tables: [docs/data-formats.md](docs/data-formats.md).

A test execution runs the whole test of a stored run through the API: register a chaos profile, plan
the faulty delivery, deliver it to a target, validate the target's state. The files are the ones
`dataforge chaos plan`, `deliver` and `validate --report` write for the same inputs:

```powershell
$profile = Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile chaos-profiles\spec-example.json
$body = @{ runId = $run.id; chaosProfileId = $profile.id; chaosSeed = 7; target = @{ type = 'reference'; name = 'naive' } } | ConvertTo-Json -Depth 5
$execution = Invoke-RestMethod -Method Post -Uri "$api/executions" -ContentType 'application/json' -Body $body
Invoke-RestMethod "$api/executions/$($execution.id)"                         # queued, running, then completed with a verdict
Invoke-RestMethod "$api/executions/$($execution.id)/report"                  # FAIL, counts by category, root causes
(Invoke-RestMethod "$api/executions/$($execution.id)/findings?category=double-processing").findings
(Invoke-RestMethod "$api/executions/$($execution.id)/attempts?aggregateId=ord_000045").attempts
```

The target can also be `{type: "reference", name: "correct", transport: "kafka"}` (a new topic and
the consumer process), or your own pipeline: `{type: "external", topic: "...", groupId: "..."}`.
DataForge then produces to your topic, waits until your consumer group has committed every record,
and validates the state your pipeline submits with `POST /executions/:id/actual-state`.

## Web UI

A web UI over the API. It **explores**: run and execution history, the report of an execution (verdict, findings
per category, root causes, every finding with its causes), and, from a finding, the **canonical timeline of an
order, customer or product next to its delivery timeline**, so a wrong result can be traced to the delivery
that caused it (a reordered event, a duplicate, a lost one). And it **does the whole test from the browser**:
JSON editors for scenarios and chaos profiles (checked by the API with the same schema saving uses, with
immutable versions; start from the repository's examples), forms that start a run or an execution (a reference
target in memory or through Kafka, or your own pipeline, to which you then submit the state it ended in), and
pages that follow a queued or running run or execution by themselves until it ends. It needs the API running.

```powershell
pnpm build
pnpm api        # window 1: http://127.0.0.1:3000
pnpm web        # window 2: http://127.0.0.1:5173 (the built UI; /api is forwarded to the API)
```

`pnpm web:dev` serves the UI with hot reload for development. `pnpm test:e2e` drives the whole flow in a real
browser (Playwright) against its own copy of the API, web server and database; it needs Docker, and a browser
downloaded once with `pnpm --filter @dataforge/e2e install-browser`. `WEB_HOST`, `WEB_PORT` and `WEB_API_URL` are
in `.env.example`. The browser talks only to the web server, so the API needs no CORS and stays reachable from
this machine only.

## Development

```powershell
pnpm test        # all automated tests: the engine and the API (Jest), then the web UI (Vitest)
pnpm typecheck   # strict TypeScript
pnpm lint        # ESLint, including the determinism guard for packages/*
pnpm check       # all three (no Docker needed)
pnpm web:dev     # the web UI with hot reload
pnpm test:integration   # build, then the Kafka and PostgreSQL integration tests (needs docker compose up -d --wait)
pnpm test:e2e           # build, then the Playwright end-to-end suite (needs docker compose up -d --wait and the browser)
pnpm demo:seed          # fill a running API with example scenarios, profiles, runs and five tests
pnpm profile --orders 100000 --customers 100000 --products 10000   # time and peak memory of every stage at the scenario limit
```

Each milestone ships a manual verification guide (`docs/manual-verification/`) and a self-check that
runs the same cases and checks every expected value:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-1.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-2.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-3.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-4.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-5.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-6.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-7.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-8.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-9.ps1
```

## Milestone workflow (Claude Code)

The project is built milestone by milestone with the `/dataforge` command:

| Command | What it does |
| --- | --- |
| `/dataforge status` | Current milestone, open decisions, next step. |
| `/dataforge start milestone <n>` | Plans, implements, tests and hands off milestone *n* (only after *n-1* is approved). |
| `/dataforge verify milestone <n>` | Runs the milestone's self-check in PowerShell 7 and 5.1 and reports per case. |
| `/dataforge fix <what failed>` | Reproduces, fixes and re-verifies a failure in the current milestone. |
| `/dataforge approve milestone <n>` | Records your approval, asks open decisions, offers to commit and push. |

## Repository layout

```
packages/core          @dataforge/core: simulation engine (no I/O, no frameworks)
packages/chaos         @dataforge/chaos: chaos delivery planner (no I/O, no frameworks)
packages/validation    @dataforge/validation: expected-vs-actual validation and root-cause hints (no I/O)
packages/targets       @dataforge/targets: reference targets and the in-memory transport (no I/O)
packages/kafka         @dataforge/kafka: Kafka record contract, plan executor, lag, consumer runner
packages/execution     @dataforge/execution: the steps of a test execution, shared by the CLI and the API
apps/cli               @dataforge/cli: the dataforge command
apps/consumer          @dataforge/consumer: the reference consumer as a standalone process
apps/api               @dataforge/api: the HTTP API (NestJS, Prisma, PostgreSQL)
apps/web               @dataforge/web: the web UI (React, Vite) over the HTTP API
apps/e2e               @dataforge/e2e: the Playwright end-to-end suite
compose.yaml           local Kafka broker (KRaft) and PostgreSQL
scenarios/             example scenario definitions
chaos-profiles/        example chaos profiles
scripts/verification/  per-milestone self-checks (PowerShell 5.1 and 7)
scripts/demo/          pnpm demo:seed: the examples of "Try it"
scripts/profile/       pnpm profile: time and peak memory per stage at any size
docs/                  specification, architecture, roadmap, data formats, manual verification, ADRs
.claude/skills/        the /dataforge milestone workflow
```

## Documentation

- [Product specification](docs/product-spec.md)
- [Manual verification guides](docs/manual-verification/)
- [Architecture](docs/ARCHITECTURE.md)
- [Data formats](docs/data-formats.md): scenario, events, expected state, manifest, chaos profile,
  delivery plan and summary, actual state, target run, Kafka record and logs, validation report,
  database tables, HTTP API (scenarios, runs, chaos profiles, test executions, the two dry runs) and the web UI's routes
- [Roadmap](docs/ROADMAP.md)
- [Performance at the scenario limits](docs/performance.md): measured time and memory, and what was decided
- [Architecture decision records](docs/adr/)

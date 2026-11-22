# DataForge

**A data pipeline chaos testing platform.** DataForge simulates a realistic business, produces the
canonical stream of events that happened and the final state a correct pipeline must reach, then
plans how those events are delivered late, duplicated, reordered or after failed attempts, and (in
upcoming milestones) checks whether your pipeline still gets the right answer.

The value is not the generated data. It is finding data-processing bugs in a reproducible way.

> **Status:** Milestones 1 (deterministic simulation core + CLI) and 2 (chaos delivery planner) of 10
> are approved. Next: Milestone 3, the validation engine and reference targets. See
> [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

- Node.js 24 LTS
- pnpm 11 (`corepack enable` or `npm install -g pnpm`)
- Docker Desktop: not needed until Milestone 4

## Quick start (PowerShell)

```powershell
pnpm install
pnpm build
pnpm dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out/run-42
pnpm dataforge verify --run out/run-42
pnpm dataforge timeline --run out/run-42 --aggregate ord_000007

pnpm dataforge chaos plan --run out/run-42 --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out/plan-42-7
pnpm dataforge explain --run out/run-42 --plan out/plan-42-7 --event evt_ord_000088_2
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

## Development

```powershell
pnpm test        # all automated tests
pnpm typecheck   # strict TypeScript
pnpm lint        # ESLint, including the determinism guard for packages/core
pnpm check       # all three
```

Each milestone ships a manual verification guide (`docs/manual-verification/`) and a self-check that
runs the same cases and checks every expected value:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-1.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-2.ps1
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
apps/cli               @dataforge/cli: the dataforge command
scenarios/             example scenario definitions
chaos-profiles/        example chaos profiles
scripts/verification/  per-milestone self-checks (PowerShell 5.1 and 7)
docs/                  specification, architecture, roadmap, data formats, manual verification, ADRs
.claude/skills/        the /dataforge milestone workflow
```

## Documentation

- [Product specification](docs/product-spec.md)
- [Manual verification guides](docs/manual-verification/)
- [Architecture](docs/ARCHITECTURE.md)
- [Data formats](docs/data-formats.md): scenario, events, expected state, manifest, chaos profile,
  delivery plan and summary
- [Roadmap](docs/ROADMAP.md)
- [Architecture decision records](docs/adr/)

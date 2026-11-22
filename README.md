# DataForge

**A data pipeline chaos testing platform.** DataForge simulates a realistic business, produces the
canonical stream of events that happened and the final state a correct pipeline must reach, then
(in upcoming milestones) delivers those events late, duplicated, reordered or after failed attempts,
and checks whether your pipeline still gets the right answer.

The value is not the generated data. It is finding data-processing bugs in a reproducible way.

> **Status:** Milestone 1 of 10 (deterministic simulation core + CLI) is approved. Next: Milestone 2,
> the chaos delivery planner. See [docs/ROADMAP.md](docs/ROADMAP.md).

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
apps/cli               @dataforge/cli: the dataforge command
scenarios/             example scenario definitions
scripts/verification/  per-milestone self-checks (PowerShell 5.1 and 7)
docs/                  specification, architecture, roadmap, data formats, manual verification, ADRs
.claude/skills/        the /dataforge milestone workflow
```

## Documentation

- [Product specification](docs/product-spec.md)
- [Manual verification guides](docs/manual-verification/)
- [Architecture](docs/ARCHITECTURE.md)
- [Data formats](docs/data-formats.md): scenario, events, expected state, manifest
- [Roadmap](docs/ROADMAP.md)
- [Architecture decision records](docs/adr/)

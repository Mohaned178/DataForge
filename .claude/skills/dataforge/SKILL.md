---
name: dataforge
description: Run the DataForge milestone workflow - status, start, verify, fix or approve a milestone.
argument-hint: "status | start milestone <n> | verify milestone <n> | fix <failure report> | approve milestone <n>"
disable-model-invocation: true
---

# DataForge milestone workflow

Request: `$ARGUMENTS`

DataForge is built one milestone at a time behind a **gate**: milestone *n* opens only when the
roadmap records milestone *n-1* as approved, and every milestone ends in a **hand-off**, after which
the turn ends and the user runs their manual tests.

## 1. Load context

Read in full:

- `docs/product-spec.md`: the user's specification (scope, principles, testing rules, standards).
- `docs/ROADMAP.md`: status table, every milestone's plan, open decisions, risks.
- `docs/ARCHITECTURE.md`.

List `docs/adr/` and read each ADR the request touches. Run `git status --short` and
`git log --oneline -5`.

Done when you can state the current milestone, its status, and whether the gate to the next one is
open.

## 2. Route

| Request | Branch |
| --- | --- |
| empty, or `status` | Status, below |
| `start milestone <n>` | [start.md](start.md) |
| `verify milestone <n>` | [verify.md](verify.md) |
| `fix <failure report>` | [fix.md](fix.md) |
| `approve milestone <n>` | [approve.md](approve.md) |

Map free-form wording onto the nearest branch ("continue", "next milestone": start; "MV-2.3 failed":
fix; "all passed, approved": approve). When the request fits no branch, show this table and ask.

## Status

Reply in at most ten lines: the current milestone's row from the status table, the roadmap's open
decisions, uncommitted changes, and the one command the user should run next.

## Roadmap status values

`Planned` → `In progress` → `Awaiting manual verification` → `Approved YYYY-MM-DD`.
Only [approve.md](approve.md) writes `Approved`. The gate for milestone *n* is open exactly when
milestone *n-1* reads `Approved ...`.

## Conventions every branch uses

- **Green** means `pnpm check` exits 0 (type-check, lint, every Jest test).
- Milestone *n* has a manual verification guide `docs/manual-verification/milestone-<n>.md` and a
  self-check `scripts/verification/milestone-<n>.ps1`; their formats are in
  [handoff.md](handoff.md).
- Run a self-check in both shells the user may have:
  `pwsh -NoProfile -File <script>` and
  `powershell -NoProfile -ExecutionPolicy Bypass -File <script> -SkipInstall`.
- Report only results you actually ran. Name any infrastructure that was unavailable (for example
  Docker not running) and the tests it blocked.

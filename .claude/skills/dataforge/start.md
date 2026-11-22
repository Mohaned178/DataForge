# Start milestone *n*

## 1. Check the gate

- Milestone *n-1* must read `Approved ...` in the roadmap status table. Otherwise report its status,
  tell the user the gate opens with `/dataforge approve milestone <n-1>` after they verify it, and
  end the turn.
- If milestone *n* already reads `In progress` or `Awaiting manual verification`, this is a
  **resume**: summarise what exists (roadmap section, `git diff`, files) and continue from the first
  unfinished step below.

Done when the gate is open and you know whether this is a fresh start or a resume.

## 2. Plan

Re-read the milestone's roadmap section and inspect the code it builds on. Rewrite that section so it
covers the spec's eight points (section 8): objective, functionality, architectural decisions,
dependencies, code and documentation changes, automated tests, acceptance criteria, manual test
cases. For each decision with several viable options, compare them in a line or two and recommend
one. Set the status to `In progress`.

Send the user a short plan message. Questions that change product scope or depart from the spec go
to the user before implementation; technical choices inside the scope are yours to make and record
as ADRs.

Done when the roadmap section covers all eight points and no scope question is open.

## 3. Implement

Build exactly this milestone's scope, following spec section 10 and the boundaries in
`docs/ARCHITECTURE.md`. Write each behaviour's automated test alongside it, asserting observable
behaviour. When implementation shows the roadmap must change, change it and give the reason in the
hand-off.

Done when every acceptance criterion has code and at least one automated test behind it.

## 4. Go green

Run `pnpm check` (plus the integration suite once infrastructure milestones add one) and fix until it
exits 0.

Done when the commands exit 0 and you have the pass counts per suite.

## 5. Write the manual verification and dry-run it

Write `docs/manual-verification/milestone-<n>.md` and `scripts/verification/milestone-<n>.ps1` in the
formats of [handoff.md](handoff.md). Dry-run everything yourself:

- the self-check in PowerShell 7 and in Windows PowerShell 5.1, until every case passes in both;
- the guide's literal command blocks once in Windows PowerShell 5.1.

Done when both shells report every case PASS and every expected value in the guide is one you
observed.

## 6. Update the docs

Roadmap: status `Awaiting manual verification`, the hand-off's questions under "Open decisions",
risks refreshed. Update the README status line, `docs/ARCHITECTURE.md`, `docs/data-formats.md` and
the ADRs the milestone touched.

## 7. Hand off

Write the hand-off message in the format of [handoff.md](handoff.md), then end the turn. The next
milestone waits for the user's results and `/dataforge approve milestone <n>`.

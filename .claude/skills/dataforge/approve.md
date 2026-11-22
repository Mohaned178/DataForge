# Approve milestone *n*

The user typing `/dataforge approve milestone <n>` (or approving in plain words) is the explicit
approval the spec requires.

1. Confirm milestone *n* reads `Awaiting manual verification`. Otherwise report its status and end
   the turn.
2. If the user reported manual results in this conversation, check them against the guide. If a case
   failed and was never fixed, ask whether they still want to approve.
3. Ask every roadmap "Open decision" that belongs to milestone *n* and has no answer yet. Apply each
   answer (code, ADR, roadmap) before continuing; a code change sends you through
   [fix.md](fix.md) first.
4. Update the roadmap: status `Approved YYYY-MM-DD` (today's date), answered decisions moved from
   "Open decisions" into the milestone section. Update the README status line.
5. Ask whether to commit and push. On yes: stage the milestone's files (leave out `.env*` and
   `.claude/settings.local.json`), commit as `Milestone <n>: <name>` with the attribution trailer the
   session provides, and push to `origin`. Then report the CI run from `gh run list --limit 1`.
6. Tell the user the gate is open: `/dataforge start milestone <n+1>`.

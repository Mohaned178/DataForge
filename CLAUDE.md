# DataForge

Data pipeline chaos testing platform, built milestone by milestone. Specification:
`docs/product-spec.md`. Plan, milestone status and open decisions: `docs/ROADMAP.md`.

**Milestone work** (status, start, continue, verify, fix, approve) follows
`.claude/skills/dataforge/SKILL.md`, which the user runs as `/dataforge <request>`. When a milestone
request arrives without the command, read that file and follow it the same way.

- One milestone at a time: the next opens only after the user explicitly approves the current one.
- Every milestone ends with a hand-off containing "Manual Verification — <Milestone Name>"; the user
  then runs the tests and reports back.
- `packages/core` stays deterministic and I/O-free (ESLint enforces it). Green is `pnpm check`.
- The user works on Windows: commands are PowerShell that runs in both 5.1 and 7.

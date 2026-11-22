# Hand-off formats

## Hand-off message

Used at the end of [start.md](start.md) (full) and [fix.md](fix.md) (short). Sections in order, from
spec section 12:

1. Summary of what was implemented.
2. Important architectural decisions: one line each, with the ADR file.
3. Files created or modified, grouped by area.
4. Automated test results: the commands you ran, pass counts per suite, anything not run and why.
5. Acceptance criteria: a table of criterion, met or not met, evidence.
6. **Manual Verification — Milestone *n*: *Name***: every case from the guide written out in the
   message (the user reads the message, not the file), then the self-check command.
7. Known limitations.
8. Questions for the user, also recorded under the roadmap's "Open decisions".
9. Next step: what the user runs now; the next milestone opens with `/dataforge approve milestone <n>`.

## Manual verification guide: `docs/manual-verification/milestone-<n>.md`

Title `Manual Verification — Milestone <n>: <Name>`. One `## MV-<n>.<k> — <title>` section per case:

- **Verifies**: what the case proves.
- **Preconditions**: earlier cases or services it needs.
- A `powershell` code block with the exact commands.
- **Expected**: the exact values you observed in your dry run.
- **How to read it**: when the output needs interpretation.
- **Failure**: what indicates failure.

Cover normal behaviour and failure scenarios (bad input, tampering, missing infrastructure).
Commands run unmodified from the repository root in Windows PowerShell 5.1 and PowerShell 7, write
under `out\mv`, and stay ASCII inside code blocks.

## Self-check script: `scripts/verification/milestone-<n>.ps1`

- One `Test-Case 'MV-<n>.<k>'` per guide case, with the same IDs and expected values.
- Built on `scripts/verification/_helpers.ps1`: `Invoke-Pnpm`, `Invoke-DataForge`, `Assert-That`,
  `Assert-Match`, `Assert-Exit`, `Write-Note`, `Complete-Verification`.
- Pass command arguments to the helpers as arrays; the helpers splat them. pnpm is a `pnpm.ps1`
  shim, and an unsplatted array reaches it as one space-joined argument.
- Writes only under `out\self-check`, takes `-SkipInstall`, ASCII only (Windows PowerShell 5.1 reads
  BOM-less scripts as ANSI), exits 0 exactly when every case passes.

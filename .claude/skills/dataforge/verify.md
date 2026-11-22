# Verify milestone *n*

Your own run of milestone *n*'s manual verification. It informs the user; it never approves the
milestone.

1. Run `pnpm build` so `dist` matches the source.
2. Run `scripts/verification/milestone-<n>.ps1` in PowerShell 7 (full) and in Windows PowerShell 5.1
   (with `-SkipInstall`); commands in [SKILL.md](SKILL.md).
3. When no self-check script exists for *n*, run the command blocks of
   `docs/manual-verification/milestone-<n>.md` literally and compare each expected value by hand.
4. Report a table: case ID, title, result in each shell, and the failure lines.
5. Treat every FAIL as a bug, either in the milestone or in its verification. Decide which, then follow
   [fix.md](fix.md). The roadmap status stays as it is.

Done when every case has a result in both shells.

# Fix a reported failure

The user, or [verify.md](verify.md), reported a failure in the current milestone. This is the loop
from spec section 9.

1. **Reproduce.** Run the reported case (its self-check case, or the guide's commands) and watch it
   fail. If it passes for you, compare environments (shell version, stale `dist`, leftover `out\`
   folders, paths) and ask the user for the exact output before changing code.
2. **Diagnose.** Name the cause and where it lives: product code, automated tests, or the
   verification guide and self-check.
3. **Fix inside the current milestone.** Fix the cause and add or tighten an automated test that
   fails without the fix. A fix that needs scope beyond the milestone goes to the user as a roadmap
   question.
4. **Re-green.** `pnpm check`, then the full self-check in both shells.
5. **Update.** Correct the guide and the self-check wherever steps or expected values changed. The
   status stays `Awaiting manual verification`.
6. **Hand off.** A short [handoff.md](handoff.md) message: cause, fix, commands rerun with results,
   and the manual cases (IDs and commands) the user should rerun. End the turn and wait for the
   user's confirmation.

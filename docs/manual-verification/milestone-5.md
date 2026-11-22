# Manual Verification — Milestone 5: Event-Time Windows and Late Data

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. `--silent` hides pnpm's own `$ node ...` echo line. Each case builds on the earlier
ones, so run them in order. MV-5.10 needs Docker Desktop; every other case runs without it.

CLI exit codes: **0** success (for `validate`: everything is correct), **1** a check failed (for
`validate`: there are findings), **2** invalid input, **3** infrastructure unavailable.

Words used below:

- **window**: one hour of event time, `[10:00, 11:00)`, aligned to the scenario epoch
  (2026-01-01T00:00Z). The target reports three numbers per window in `actual-windows.json`:
  `ordersCreated`, `paymentsCompleted` and `revenueMinor` (cents).
- **stream time**: the largest event time the target has received so far. It only moves forward.
- **allowed lateness** and **close**: in the example profiles a window still accepts events for
  10 minutes after it ends. It *closes* when stream time reaches its end + 10 minutes, so the
  10:00 window closes when the target has seen an event from 11:10 or later.
- **arrival** of an event, by stream time when it first arrives: *on time* (its window has not
  ended), *within the allowed lateness* (ended, not closed: it must still be counted), *after
  close* (a pipeline with this lateness drops it), or *lost*.
- **late fault**: makes an event arrive after its window has closed, at least 1 to 30 minutes past
  the close (profile `late-data`).
- **expected windows**: the true values, every event counted once in the window of its event time.
  `validate` computes them from the canonical log.
- the reference targets with windows: `correct` counts each event once in its event-time window and
  drops an event that arrives after close; `naive` counts every message, copies included, in the
  window of the moment it arrives (processing time).

Self-check: `scripts/verification/milestone-5.ps1` runs these same cases with the same expected values
and prints PASS/FAIL per case. It writes to `out\self-check`; the hand-run steps below use `out\mv`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-5.ps1
```

---

## MV-5.1 — Install, build and run the automated checks

- **Verifies:** the workspace installs, type-checks, lints and passes every automated test,
  including the new window tests.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `pnpm -r typecheck` lists seven projects, each `Done`; nothing after `$ eslint .`;
  `Test Suites: 29 passed, 29 total` and `Tests: 393 passed, 393 total`; `Done` for all seven in
  the build.
- **Failure:** any `error TS...`, an ESLint error, a failed test, or an `ERR_PNPM_...` message.

## MV-5.2 — Nothing changes for profiles without windows

- **Verifies:** Milestone 5 changes no existing output. The naive target under the specification's
  example gives exactly the files that Milestone 4 pinned, and a profile without windows prints no
  window lines.
- **Preconditions:** MV-5.1. Starts from an empty `out\mv`.

```powershell
if (Test-Path out\mv) { Remove-Item out\mv -Recurse -Force }
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\run-a | Out-Null
foreach ($p in 'spec-example', 'windowed-none', 'windowed-delays', 'late-data') {
  pnpm --silent dataforge chaos plan --run out\mv\run-a --profile "chaos-profiles/$p.json" --chaos-seed 7 --out "out\mv\plan-$p" | Out-Null
}
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out\mv\plan-spec-example --force | Select-String 'window|arrivals|late '
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-spec-example --target naive --out out\mv\spec-naive | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\spec-naive\actual-state.json --plan out\mv\plan-spec-example --report out\mv\spec-naive-report.json --limit 0 | Select-Object -Last 1
Get-ChildItem out\mv\spec-naive | Select-Object -ExpandProperty Name
Get-FileHash out\mv\spec-naive\actual-state.json, out\mv\spec-naive\target-run.json, out\mv\spec-naive-report.json | Format-Table Hash
```

- **Expected:**
  - the `Select-String` line prints nothing (no `windowing`, `arrivals` or `late` line);
  - `Result: FAIL (48 findings)`, exactly as in Milestone 4;
  - the delivery directory holds only `actual-state.json` and `target-run.json`;
  - the three hashes, the values pinned by the Milestone 4 self-check:
    `A47FBBB75451D59707B0E69CF2FEBDAF5D96BC845A94746285AE68DA46A81877`,
    `62E37D930F2B321E8590593B137A4EFD550CA4C35A8CD51E64697D8D54299D86`,
    `51C6D6331A95CCF3CB0DDD1C94B90AD98E9CEC5C3E50D73A30A865F864945B44`.
- **How to read it:** identical hashes mean the plan, the target's state, the target run (which
  records the profile's hash and the planner version) and the report are byte for byte what
  Milestone 4 produced.
- **Failure:** a window line, a different count, an `actual-windows.json`, or any other hash.

## MV-5.3 — A windowed plan with late events

- **Verifies:** a profile with a windowing contract and the `late` fault plans events that arrive
  after their window has closed, and reports every counted event's arrival.
- **Preconditions:** MV-5.2.

```powershell
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/late-data.json --chaos-seed 7 --out out\mv\plan-late-data --force
Get-Content chaos-profiles\late-data.json
```

- **Expected:**
  - `late   21 of 456 eligible   4.61%  (configured 5.00%)  arrive after their window closed`;
  - `windowing   1 h tumbling event-time windows, allowed lateness 10 min`;
  - `arrivals    228 windowed events (OrderCreated, PaymentCompleted), by stream time: 219 on time,
    0 within the allowed lateness, 9 after their window closed, 0 lost`;
  - `delivery-plan.jsonl sha256 ddb558b944f9ae3dd952cd6db36599b01140a967b344fbea12161f6d39e197e5`.
- **How to read it:** 21 events got a late fault; 9 of them are OrderCreated or PaymentCompleted,
  the events windows count, and those are the 9 "after their window closed". "456 eligible":
  events in the last windows (whose close comes after the last event) cannot be late. The profile
  shows the `windowing` section and `faults.late` with `lateByMs` 60000 to 1800000.
- **Failure:** no `late` or `arrivals` line, different counts, or a different plan hash.

## MV-5.4 — Zero faults: both targets report the true windows

- **Verifies:** with perfect delivery, both targets' windows are exactly the expected windows, and
  `validate` checks the windows and passes. This is the baseline for the window cases.
- **Preconditions:** MV-5.2.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-windowed-none --target correct --out out\mv\wnone-correct
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-windowed-none --target naive --out out\mv\wnone-naive | Out-Null
Get-FileHash out\mv\wnone-correct\actual-windows.json, out\mv\wnone-naive\actual-windows.json | Format-Table Hash
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\wnone-correct\actual-state.json --plan out\mv\plan-windowed-none | Select-Object -Last 12
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\wnone-naive\actual-state.json --plan out\mv\plan-windowed-none | Select-Object -Last 1
```

- **Expected:**
  - `deliver` lists `actual-windows.json  sha256 2d7b96bf...` in its output and the line
    `0 events not counted in their window: they arrived after it closed`;
  - both hashes are `2D7B96BFAB622E6154E0F028073F8F1A82D428FE89D6D58A70CA09F3DB428BC5`;
  - the validate output has a `Windows (1 h tumbling event-time windows, allowed lateness 10 min)`
    section with `checked 41 reported windows against 41 expected` and `findings 0`;
  - both end with `Result: PASS (the actual state matches the expected state and satisfies every
    invariant; every window has its true values)`.
- **Failure:** different hashes, any window finding, or no windows section.

## MV-5.5 — Delays within the allowed lateness: correct passes, naive does not

- **Verifies:** a correct windowed pipeline gets every window right when delays stay within the
  allowed lateness (up to 9 minutes here) and events are duplicated; a processing-time pipeline
  counts copies twice and puts delayed events in the wrong hour, and every wrong window is explained.
- **Preconditions:** MV-5.2.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-windowed-delays --target correct --out out\mv\wdel-correct | Out-Null
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-windowed-delays --target naive --out out\mv\wdel-naive | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\wdel-correct\actual-state.json --plan out\mv\plan-windowed-delays | Select-Object -Last 1
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\wdel-naive\actual-state.json --plan out\mv\plan-windowed-delays --limit 100 > out\mv\wdel-naive.txt
Select-String -Path out\mv\wdel-naive.txt -Pattern 'window-undercount|window-overcount|window findings are linked|Result'
Select-String -Path out\mv\wdel-naive.txt -Pattern 'T19:00Z, 20:00Z|T20:00Z, 21:00Z' -Context 0,1
```

- **Expected:**
  - correct: `Result: PASS (... every window has its true values)`;
  - naive: `window-undercount 2`, `window-overcount 11`, `explained 13 of 13 window findings are
    linked to late, lost, misplaced or duplicated events; 0 are not explained by any delivery
    fault`, `Result: FAIL (70 findings, 13 window findings)`;
  - `[2026-01-02T19:00Z, 20:00Z) window-undercount  paymentsCompleted is 2, expected 3; revenueMinor
    is 67330, expected 120958` with the cause `evt_ord_000002_2 PaymentCompleted at
    2026-01-02T19:54:49.906Z, delivered during the window starting 2026-01-02T20:00Z [delay]`, and
    right after it `[2026-01-02T20:00Z, 21:00Z) window-overcount  paymentsCompleted is 3, expected 2;
    revenueMinor is 93191, expected 39563`.
- **How to read it:** an over-count is most often a duplicate (`delivered 2 times [duplicate]`); an
  under-count followed by an over-count in the next hour is a delayed event counted by arrival time.
  The correct target is not affected: it counts by event time and never closes a window before
  10 minutes after its end, and every delay is shorter.
- **Failure:** correct fails, naive passes, or any window finding is not explained.

## MV-5.6 — Late data: dropped events are explained by their late arrival

- **Verifies:** events that arrive after their window closed are dropped by the correct target
  (its windowing contract), and every short window it reports is explained by such an event; the
  naive target counts them in the wrong hour instead.
- **Preconditions:** MV-5.3.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-late-data --target correct --out out\mv\late-correct | Select-String 'not counted|actual-windows'
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-late-data --target naive --out out\mv\late-naive | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\late-correct\actual-state.json --plan out\mv\plan-late-data --limit 2
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\late-naive\actual-state.json --plan out\mv\plan-late-data --limit 0 | Select-String 'window-under|window-over|Result'
```

- **Expected:**
  - deliver: `9 events not counted in their window: they arrived after it closed` and
    `actual-windows.json  sha256 c4972ff9eba16ac9d9d006f340b2a9d239d556d537b5816e9cba863b7f4b5957`;
  - correct: entity `findings 0`; windows `findings 7`, all `window-undercount`, `explained 7 of 7`;
    the first finding is
    `[2026-01-01T14:00Z, 15:00Z) window-undercount  paymentsCompleted is 3, expected 4; revenueMinor is 61320, expected 83806`
    with the cause `evt_ord_000012_2 PaymentCompleted at 2026-01-01T14:05:30.532Z, arrived AFTER its
    window closed (stream time 2026-01-01T15:29:33.886Z, 19.6 min past the close at
    2026-01-01T15:10Z): dropped by a pipeline with this lateness, ... [late]`;
    the result is `Result: FAIL (0 findings, 7 window findings)` with exit code 1;
  - naive: `window-undercount 7`, `window-overcount 6`, `Result: FAIL (19 findings, 13 window findings)`.
- **How to read it:** the correct target's entity state is perfect (0 findings): only its windows
  are short, and only by the 9 events that arrived after close, which its 10 minutes of allowed
  lateness tells it to drop. The verdict is FAIL because the windows do not hold the true revenue;
  every finding points at the late event, as lost events do in Milestone 3 (decision D-5.1).
  The naive target does not drop them: it adds the 14:05 payment to the 15:00 hour, so 14:00 is
  short and 15:00 is long.
- **Failure:** any unexplained window finding, an over-count for the correct target, or other counts.

## MV-5.7 — Explain a late event

- **Verifies:** `explain` shows the event's window, when it closes, the late fault, and when the
  event arrives relative to the close.
- **Preconditions:** MV-5.3.

```powershell
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-late-data --event evt_ord_000012_2
```

- **Expected:**
  - `window      [2026-01-01T14:00Z, 15:00Z), closes at 2026-01-01T15:10Z (1 h tumbling event-time windows, allowed lateness 10 min)`;
  - one attempt, `#97`, scheduled `2026-01-01T15:29:33.887Z`, `+5,043,355 ms` after event time,
    why: `late: held until after evt_ord_000013_3, which is past the window close, +5,043,355 ms`;
  - `Window: arrives AFTER its window closed (stream time 2026-01-01T15:29:33.886Z, 19.6 min past
    the close). A pipeline with this allowed lateness drops it.`
  - `Aggregate order: OUT OF ORDER` (its shipment, version 3, arrives first).
- **How to read it:** the payment happened at 14:05; it was held until just after
  `evt_ord_000013_3`, an event from 15:29, had reached the target, so stream time was 19.6 minutes
  past the 15:10 close when the payment arrived.
- **Failure:** no window line, or an arrival other than after close.

## MV-5.8 — Same inputs, same bytes

- **Verifies:** windows and the report are deterministic.
- **Preconditions:** MV-5.6.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-late-data --target naive --out out\mv\late-naive-2 | Out-Null
Get-FileHash out\mv\late-naive\actual-windows.json, out\mv\late-naive-2\actual-windows.json | Format-Table Hash
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\late-naive\actual-state.json --plan out\mv\plan-late-data --report out\mv\late-naive-1.json | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\late-naive-2\actual-state.json --plan out\mv\plan-late-data --report out\mv\late-naive-2.json | Out-Null
Get-FileHash out\mv\late-naive-1.json, out\mv\late-naive-2.json | Format-Table Hash
```

- **Expected:** both `actual-windows.json` hashes are
  `18E9D094842572A3635B3F02C30F2CE9902C02529666254A51834C3CD3273A47`; both report hashes are equal
  to each other.
- **Failure:** any two hashes in a pair differ.

## MV-5.9 — A hand-edited windows file

- **Verifies:** `validate` notices a windows file edited after delivery, reports an extra amount, a
  window listed twice and a misaligned window, and says that no delivery fault explains them.
- **Preconditions:** MV-5.4.

```powershell
Copy-Item out\mv\wnone-correct out\mv\edited -Recurse
$w = Get-Content out\mv\edited\actual-windows.json -Raw | ConvertFrom-Json
$w.windows[5].revenueMinor += 100
$w.windows += $w.windows[0]
$w.windows += [pscustomobject]@{ windowStartMs = 1800000; windowEndMs = 5400000; ordersCreated = 0; paymentsCompleted = 0; revenueMinor = 0 }
$w | ConvertTo-Json -Depth 5 | Set-Content out\mv\edited\actual-windows.json
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\edited\actual-state.json --plan out\mv\plan-windowed-none
$LASTEXITCODE
```

- **Expected:**
  - `actual ... EDITED since delivery (checksum differs from target-run.json)` and `checked 43
    reported windows against 41 expected`;
  - window findings `3`: `window-overcount 1`, `duplicate-window 1`, `misaligned-window 1`, and
    `explained 0 of 3 window findings ...; 3 are not explained by any delivery fault`;
  - `[2026-01-01T00:30Z, 01:30Z) misaligned-window  [1800000, 5400000) is not a window of 3600000 ms
    aligned to the epoch; its values are not compared`;
  - `[2026-01-01T05:00Z, 06:00Z) duplicate-window   listed 2 times; the first one is compared`; the
    misaligned and the duplicate window each followed by `cause: not a delivery effect; the target
    listed this window wrongly`;
  - `[2026-01-01T10:00Z, 11:00Z) window-overcount   revenueMinor is 50171, expected 50071`, followed
    by `cause: none found; no abnormal delivery of an event counted in this window`;
  - `Result: FAIL (0 findings, 3 window findings)` and exit code `1`.
- **Failure:** the edit is not flagged, a finding is "explained", or a different count.

## MV-5.10 — Windows through Kafka

- **Verifies:** the separate consumer process computes the same windows as the in-memory delivery.
- **Preconditions:** MV-5.6, Docker Desktop running.

```powershell
docker compose up -d --wait
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-late-data --target correct --out out\mv\k-late-correct --transport kafka | Select-String 'sent|not counted|actual-windows'
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-late-data --target naive --out out\mv\k-late-naive --transport kafka | Out-Null
Get-FileHash out\mv\late-correct\actual-windows.json, out\mv\k-late-correct\actual-windows.json, out\mv\late-naive\actual-windows.json, out\mv\k-late-naive\actual-windows.json | Format-Table Hash
Get-FileHash out\mv\late-correct\target-run.json, out\mv\k-late-correct\target-run.json | Format-Table Hash
Get-Content out\mv\k-late-correct\consumer.log | Select-String 'actual-windows'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-late-correct\actual-state.json --plan out\mv\plan-late-data --limit 0 | Select-Object -Last 1
```

- **Expected:**
  - `sent 472 records, 0 planned failures not sent`, `9 events not counted in their window`, and
    `actual-windows.json sha256 c4972ff9...`;
  - windows hashes: the two correct ones
    `C4972FF9EBA16AC9D9D006F340B2A9D239D556D537B5816E9CBA863B7F4B5957`, the two naive ones
    `18E9D094842572A3635B3F02C30F2CE9902C02529666254A51834C3CD3273A47`;
  - the two `target-run.json` hashes are equal;
  - the consumer log lists `actual-windows.json` among its outputs;
  - `Result: FAIL (0 findings, 7 window findings)`, as in MV-5.6.
- **How to read it:** the consumer received the windowing contract on its command line and read
  processing time from the `scheduledDeliveryTimeMs` header, so Kafka changes nothing.
- **Failure:** exit code 3 with Docker running, or any hash that differs from the in-memory one.

## MV-5.11 — The specification's example size

- **Verifies:** windows at the specification's size (1,000 customers, 5,000 orders, 7 days, 168
  hourly windows): the correct target passes with delays within the lateness, and every finding
  under late data is explained.
- **Preconditions:** MV-5.1.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-standard.json --seed 42 --out out\mv\run-std | Out-Null
foreach ($p in 'windowed-delays', 'late-data') {
  pnpm --silent dataforge chaos plan --run out\mv\run-std --profile "chaos-profiles/$p.json" --chaos-seed 7 --out "out\mv\std-plan-$p" | Select-String 'late |arrivals'
  pnpm --silent dataforge deliver --run out\mv\run-std --plan "out\mv\std-plan-$p" --target correct --out "out\mv\std-$p" | Out-Null
  pnpm --silent dataforge validate --run out\mv\run-std --actual "out\mv\std-$p\actual-state.json" --plan "out\mv\std-plan-$p" --limit 0 | Select-String 'reported windows|window-undercount|window findings are linked|Result'
}
```

- **Expected:**
  - windowed-delays: `arrivals 9,749 windowed events ...: 9,570 on time, 179 within the allowed
    lateness, 0 after their window closed, 0 lost`; `checked 168 reported windows against 168
    expected`; `Result: PASS (...)`;
  - late-data: `late 955 of 18,366 eligible 5.20% (configured 5.00%)`; `arrivals ...: 9,216 on
    time, 27 within the allowed lateness, 506 after their window closed, 0 lost`;
    `window-undercount 160`; `explained 160 of 160 window findings`; `Result: FAIL (0 findings,
    160 window findings)`.
- **How to read it:** at this size the stream is dense, so a delayed event often arrives after its
  hour has ended (179 "within the allowed lateness"); the correct target still counts all of them.
- **Failure:** different counts or any unexplained finding.

## MV-5.12 — Bad input is refused with the reason

- **Verifies:** a late fault without windows, a windowed plan without windows, windows without a
  windowing contract, and an invalid windows file are each refused with exit code 2.
- **Preconditions:** MV-5.4, MV-5.2.

```powershell
Set-Content out\mv\late-only.json '{ "formatVersion": 1, "name": "late-only", "faults": { "late": { "rate": 0.1 } } }'
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile out\mv\late-only.json --chaos-seed 7 --out out\mv\never
$LASTEXITCODE
Copy-Item out\mv\wnone-correct out\mv\no-windows -Recurse
Remove-Item out\mv\no-windows\actual-windows.json
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\no-windows\actual-state.json --plan out\mv\plan-windowed-none
$LASTEXITCODE
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\spec-naive\actual-state.json --plan out\mv\plan-spec-example --windows out\mv\wnone-correct\actual-windows.json
$LASTEXITCODE
Set-Content out\mv\bad-windows.json '{ "format": "dataforge.actual-windows", "formatVersion": 1, "windows": [ { "windowStartMs": 0, "windowEndMs": 3600000, "ordersCreated": 1.5, "revenue": 3 } ] }'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\wnone-correct\actual-state.json --plan out\mv\plan-windowed-none --windows out\mv\bad-windows.json
$LASTEXITCODE
```

- **Expected**, each followed by `2`:
  - `Invalid chaos profile:` and `faults.late: needs a "windowing" section: a late event is late
    relative to the close of its window`;
  - `The plan defines event-time windows (1 h tumbling event-time windows, allowed lateness 10 min),
    but no windows were found for this target.`;
  - `... holds per-window metrics, but there is no windowing contract to check them against.` and
    `The plan (profile spec-example) has no "windowing" section.`;
  - `Invalid actual windows:` with `windows.0.ordersCreated: ...`, `windows.0.paymentsCompleted: ...`,
    `windows.0.revenueMinor: ...` and `windows.0: Unrecognized key: "revenue"`.
- **Failure:** any other exit code, or a message without the path of the problem.

## MV-5.13 — The determinism guard covers the windows module

- **Verifies:** the new `windows/` module of the core is under the ESLint determinism guard.
- **Preconditions:** MV-5.1.

```powershell
Set-Content packages\core\src\windows\guard-probe.ts 'export const probe = (): number => Math.random() + Date.now();'
pnpm lint
$LASTEXITCODE
Remove-Item packages\core\src\windows\guard-probe.ts
pnpm lint
$LASTEXITCODE
```

- **Expected:** the first `pnpm lint` reports `packages\core\src\windows\guard-probe.ts` with
  `'Math.random' is restricted` and `'Date.now' is restricted`, and exits with `1`; after removing
  the probe, `pnpm lint` exits `0`.
- **Failure:** the first lint passes, or the probe file is left behind.

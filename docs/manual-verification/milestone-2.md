# Manual Verification — Milestone 2: Chaos Delivery Planner

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. `--silent` hides pnpm's own `$ node ...` echo line.

CLI exit codes: **0** success, **1** a check failed (for `explain`: the event is not in the log),
**2** invalid input (bad profile or seed, edited run or plan, plan of another run).

Words used below:

- **canonical log**: `events.jsonl` from Milestone 1, what happened in the simulated store.
- **delivery attempt**: one planned delivery of one event to the target. An event can have several
  (a failed attempt and its retries, an original and its duplicates); they share the `eventId` and
  each has its own `attemptId`.
- **position**: `deliverySequence`, the attempt's place in delivery order (line number in
  `delivery-plan.jsonl`).
- **chaos seed**: chooses the fault pattern. It is independent of the simulation seed, which chooses
  the world.

Self-check: `scripts/verification/milestone-2.ps1` runs these same cases with the same expected values
and prints PASS/FAIL per case. It writes to `out\self-check`; the hand-run steps below use `out\mv`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-2.ps1
```

---

## MV-2.1 — Install, build and run the automated checks

- **Verifies:** the workspace, now with `@dataforge/chaos`, installs, type-checks, lints and passes
  every automated test.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `pnpm -r typecheck` lists three projects (`packages/core`, `packages/chaos`,
  `apps/cli`); `Test Suites: 14 passed, 14 total` and `Tests: 179 passed, 179 total`; nothing
  after `$ eslint .`; `Done` for all three packages in the build.
- **Failure:** any `error TS...`, an ESLint error, a failed test, or an `ERR_PNPM_...` message.

## MV-2.2 — Plan the specification's example faults

- **Verifies:** `chaos plan` turns a run, a profile and a chaos seed into a delivery plan with three
  files, and reports configured against observed fault rates.
- **Preconditions:** MV-2.1. Starts from an empty `out\mv`.

```powershell
if (Test-Path out\mv) { Remove-Item out\mv -Recurse -Force }
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\run-a | Out-Null
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out\mv\plan-a
$LASTEXITCODE
Get-ChildItem out\mv\plan-a | Format-Table Name, Length
Get-Content out\mv\plan-a\delivery-plan.jsonl -TotalCount 1
```

- **Expected:**
  - `attempts 486: original 472, retry 0, duplicate 14; delivered 486, failed 0`;
  - `delay 26 of 472 events 5.51% (configured 5.00%)`,
    `reorder 8 of 315 eligible 2.54% (configured 2.00%)`,
    `duplicate 14 of 472 delivered 2.97% (configured 3.00%) +14 extra deliveries`,
    `transientFailure 0 of 472 events 0.00% (configured 0.00%)`;
  - `472 of 472 events delivered, 0 lost`;
  - `10 events delivered after a later event of their aggregate (11 inverted pairs in 9 aggregates)`;
  - exit code `0`;
  - file sizes `chaos-profile.resolved.json` 831, `delivery-plan.jsonl` 167512,
    `delivery-summary.json` 1825;
  - the first line is attempt `att_prd_000001_1_1`, `"deliverySequence":1`, `"kind":"original"`,
    `"faults":[]`.
- **How to read it:** `original` is the first attempt of each event (always 472, one per event).
  `duplicate` attempts are extra copies. The observed rates differ a little from the configured ones
  because each event is decided by its own random draw, like 472 coin flips. Reorder is counted
  against the 315 events that have a later event in their own order (products, customers and the
  last event of each order cannot be moved behind a later one). *Out of order* counts what the
  target will see, whatever caused it: here 8 reorders plus 2 delays that happened to overtake the
  next event of the same order.
- **Failure:** non-zero exit code, different counts, or a file missing.

## MV-2.3 — Same run, profile and chaos seed: same plan

- **Verifies:** planning is deterministic across separate processes.
- **Preconditions:** MV-2.2.

```powershell
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out\mv\plan-b | Out-Null
Get-FileHash out\mv\plan-a\*, out\mv\plan-b\* | Sort-Object { Split-Path $_.Path -Leaf } | Format-Table Hash, Path -AutoSize
```

- **Expected:** each file has the same hash in `plan-a` and `plan-b`: `delivery-plan.jsonl`
  `0C08D623A42034548EE3AD76AE21B8C9638A735CBF687AA72D90C5A584CC6232`,
  `chaos-profile.resolved.json` `759A85738A32CD3BF6CED386FEFAF76F52DF33DD7DE65CD49EC70142C1A33D65`,
  `delivery-summary.json` `63887F16C26B5F8C08977A63CADA00A35BC5E5D3E1278FD148732B75E12C3B6D`.
- **How to read it:** identical hashes mean identical bytes. The summary contains no timestamps or
  paths, so it is reproducible too.
- **Failure:** any hash that differs between the two plans (a determinism bug).

## MV-2.4 — A different chaos seed: a different plan, the same world

- **Verifies:** the chaos seed changes the fault pattern and never the canonical log.
- **Preconditions:** MV-2.2.

```powershell
$eventsBefore = (Get-FileHash out\mv\run-a\events.jsonl).Hash
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/spec-example.json --chaos-seed 8 --out out\mv\plan-c
'plan same as chaos seed 7: {0}' -f ((Get-FileHash out\mv\plan-a\delivery-plan.jsonl).Hash -eq (Get-FileHash out\mv\plan-c\delivery-plan.jsonl).Hash)
'events.jsonl unchanged:    {0}' -f ($eventsBefore -eq (Get-FileHash out\mv\run-a\events.jsonl).Hash)
pnpm --silent dataforge verify --run out\mv\run-a; $LASTEXITCODE
```

- **Expected:**
  - the same `events.jsonl sha256 01b57d64...` line as in MV-2.2 (same world), but a different
    fault pattern: `attempts 481: original 472, retry 0, duplicate 9`, `delay 24`, `reorder 7`,
    `duplicate 9`, `8 events delivered after a later event of their aggregate (10 inverted pairs
    in 8 aggregates)`, `delivery-plan.jsonl sha256 43c0caa5...`;
  - `plan same as chaos seed 7: False` and `events.jsonl unchanged:    True`;
  - `verify`: seven `OK` lines, `Result: PASS`, exit code `0`.
- **How to read it:** one world, many fault patterns. Planning only reads the run directory and
  writes to its own `--out` directory, so the canonical run still verifies byte for byte.
- **Failure:** `True` for the plan, `False` for the events, or `Result: FAIL`.

## MV-2.5 — No faults: canonical order at event time

- **Verifies:** a profile without faults delivers every event exactly once, in canonical order, at
  its event time.
- **Preconditions:** MV-2.2.

```powershell
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/none.json --chaos-seed 7 --out out\mv\plan-none
$plan = Get-Content out\mv\plan-none\delivery-plan.jsonl | ConvertFrom-Json
'attempts: {0}' -f $plan.Count
'attempts that differ from the canonical log: {0}' -f @($plan | Where-Object { $_.kind -ne 'original' -or $_.plannedOutcome -ne 'delivered' -or $_.deliverySequence -ne $_.eventSequence -or $_.scheduledDeliveryTimeMs -ne $_.eventTimeMs -or @($_.faults).Count -ne 0 }).Count
```

- **Expected:** `attempts 472: original 472, retry 0, duplicate 0; delivered 472, failed 0`, every
  fault `0`, `0 events delivered after a later event ...`; then `attempts: 472` and
  `attempts that differ from the canonical log: 0`.
- **How to read it:** each attempt is the original, delivered at the position of its canonical
  sequence and at its event time, with no fault. This is the baseline: with no chaos, the target
  sees exactly the canonical log. Any other chaos seed gives the same plan.
- **Failure:** any other count, or any attempt that differs.

## MV-2.6 — Duplicates keep the business identity

- **Verifies:** a duplicated event has several attempts with the same `eventId` and distinct
  `attemptId`s, and `explain` shows each of them.
- **Preconditions:** MV-2.2.

```powershell
$plan = Get-Content out\mv\plan-a\delivery-plan.jsonl | ConvertFrom-Json
'duplicate attempts:  {0}' -f @($plan | Where-Object kind -eq 'duplicate').Count
'distinct attemptIds: {0}' -f @($plan.attemptId | Sort-Object -Unique).Count
'distinct eventIds:   {0}' -f @($plan.eventId | Sort-Object -Unique).Count
$plan | Where-Object eventId -eq 'evt_ord_000078_1' | Format-Table attemptId, eventId, kind, deliverySequence, scheduledDeliveryTimeMs -AutoSize
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-a --event evt_ord_000078_1
```

- **Expected:**
  - `duplicate attempts:  14`, `distinct attemptIds: 486` (one per attempt),
    `distinct eventIds:   472` (one per business event);
  - two rows for `evt_ord_000078_1`: `att_ord_000078_1_1 original 42 33212526` and
    `att_ord_000078_1_2 duplicate 43 33229140`;
  - `explain`: `Delivery attempts (2)`; attempt 1 `original #42 ... +0 ms DELIVERED no fault`;
    attempt 2 `duplicate #43 2026-01-01T09:13:49.140Z +16,614 ms DELIVERED duplicate copy 1 of 1,
    16,614 ms after att_ord_000078_1_1`; then
    `Outcome: delivered 2 times with the same eventId (first at position #42)`.
- **How to read it:** this is the spec's "one business event, two delivery attempts". A target that
  creates an order per message would create `ord_000078` twice. A correct target recognises the
  `eventId` and applies it once. Milestone 3 checks exactly that.
- **Failure:** fewer distinct `attemptId`s than attempts, a duplicate with another `eventId`, or a
  duplicate delivered before its original.

## MV-2.7 — A reorder always produces an inversion

- **Verifies:** each reorder fault moves an event behind a later event of its own aggregate, and
  `explain` shows the inversion.
- **Preconditions:** MV-2.2.

```powershell
pnpm --silent dataforge timeline --run out\mv\run-a --aggregate ord_000088
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-a --event evt_ord_000088_2
$plan = Get-Content out\mv\plan-a\delivery-plan.jsonl | ConvertFrom-Json
$first = @{}
foreach ($a in $plan) { if ($a.plannedOutcome -eq 'delivered' -and -not $first.ContainsKey($a.eventId)) { $first[$a.eventId] = $a.deliverySequence } }
$plan | ForEach-Object { foreach ($f in $_.faults) { if ($f.type -eq 'reorder') { [pscustomobject]@{ event = $_.eventId; behind = $f.behindEventId; eventPosition = $first[$_.eventId]; behindPosition = $first[$f.behindEventId] } } } } | Format-Table -AutoSize
```

- **Expected:**
  - the timeline of `ord_000088`: v1 `OrderCreated` (seq 27), v2 `PaymentCompleted` (seq 28), v3
    `ShipmentCreated` (seq 57), v4 `ShipmentDelivered` (seq 155);
  - `explain`: one attempt, `original #58 2026-01-01T10:49:28.384Z +11,295,521 ms DELIVERED reorder:
    moved behind evt_ord_000088_3 (1 later), +11,295,521 ms`, then
    `Aggregate order: OUT OF ORDER. The target receives later events of ord_000088 first:` and
    `evt_ord_000088_3 v3 ShipmentCreated first delivered at position #57`;
  - eight rows, each with `eventPosition` one more than `behindPosition`:

    | event | behind | eventPosition | behindPosition |
    | --- | --- | --- | --- |
    | evt_ord_000088_2 | evt_ord_000088_3 | 58 | 57 |
    | evt_ord_000057_3 | evt_ord_000057_4 | 128 | 127 |
    | evt_ord_000059_2 | evt_ord_000059_3 | 145 | 144 |
    | evt_ord_000045_1 | evt_ord_000045_2 | 154 | 153 |
    | evt_ord_000063_3 | evt_ord_000063_4 | 170 | 169 |
    | evt_ord_000020_2 | evt_ord_000020_4 | 306 | 305 |
    | evt_ord_000117_2 | evt_ord_000117_3 | 402 | 401 |
    | evt_ord_000045_3 | evt_ord_000045_4 | 480 | 479 |

- **How to read it:** the target receives `ShipmentCreated` for `ord_000088` before its
  `PaymentCompleted`, although an order can only ship once it is paid. A naive target that
  applies events as they arrive will reject or corrupt this order. The payment waits
  11,295,521 ms (about 3 hours) because a reorder waits for the next event of its order and is
  delivered 1 ms after it. `evt_ord_000020_2` was drawn with distance 2, so it goes behind v4.
- **Failure:** a reordered event whose position is lower than the position of the event it is behind.

## MV-2.8 — Retries, and loss only when allowed

- **Verifies:** failed attempts are retried after a backoff; an event is lost only when the profile
  allows loss; a profile that could lose events without opting in is rejected.
- **Preconditions:** MV-2.2.

```powershell
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/flaky-network.json --chaos-seed 7 --out out\mv\plan-flaky
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/lossy.json --chaos-seed 7 --out out\mv\plan-lossy
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-lossy --event evt_prd_000002_1
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-lossy --event evt_ord_000063_1
'{"formatVersion":1,"name":"lossy-no-opt-in","faults":{"transientFailure":{"rate":0.1,"failures":{"min":1,"max":4},"maxRetries":2}}}' | Set-Content out\mv\lossy-no-opt-in.json
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile out\mv\lossy-no-opt-in.json --chaos-seed 7 --out out\mv\plan-never; $LASTEXITCODE
```

- **Expected:**
  - `plan-flaky`: `attempts 542: original 472, retry 33, duplicate 37; delivered 509, failed 33`,
    `transientFailure 20 of 472 events 4.24% (configured 5.00%) 33 failed attempts, 0 lost`,
    `472 of 472 events delivered, 0 lost`;
  - `plan-lossy`: `attempts 575: original 472, retry 82, duplicate 21; delivered 471, failed 104`,
    `duplicate 21 of 450 delivered`,
    `transientFailure 48 of 472 events 10.17% (configured 10.00%) 104 failed attempts, 22 lost`,
    `450 of 472 events delivered, 22 lost`;
  - `evt_prd_000002_1`: three attempts: `#2 FAILED transient failure 1 of 2`,
    `#14 FAILED retry 39,301 ms after att_prd_000002_1_1 failed; transient failure 2 of 2`,
    `#15 DELIVERED retry 39,209 ms after att_prd_000002_1_2 failed`; `Outcome: delivered once`;
  - `evt_ord_000063_1`: three `FAILED` attempts (`transient failure 1 of 3`, `2 of 3`, `3 of 3`),
    then `Outcome: LOST. All 3 attempts fail and the sender gives up after 2 retries (the profile
    allows loss).`;
  - the last command prints `Invalid chaos profile:` and
    `faults.transientFailure.failures.max: cannot exceed maxRetries (2) unless allowLoss is true`,
    exit code `2`.
- **How to read it:** `flaky-network` plans at most 2 failures with 3 retries, so every event
  arrives in the end, only later. `lossy` plans up to 4 failures with 2 retries, so an event drawn
  with 3 or 4 failures is lost. Here one of them is `ord_000063`'s `OrderCreated`: the target
  will receive that order's later events without the order. Lost events get no duplicates, which
  is why duplicates count against 450 delivered events. Without `allowLoss: true` such a profile
  is refused instead of silently losing events.
- **Failure:** a lost event in `plan-flaky`, no lost events in `plan-lossy`, or the last profile accepted.

## MV-2.9 — Fault types do not disturb each other

- **Verifies:** the events a fault type selects, and the values it draws, are the same whether or
  not other fault types are enabled.
- **Preconditions:** MV-2.2.

```powershell
'{"formatVersion":1,"name":"delay-only","faults":{"delay":{"rate":0.05,"delayMs":{"min":1000,"max":300000}}}}' | Set-Content out\mv\delay-only.json
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile out\mv\delay-only.json --chaos-seed 7 --out out\mv\plan-delay | Out-Null
function Get-Delays([string]$Dir) { Get-Content "$Dir\delivery-plan.jsonl" | ConvertFrom-Json | ForEach-Object { foreach ($f in $_.faults) { if ($f.type -eq 'delay') { '{0} +{1}' -f $_.eventId, $f.delayMs } } } | Sort-Object }
$withAll = Get-Delays out\mv\plan-a
$alone = Get-Delays out\mv\plan-delay
'delays with all faults: {0}, delay alone: {1}, differences: {2}' -f $withAll.Count, $alone.Count, @(Compare-Object $withAll $alone).Count
$withAll | Select-Object -First 3
```

- **Expected:** `delays with all faults: 26, delay alone: 26, differences: 0`, then
  `evt_cus_000008_1 +46739`, `evt_cus_000014_1 +31010`, `evt_ord_000001_3 +204380`.
- **How to read it:** each fault type draws from its own random stream per event, keyed by
  (chaos seed, fault type, eventId). Turning duplicates and reorders on or off cannot change which
  events are delayed or by how much, so you can add one kind of chaos and still reproduce another.
- **Failure:** any difference.

## MV-2.10 — Observed rates on the specification's example size

- **Verifies:** on 1,000 customers and 5,000 orders, observed rates are close to the configured
  rates.
- **Preconditions:** MV-2.1.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-standard.json --seed 42 --out out\mv\run-standard | Out-Null
pnpm --silent dataforge chaos plan --run out\mv\run-standard --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out\mv\plan-standard
```

- **Expected:** `18,479 events`; `delay 931 of 18,479 events 5.04% (configured 5.00%)`,
  `reorder 256 of 12,279 eligible 2.08% (configured 2.00%)`,
  `duplicate 571 of 18,479 delivered 3.09% (configured 3.00%)`;
  `315 events delivered after a later event of their aggregate (395 inverted pairs in 310
  aggregates)`; `done in` well under a second (about 430 ms here).
- **How to read it:** with about 18,000 independent draws, the observed rates land within a tenth
  of a percentage point of the configured ones; the automated test allows 0.5 points. Because the
  draws are seeded, this result is the same on every run and every machine, not "usually close".
- **Failure:** an observed rate more than 0.5 percentage points away from its configured rate.

## MV-2.11 — Bad input is rejected

- **Verifies:** invalid profiles, chaos seeds and options are rejected with the path of each
  problem, and nothing is written.
- **Preconditions:** MV-2.2.

```powershell
'{"formatVersion":1,"name":"broken","faults":{"delay":{"rate":1.5},"dealy":{"rate":0.1},"reorder":{"distance":{"min":3,"max":1}}}}' | Set-Content out\mv\broken.json
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile out\mv\broken.json --chaos-seed 7 --out out\mv\plan-never; $LASTEXITCODE
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/none.json --chaos-seed "not valid" --out out\mv\plan-never; $LASTEXITCODE
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/none.json --chaos-seed 7 --out out\mv\run-a; $LASTEXITCODE
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/none.json --chaos-seed 7 --out out\mv\plan-a; $LASTEXITCODE
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-a --event evt_ord_999999_1; $LASTEXITCODE
Test-Path out\mv\plan-never
```

- **Expected:**
  - `Invalid chaos profile:` with three problems: `faults.delay.rate: Too big: expected number to be
    <=1`, `faults.reorder.distance.max: "min" must be less than or equal to "max"` and
    `faults: Unrecognized key: "dealy"`; exit code `2`;
  - `Invalid chaos seed "not valid": use 1-128 characters ...`, exit code `2`;
  - `--out must not be the run directory ...`, exit code `2`;
  - `Output directory is not empty: ...plan-a` and `Use --force to overwrite the plan files in it.`,
    exit code `2`;
  - `Event "evt_ord_999999_1" is not in the canonical log. ...`, exit code `1`;
  - `False` (no plan directory was created).
- **Failure:** any exit code `0`, or `True` from `Test-Path`.

## MV-2.12 — Edited runs, edited plans and mismatched plans are refused

- **Verifies:** nothing is planned from an edited canonical log, and `explain` refuses a plan that
  was edited or that belongs to another run.
- **Preconditions:** MV-2.2. Each step works on a copy.

```powershell
Copy-Item out\mv\run-a out\mv\t-run -Recurse
$p = (Resolve-Path out\mv\t-run\events.jsonl).Path
[IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"priceMinor":8991', '"priceMinor":8992'))
pnpm --silent dataforge chaos plan --run out\mv\t-run --profile chaos-profiles/none.json --chaos-seed 7 --out out\mv\plan-never; $LASTEXITCODE

Copy-Item out\mv\plan-a out\mv\t-plan -Recurse
$p = (Resolve-Path out\mv\t-plan\delivery-plan.jsonl).Path
[IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"kind":"duplicate"', '"kind":"original"'))
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\t-plan --event evt_ord_000078_1; $LASTEXITCODE

pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 43 --out out\mv\run-43 | Out-Null
pnpm --silent dataforge explain --run out\mv\run-43 --plan out\mv\plan-a --event evt_ord_000078_1; $LASTEXITCODE
```

- **Expected:**
  - edited run: `events.jsonl in ...t-run does not match the checksum in manifest.json: the run was
    modified.`, exit code `2`;
  - edited plan: `delivery-plan.jsonl in ...t-plan does not match the checksum in
    delivery-summary.json: the plan was modified.`, exit code `2`;
  - plan of another run: `The plan in ...plan-a was made for a different canonical log.` with
    `plan:  events.jsonl sha256 01b57d64... (seed 42, ...)` and
    `run:   events.jsonl sha256 9ce42b8c... (seed 43, ...)`, exit code `2`.
- **How to read it:** a plan only makes sense for the exact log it was made from. The plan records
  that log's SHA-256 and the checksums of its own files, so an explanation is never built from an
  edited or mismatched plan.
- **Failure:** a plan written from the edited run, or an explanation printed from an edited or
  mismatched plan.

## MV-2.13 — The determinism guard covers the chaos planner

- **Verifies:** lint blocks machine-clock and random calls in `packages/chaos`, as in
  `packages/core`.
- **Preconditions:** MV-2.1.

```powershell
Set-Content packages\chaos\src\guard-probe.ts "export const probe = (): number => Math.random() + Date.now();"
pnpm lint
Remove-Item packages\chaos\src\guard-probe.ts
pnpm lint
```

- **Expected:** the first lint fails on `packages\chaos\src\guard-probe.ts` with
  `'Math.random' is restricted ... Use a RandomStream derived from the run seed` and
  `'Date.now' is restricted ...`; the second lint is clean.
- **Failure:** the first lint passes.

---

Clean up afterwards with `Remove-Item out -Recurse -Force` (`out\` is git-ignored).

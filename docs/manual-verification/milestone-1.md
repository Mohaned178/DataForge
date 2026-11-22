# Manual Verification — Milestone 1: Deterministic Simulation Core

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. `--silent` hides pnpm's own `$ node ...` echo line.

CLI exit codes: **0** success, **1** a check failed, **2** invalid input.

Self-check: `scripts/verification/milestone-1.ps1` runs these same cases with the same expected values
and prints PASS/FAIL per case. It writes to `out\self-check`; the hand-run steps below use `out\mv`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-1.ps1
```

---

## MV-1.1 — Install, build and run the automated checks

- **Verifies:** the workspace installs, type-checks, lints and passes every automated test.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `Test Suites: 8 passed, 8 total` and `Tests: 116 passed, 116 total`; nothing after
  `$ eslint .`; `Done` for both packages in the build.
- **Failure:** any `error TS...`, an ESLint error, a failed test, or an `ERR_PNPM_...` message.

## MV-1.2 — Generate a run and look at it

- **Verifies:** generation works and writes the four run files.
- **Preconditions:** MV-1.1.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\run-a
$LASTEXITCODE
Get-ChildItem out\mv\run-a | Format-Table Name, Length
(Get-Content out\mv\run-a\events.jsonl).Count
Get-Content out\mv\run-a\events.jsonl -TotalCount 1
```

- **Expected:**
  - exit code `0`;
  - `events 472`: ProductCreated 12, CustomerRegistered 25, OrderCreated 120, PaymentFailed 29,
    PaymentCompleted 108, OrderCancelled 11, ShipmentCreated 98, ShipmentDelivered 69;
  - file sizes `events.jsonl` 146142, `expected-state.json` 135526, `manifest.json` 1101,
    `scenario.resolved.json` 1145;
  - `472` lines; the first line is `ProductCreated` for `prd_000001`, "Deluxe Cotton Sneakers",
    price 8991.
- **How to read it:** keys are alphabetical on purpose (canonical JSON), so identical content is
  always identical bytes. `eventTimeMs` is milliseconds since the scenario epoch, not Unix time.
- **Failure:** non-zero exit code, missing files, or different counts.

## MV-1.3 — Same seed, same files

- **Verifies:** two separate runs with the same scenario and seed produce byte-identical files.
- **Preconditions:** MV-1.2.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\run-b
Get-FileHash out\mv\run-a\*, out\mv\run-b\* | Sort-Object { Split-Path $_.Path -Leaf } | Format-Table Hash, Path -AutoSize
(Get-Content out\mv\run-a\manifest.json -Raw | ConvertFrom-Json).files.'events.jsonl'.sha256
```

- **Expected:** each file name has the same hash in `run-a` and `run-b`. `events.jsonl` is
  `01B57D640AB12E33702CCB72339FD00552E6B37B3FDDCE4DFF7A5A8C0CCA42DE` and `expected-state.json` is
  `3546842D89241F81B31BD2BFAA11916FFF0EE04CC400195A70B4C2E6BEFF2101` (the values pinned in
  `packages/core/test/golden.test.ts`). The manifest prints the same events hash in lower case.
- **How to read it:** identical checksums mean identical bytes, so generation is deterministic across
  separate processes.
- **Failure:** any hash that differs between the two runs (a determinism bug).

## MV-1.4 — A different seed gives a different world

- **Verifies:** the seed changes the generated world but not the scenario.
- **Preconditions:** MV-1.2.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 43 --out out\mv\run-c
foreach ($f in 'events.jsonl','expected-state.json','scenario.resolved.json') { '{0,-24} same as seed 42: {1}' -f $f, ((Get-FileHash "out\mv\run-a\$f").Hash -eq (Get-FileHash "out\mv\run-c\$f").Hash) }
```

- **Expected:** `events 456`; the same scenario hash `sha256:3afbcf1a...`; then `False`, `False`,
  `True`.
- **Failure:** `True` for the event log, or `False` for the scenario.

## MV-1.5 — Verify a clean run

- **Verifies:** an untouched run passes every independent check.
- **Preconditions:** MV-1.2.

```powershell
pnpm --silent dataforge verify --run out\mv\run-a; $LASTEXITCODE
```

- **Expected:** seven `OK` lines (checksum x3, parse, replay, state, reproduce), `Result: PASS`,
  exit code `0`. *state* means replaying the events rebuilt `expected-state.json` byte for byte;
  *reproduce* means regenerating from the scenario and seed gave the same events.
- **Failure:** any `FAIL`.

## MV-1.6 — Tampering is detected

- **Verifies:** `verify` catches an edited event, a missing event, and an edited expected state.
- **Preconditions:** MV-1.2. Each step works on a copy of `run-a`.

```powershell
# a) change one payment amount
Copy-Item out\mv\run-a out\mv\t-amount -Recurse
$p = (Resolve-Path out\mv\t-amount\events.jsonl).Path
[IO.File]::WriteAllText($p, ([regex]'"amountMinor":\d+').Replace([IO.File]::ReadAllText($p), '"amountMinor":1', 1))
pnpm --silent dataforge verify --run out\mv\t-amount; $LASTEXITCODE
```

- **Expected (a):** `checksum events.jsonl FAIL` with both hashes;
  `replay FAIL` at `Event #15 evt_ord_000115_2 (PaymentCompleted)`:
  `[payment.amount-matches-order] payment amount 1 differs from order total 25188`;
  `state SKIP`; `reproduce OK` (the original world is still reproducible from scenario + seed);
  `Result: FAIL`, exit code `1`.

```powershell
# b) delete one event
Copy-Item out\mv\run-a out\mv\t-delete -Recurse
$p = (Resolve-Path out\mv\t-delete\events.jsonl).Path
$kept = [IO.File]::ReadAllLines($p) | Where-Object { $_ -notmatch '"eventId":"evt_ord_000007_1"' }
[IO.File]::WriteAllText($p, (($kept -join "`n") + "`n"))
pnpm --silent dataforge verify --run out\mv\t-delete; $LASTEXITCODE
```

- **Expected (b):** `Event #281 evt_ord_000038_5 (ShipmentDelivered)` with
  `[log.sequence] expected sequence 280, got 281`, exit code `1`: the sequence gap exposes the
  missing event.

```powershell
# c) change the expected state
Copy-Item out\mv\run-a out\mv\t-state -Recurse
$p = (Resolve-Path out\mv\t-state\expected-state.json).Path
[IO.File]::WriteAllText($p, ([IO.File]::ReadAllText($p) -replace '"revenueMinor": \d+', '"revenueMinor": 999'))
pnpm --silent dataforge verify --run out\mv\t-state; $LASTEXITCODE
```

- **Expected (c):** `state FAIL`, `first difference at line 5511`, replayed `2525664` versus file
  `999`, exit code `1`.
- **Failure (any step):** `Result: PASS` on an edited run.

## MV-1.7 — Bad input is rejected

- **Verifies:** invalid scenarios, invalid seeds and non-empty output folders are refused before
  anything is written.
- **Preconditions:** MV-1.2 (so `out\mv` exists).

```powershell
'{ "formatVersion": 1, "name": "broken", "orders": { "count": 10, "itemsPerOrder": { "min": 3, "max": 2 } }, "payments": { "failureRate": 1.5 }, "customers": { "cout": 5 } }' | Set-Content out\mv\broken.json
pnpm --silent dataforge generate --scenario out\mv\broken.json --seed 42 --out out\mv\broken; $LASTEXITCODE; Test-Path out\mv\broken
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed "bad seed" --out out\mv\x; $LASTEXITCODE
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\run-a; $LASTEXITCODE
```

- **Expected:**
  - three problems: `customers: Unrecognized key: "cout"`,
    `orders.itemsPerOrder.max: "min" must be less than or equal to "max"`,
    `payments.failureRate: Too big...`; exit code `2`; `Test-Path` prints `False`;
  - `Invalid seed "bad seed"...`, exit code `2`;
  - `Output directory is not empty ... Use --force`, exit code `2`.
- **Failure:** exit code `0`, or files written for invalid input.

## MV-1.8 — Adding an order leaves existing orders unchanged

- **Verifies:** randomness is isolated per entity: one more order changes nothing that existed.
- **Preconditions:** MV-1.2.

```powershell
$s = Get-Content scenarios\ecommerce-small.json -Raw | ConvertFrom-Json; $s.orders.count = 121
$s | ConvertTo-Json -Depth 10 | Set-Content out\mv\small-121.json
pnpm --silent dataforge generate --scenario out\mv\small-121.json --seed 42 --out out\mv\run-121
$a = Select-String -Path out\mv\run-a\events.jsonl -Pattern '"aggregateId":"ord_000050"' | ForEach-Object { $_.Line -replace '"sequence":\d+,', '' }
$b = Select-String -Path out\mv\run-121\events.jsonl -Pattern '"aggregateId":"ord_000050"' | ForEach-Object { $_.Line -replace '"sequence":\d+,', '' }
"ord_000050: $($a.Count) vs $($b.Count) events, identical: " + (($a -join "`n") -eq ($b -join "`n"))
(Get-FileHash out\mv\run-a\events.jsonl).Hash -eq (Get-FileHash out\mv\run-121\events.jsonl).Hash
```

- **Expected:** `events 474` with `OrderCreated 121`; `ord_000050: 3 vs 3 events, identical: True`;
  then `False` for the whole file. `sequence` is stripped because it is a position in the global
  log and may shift. Any order from `ord_000001` to `ord_000120` gives the same result.
- **Failure:** `identical: False`.

## MV-1.9 — Read one order's history

- **Verifies:** order lifecycles are sensible and the expected state agrees with the events.
- **Preconditions:** MV-1.2.

```powershell
pnpm --silent dataforge timeline --run out\mv\run-a --aggregate ord_000061
pnpm --silent dataforge timeline --run out\mv\run-a --aggregate ord_000006
$state = Get-Content out\mv\run-a\expected-state.json -Raw | ConvertFrom-Json
$state.orders | Where-Object orderId -eq 'ord_000006' | Format-List orderId, status, totalMinor, amountPaidMinor, paymentAttempts, failedPaymentAttempts, shipmentId
$state.payments | Where-Object orderId -eq 'ord_000006' | Format-Table paymentId, attempt, status, amountMinor, failureReason
pnpm --silent dataforge timeline --run out\mv\run-a --aggregate ord_999999; $LASTEXITCODE
```

- **Expected:**
  - `ord_000061`: three `PaymentFailed`, then `OrderCancelled reason=PAYMENT_FAILED`;
  - `ord_000006`: created, `PaymentFailed` (`PROCESSOR_TIMEOUT`), `PaymentCompleted` attempt 2,
    shipped, delivered, with event times always increasing;
  - expected state: `DELIVERED`, `totalMinor` = `amountPaidMinor` = 37864, 2 attempts with 1
    failed, `shp_000006`; payments `pay_000006_1` FAILED and `pay_000006_2` COMPLETED;
  - the unknown order prints `No events found`, exit code `1`.
- **Failure:** times going backwards, or a state that contradicts the timeline.

## MV-1.10 — The resolved scenario is a complete recipe

- **Verifies:** `scenario.resolved.json` plus the seed reproduces the run exactly.
- **Preconditions:** MV-1.2.

```powershell
pnpm --silent dataforge generate --scenario out\mv\run-a\scenario.resolved.json --seed 42 --out out\mv\run-again
(Get-FileHash out\mv\run-a\events.jsonl).Hash -eq (Get-FileHash out\mv\run-again\events.jsonl).Hash
(Get-FileHash out\mv\run-a\manifest.json).Hash -eq (Get-FileHash out\mv\run-again\manifest.json).Hash
```

- **Expected:** `True`, `True`.
- **Failure:** either is `False`.

## MV-1.11 — The specification's example size

- **Verifies:** 1,000 customers and 5,000 orders generate and verify quickly.
- **Preconditions:** MV-1.1.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-standard.json --seed 42 --out out\mv\standard
Measure-Command { pnpm --silent dataforge verify --run out\mv\standard | Out-Host }
```

- **Expected:** `events 18,479`; orders `PENDING_PAYMENT 6, PAID 358, SHIPPED 2,022,
  DELIVERED 2,369, CANCELLED 245`; generation in about half a second; `Result: PASS` in about a
  second. Many orders are SHIPPED but not DELIVERED because delivery takes 1-5 days and late orders
  are still in transit when the 7-day window ends. That is intended.
- **Failure:** any `FAIL`, or it takes much longer than a few seconds.

## MV-1.12 — The determinism guard

- **Verifies:** lint blocks machine-clock and random calls in `packages/core`.
- **Preconditions:** MV-1.1.

```powershell
Set-Content packages\core\src\guard-probe.ts "export const probe = (): number => Math.random() + Date.now();"
pnpm lint
Remove-Item packages\core\src\guard-probe.ts
pnpm lint
```

- **Expected:** the first lint fails with `'Math.random' is restricted ... Use a RandomStream derived
  from the run seed` and `'Date.now' is restricted ...`; the second lint is clean.
- **Failure:** the first lint passes.

---

Clean up afterwards with `Remove-Item out -Recurse -Force` (`out\` is git-ignored).

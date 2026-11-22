# Manual Verification — Milestone 3: Validation Engine + Reference Targets

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. `--silent` hides pnpm's own `$ node ...` echo line. Each case builds on the earlier
ones, so run them in order.

CLI exit codes: **0** success (for `validate`: the actual state is correct), **1** a check failed
(for `validate`: there are findings), **2** invalid input (bad file, edited run or plan, a plan the
target did not consume).

Words used below:

- **target**: the pipeline under test. Milestone 3 ships two reference targets that run in process:
  - `correct` ignores an `eventId` it already has, applies each order's events in version order
    (parking an event that arrives before its predecessor), and waits until an order's customer
    and products exist;
  - `naive` applies every message as it arrives: a create overwrites the row, the last message to
    arrive decides the status, every copy is counted, and an update of a row that does not exist
    yet is silently lost.
- **actual state** (`actual-state.json`): the state a target ends in, in the same shape as
  `expected-state.json`.
- **finding**: one way the actual state is wrong, for one entity, in one category
  (`missing-entity`, `status-mismatch`, `double-processing`, `referential-integrity`, ...).
- **cause**: an event whose delivery was abnormal (delayed, reordered, duplicated, retried, lost,
  or overtaken) on an aggregate the entity depends on. Causes are hints, listed most likely first.
  "Not explained by any delivery fault" means no fault touched those aggregates, which points at a
  processing bug or a state edited by hand.

Self-check: `scripts/verification/milestone-3.ps1` runs these same cases with the same expected values
and prints PASS/FAIL per case. It writes to `out\self-check`; the hand-run steps below use `out\mv`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-3.ps1
```

---

## MV-3.1 — Install, build and run the automated checks

- **Verifies:** the workspace, now with `@dataforge/validation` and `@dataforge/targets`, installs,
  type-checks, lints and passes every automated test.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `pnpm -r typecheck` lists five projects (`packages/core`, `packages/chaos`,
  `packages/targets`, `packages/validation`, `apps/cli`); `Test Suites: 19 passed, 19 total` and
  `Tests: 286 passed, 286 total`; nothing after `$ eslint .`; `Done` for all five in the build.
- **Failure:** any `error TS...`, an ESLint error, a failed test, or an `ERR_PNPM_...` message.

## MV-3.2 — Zero faults: both targets reach the expected state

- **Verifies:** with perfect delivery, both reference targets end in exactly the expected state and
  `validate` passes. This is the baseline: everything that fails later is caused by delivery.
- **Preconditions:** MV-3.1. Starts from an empty `out\mv`.

```powershell
if (Test-Path out\mv) { Remove-Item out\mv -Recurse -Force }
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\run-a | Out-Null
foreach ($p in 'none', 'spec-example', 'duplicates-only', 'reorders-only', 'flaky-network', 'lossy') {
  pnpm --silent dataforge chaos plan --run out\mv\run-a --profile "chaos-profiles/$p.json" --chaos-seed 7 --out "out\mv\plan-$p" | Out-Null
}
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-none --target correct --out out\mv\none-correct
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-none --target naive --out out\mv\none-naive | Out-Null
Get-FileHash out\mv\none-correct\actual-state.json, out\mv\none-naive\actual-state.json | Format-Table Hash
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\none-correct\actual-state.json --plan out\mv\plan-none
$LASTEXITCODE
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\none-naive\actual-state.json --plan out\mv\plan-none | Select-Object -Last 1
```

- **Expected:**
  - `deliver` prints `delivered 472 messages: 472 distinct events, 0 redeliveries; 0 failed
    attempts never reached the target`, then `0 redeliveries ignored`, `0 events parked` and
    `parked none: every received event was applied`;
  - both hashes are `AF4A8046F579EB7123F45B68C594C548A7543FB522DC411EE0930F7E8455AA74`;
  - `validate` prints `checked 12/12 products, 25/25 customers, 120/120 orders, 137/137 payments,
    98/98 shipments (actual/expected), 16 invariants`, `findings 0` with every category at 0,
    and `Result: PASS (the actual state matches the expected state and satisfies every invariant)`;
  - exit code `0`; the naive target's last line is the same `Result: PASS ...`.
- **How to read it:** the two targets are built very differently, yet with no faults they write the
  same bytes, which equal the expected records. `actual-state.json` contains only the five
  collections; `target-run.json` beside it records which plan and run it came from.
- **Failure:** different hashes, any finding, or a non-zero exit code.

## MV-3.3 — The specification's example: correct passes, naive fails

- **Verifies:** under the spec's example faults (5% delayed, 3% duplicated, 2% reordered), the
  correct target still reaches the expected state, the naive one does not, and every finding of the
  naive target is linked to a delivery fault.
- **Preconditions:** MV-3.2.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-spec-example --target correct --out out\mv\spec-correct
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\spec-correct\actual-state.json --plan out\mv\plan-spec-example | Select-Object -Last 1
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-spec-example --target naive --out out\mv\spec-naive | Select-String 'updates lost'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\spec-naive\actual-state.json --plan out\mv\plan-spec-example --limit 4
$LASTEXITCODE
```

- **Expected:**
  - correct: `delivered 486 messages: 472 distinct events, 14 redeliveries`,
    `14 redeliveries ignored (eventId already received)`,
    `11 events parked until their predecessor or referenced entities arrived`, then
    `Result: PASS ...`;
  - naive: `6 updates lost (the row did not exist yet when the message arrived)`;
  - validate naive: `findings 48`: `status-mismatch 8`, `field-mismatch 14`,
    `double-processing 8`, `invariant-violation 18`, the other four categories 0;
    `explained 48 of 48 findings are linked to abnormal deliveries; 0 are not explained by any
    delivery fault`;
  - first line under `Most likely causes`:
    `evt_ord_000045_1 OrderCreated arrived after evt_ord_000045_2 [reorder] 7 findings`;
  - four findings, then `Result: FAIL (48 findings)`; exit code `1`.
- **How to read it:** both targets received the same 486 messages. The correct one ignored the 14
  redeliveries and held back 11 events that arrived too early. The naive one applied everything:
  `evt_ord_000045_1` (the order's creation) arrived after its payment, so the payment update was
  lost and the order was then created as unpaid; that one fault explains 7 findings.
  *Most likely causes* counts each finding under its first cause; *Findings* lists each wrong
  entity with its causes.
- **Failure:** the correct target has a finding, the naive one has none, or a finding is not
  explained.

## MV-3.4 — Duplicates: the naive target charges twice

- **Verifies:** a duplicated `PaymentCompleted` makes a non-idempotent target charge the order and
  the customer twice, the finding is `double-processing`, and it names the duplicated event.
- **Preconditions:** MV-3.2.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-duplicates-only --target naive --out out\mv\dup-naive | Select-String 'delivered'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\dup-naive\actual-state.json --plan out\mv\plan-duplicates-only --limit 100 | Select-String '^ +(findings|double-processing|invariant-violation) +[0-9,]+$|ord_000018 |cus_000009 .*double' -Context 0,1
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-duplicates-only --event evt_ord_000018_3 | Select-Object -Skip 5
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-duplicates-only --target correct --out out\mv\dup-correct | Select-String 'ignored'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\dup-correct\actual-state.json --plan out\mv\plan-duplicates-only | Select-Object -Last 1
```

- **Expected:**
  - `delivered 527 messages: 472 distinct events, 55 redeliveries`;
  - `findings 58`, `double-processing 36`, `invariant-violation 22`;
  - `customer cus_000009 double-processing orderCount is 24, expected 22; totalPaidMinor is
    597698, expected 507224`, cause `evt_ord_000018_3 PaymentCompleted, delivered 2 times
    [duplicate]`;
  - `order ord_000018 double-processing amountPaidMinor is 7000, expected 3500 (2x);
    paymentAttempts is 3, expected 2`, then
    `amountPaidMinor 7000 exceeds totalMinor 3500 [order.paid-within-total]` and
    `paymentAttempts is 3 but the order has 2 payment records [order.payment-counters]`, each
    with the cause `evt_ord_000018_3 PaymentCompleted, delivered 2 times [duplicate]`;
  - `explain`: attempt `att_ord_000018_3_2 duplicate #125 ... +26,360 ms DELIVERED duplicate
    copy 1 of 1`, and `Outcome: delivered 2 times with the same eventId (first at position
    #124)`;
  - correct: `55 redeliveries ignored`, then `Result: PASS ...`.
- **How to read it:** order `ord_000018` costs 3500 and was paid once in the simulated world. The
  payment message arrived twice, 26 seconds apart, with the same `eventId`; the naive target added
  3500 both times, so the order shows 7000 paid and its customer is charged twice. *(2x)* marks a
  value that is an exact multiple of the expected one. The correct target recognised the `eventId`
  and ignored the copy.
- **Failure:** no `double-processing` finding, a cause other than the duplicated payment, or the
  correct target failing.

## MV-3.5 — Reorders: the naive target ends orders in the wrong status

- **Verifies:** an event delivered after a later event of the same order makes a
  last-arrival-wins target end in the wrong status, and the finding names the reordered event.
- **Preconditions:** MV-3.2.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-reorders-only --target naive --out out\mv\reo-naive | Select-String 'updates lost'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\reo-naive\actual-state.json --plan out\mv\plan-reorders-only --limit 100 | Select-String '^ +(findings|status-mismatch|double-processing) +[0-9,]+$|ord_000020 .*status' -Context 0,1
pnpm --silent dataforge explain --run out\mv\run-a --plan out\mv\plan-reorders-only --event evt_ord_000020_2 | Select-Object -Skip 7
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-reorders-only --target correct --out out\mv\reo-correct | Select-String 'parked until'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\reo-correct\actual-state.json --plan out\mv\plan-reorders-only | Select-Object -Last 1
```

- **Expected:**
  - `21 updates lost`;
  - `findings 80`, `status-mismatch 27`, `double-processing 0`;
  - `order ord_000020 status-mismatch status is PAID, expected DELIVERED`, cause
    `evt_ord_000020_2 PaymentCompleted, arrived after evt_ord_000020_3, evt_ord_000020_4
    [reorder]`; also `status is PAID but shipmentId is shp_000020 [order.shipment-status]`;
  - `explain`: `reorder: moved behind evt_ord_000020_4 (2 later)` and
    `Aggregate order: OUT OF ORDER`, listing `evt_ord_000020_3 v3 ShipmentCreated` and
    `evt_ord_000020_4 v4 ShipmentDelivered`;
  - correct: `31 events parked until their predecessor or referenced entities arrived`, then
    `Result: PASS ...`.
- **How to read it:** in the simulated world, order 20 was paid, shipped, then delivered. The payment
  message reached the target last; the naive target set the status from it, so the order ends
  `PAID`, which also contradicts its own shipment record (the invariant finding). The correct target
  parked the shipment events until the payment arrived, then applied all three in order.
  Reorders only mis-order, so there is no double processing.
- **Failure:** no `status-mismatch`, a cause that is not a reorder, or the correct target failing.

## MV-3.6 — The correct target passes every profile that loses nothing

- **Verifies:** the correct target reaches exactly the expected state under every example profile
  without loss, including retries and all four faults at once.
- **Preconditions:** MV-3.2 to MV-3.5.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-flaky-network --target correct --out out\mv\flaky-correct | Select-String 'delivered'
foreach ($d in 'none-correct', 'spec-correct', 'dup-correct', 'reo-correct', 'flaky-correct') {
  $p = (Get-Content "out\mv\$d\target-run.json" -Raw | ConvertFrom-Json).plan.profile.name
  $r = pnpm --silent dataforge validate --run out\mv\run-a --actual "out\mv\$d\actual-state.json" --plan "out\mv\plan-$p" | Select-Object -Last 1
  '{0,-14} {1,-16} exit {2}  {3}  {4}' -f $d, $p, $LASTEXITCODE, (Get-FileHash "out\mv\$d\actual-state.json").Hash.Substring(0, 12), $r
}
```

- **Expected:**
  - `delivered 509 messages: 472 distinct events, 37 redeliveries; 33 failed attempts never
    reached the target`;
  - five rows, profiles `none`, `spec-example`, `duplicates-only`, `reorders-only` and
    `flaky-network`, each `exit 0  AF4A8046F579  Result: PASS ...`.
- **How to read it:** whatever the faults, the correct target writes the same bytes as with no
  faults. Failed attempts never reach a target; only their successful retries do.
- **Failure:** any row with exit 1 or a different hash.

## MV-3.7 — Lost events: the correct target fails, and every finding points at a loss

- **Verifies:** when the profile allows loss, no consumer can rebuild what it never received: the
  correct target fails too, its state stays consistent (no invariant breaks), and every finding is
  linked to a lost event.
- **Preconditions:** MV-3.2.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-lossy --target correct --out out\mv\lossy-correct | Select-String 'delivered|parked  '
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\lossy-correct\actual-state.json --plan out\mv\plan-lossy --report out\mv\lossy-correct-report.json --limit 3
$report = Get-Content out\mv\lossy-correct-report.json -Raw | ConvertFrom-Json
@($report.findings | Where-Object { @($_.causes | Where-Object { $_.lost }).Count -eq 0 }).Count
```

- **Expected:**
  - `delivered 471 messages: 450 distinct events, 21 redeliveries; 104 failed attempts never
    reached the target`;
  - `parked 35 events never applied (what they wait for never arrived): evt_ord_000014_4,
    evt_ord_000015_3, ...`;
  - `findings 81`: `missing-entity 40`, `status-mismatch 17`, `field-mismatch 24`,
    `invariant-violation 0`; `explained 81 of 81 findings`;
  - first cause `evt_ord_000015_2 PaymentFailed LOST after 3 failed attempts [transientFailure]
    6 findings`;
  - the first finding is `customer cus_000001 field-mismatch totalPaidMinor is 83574, expected
    166323`, caused by `evt_ord_000041_3 PaymentCompleted, LOST after 3 failed attempts`;
  - `Result: FAIL (81 findings)`, and the last command prints `0` (no finding without a lost cause).
- **How to read it:** 22 events were lost. The correct target waits for a lost event's successors
  forever (35 parked events), so payments and shipments are missing and orders stop early. Each
  of those findings is explained by a loss, not by the target. Compare with the naive target under
  the same profile, which also breaks invariants:
  `pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-lossy --target naive --out out\mv\lossy-naive`.
- **Failure:** the correct target passes, an invariant breaks, or the last command prints a
  number other than 0.

## MV-3.8 — Same inputs: same actual state, same report

- **Verifies:** delivery and validation are deterministic across separate processes.
- **Preconditions:** MV-3.3.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-spec-example --target naive --out out\mv\spec-naive-again | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\spec-naive\actual-state.json --plan out\mv\plan-spec-example --report out\mv\report-1.json | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\spec-naive-again\actual-state.json --plan out\mv\plan-spec-example --report out\mv\report-2.json | Out-Null
Get-FileHash out\mv\spec-naive\actual-state.json, out\mv\spec-naive-again\actual-state.json, out\mv\report-1.json, out\mv\report-2.json | Format-Table Hash, Path
```

- **Expected:** both actual states
  `A47FBBB75451D59707B0E69CF2FEBDAF5D96BC845A94746285AE68DA46A81877`; both reports
  `51C6D6331A95CCF3CB0DDD1C94B90AD98E9CEC5C3E50D73A30A865F864945B44`.
- **How to read it:** identical hashes mean identical bytes. The report holds no timestamps or
  paths, so these hashes are the same on any machine.
- **Failure:** any two hashes in a pair differ, or differ from the values above.

## MV-3.9 — Hand-mutated actual states are caught in the right category

- **Verifies:** the validator detects a dropped order (`missing-entity`), a doubled payment
  (`double-processing`), a wrong status (`status-mismatch`) and a dangling reference
  (`referential-integrity`), and reports that no delivery fault explains them.
- **Preconditions:** MV-3.2. Each mutation edits a copy of the zero-fault correct state, and is
  validated against the zero-fault plan.

```powershell
New-Item -ItemType Directory -Force out\mv\mutated | Out-Null
$base = 'out\mv\none-correct\actual-state.json'
$s = Get-Content $base -Raw | ConvertFrom-Json
$s.orders = @($s.orders | Where-Object { $_.orderId -ne 'ord_000007' })
$s | ConvertTo-Json -Depth 10 | Set-Content out\mv\mutated\dropped-order.json
$s = Get-Content $base -Raw | ConvertFrom-Json
($s.orders | Where-Object { $_.orderId -eq 'ord_000007' }).amountPaidMinor = 38916
$s | ConvertTo-Json -Depth 10 | Set-Content out\mv\mutated\doubled-payment.json
$s = Get-Content $base -Raw | ConvertFrom-Json
($s.orders | Where-Object { $_.orderId -eq 'ord_000007' }).status = 'SHIPPED'
$s | ConvertTo-Json -Depth 10 | Set-Content out\mv\mutated\wrong-status.json
$s = Get-Content $base -Raw | ConvertFrom-Json
($s.orders | Where-Object { $_.orderId -eq 'ord_000007' }).customerId = 'cus_999999'
$s | ConvertTo-Json -Depth 10 | Set-Content out\mv\mutated\dangling-customer.json
foreach ($m in 'dropped-order', 'doubled-payment', 'wrong-status', 'dangling-customer') {
  "=== $m"
  pnpm --silent dataforge validate --run out\mv\run-a --actual "out\mv\mutated\$m.json" --plan out\mv\plan-none | Select-String 'not written|explained|^  (customer|order|payment|shipment) '
}
```

- **Expected:** every block starts with `no target-run.json next to it: not written by "dataforge
  deliver"` and `explained 0 of N findings ... N are not explained by any delivery fault`, then:
  - `dropped-order` (5 findings): `order ord_000007 missing-entity expected, but missing from the
    actual state`; `payment pay_000007_1 referential-integrity order ord_000007 does not exist
    [ref.payment-order]`; `shipment shp_000007 referential-integrity ... [ref.shipment-order]`;
    two `customer cus_000011 invariant-violation` lines (`orderCount is 3 but the customer has 2
    orders`, `totalPaidMinor is 65042 but their orders were paid 45584 in total`);
  - `doubled-payment` (3): `order ord_000007 double-processing amountPaidMinor is 38916, expected
    19458 (2x)`, `amountPaidMinor 38916 exceeds totalMinor 19458 [order.paid-within-total]`, and
    `customer cus_000011 invariant-violation totalPaidMinor is 65042 but their orders were paid
    84500 in total`;
  - `wrong-status` (2): `order ord_000007 status-mismatch status is SHIPPED, expected DELIVERED`
    and `status is SHIPPED but shipment shp_000007 is DELIVERED [order.shipment-status]`;
  - `dangling-customer` (4): `order ord_000007 field-mismatch customerId is cus_999999, expected
    cus_000011`, `order ord_000007 referential-integrity customer cus_999999 does not exist
    [ref.order-customer]`, and the two `customer cus_000011 invariant-violation` lines.
  Each finding is followed by `cause: none found; no delivery fault touched this entity's
  aggregates`.
- **How to read it:** one edit usually breaks several facts: dropping an order leaves its payment
  and shipment pointing at nothing, and its customer's counters no longer add up. Findings marked
  with `[...]` come from an invariant (the state contradicts itself); the others from comparing
  with the expected state. Since the plan has no faults, nothing explains these differences: in a
  real test, that points at a bug in the pipeline's processing logic.
- **Failure:** a mutation not detected, detected in another category, or reported as explained.

## MV-3.10 — Bad input is rejected

- **Verifies:** an actual state that breaks the format is rejected with the path of each problem,
  and bad options are refused, with exit code 2 and nothing written.
- **Preconditions:** MV-3.2.

```powershell
$s = Get-Content out\mv\none-correct\actual-state.json -Raw | ConvertFrom-Json
$s.orders[3].status = 'SHIPPPED'
$s.shipments[0] | Add-Member -NotePropertyName 'colour' -NotePropertyValue 'red'
$s | ConvertTo-Json -Depth 10 | Set-Content out\mv\bad-actual.json
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\bad-actual.json
$LASTEXITCODE
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\run-a\expected-state.json
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\nope.json
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-none --target clever --out out\mv\never
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-none --target naive --out out\mv\plan-none
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\none-naive\actual-state.json --limit ten
$LASTEXITCODE
Test-Path out\mv\never
```

- **Expected:**
  - `Invalid actual state:` with
    `orders.3.status: Invalid option: expected one of "PENDING_PAYMENT"|"PAID"|"SHIPPED"|"DELIVERED"|"CANCELLED"`
    and `shipments.0: Unrecognized key: "colour"`; exit code `2`;
  - the expected state is not an actual state: `format: format must be "dataforge.actual-state"`
    and `(root): Unrecognized keys: "lastEventTimeMs", "lastSequence", "summary"`;
  - `Cannot read actual state file: ...nope.json`;
  - `Unknown target "clever". Reference targets: correct, naive.`;
  - `--out must be its own directory: the run and the plan it consumed stay untouched.`;
  - `--limit must be a whole number of findings to print, got "ten".`; exit code `2`;
  - `False` (nothing was created).
- **Failure:** exit code 0 or 1, a missing path, or `out\mv\never` created.

## MV-3.11 — Mismatched and edited inputs are refused or flagged

- **Verifies:** hints never come from the wrong plan, an actual state is never compared with another
  run, an edited run or plan is refused, and an edited actual state is accepted but flagged.
- **Preconditions:** MV-3.3.

```powershell
pnpm --silent dataforge chaos plan --run out\mv\run-a --profile chaos-profiles/spec-example.json --chaos-seed 8 --out out\mv\plan-spec-8 | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\spec-naive\actual-state.json --plan out\mv\plan-spec-8
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 43 --out out\mv\run-43 | Out-Null
pnpm --silent dataforge validate --run out\mv\run-43 --actual out\mv\none-correct\actual-state.json
Copy-Item out\mv\run-a out\mv\t-run -Recurse
$p = (Resolve-Path out\mv\t-run\expected-state.json).Path
[IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"revenueMinor": 2525664', '"revenueMinor": 2525665'))
pnpm --silent dataforge validate --run out\mv\t-run --actual out\mv\none-correct\actual-state.json
Copy-Item out\mv\plan-spec-example out\mv\t-plan -Recurse
$p = (Resolve-Path out\mv\t-plan\delivery-plan.jsonl).Path
[IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"kind":"duplicate"', '"kind":"original"'))
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\t-plan --target naive --out out\mv\never
Copy-Item out\mv\none-correct out\mv\edited-delivery -Recurse
$p = (Resolve-Path out\mv\edited-delivery\actual-state.json).Path
[IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"totalPaidMinor": 65042', '"totalPaidMinor": 65041'))
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\edited-delivery\actual-state.json --plan out\mv\plan-none | Select-String 'EDITED|cus_000011|Result'
```

- **Expected:**
  - wrong plan, exit 2: `... was produced from a different delivery plan, so its findings cannot
    be explained by this one.`, then `target run: profile spec-example, chaos seed 7, ...` and
    `--plan: profile spec-example, chaos seed 8, ...`;
  - other run, exit 2: `... was produced from a different canonical log.`;
  - edited expected state, exit 2: `expected-state.json in ...t-run does not match the checksum in
    manifest.json: the run was modified.`;
  - edited plan, exit 2: `delivery-plan.jsonl in ...t-plan does not match the checksum in
    delivery-summary.json: the plan was modified.`;
  - edited actual state, exit 1: `written by target correct from profile none, chaos seed 7;
    EDITED since (checksum differs from target-run.json)`, `customer cus_000011 field-mismatch
    totalPaidMinor is 65041, expected 65042`, `customer cus_000011 invariant-violation
    totalPaidMinor is 65041 but their orders were paid 65042 in total [customer.total-paid]`, and
    `Result: FAIL (2 findings)`.
- **How to read it:** `target-run.json` ties an actual state to the run and plan it came from, by
  SHA-256. Editing the actual state is allowed (that is how MV-3.9 tests the validator), so it is
  only flagged. Editing the run or the plan would make the comparison or the hints meaningless, so
  those are refused. A value *below* the expected one is a `field-mismatch` (a lost update); above
  it, it would be `double-processing`.
- **Failure:** any of the four refusals passes, or the edited actual state is not flagged.

## MV-3.12 — The specification's example size

- **Verifies:** the full loop on the spec's reference workload (1,000 customers, 5,000 orders),
  and how long it takes.
- **Preconditions:** MV-3.1.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-standard.json --seed 42 --out out\mv\run-standard | Out-Null
pnpm --silent dataforge chaos plan --run out\mv\run-standard --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out\mv\plan-standard | Out-Null
Measure-Command { pnpm --silent dataforge deliver --run out\mv\run-standard --plan out\mv\plan-standard --target correct --out out\mv\standard-correct | Out-Host } | Select-Object TotalSeconds
pnpm --silent dataforge validate --run out\mv\run-standard --actual out\mv\standard-correct\actual-state.json --plan out\mv\plan-standard | Select-String 'checked|Result'
pnpm --silent dataforge deliver --run out\mv\run-standard --plan out\mv\plan-standard --target naive --out out\mv\standard-naive | Select-String 'updates lost'
Measure-Command { pnpm --silent dataforge validate --run out\mv\run-standard --actual out\mv\standard-naive\actual-state.json --plan out\mv\plan-standard --limit 0 | Out-Host } | Select-Object TotalSeconds
```

- **Expected:**
  - correct: `delivered 19,050 messages: 18,479 distinct events, 571 redeliveries`,
    `571 redeliveries ignored`, `393 events parked until their predecessor or referenced entities
    arrived`, `parked none`; `checked 200/200 products, 1,000/1,000 customers, 5,000/5,000
    orders, ...` and `Result: PASS ...`;
  - naive: `266 updates lost`; `findings 1,897`: `status-mismatch 204`, `field-mismatch 432`,
    `double-processing 539`, `invariant-violation 722`; `explained 1,897 of 1,897 findings`;
    `Result: FAIL (1,897 findings)`;
  - each `TotalSeconds` is about 1 to 1.5 here (Node start-up included); a few seconds is fine.
- **Failure:** the correct target fails, a finding is unexplained, or a command takes more than
  about 30 seconds.

## MV-3.13 — The determinism guard covers validation and targets

- **Verifies:** the ESLint determinism guard now also covers `packages/validation` and
  `packages/targets`, so neither can use the machine clock or unseeded randomness.
- **Preconditions:** MV-3.1.

```powershell
Set-Content packages\validation\src\guard-probe.ts 'export const probe = (): number => Math.random() + Date.now();'
Copy-Item packages\validation\src\guard-probe.ts packages\targets\src\guard-probe.ts
pnpm lint
$LASTEXITCODE
Remove-Item packages\validation\src\guard-probe.ts, packages\targets\src\guard-probe.ts
pnpm lint
$LASTEXITCODE
```

- **Expected:** the first `pnpm lint` reports both `packages\validation\src\guard-probe.ts` and
  `packages\targets\src\guard-probe.ts`, each with `'Math.random' is restricted` and
  `'Date.now' is restricted`, and exits with `1`; after removing the probes, `pnpm lint` exits `0`.
- **Failure:** the first lint passes, or a probe file is left behind.

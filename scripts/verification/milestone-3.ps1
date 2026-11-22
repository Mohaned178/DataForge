<#
.SYNOPSIS
    Runs every Milestone 3 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-3.md case by case (same IDs, same commands,
    same expected values). Writes only to out\self-check, never to out\mv where the hand-run
    tests live. Works in Windows PowerShell 5.1 and PowerShell 7.
    Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-3.1 (pnpm install, check, build) when the workspace is already installed and built.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-3.ps1
#>
param([switch]$SkipInstall)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$runA = Join-Path $out 'run-a'
$never = Join-Path $out 'never'
$expectedActual = 'AF4A8046F579EB7123F45B68C594C548A7543FB522DC411EE0930F7E8455AA74'
$naiveSpecActual = 'A47FBBB75451D59707B0E69CF2FEBDAF5D96BC845A94746285AE68DA46A81877'
$naiveSpecReport = '51C6D6331A95CCF3CB0DDD1C94B90AD98E9CEC5C3E50D73A30A865F864945B44'

function Plan-Path([string]$Profile) { Join-Path $out "plan-$Profile" }
function Delivery-Path([string]$Profile, [string]$Target) { Join-Path $out "$Profile-$Target" }

function Invoke-Plan {
    param([string]$Run, [string]$Profile, [string]$ChaosSeed, [string]$Out)
    Invoke-DataForge @('chaos', 'plan', '--run', $Run, '--profile', "chaos-profiles/$Profile.json", '--chaos-seed', $ChaosSeed, '--out', $Out)
}

function Invoke-Deliver {
    param([string]$Run, [string]$Plan, [string]$Target, [string]$Out)
    Invoke-DataForge @('deliver', '--run', $Run, '--plan', $Plan, '--target', $Target, '--out', $Out)
}

function Invoke-Validate {
    param([string]$Run, [string]$Actual, [string[]]$Extra = @())
    Invoke-DataForge (@('validate', '--run', $Run, '--actual', $Actual) + $Extra)
}

function Deliver-Profile {
    param([string]$Profile, [string]$Target)
    Invoke-Deliver $runA (Plan-Path $Profile) $Target (Delivery-Path $Profile $Target)
}

function Validate-Profile {
    param([string]$Profile, [string]$Target, [string[]]$Extra = @())
    Invoke-Validate $runA (Join-Path (Delivery-Path $Profile $Target) 'actual-state.json') (@('--plan', (Plan-Path $Profile)) + $Extra)
}

function Save-Mutation {
    param([string]$Name, [scriptblock]$Change)
    $s = Get-Content (Join-Path (Delivery-Path 'none' 'correct') 'actual-state.json') -Raw | ConvertFrom-Json
    & $Change $s
    $path = Join-Path $out "mutated\$Name.json"
    $s | ConvertTo-Json -Depth 10 | Set-Content $path
    $path
}

Write-Host "DataForge Milestone 3 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

Test-Case 'MV-3.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    foreach ($project in 'packages/validation', 'packages/targets') {
        Assert-Match $check.Text "$project typecheck: Done" "$project type-checked"
    }
    Assert-Match $check.Text 'Test Suites:\s+19 passed, 19 total' 'pnpm check suites'
    Assert-Match $check.Text 'Tests:\s+286 passed, 286 total' 'pnpm check tests'
    Assert-That ($check.Text -notmatch 'error TS\d+') 'pnpm check reported TypeScript errors'
    $build = Invoke-Pnpm @('build')
    Assert-Exit $build 0 'pnpm build'
    Assert-Match $build.Text 'packages/validation build: Done' 'validation package built'
    Assert-Match $build.Text 'packages/targets build: Done' 'targets package built'
}

Test-Case 'MV-3.2' 'Zero faults: both targets reach the expected state' {
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '42', '--out', $runA)) 0 'generate run-a'
    foreach ($profile in 'none', 'spec-example', 'duplicates-only', 'reorders-only', 'flaky-network', 'lossy') {
        Assert-Exit (Invoke-Plan $runA $profile '7' (Plan-Path $profile)) 0 "chaos plan $profile"
    }
    foreach ($target in 'correct', 'naive') {
        $d = Deliver-Profile 'none' $target
        Assert-Exit $d 0 "deliver none $target"
        Assert-Match $d.Text 'delivered\s+472 messages: 472 distinct events, 0 redeliveries; 0 failed attempts never reached the target' "$target messages"
        Assert-Match $d.Text 'parked\s+none: every received event was applied' "$target parked"
        $hash = Get-Sha256 (Join-Path (Delivery-Path 'none' $target) 'actual-state.json')
        Assert-That ($hash -eq $expectedActual) "$target actual-state.json hash is $hash"
        $v = Validate-Profile 'none' $target
        Assert-Exit $v 0 "validate none $target"
        Assert-Match $v.Text 'checked\s+12/12 products, 25/25 customers, 120/120 orders, 137/137 payments, 98/98 shipments \(actual/expected\), 16 invariants' "$target checked"
        Assert-Match $v.Text 'findings\s+0' "$target findings"
        Assert-Match $v.Text 'Result: PASS' "$target result"
    }
    $actual = Get-Content (Join-Path (Delivery-Path 'none' 'correct') 'actual-state.json') -Raw | ConvertFrom-Json
    $expected = Get-Content (Join-Path $runA 'expected-state.json') -Raw | ConvertFrom-Json
    foreach ($c in 'products', 'customers', 'orders', 'payments', 'shipments') {
        $same = ($actual.$c | ConvertTo-Json -Depth 10 -Compress) -eq ($expected.$c | ConvertTo-Json -Depth 10 -Compress)
        Assert-That $same "$c differ from expected-state.json"
    }
}

Test-Case 'MV-3.3' 'The specification''s example: correct passes, naive fails' {
    $c = Deliver-Profile 'spec-example' 'correct'
    Assert-Exit $c 0 'deliver correct'
    Assert-Match $c.Text 'delivered\s+486 messages: 472 distinct events, 14 redeliveries' 'correct messages'
    Assert-Match $c.Text '14 redeliveries ignored \(eventId already received\)' 'correct ignored'
    Assert-Match $c.Text '11 events parked until their predecessor or referenced entities arrived' 'correct parked'
    $v = Validate-Profile 'spec-example' 'correct'
    Assert-Exit $v 0 'validate correct'
    Assert-Match $v.Text 'Result: PASS' 'correct result'
    $n = Deliver-Profile 'spec-example' 'naive'
    Assert-Exit $n 0 'deliver naive'
    Assert-Match $n.Text '6 updates lost \(the row did not exist yet when the message arrived\)' 'naive updates lost'
    $v = Validate-Profile 'spec-example' 'naive'
    Assert-Exit $v 1 'validate naive'
    Assert-Match $v.Text 'findings\s+48' 'naive findings'
    foreach ($pair in @(@('status-mismatch', 8), @('field-mismatch', 14), @('double-processing', 8), @('invariant-violation', 18), @('missing-entity', 0))) {
        Assert-Match $v.Text ("{0}\s+{1}\r?\n" -f $pair[0], $pair[1]) "naive $($pair[0])"
    }
    Assert-Match $v.Text 'explained\s+48 of 48 findings are linked to abnormal deliveries; 0 are not explained by any delivery fault' 'naive explained'
    Assert-Match $v.Text 'evt_ord_000045_1\s+OrderCreated\s+arrived after evt_ord_000045_2 \[reorder\]\s+7 findings' 'top cause'
    Assert-Match $v.Text 'Result: FAIL \(48 findings\)' 'naive result'
}

Test-Case 'MV-3.4' 'Duplicates: the naive target charges twice' {
    $d = Deliver-Profile 'duplicates-only' 'naive'
    Assert-Exit $d 0 'deliver naive'
    Assert-Match $d.Text 'delivered\s+527 messages: 472 distinct events, 55 redeliveries' 'messages'
    $v = Validate-Profile 'duplicates-only' 'naive' @('--limit', '200')
    Assert-Exit $v 1 'validate naive'
    Assert-Match $v.Text 'findings\s+58' 'findings'
    Assert-Match $v.Text 'double-processing\s+36' 'double processing'
    Assert-Match $v.Text 'invariant-violation\s+22' 'invariants'
    Assert-Match $v.Text 'order\s+ord_000018\s+double-processing\s+amountPaidMinor is 7000, expected 3500 \(2x\); paymentAttempts is 3, expected 2' 'order double charge'
    Assert-Match $v.Text 'customer cus_000009\s+double-processing\s+orderCount is 24, expected 22; totalPaidMinor is 597698, expected 507224' 'customer double charge'
    Assert-Match $v.Text 'order\s+ord_000018\s+double-processing\s+amountPaidMinor 7000 exceeds totalMinor 3500 \[order\.paid-within-total\]' 'overpaid invariant'
    Assert-Match $v.Text 'cause: evt_ord_000018_3 PaymentCompleted, delivered 2 times \[duplicate\]' 'cause'
    $c = Deliver-Profile 'duplicates-only' 'correct'
    Assert-Match $c.Text '55 redeliveries ignored' 'correct ignored'
    Assert-Exit (Validate-Profile 'duplicates-only' 'correct') 0 'validate correct'
    $e = Invoke-DataForge @('explain', '--run', $runA, '--plan', (Plan-Path 'duplicates-only'), '--event', 'evt_ord_000018_3')
    Assert-Exit $e 0 'explain'
    Assert-Match $e.Text 'att_ord_000018_3_2\s+duplicate\s+#125\s+.*\+26,360 ms\s+DELIVERED\s+duplicate copy 1 of 1' 'duplicate attempt'
    Assert-Match $e.Text 'Outcome: delivered 2 times with the same eventId \(first at position #124\)' 'explain outcome'
}

Test-Case 'MV-3.5' 'Reorders: the naive target ends orders in the wrong status' {
    $d = Deliver-Profile 'reorders-only' 'naive'
    Assert-Exit $d 0 'deliver naive'
    Assert-Match $d.Text '21 updates lost' 'updates lost'
    $v = Validate-Profile 'reorders-only' 'naive' @('--limit', '200')
    Assert-Exit $v 1 'validate naive'
    Assert-Match $v.Text 'findings\s+80' 'findings'
    Assert-Match $v.Text 'status-mismatch\s+27' 'status mismatches'
    Assert-Match $v.Text 'double-processing\s+0' 'no double processing'
    Assert-Match $v.Text 'order\s+ord_000020\s+status-mismatch\s+status is PAID, expected DELIVERED' 'ord_000020 status'
    Assert-Match $v.Text 'cause: evt_ord_000020_2 PaymentCompleted, arrived after evt_ord_000020_3, evt_ord_000020_4 \[reorder\]' 'ord_000020 cause'
    $c = Deliver-Profile 'reorders-only' 'correct'
    Assert-Match $c.Text '31 events parked until their predecessor or referenced entities arrived' 'correct parked'
    Assert-Exit (Validate-Profile 'reorders-only' 'correct') 0 'validate correct'
    $e = Invoke-DataForge @('explain', '--run', $runA, '--plan', (Plan-Path 'reorders-only'), '--event', 'evt_ord_000020_2')
    Assert-Match $e.Text 'reorder: moved behind evt_ord_000020_4 \(2 later\)' 'explain reorder'
    Assert-Match $e.Text 'Aggregate order: OUT OF ORDER' 'explain out of order'
}

Test-Case 'MV-3.6' 'The correct target passes every profile that loses nothing' {
    $d = Deliver-Profile 'flaky-network' 'correct'
    Assert-Exit $d 0 'deliver flaky-network'
    Assert-Match $d.Text 'delivered\s+509 messages: 472 distinct events, 37 redeliveries; 33 failed attempts never reached the target' 'flaky messages'
    foreach ($profile in 'none', 'spec-example', 'duplicates-only', 'reorders-only', 'flaky-network') {
        $v = Validate-Profile $profile 'correct'
        Assert-Exit $v 0 "validate $profile"
        $hash = Get-Sha256 (Join-Path (Delivery-Path $profile 'correct') 'actual-state.json')
        Assert-That ($hash -eq $expectedActual) "$profile actual-state.json hash is $hash"
    }
    Assert-Exit (Deliver-Profile 'flaky-network' 'naive') 0 'deliver flaky naive'
    $n = Validate-Profile 'flaky-network' 'naive' @('--limit', '0')
    Assert-Exit $n 1 'validate flaky naive'
    Assert-Match $n.Text 'explained\s+119 of 119 findings' 'flaky naive findings'
}

Test-Case 'MV-3.7' 'Lost events: the correct target fails, and every finding points at a loss' {
    $d = Deliver-Profile 'lossy' 'correct'
    Assert-Exit $d 0 'deliver lossy'
    Assert-Match $d.Text 'delivered\s+471 messages: 450 distinct events, 21 redeliveries; 104 failed attempts never reached the target' 'messages'
    Assert-Match $d.Text 'parked\s+35 events never applied \(what they wait for never arrived\): evt_ord_000014_4, evt_ord_000015_3' 'parked'
    $report = Join-Path $out 'lossy-correct-report.json'
    $v = Validate-Profile 'lossy' 'correct' @('--report', $report, '--limit', '3')
    Assert-Exit $v 1 'validate lossy'
    Assert-Match $v.Text 'findings\s+81' 'findings'
    Assert-Match $v.Text 'missing-entity\s+40' 'missing entities'
    Assert-Match $v.Text 'invariant-violation\s+0' 'no invariant broken'
    Assert-Match $v.Text 'explained\s+81 of 81 findings' 'explained'
    Assert-Match $v.Text 'evt_ord_000015_2\s+PaymentFailed\s+LOST after 3 failed attempts \[transientFailure\]\s+6 findings' 'top cause'
    $r = Get-Content $report -Raw | ConvertFrom-Json
    $withoutLoss = @($r.findings | Where-Object { @($_.causes | Where-Object { $_.lost }).Count -eq 0 }).Count
    Assert-That ($withoutLoss -eq 0) "$withoutLoss findings have no lost cause"
}

Test-Case 'MV-3.8' 'Same inputs: same actual state, same report' {
    $again = Join-Path $out 'spec-example-naive-again'
    Assert-Exit (Invoke-Deliver $runA (Plan-Path 'spec-example') 'naive' $again) 0 'deliver again'
    $a = Get-Sha256 (Join-Path (Delivery-Path 'spec-example' 'naive') 'actual-state.json')
    $b = Get-Sha256 (Join-Path $again 'actual-state.json')
    Assert-That ($a -eq $b) 'actual states differ'
    Assert-That ($a -eq $naiveSpecActual) "actual-state.json hash is $a"
    $ta = Get-Sha256 (Join-Path (Delivery-Path 'spec-example' 'naive') 'target-run.json')
    Assert-That ($ta -eq (Get-Sha256 (Join-Path $again 'target-run.json'))) 'target-run.json differs'
    $r1 = Join-Path $out 'report-1.json'
    $r2 = Join-Path $out 'report-2.json'
    Assert-Exit (Validate-Profile 'spec-example' 'naive' @('--report', $r1)) 1 'report 1'
    Assert-Exit (Invoke-Validate $runA (Join-Path $again 'actual-state.json') @('--plan', (Plan-Path 'spec-example'), '--report', $r2)) 1 'report 2'
    $h1 = Get-Sha256 $r1
    Assert-That ($h1 -eq (Get-Sha256 $r2)) 'reports differ'
    Assert-That ($h1 -eq $naiveSpecReport) "report hash is $h1"
}

Test-Case 'MV-3.9' 'Hand-mutated actual states are caught in the right category' {
    New-Item -ItemType Directory -Force (Join-Path $out 'mutated') | Out-Null
    $none = Plan-Path 'none'
    $cases = @(
        @{ Name = 'dropped-order'; Change = { param($s) $s.orders = @($s.orders | Where-Object { $_.orderId -ne 'ord_000007' }) };
           Findings = 5; Patterns = @('order\s+ord_000007\s+missing-entity\s+expected, but missing from the actual state', 'payment\s+pay_000007_1\s+referential-integrity\s+order ord_000007 does not exist \[ref\.payment-order\]', 'shipment shp_000007\s+referential-integrity') },
        @{ Name = 'doubled-payment'; Change = { param($s) ($s.orders | Where-Object { $_.orderId -eq 'ord_000007' }).amountPaidMinor = 38916 };
           Findings = 3; Patterns = @('order\s+ord_000007\s+double-processing\s+amountPaidMinor is 38916, expected 19458 \(2x\)', 'amountPaidMinor 38916 exceeds totalMinor 19458 \[order\.paid-within-total\]') },
        @{ Name = 'wrong-status'; Change = { param($s) ($s.orders | Where-Object { $_.orderId -eq 'ord_000007' }).status = 'SHIPPED' };
           Findings = 2; Patterns = @('order\s+ord_000007\s+status-mismatch\s+status is SHIPPED, expected DELIVERED', 'status is SHIPPED but shipment shp_000007 is DELIVERED \[order\.shipment-status\]') },
        @{ Name = 'dangling-customer'; Change = { param($s) ($s.orders | Where-Object { $_.orderId -eq 'ord_000007' }).customerId = 'cus_999999' };
           Findings = 4; Patterns = @('order\s+ord_000007\s+referential-integrity\s+customer cus_999999 does not exist \[ref\.order-customer\]', 'order\s+ord_000007\s+field-mismatch\s+customerId is cus_999999, expected cus_000011') }
    )
    foreach ($case in $cases) {
        $path = Save-Mutation $case.Name $case.Change
        $v = Invoke-Validate $runA $path @('--plan', $none)
        Assert-Exit $v 1 "validate $($case.Name)"
        Assert-Match $v.Text ("findings\s+{0}\r?\n" -f $case.Findings) "$($case.Name) finding count"
        Assert-Match $v.Text ("explained\s+0 of {0} findings are linked to abnormal deliveries; {0} are not explained" -f $case.Findings) "$($case.Name) unexplained"
        Assert-Match $v.Text 'no target-run\.json next to it' "$($case.Name) source note"
        foreach ($pattern in $case.Patterns) { Assert-Match $v.Text $pattern $case.Name }
    }
}

Test-Case 'MV-3.10' 'Bad input is rejected' {
    $bad = Join-Path $out 'bad-actual.json'
    $s = Get-Content (Join-Path (Delivery-Path 'none' 'correct') 'actual-state.json') -Raw | ConvertFrom-Json
    $s.orders[3].status = 'SHIPPPED'
    $s.shipments[0] | Add-Member -NotePropertyName 'colour' -NotePropertyValue 'red'
    $s | ConvertTo-Json -Depth 10 | Set-Content $bad
    $r = Invoke-Validate $runA $bad
    Assert-Exit $r 2 'invalid actual state'
    Assert-Match $r.Text 'Invalid actual state:' 'invalid header'
    Assert-Match $r.Text 'orders\.3\.status: Invalid option: expected one of "PENDING_PAYMENT"\|"PAID"\|"SHIPPED"\|"DELIVERED"\|"CANCELLED"' 'status path'
    Assert-Match $r.Text 'shipments\.0: Unrecognized key: "colour"' 'unknown key path'
    $r = Invoke-Validate $runA (Join-Path $runA 'expected-state.json')
    Assert-Exit $r 2 'expected state given as actual'
    Assert-Match $r.Text 'format: format must be "dataforge\.actual-state"' 'format message'
    $r = Invoke-Validate $runA (Join-Path $out 'nope.json')
    Assert-Exit $r 2 'missing actual'
    Assert-Match $r.Text 'Cannot read actual state file' 'missing message'
    $r = Invoke-Deliver $runA (Plan-Path 'none') 'clever' $never
    Assert-Exit $r 2 'unknown target'
    Assert-Match $r.Text 'Unknown target "clever"\. Reference targets: correct, naive\.' 'target message'
    $r = Invoke-Deliver $runA (Plan-Path 'none') 'naive' (Plan-Path 'none')
    Assert-Exit $r 2 'deliver into the plan'
    Assert-Match $r.Text '--out must be its own directory' 'out message'
    $r = Invoke-Validate $runA (Join-Path (Delivery-Path 'none' 'naive') 'actual-state.json') @('--limit', 'ten')
    Assert-Exit $r 2 'bad limit'
    Assert-Match $r.Text '--limit must be a whole number of findings to print, got "ten"\.' 'limit message'
    Assert-That (-not (Test-Path $never)) 'never was created'
}

Test-Case 'MV-3.11' 'Mismatched and edited inputs are refused or flagged' {
    $plan8 = Join-Path $out 'plan-spec-example-8'
    Assert-Exit (Invoke-Plan $runA 'spec-example' '8' $plan8) 0 'plan seed 8'
    $r = Invoke-Validate $runA (Join-Path (Delivery-Path 'spec-example' 'naive') 'actual-state.json') @('--plan', $plan8)
    Assert-Exit $r 2 'wrong plan'
    Assert-Match $r.Text 'was produced from a different delivery plan, so its findings cannot be explained by this one' 'wrong plan message'
    Assert-Match $r.Text 'target run: profile spec-example, chaos seed 7' 'target run side'
    Assert-Match $r.Text '--plan:\s+profile spec-example, chaos seed 8' 'plan side'

    $run43 = Join-Path $out 'run-43'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '43', '--out', $run43)) 0 'generate run-43'
    $r = Invoke-Validate $run43 (Join-Path (Delivery-Path 'none' 'correct') 'actual-state.json')
    Assert-Exit $r 2 'actual from another run'
    Assert-Match $r.Text 'was produced from a different canonical log' 'other run message'

    $tRun = Join-Path $out 't-run'
    Copy-Item $runA $tRun -Recurse
    $p = (Resolve-Path (Join-Path $tRun 'expected-state.json')).Path
    [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"revenueMinor": 2525664', '"revenueMinor": 2525665'))
    $r = Invoke-Validate $tRun (Join-Path (Delivery-Path 'none' 'correct') 'actual-state.json')
    Assert-Exit $r 2 'edited expected state'
    Assert-Match $r.Text 'expected-state\.json in .*t-run does not match the checksum in manifest\.json: the run was modified\.' 'edited run message'

    $tPlan = Join-Path $out 't-plan'
    Copy-Item (Plan-Path 'spec-example') $tPlan -Recurse
    $p = (Resolve-Path (Join-Path $tPlan 'delivery-plan.jsonl')).Path
    [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"kind":"duplicate"', '"kind":"original"'))
    $r = Invoke-Deliver $runA $tPlan 'naive' $never
    Assert-Exit $r 2 'deliver an edited plan'
    Assert-Match $r.Text 'delivery-plan\.jsonl in .*t-plan does not match the checksum in delivery-summary\.json: the plan was modified\.' 'edited plan message'

    $edited = Join-Path $out 'edited-delivery'
    Copy-Item (Delivery-Path 'none' 'correct') $edited -Recurse
    $p = (Resolve-Path (Join-Path $edited 'actual-state.json')).Path
    [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"totalPaidMinor": 65042', '"totalPaidMinor": 65041'))
    $r = Invoke-Validate $runA $p @('--plan', (Plan-Path 'none'))
    Assert-Exit $r 1 'edited actual state'
    Assert-Match $r.Text 'written by target correct from profile none, chaos seed 7; EDITED since \(checksum differs from target-run\.json\)' 'edited note'
    Assert-Match $r.Text 'customer cus_000011\s+field-mismatch\s+totalPaidMinor is 65041, expected 65042' 'edited finding'
    Assert-That (-not (Test-Path $never)) 'never was created'
}

Test-Case 'MV-3.12' 'The specification''s example size' {
    $runStandard = Join-Path $out 'run-standard'
    $planStandard = Join-Path $out 'plan-standard'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-standard.json', '--seed', '42', '--out', $runStandard)) 0 'generate standard'
    Assert-Exit (Invoke-Plan $runStandard 'spec-example' '7' $planStandard) 0 'plan standard'
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $c = Invoke-Deliver $runStandard $planStandard 'correct' (Join-Path $out 'standard-correct')
    Assert-Exit $c 0 'deliver correct'
    Assert-Match $c.Text 'delivered\s+19,050 messages: 18,479 distinct events, 571 redeliveries' 'messages'
    Assert-Match $c.Text '393 events parked until their predecessor or referenced entities arrived' 'parked'
    $v = Invoke-Validate $runStandard (Join-Path $out 'standard-correct\actual-state.json') @('--plan', $planStandard)
    Assert-Exit $v 0 'validate correct'
    Assert-Match $v.Text 'checked\s+200/200 products, 1,000/1,000 customers, 5,000/5,000 orders' 'checked'
    Write-Note ("correct: deliver + validate in {0:N1} s" -f $watch.Elapsed.TotalSeconds)
    $n = Invoke-Deliver $runStandard $planStandard 'naive' (Join-Path $out 'standard-naive')
    Assert-Exit $n 0 'deliver naive'
    Assert-Match $n.Text '266 updates lost' 'updates lost'
    $v = Invoke-Validate $runStandard (Join-Path $out 'standard-naive\actual-state.json') @('--plan', $planStandard, '--limit', '0')
    Assert-Exit $v 1 'validate naive'
    Assert-Match $v.Text 'findings\s+1,897' 'findings'
    Assert-Match $v.Text 'status-mismatch\s+204' 'status'
    Assert-Match $v.Text 'double-processing\s+539' 'double processing'
    Assert-Match $v.Text 'explained\s+1,897 of 1,897 findings' 'explained'
}

Test-Case 'MV-3.13' 'The determinism guard covers validation and targets' {
    $probes = @((Join-Path $root 'packages\validation\src\guard-probe.ts'), (Join-Path $root 'packages\targets\src\guard-probe.ts'))
    try {
        foreach ($probe in $probes) { Set-Content $probe 'export const probe = (): number => Math.random() + Date.now();' }
        $blocked = Invoke-Pnpm @('lint')
        Assert-That ($blocked.Code -ne 0) 'lint passed with Math.random and Date.now in the new packages'
        Assert-Match $blocked.Text 'packages[\\/]validation[\\/]src[\\/]guard-probe\.ts' 'validation probe reported'
        Assert-Match $blocked.Text 'packages[\\/]targets[\\/]src[\\/]guard-probe\.ts' 'targets probe reported'
        Assert-Match $blocked.Text "'Math\.random' is restricted" 'Math.random message'
        Assert-Match $blocked.Text "'Date\.now' is restricted" 'Date.now message'
    } finally {
        foreach ($probe in $probes) { Remove-Item $probe -ErrorAction SilentlyContinue }
    }
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint after removing the probes'
}

Complete-Verification 'Milestone 3'

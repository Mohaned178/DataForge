<#
.SYNOPSIS
    Runs every Milestone 1 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-1.md case by case (same IDs, same commands,
    same expected values). Writes only to out\self-check, never to out\mv where the hand-run
    tests live. Works in Windows PowerShell 5.1 and PowerShell 7.
    Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-1.1 (pnpm install, check, build) when the workspace is already installed and built.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-1.ps1
#>
param([switch]$SkipInstall)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$smallScenario = 'scenarios/ecommerce-small.json'
$runA = Join-Path $out 'run-a'
$goldenEvents = '01B57D640AB12E33702CCB72339FD00552E6B37B3FDDCE4DFF7A5A8C0CCA42DE'
$goldenExpectedState = '3546842D89241F81B31BD2BFAA11916FFF0EE04CC400195A70B4C2E6BEFF2101'
$smallScenarioHash = 'sha256:3afbcf1ac2460a195a0e6306bd5ea1e1d3655b8d80f1d356958e60109e901158'
$runFiles = @('events.jsonl', 'expected-state.json', 'scenario.resolved.json', 'manifest.json')

Write-Host "DataForge Milestone 1 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

Test-Case 'MV-1.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    Assert-Match $check.Text 'Test Suites:\s+(\d+) passed, \1 total' 'pnpm check suites'
    Assert-Match $check.Text 'Tests:\s+(\d+) passed, \1 total' 'pnpm check tests'
    Assert-That ($check.Text -notmatch 'error TS\d+') 'pnpm check reported TypeScript errors'
    if ($check.Text -match 'Tests:\s+(\d+) passed') { Write-Note "automated tests passed: $($Matches[1])" }
    Assert-Exit (Invoke-Pnpm @('build')) 0 'pnpm build'
}

Test-Case 'MV-1.2' 'Generate a run and look at it' {
    $r = Invoke-DataForge @('generate', '--scenario', $smallScenario, '--seed', '42', '--out', $runA)
    Assert-Exit $r 0 'generate'
    Assert-Match $r.Text 'events\s+472\b' 'event total'
    foreach ($count in @('ProductCreated\s+12\b', 'CustomerRegistered\s+25\b', 'OrderCreated\s+120\b', 'PaymentFailed\s+29\b',
            'PaymentCompleted\s+108\b', 'OrderCancelled\s+11\b', 'ShipmentCreated\s+98\b', 'ShipmentDelivered\s+69\b')) {
        Assert-Match $r.Text $count 'per-type count'
    }
    $sizes = @{ 'events.jsonl' = 146142; 'expected-state.json' = 135526; 'manifest.json' = 1101; 'scenario.resolved.json' = 1145 }
    foreach ($name in $sizes.Keys) {
        $path = Join-Path $runA $name
        if (Test-Path $path) {
            $length = (Get-Item $path).Length
            Assert-That ($length -eq $sizes[$name]) "$name is $length bytes, expected $($sizes[$name])"
        } else {
            Assert-That $false "$name was not written"
        }
    }
    $eventsPath = Join-Path $runA 'events.jsonl'
    $lines = [IO.File]::ReadAllLines($eventsPath)
    Assert-That ($lines.Count -eq 472) "events.jsonl has $($lines.Count) lines, expected 472"
    Assert-That (-not ([IO.File]::ReadAllBytes($eventsPath) -contains 13)) 'events.jsonl contains CR characters'
    foreach ($fragment in @('"aggregateId":"prd_000001"', '"name":"Deluxe Cotton Sneakers"', '"priceMinor":8991', '"type":"ProductCreated"')) {
        Assert-That ($lines[0].Contains($fragment)) "first event lacks $fragment"
    }
}

Test-Case 'MV-1.3' 'Same seed, same files' {
    $runB = Join-Path $out 'run-b'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', $smallScenario, '--seed', '42', '--out', $runB)) 0 'generate run-b'
    foreach ($name in $runFiles) {
        Assert-That ((Get-Sha256 (Join-Path $runA $name)) -eq (Get-Sha256 (Join-Path $runB $name))) "$name differs between run-a and run-b"
    }
    Assert-That ((Get-Sha256 (Join-Path $runA 'events.jsonl')) -eq $goldenEvents) 'events.jsonl hash differs from the golden value'
    Assert-That ((Get-Sha256 (Join-Path $runA 'expected-state.json')) -eq $goldenExpectedState) 'expected-state.json hash differs from the golden value'
    $manifest = Get-Content (Join-Path $runA 'manifest.json') -Raw | ConvertFrom-Json
    Assert-That ($manifest.files.'events.jsonl'.sha256 -eq (Get-Sha256 (Join-Path $runA 'events.jsonl'))) 'manifest checksum does not match events.jsonl'
}

Test-Case 'MV-1.4' 'A different seed gives a different world' {
    $runC = Join-Path $out 'run-c'
    $r = Invoke-DataForge @('generate', '--scenario', $smallScenario, '--seed', '43', '--out', $runC)
    Assert-Exit $r 0 'generate run-c'
    Assert-Match $r.Text 'events\s+456\b' 'event total for seed 43'
    Assert-That ($r.Text.Contains($smallScenarioHash)) 'scenario hash changed with the seed'
    Assert-That ((Get-Sha256 (Join-Path $runA 'events.jsonl')) -ne (Get-Sha256 (Join-Path $runC 'events.jsonl'))) 'events.jsonl is identical for seeds 42 and 43'
    Assert-That ((Get-Sha256 (Join-Path $runA 'expected-state.json')) -ne (Get-Sha256 (Join-Path $runC 'expected-state.json'))) 'expected-state.json is identical for seeds 42 and 43'
    Assert-That ((Get-Sha256 (Join-Path $runA 'scenario.resolved.json')) -eq (Get-Sha256 (Join-Path $runC 'scenario.resolved.json'))) 'scenario.resolved.json differs between seeds'
}

Test-Case 'MV-1.5' 'Verify a clean run' {
    $r = Invoke-DataForge @('verify', '--run', $runA)
    Assert-Exit $r 0 'verify'
    Assert-Match $r.Text 'Result: PASS' 'verify result'
    $okLines = [regex]::Matches($r.Text, '(?m)\sOK$').Count
    Assert-That ($okLines -eq 7) "verify printed $okLines OK lines, expected 7"
    Assert-That ($r.Text -notmatch 'FAIL') 'verify printed FAIL'
}

Test-Case 'MV-1.6a' 'An edited payment amount is detected' {
    $dir = Join-Path $out 't-amount'
    Copy-Item $runA $dir -Recurse
    $path = Join-Path $dir 'events.jsonl'
    [IO.File]::WriteAllText($path, ([regex]'"amountMinor":\d+').Replace([IO.File]::ReadAllText($path), '"amountMinor":1', 1))
    $r = Invoke-DataForge @('verify', '--run', $dir)
    Assert-Exit $r 1 'verify'
    Assert-Match $r.Text 'checksum\s+events\.jsonl\s+FAIL' 'checksum line'
    Assert-Match $r.Text 'Event #15 evt_ord_000115_2 \(PaymentCompleted\)' 'offending event'
    Assert-Match $r.Text '\[payment\.amount-matches-order\] payment amount 1 differs from order total 25188' 'violated rule'
    Assert-Match $r.Text 'state\s+.*SKIP' 'state step skipped'
    Assert-Match $r.Text 'reproduce\s+.*OK' 'reproduce step'
    Assert-Match $r.Text 'Result: FAIL' 'verify result'
}

Test-Case 'MV-1.6b' 'A deleted event is detected' {
    $dir = Join-Path $out 't-delete'
    Copy-Item $runA $dir -Recurse
    $path = Join-Path $dir 'events.jsonl'
    $kept = [IO.File]::ReadAllLines($path) | Where-Object { $_ -notmatch '"eventId":"evt_ord_000007_1"' }
    [IO.File]::WriteAllText($path, (($kept -join "`n") + "`n"))
    Assert-That (@($kept).Count -eq 471) "expected 471 lines after deleting one event, got $(@($kept).Count)"
    $r = Invoke-DataForge @('verify', '--run', $dir)
    Assert-Exit $r 1 'verify'
    Assert-Match $r.Text 'Event #281 evt_ord_000038_5 \(ShipmentDelivered\)' 'offending event'
    Assert-Match $r.Text '\[log\.sequence\] expected sequence 280, got 281' 'violated check'
}

Test-Case 'MV-1.6c' 'An edited expected state is detected' {
    $dir = Join-Path $out 't-state'
    Copy-Item $runA $dir -Recurse
    $path = Join-Path $dir 'expected-state.json'
    [IO.File]::WriteAllText($path, ([IO.File]::ReadAllText($path) -replace '"revenueMinor": \d+', '"revenueMinor": 999'))
    $r = Invoke-DataForge @('verify', '--run', $dir)
    Assert-Exit $r 1 'verify'
    Assert-Match $r.Text 'checksum\s+expected-state\.json\s+FAIL' 'checksum line'
    Assert-Match $r.Text 'state\s+replayed state vs expected-state\.json\s+FAIL' 'state line'
    Assert-Match $r.Text 'first difference at line 5511' 'difference location'
    Assert-Match $r.Text 'replayed: "revenueMinor": 2525664' 'replayed value'
    Assert-Match $r.Text 'file:\s+"revenueMinor": 999' 'file value'
}

Test-Case 'MV-1.7' 'Bad input is rejected' {
    $broken = Join-Path $out 'broken.json'
    '{ "formatVersion": 1, "name": "broken", "orders": { "count": 10, "itemsPerOrder": { "min": 3, "max": 2 } }, "payments": { "failureRate": 1.5 }, "customers": { "cout": 5 } }' | Set-Content $broken
    $r = Invoke-DataForge @('generate', '--scenario', $broken, '--seed', '42', '--out', (Join-Path $out 'broken'))
    Assert-Exit $r 2 'invalid scenario'
    Assert-Match $r.Text 'customers: Unrecognized key: "cout"' 'unknown key'
    Assert-Match $r.Text 'orders\.itemsPerOrder\.max: "min" must be less than or equal to "max"' 'min/max'
    Assert-Match $r.Text 'payments\.failureRate: Too big' 'rate'
    Assert-That (-not (Test-Path (Join-Path $out 'broken'))) 'an output folder was created for an invalid scenario'

    $seed = Invoke-DataForge @('generate', '--scenario', $smallScenario, '--seed', 'bad seed', '--out', (Join-Path $out 'x'))
    Assert-Exit $seed 2 'invalid seed'
    Assert-Match $seed.Text 'Invalid seed "bad seed"' 'seed message'

    $nonEmpty = Invoke-DataForge @('generate', '--scenario', $smallScenario, '--seed', '42', '--out', $runA)
    Assert-Exit $nonEmpty 2 'non-empty output folder'
    Assert-Match $nonEmpty.Text 'Output directory is not empty' 'non-empty message'
    Assert-Match $nonEmpty.Text 'Use --force' 'force hint'
}

function Get-EventsByAggregate {
    param([string]$Path)
    $map = @{}
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $id = [regex]::Match($line, '"aggregateId":"([^"]+)"').Groups[1].Value
        if (-not $map.ContainsKey($id)) { $map[$id] = New-Object System.Collections.Generic.List[string] }
        $map[$id].Add(($line -replace '"sequence":\d+,', ''))
    }
    $map
}

Test-Case 'MV-1.8' 'Adding an order leaves existing orders unchanged' {
    $scenario121 = Join-Path $out 'small-121.json'
    $s = Get-Content $smallScenario -Raw | ConvertFrom-Json
    $s.orders.count = 121
    $s | ConvertTo-Json -Depth 10 | Set-Content $scenario121
    $run121 = Join-Path $out 'run-121'
    $r = Invoke-DataForge @('generate', '--scenario', $scenario121, '--seed', '42', '--out', $run121)
    Assert-Exit $r 0 'generate run-121'
    Assert-Match $r.Text 'events\s+474\b' 'event total'
    Assert-Match $r.Text 'OrderCreated\s+121\b' 'order count'
    $before = Get-EventsByAggregate (Join-Path $runA 'events.jsonl')
    $after = Get-EventsByAggregate (Join-Path $run121 'events.jsonl')
    $changed = @($before.Keys | Where-Object { ($before[$_] -join "`n") -ne ($after[$_] -join "`n") })
    Assert-That ($changed.Count -eq 0) "aggregates changed by adding one order: $($changed -join ', ')"
    Write-Note "compared $($before.Keys.Count) aggregates (all products, customers and orders 1-120)"
    Assert-That ($after.ContainsKey('ord_000121')) 'ord_000121 is missing from the larger run'
    Assert-That ((Get-Sha256 (Join-Path $runA 'events.jsonl')) -ne (Get-Sha256 (Join-Path $run121 'events.jsonl'))) 'whole event logs are identical'
}

Test-Case 'MV-1.9' "Read one order's history" {
    $failedOrder = Invoke-DataForge @('timeline', '--run', $runA, '--aggregate', 'ord_000061')
    Assert-Exit $failedOrder 0 'timeline ord_000061'
    Assert-That ([regex]::Matches($failedOrder.Text, 'PaymentFailed').Count -eq 3) 'ord_000061 should have three PaymentFailed events'
    Assert-Match $failedOrder.Text 'OrderCancelled\s+reason=PAYMENT_FAILED' 'ord_000061 cancellation'

    $retried = Invoke-DataForge @('timeline', '--run', $runA, '--aggregate', 'ord_000006')
    Assert-Exit $retried 0 'timeline ord_000006'
    $types = ([regex]::Matches($retried.Text, '(?m)\s(OrderCreated|PaymentFailed|PaymentCompleted|OrderCancelled|ShipmentCreated|ShipmentDelivered)\s') |
        ForEach-Object { $_.Groups[1].Value }) -join ','
    Assert-That ($types -eq 'OrderCreated,PaymentFailed,PaymentCompleted,ShipmentCreated,ShipmentDelivered') "ord_000006 lifecycle is $types"
    Assert-Match $retried.Text 'reason=PROCESSOR_TIMEOUT' 'failure reason'
    Assert-Match $retried.Text 'pay_000006_2 attempt=2' 'second attempt'
    $times = @([regex]::Matches($retried.Text, '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z') | ForEach-Object { $_.Value })
    for ($i = 1; $i -lt $times.Count; $i++) {
        Assert-That ([string]::CompareOrdinal($times[$i - 1], $times[$i]) -lt 0) "event times not increasing: $($times[$i - 1]) then $($times[$i])"
    }

    $state = Get-Content (Join-Path $runA 'expected-state.json') -Raw | ConvertFrom-Json
    $order = $state.orders | Where-Object { $_.orderId -eq 'ord_000006' }
    Assert-That ($order.status -eq 'DELIVERED') "ord_000006 status is $($order.status)"
    Assert-That ($order.totalMinor -eq 37864 -and $order.amountPaidMinor -eq 37864) 'ord_000006 total/paid should both be 37864'
    Assert-That ($order.paymentAttempts -eq 2 -and $order.failedPaymentAttempts -eq 1) 'ord_000006 should have 2 attempts, 1 failed'
    Assert-That ($order.shipmentId -eq 'shp_000006') "ord_000006 shipment is $($order.shipmentId)"
    $payments = @($state.payments | Where-Object { $_.orderId -eq 'ord_000006' } | ForEach-Object { "$($_.paymentId):$($_.status):$($_.failureReason)" }) -join ' '
    Assert-That ($payments -eq 'pay_000006_1:FAILED:PROCESSOR_TIMEOUT pay_000006_2:COMPLETED:') "ord_000006 payments are $payments"

    $missing = Invoke-DataForge @('timeline', '--run', $runA, '--aggregate', 'ord_999999')
    Assert-Exit $missing 1 'timeline unknown order'
    Assert-Match $missing.Text 'No events found' 'unknown order message'
}

Test-Case 'MV-1.10' 'The resolved scenario is a complete recipe' {
    $again = Join-Path $out 'run-again'
    $resolved = Join-Path $runA 'scenario.resolved.json'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', $resolved, '--seed', '42', '--out', $again)) 0 'generate from resolved scenario'
    Assert-That ((Get-Sha256 (Join-Path $runA 'events.jsonl')) -eq (Get-Sha256 (Join-Path $again 'events.jsonl'))) 'events.jsonl differs'
    Assert-That ((Get-Sha256 (Join-Path $runA 'manifest.json')) -eq (Get-Sha256 (Join-Path $again 'manifest.json'))) 'manifest.json differs'
}

Test-Case 'MV-1.11' "The specification's example size" {
    $standard = Join-Path $out 'standard'
    $generateTime = Measure-Command { $script:standardRun = Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-standard.json', '--seed', '42', '--out', $standard) }
    Assert-Exit $script:standardRun 0 'generate standard'
    Assert-Match $script:standardRun.Text 'events\s+18,479\b' 'event total'
    Assert-Match $script:standardRun.Text 'PENDING_PAYMENT 6, PAID 358, SHIPPED 2,022, DELIVERED 2,369, CANCELLED 245' 'order statuses'
    $verifyTime = Measure-Command { $script:standardVerify = Invoke-DataForge @('verify', '--run', $standard) }
    Assert-Exit $script:standardVerify 0 'verify standard'
    Assert-Match $script:standardVerify.Text 'Result: PASS' 'verify result'
    Assert-That ($generateTime.TotalSeconds -lt 15 -and $verifyTime.TotalSeconds -lt 15) 'generate or verify took longer than 15 s'
    Write-Note ('generate {0:N1} s, verify {1:N1} s (including pnpm and node start-up)' -f $generateTime.TotalSeconds, $verifyTime.TotalSeconds)
}

Test-Case 'MV-1.12' 'The determinism guard' {
    $probe = Join-Path $root 'packages\core\src\guard-probe.ts'
    try {
        Set-Content $probe 'export const probe = (): number => Math.random() + Date.now();'
        $blocked = Invoke-Pnpm @('lint')
        Assert-That ($blocked.Code -ne 0) 'lint passed with Math.random and Date.now in packages/core'
        Assert-Match $blocked.Text "'Math\.random' is restricted" 'Math.random message'
        Assert-Match $blocked.Text "'Date\.now' is restricted" 'Date.now message'
    } finally {
        Remove-Item $probe -ErrorAction SilentlyContinue
    }
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint after removing the probe'
}

Complete-Verification 'Milestone 1'

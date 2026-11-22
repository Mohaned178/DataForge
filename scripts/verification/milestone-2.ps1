<#
.SYNOPSIS
    Runs every Milestone 2 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-2.md case by case (same IDs, same commands,
    same expected values). Writes only to out\self-check, never to out\mv where the hand-run
    tests live. Works in Windows PowerShell 5.1 and PowerShell 7.
    Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-2.1 (pnpm install, check, build) when the workspace is already installed and built.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-2.ps1
#>
param([switch]$SkipInstall)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$runA = Join-Path $out 'run-a'
$planA = Join-Path $out 'plan-a'
$planNever = Join-Path $out 'plan-never'
$specExample = 'chaos-profiles/spec-example.json'
$goldenEvents = '01B57D640AB12E33702CCB72339FD00552E6B37B3FDDCE4DFF7A5A8C0CCA42DE'
$planHashes = @{
    'delivery-plan.jsonl'         = '0C08D623A42034548EE3AD76AE21B8C9638A735CBF687AA72D90C5A584CC6232'
    'chaos-profile.resolved.json' = '759A85738A32CD3BF6CED386FEFAF76F52DF33DD7DE65CD49EC70142C1A33D65'
    'delivery-summary.json'       = '63887F16C26B5F8C08977A63CADA00A35BC5E5D3E1278FD148732B75E12C3B6D'
}

function Read-Plan {
    param([string]$Directory)
    Get-Content (Join-Path $Directory 'delivery-plan.jsonl') | ConvertFrom-Json
}

function Invoke-Plan {
    param([string]$Run, [string]$Profile, [string]$ChaosSeed, [string]$Out)
    Invoke-DataForge @('chaos', 'plan', '--run', $Run, '--profile', $Profile, '--chaos-seed', $ChaosSeed, '--out', $Out)
}

function Invoke-Explain {
    param([string]$Run, [string]$Plan, [string]$EventId)
    Invoke-DataForge @('explain', '--run', $Run, '--plan', $Plan, '--event', $EventId)
}

Write-Host "DataForge Milestone 2 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

Test-Case 'MV-2.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    Assert-Match $check.Text 'packages/chaos typecheck: Done' 'chaos package type-checked'
    Assert-Match $check.Text 'Test Suites:\s+14 passed, 14 total' 'pnpm check suites'
    Assert-Match $check.Text 'Tests:\s+179 passed, 179 total' 'pnpm check tests'
    Assert-That ($check.Text -notmatch 'error TS\d+') 'pnpm check reported TypeScript errors'
    $build = Invoke-Pnpm @('build')
    Assert-Exit $build 0 'pnpm build'
    Assert-Match $build.Text 'packages/chaos build: Done' 'chaos package built'
}

Test-Case 'MV-2.2' 'Plan the specification''s example faults' {
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '42', '--out', $runA)) 0 'generate run-a'
    $r = Invoke-Plan $runA $specExample '7' $planA
    Assert-Exit $r 0 'chaos plan'
    Assert-Match $r.Text 'attempts\s+486: original 472, retry 0, duplicate 14; delivered 486, failed 0' 'attempt counts'
    Assert-Match $r.Text 'delay\s+26 of 472 events\s+5\.51%\s+\(configured 5\.00%\)' 'delay rate'
    Assert-Match $r.Text 'reorder\s+8 of 315 eligible\s+2\.54%\s+\(configured 2\.00%\)' 'reorder rate'
    Assert-Match $r.Text 'duplicate\s+14 of 472 delivered\s+2\.97%\s+\(configured 3\.00%\)\s+\+14 extra deliveries' 'duplicate rate'
    Assert-Match $r.Text 'transientFailure\s+0 of 472 events\s+0\.00%\s+\(configured 0\.00%\)' 'transient failure rate'
    Assert-Match $r.Text '472 of 472 events delivered, 0 lost' 'outcome'
    Assert-Match $r.Text '10 events delivered after a later event of their aggregate \(11 inverted pairs in 9 aggregates\)' 'ordering'
    $sizes = @{ 'chaos-profile.resolved.json' = 831; 'delivery-plan.jsonl' = 167512; 'delivery-summary.json' = 1825 }
    foreach ($name in $sizes.Keys) {
        $path = Join-Path $planA $name
        if (Test-Path $path) {
            $length = (Get-Item $path).Length
            Assert-That ($length -eq $sizes[$name]) "$name is $length bytes, expected $($sizes[$name])"
        } else {
            Assert-That $false "$name was not written"
        }
    }
    $first = Get-Content (Join-Path $planA 'delivery-plan.jsonl') -TotalCount 1
    foreach ($fragment in @('"attemptId":"att_prd_000001_1_1"', '"deliverySequence":1,', '"kind":"original"', '"faults":[]')) {
        Assert-That ($first.Contains($fragment)) "first attempt lacks $fragment"
    }
}

Test-Case 'MV-2.3' 'Same run, profile and chaos seed: same plan' {
    $planB = Join-Path $out 'plan-b'
    Assert-Exit (Invoke-Plan $runA $specExample '7' $planB) 0 'chaos plan plan-b'
    foreach ($name in $planHashes.Keys) {
        $a = Get-Sha256 (Join-Path $planA $name)
        $b = Get-Sha256 (Join-Path $planB $name)
        Assert-That ($a -eq $b) "$name differs between plan-a and plan-b"
        Assert-That ($a -eq $planHashes[$name]) "$name hash is $a, expected $($planHashes[$name])"
    }
}

Test-Case 'MV-2.4' 'A different chaos seed: a different plan, the same world' {
    $eventsBefore = Get-Sha256 (Join-Path $runA 'events.jsonl')
    $planC = Join-Path $out 'plan-c'
    $r = Invoke-Plan $runA $specExample '8' $planC
    Assert-Exit $r 0 'chaos plan seed 8'
    Assert-Match $r.Text 'events\.jsonl sha256 01b57d640ab12e33702ccb72339fd00552e6b37b3fddce4dff7a5a8c0cca42de' 'same world'
    Assert-Match $r.Text 'attempts\s+481: original 472, retry 0, duplicate 9' 'seed 8 attempt counts'
    Assert-Match $r.Text 'delay\s+24 of 472' 'seed 8 delay'
    Assert-Match $r.Text 'reorder\s+7 of 315' 'seed 8 reorder'
    Assert-Match $r.Text '8 events delivered after a later event of their aggregate \(10 inverted pairs in 8 aggregates\)' 'seed 8 ordering'
    Assert-Match $r.Text 'delivery-plan\.jsonl\s+sha256 43c0caa5' 'seed 8 plan hash'
    Assert-That ((Get-Sha256 (Join-Path $planA 'delivery-plan.jsonl')) -ne (Get-Sha256 (Join-Path $planC 'delivery-plan.jsonl'))) 'seed 8 produced the seed 7 plan'
    $eventsAfter = Get-Sha256 (Join-Path $runA 'events.jsonl')
    Assert-That ($eventsBefore -eq $eventsAfter) 'events.jsonl changed'
    Assert-That ($eventsAfter -eq $goldenEvents) "events.jsonl hash is $eventsAfter"
    $verify = Invoke-DataForge @('verify', '--run', $runA)
    Assert-Exit $verify 0 'verify run-a'
    Assert-Match $verify.Text 'Result: PASS' 'verify result'
}

Test-Case 'MV-2.5' 'No faults: canonical order at event time' {
    $planNone = Join-Path $out 'plan-none'
    $r = Invoke-Plan $runA 'chaos-profiles/none.json' '7' $planNone
    Assert-Exit $r 0 'chaos plan none'
    Assert-Match $r.Text 'attempts\s+472: original 472, retry 0, duplicate 0; delivered 472, failed 0' 'attempt counts'
    Assert-Match $r.Text '0 events delivered after a later event' 'ordering'
    $plan = Read-Plan $planNone
    Assert-That ($plan.Count -eq 472) "plan has $($plan.Count) attempts"
    $different = @($plan | Where-Object { $_.kind -ne 'original' -or $_.plannedOutcome -ne 'delivered' -or $_.deliverySequence -ne $_.eventSequence -or $_.scheduledDeliveryTimeMs -ne $_.eventTimeMs -or @($_.faults).Count -ne 0 }).Count
    Assert-That ($different -eq 0) "$different attempts differ from the canonical log"
}

Test-Case 'MV-2.6' 'Duplicates keep the business identity' {
    $plan = Read-Plan $planA
    $duplicates = @($plan | Where-Object kind -eq 'duplicate').Count
    $attemptIds = @($plan.attemptId | Sort-Object -Unique).Count
    $eventIds = @($plan.eventId | Sort-Object -Unique).Count
    Assert-That ($duplicates -eq 14) "duplicate attempts: $duplicates"
    Assert-That ($attemptIds -eq 486) "distinct attemptIds: $attemptIds"
    Assert-That ($eventIds -eq 472) "distinct eventIds: $eventIds"
    $own = @($plan | Where-Object eventId -eq 'evt_ord_000078_1')
    Assert-That ($own.Count -eq 2) "evt_ord_000078_1 has $($own.Count) attempts"
    if ($own.Count -eq 2) {
        Assert-That ($own[0].attemptId -eq 'att_ord_000078_1_1' -and $own[0].kind -eq 'original' -and $own[0].deliverySequence -eq 42 -and $own[0].scheduledDeliveryTimeMs -eq 33212526) 'first attempt of evt_ord_000078_1'
        Assert-That ($own[1].attemptId -eq 'att_ord_000078_1_2' -and $own[1].kind -eq 'duplicate' -and $own[1].deliverySequence -eq 43 -and $own[1].scheduledDeliveryTimeMs -eq 33229140) 'second attempt of evt_ord_000078_1'
    }
    $r = Invoke-Explain $runA $planA 'evt_ord_000078_1'
    Assert-Exit $r 0 'explain'
    Assert-Match $r.Text 'Delivery attempts \(2\):' 'attempt count'
    Assert-Match $r.Text 'att_ord_000078_1_1\s+original\s+#42\s+.*\+0 ms\s+DELIVERED\s+no fault' 'original attempt line'
    Assert-Match $r.Text 'att_ord_000078_1_2\s+duplicate\s+#43\s+2026-01-01T09:13:49\.140Z\s+\+16,614 ms\s+DELIVERED\s+duplicate copy 1 of 1, 16,614 ms after att_ord_000078_1_1' 'duplicate attempt line'
    Assert-Match $r.Text 'Outcome: delivered 2 times with the same eventId \(first at position #42\)' 'outcome'
}

Test-Case 'MV-2.7' 'A reorder always produces an inversion' {
    $timeline = Invoke-DataForge @('timeline', '--run', $runA, '--aggregate', 'ord_000088')
    Assert-Exit $timeline 0 'timeline'
    Assert-Match $timeline.Text '2\s+28\s+.*PaymentCompleted' 'timeline v2'
    Assert-Match $timeline.Text '3\s+57\s+.*ShipmentCreated' 'timeline v3'
    $r = Invoke-Explain $runA $planA 'evt_ord_000088_2'
    Assert-Exit $r 0 'explain'
    Assert-Match $r.Text 'original\s+#58\s+2026-01-01T10:49:28\.384Z\s+\+11,295,521 ms\s+DELIVERED\s+reorder: moved behind evt_ord_000088_3 \(1 later\), \+11,295,521 ms' 'reorder attempt line'
    Assert-Match $r.Text 'Aggregate order: OUT OF ORDER\. The target receives later events of ord_000088 first:' 'out of order'
    Assert-Match $r.Text 'evt_ord_000088_3\s+v3 ShipmentCreated\s+first delivered at position #57' 'overtaking event'
    $plan = Read-Plan $planA
    $first = @{}
    foreach ($a in $plan) { if ($a.plannedOutcome -eq 'delivered' -and -not $first.ContainsKey($a.eventId)) { $first[$a.eventId] = $a.deliverySequence } }
    $rows = @($plan | ForEach-Object { foreach ($f in $_.faults) { if ($f.type -eq 'reorder') { [pscustomobject]@{ event = $_.eventId; behind = $f.behindEventId; eventPosition = $first[$_.eventId]; behindPosition = $first[$f.behindEventId] } } } })
    Assert-That ($rows.Count -eq 8) "$($rows.Count) reordered events, expected 8"
    foreach ($row in $rows) {
        Assert-That ($row.eventPosition -gt $row.behindPosition) "$($row.event) at $($row.eventPosition) is not behind $($row.behind) at $($row.behindPosition)"
    }
    $expected = 'evt_ord_000088_2>evt_ord_000088_3:58/57,evt_ord_000057_3>evt_ord_000057_4:128/127,evt_ord_000059_2>evt_ord_000059_3:145/144,evt_ord_000045_1>evt_ord_000045_2:154/153,evt_ord_000063_3>evt_ord_000063_4:170/169,evt_ord_000020_2>evt_ord_000020_4:306/305,evt_ord_000117_2>evt_ord_000117_3:402/401,evt_ord_000045_3>evt_ord_000045_4:480/479'
    $actual = ($rows | ForEach-Object { '{0}>{1}:{2}/{3}' -f $_.event, $_.behind, $_.eventPosition, $_.behindPosition }) -join ','
    Assert-That ($actual -eq $expected) "reorder rows: $actual"
}

Test-Case 'MV-2.8' 'Retries, and loss only when allowed' {
    $flaky = Invoke-Plan $runA 'chaos-profiles/flaky-network.json' '7' (Join-Path $out 'plan-flaky')
    Assert-Exit $flaky 0 'chaos plan flaky-network'
    Assert-Match $flaky.Text 'attempts\s+542: original 472, retry 33, duplicate 37; delivered 509, failed 33' 'flaky attempt counts'
    Assert-Match $flaky.Text 'transientFailure\s+20 of 472 events\s+4\.24%\s+\(configured 5\.00%\)\s+33 failed attempts, 0 lost' 'flaky failures'
    Assert-Match $flaky.Text '472 of 472 events delivered, 0 lost' 'flaky outcome'
    $planLossy = Join-Path $out 'plan-lossy'
    $lossy = Invoke-Plan $runA 'chaos-profiles/lossy.json' '7' $planLossy
    Assert-Exit $lossy 0 'chaos plan lossy'
    Assert-Match $lossy.Text 'attempts\s+575: original 472, retry 82, duplicate 21; delivered 471, failed 104' 'lossy attempt counts'
    Assert-Match $lossy.Text 'duplicate\s+21 of 450 delivered' 'lossy duplicates'
    Assert-Match $lossy.Text 'transientFailure\s+48 of 472 events\s+10\.17%\s+\(configured 10\.00%\)\s+104 failed attempts, 22 lost' 'lossy failures'
    Assert-Match $lossy.Text '450 of 472 events delivered, 22 lost' 'lossy outcome'
    $retried = Invoke-Explain $runA $planLossy 'evt_prd_000002_1'
    Assert-Exit $retried 0 'explain retried event'
    Assert-Match $retried.Text '#2\s+.*FAILED\s+transient failure 1 of 2' 'first failure'
    Assert-Match $retried.Text '#14\s+.*FAILED\s+retry 39,301 ms after att_prd_000002_1_1 failed; transient failure 2 of 2' 'second failure'
    Assert-Match $retried.Text '#15\s+.*DELIVERED\s+retry 39,209 ms after att_prd_000002_1_2 failed' 'delivered retry'
    Assert-Match $retried.Text 'Outcome: delivered once' 'retried outcome'
    $lost = Invoke-Explain $runA $planLossy 'evt_ord_000063_1'
    Assert-Exit $lost 0 'explain lost event'
    Assert-Match $lost.Text 'transient failure 3 of 3' 'third failure'
    Assert-Match $lost.Text 'Outcome: LOST\. All 3 attempts fail and the sender gives up after 2 retries \(the profile allows loss\)\.' 'lost outcome'
    $profilePath = Join-Path $out 'lossy-no-opt-in.json'
    '{"formatVersion":1,"name":"lossy-no-opt-in","faults":{"transientFailure":{"rate":0.1,"failures":{"min":1,"max":4},"maxRetries":2}}}' | Set-Content $profilePath
    $refused = Invoke-Plan $runA $profilePath '7' $planNever
    Assert-Exit $refused 2 'profile without allowLoss'
    Assert-Match $refused.Text 'faults\.transientFailure\.failures\.max: cannot exceed maxRetries \(2\) unless allowLoss is true' 'loss rule message'
}

Test-Case 'MV-2.9' 'Fault types do not disturb each other' {
    $profilePath = Join-Path $out 'delay-only.json'
    '{"formatVersion":1,"name":"delay-only","faults":{"delay":{"rate":0.05,"delayMs":{"min":1000,"max":300000}}}}' | Set-Content $profilePath
    $planDelay = Join-Path $out 'plan-delay'
    Assert-Exit (Invoke-Plan $runA $profilePath '7' $planDelay) 0 'chaos plan delay-only'
    function Get-Delays([string]$Dir) { Read-Plan $Dir | ForEach-Object { foreach ($f in $_.faults) { if ($f.type -eq 'delay') { '{0} +{1}' -f $_.eventId, $f.delayMs } } } | Sort-Object }
    $withAll = @(Get-Delays $planA)
    $alone = @(Get-Delays $planDelay)
    Assert-That ($withAll.Count -eq 26) "delays with all faults: $($withAll.Count)"
    Assert-That ($alone.Count -eq 26) "delay alone: $($alone.Count)"
    Assert-That (@(Compare-Object $withAll $alone).Count -eq 0) 'delays differ between the two plans'
    Assert-That (($withAll[0..2] -join ',') -eq 'evt_cus_000008_1 +46739,evt_cus_000014_1 +31010,evt_ord_000001_3 +204380') "first delays: $($withAll[0..2] -join ',')"
}

Test-Case 'MV-2.10' 'Observed rates on the specification''s example size' {
    $runStandard = Join-Path $out 'run-standard'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-standard.json', '--seed', '42', '--out', $runStandard)) 0 'generate standard'
    $r = Invoke-Plan $runStandard $specExample '7' (Join-Path $out 'plan-standard')
    Assert-Exit $r 0 'chaos plan standard'
    Assert-Match $r.Text '18,479 events' 'event count'
    Assert-Match $r.Text 'delay\s+931 of 18,479 events\s+5\.04%\s+\(configured 5\.00%\)' 'delay rate'
    Assert-Match $r.Text 'reorder\s+256 of 12,279 eligible\s+2\.08%\s+\(configured 2\.00%\)' 'reorder rate'
    Assert-Match $r.Text 'duplicate\s+571 of 18,479 delivered\s+3\.09%\s+\(configured 3\.00%\)' 'duplicate rate'
    Assert-Match $r.Text '315 events delivered after a later event of their aggregate \(395 inverted pairs in 310 aggregates\)' 'ordering'
    if ($r.Text -match 'done in (\d+) ms') { Write-Note "planned 18,479 events in $($Matches[1]) ms" }
}

Test-Case 'MV-2.11' 'Bad input is rejected' {
    $broken = Join-Path $out 'broken.json'
    '{"formatVersion":1,"name":"broken","faults":{"delay":{"rate":1.5},"dealy":{"rate":0.1},"reorder":{"distance":{"min":3,"max":1}}}}' | Set-Content $broken
    $r = Invoke-Plan $runA $broken '7' $planNever
    Assert-Exit $r 2 'broken profile'
    Assert-Match $r.Text 'faults\.delay\.rate: Too big: expected number to be <=1' 'rate problem'
    Assert-Match $r.Text 'faults\.reorder\.distance\.max: "min" must be less than or equal to "max"' 'range problem'
    Assert-Match $r.Text 'faults: Unrecognized key: "dealy"' 'unknown key problem'
    $r = Invoke-Plan $runA 'chaos-profiles/none.json' 'not valid' $planNever
    Assert-Exit $r 2 'invalid chaos seed'
    Assert-Match $r.Text 'Invalid chaos seed "not valid": use 1-128 characters' 'seed message'
    $r = Invoke-Plan $runA 'chaos-profiles/none.json' '7' $runA
    Assert-Exit $r 2 'out is the run directory'
    Assert-Match $r.Text '--out must not be the run directory' 'run directory message'
    $r = Invoke-Plan $runA 'chaos-profiles/none.json' '7' $planA
    Assert-Exit $r 2 'non-empty out directory'
    Assert-Match $r.Text 'Use --force to overwrite the plan files in it\.' 'non-empty message'
    $r = Invoke-Explain $runA $planA 'evt_ord_999999_1'
    Assert-Exit $r 1 'unknown event'
    Assert-Match $r.Text 'Event "evt_ord_999999_1" is not in the canonical log' 'unknown event message'
    Assert-That (-not (Test-Path $planNever)) 'plan-never was created'
}

Test-Case 'MV-2.12' 'Edited runs, edited plans and mismatched plans are refused' {
    $tRun = Join-Path $out 't-run'
    Copy-Item $runA $tRun -Recurse
    $p = (Resolve-Path (Join-Path $tRun 'events.jsonl')).Path
    [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"priceMinor":8991', '"priceMinor":8992'))
    $r = Invoke-Plan $tRun 'chaos-profiles/none.json' '7' $planNever
    Assert-Exit $r 2 'plan from an edited run'
    Assert-Match $r.Text 'events\.jsonl in .*t-run does not match the checksum in manifest\.json: the run was modified\.' 'edited run message'

    $tPlan = Join-Path $out 't-plan'
    Copy-Item $planA $tPlan -Recurse
    $p = (Resolve-Path (Join-Path $tPlan 'delivery-plan.jsonl')).Path
    [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace('"kind":"duplicate"', '"kind":"original"'))
    $r = Invoke-Explain $runA $tPlan 'evt_ord_000078_1'
    Assert-Exit $r 2 'explain an edited plan'
    Assert-Match $r.Text 'delivery-plan\.jsonl in .*t-plan does not match the checksum in delivery-summary\.json: the plan was modified\.' 'edited plan message'

    $run43 = Join-Path $out 'run-43'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '43', '--out', $run43)) 0 'generate run-43'
    $r = Invoke-Explain $run43 $planA 'evt_ord_000078_1'
    Assert-Exit $r 2 'explain a plan of another run'
    Assert-Match $r.Text 'was made for a different canonical log' 'mismatch message'
    Assert-Match $r.Text 'plan:\s+events\.jsonl sha256 01b57d64\S+ \(seed 42' 'plan side'
    Assert-Match $r.Text 'run:\s+events\.jsonl sha256 9ce42b8c\S+ \(seed 43' 'run side'
    Assert-That (-not (Test-Path $planNever)) 'plan-never was created'
}

Test-Case 'MV-2.13' 'The determinism guard covers the chaos planner' {
    $probe = Join-Path $root 'packages\chaos\src\guard-probe.ts'
    try {
        Set-Content $probe 'export const probe = (): number => Math.random() + Date.now();'
        $blocked = Invoke-Pnpm @('lint')
        Assert-That ($blocked.Code -ne 0) 'lint passed with Math.random and Date.now in packages/chaos'
        Assert-Match $blocked.Text 'packages[\\/]chaos[\\/]src[\\/]guard-probe\.ts' 'probe file reported'
        Assert-Match $blocked.Text "'Math\.random' is restricted" 'Math.random message'
        Assert-Match $blocked.Text "'Date\.now' is restricted" 'Date.now message'
    } finally {
        Remove-Item $probe -ErrorAction SilentlyContinue
    }
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint after removing the probe'
}

Complete-Verification 'Milestone 2'

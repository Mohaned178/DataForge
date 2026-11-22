<#
.SYNOPSIS
    Runs every Milestone 5 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-5.md case by case (same IDs, same commands,
    same expected values). Writes only to out\self-check, never to out\mv where the hand-run
    tests live. Works in Windows PowerShell 5.1 and PowerShell 7.
    MV-5.10 needs Docker Desktop: it starts the Kafka broker (docker compose up -d --wait).
    Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-5.1 (pnpm install, check, build) when the workspace is already installed and built.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-5.ps1
#>
param([switch]$SkipInstall)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$runA = Join-Path $out 'run-a'
$runStd = Join-Path $out 'run-std'
$m4NaiveActual = 'A47FBBB75451D59707B0E69CF2FEBDAF5D96BC845A94746285AE68DA46A81877'
$m4NaiveTargetRun = '62E37D930F2B321E8590593B137A4EFD550CA4C35A8CD51E64697D8D54299D86'
$m4NaiveReport = '51C6D6331A95CCF3CB0DDD1C94B90AD98E9CEC5C3E50D73A30A865F864945B44'
$trueWindows = '2D7B96BFAB622E6154E0F028073F8F1A82D428FE89D6D58A70CA09F3DB428BC5'
$lateCorrectWindows = 'C4972FF9EBA16AC9D9D006F340B2A9D239D556D537B5816E9CBA863B7F4B5957'
$lateNaiveWindows = '18E9D094842572A3635B3F02C30F2CE9902C02529666254A51834C3CD3273A47'

function Invoke-Native {
    param([string]$Command, [string[]]$Arguments)
    $lines = & $Command @Arguments 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($lines -join "`n") }
}

function Plan-Path([string]$Profile) { Join-Path $out "plan-$Profile" }
function Out-Path([string]$Name) { Join-Path $out $Name }
function Hash-Of([string]$Name, [string]$File) { Get-Sha256 (Join-Path (Out-Path $Name) $File) }

function Deliver {
    param([string]$Profile, [string]$Target, [string]$Name, [string[]]$Extra = @(), [string]$Run = $runA, [string]$Plan = (Plan-Path $Profile))
    Invoke-DataForge (@('deliver', '--run', $Run, '--plan', $Plan, '--target', $Target, '--out', (Out-Path $Name)) + $Extra)
}

function Validate {
    param([string]$Profile, [string]$Name, [string[]]$Extra = @(), [string]$Run = $runA, [string]$Plan = (Plan-Path $Profile))
    Invoke-DataForge (@('validate', '--run', $Run, '--actual', (Join-Path (Out-Path $Name) 'actual-state.json'), '--plan', $Plan) + $Extra)
}

Write-Host "DataForge Milestone 5 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

Test-Case 'MV-5.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    foreach ($project in 'packages/core', 'packages/chaos', 'packages/targets', 'packages/validation', 'packages/kafka', 'apps/consumer', 'apps/cli') {
        Assert-Match $check.Text "$project typecheck: Done" "$project type-checked"
    }
    Assert-Match $check.Text 'Test Suites:\s+29 passed, 29 total' 'pnpm check suites'
    Assert-Match $check.Text 'Tests:\s+393 passed, 393 total' 'pnpm check tests'
    Assert-That ($check.Text -notmatch 'error TS\d+') 'pnpm check reported TypeScript errors'
    Assert-Exit (Invoke-Pnpm @('build')) 0 'pnpm build'
}

Test-Case 'MV-5.2' 'Nothing changes for profiles without windows' {
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '42', '--out', $runA)) 0 'generate run-a'
    foreach ($profile in 'spec-example', 'windowed-none', 'windowed-delays', 'late-data') {
        $plan = Invoke-DataForge @('chaos', 'plan', '--run', $runA, '--profile', "chaos-profiles/$profile.json", '--chaos-seed', '7', '--out', (Plan-Path $profile))
        Assert-Exit $plan 0 "chaos plan $profile"
        if ($profile -eq 'spec-example') {
            Assert-That ($plan.Text -notmatch 'windowing|arrivals|\blate ') 'spec-example plan prints window lines'
        }
    }
    Assert-Exit (Deliver 'spec-example' 'naive' 'spec-naive') 0 'deliver spec-example naive'
    $report = Out-Path 'spec-naive-report.json'
    $v = Validate 'spec-example' 'spec-naive' @('--report', $report, '--limit', '0')
    Assert-Exit $v 1 'validate spec-example naive'
    Assert-Match $v.Text 'Result: FAIL \(48 findings\)$' 'naive result'
    $files = @(Get-ChildItem (Out-Path 'spec-naive') | Select-Object -ExpandProperty Name)
    Assert-That (($files -join ',') -eq 'actual-state.json,target-run.json') "delivery files are $($files -join ',')"
    Assert-That ((Hash-Of 'spec-naive' 'actual-state.json') -eq $m4NaiveActual) 'actual-state.json differs from Milestone 4'
    Assert-That ((Hash-Of 'spec-naive' 'target-run.json') -eq $m4NaiveTargetRun) 'target-run.json differs from Milestone 4'
    Assert-That ((Get-Sha256 $report) -eq $m4NaiveReport) "report differs from Milestone 4: $(Get-Sha256 $report)"
}

Test-Case 'MV-5.3' 'A windowed plan with late events' {
    $p = Invoke-DataForge @('chaos', 'plan', '--run', $runA, '--profile', 'chaos-profiles/late-data.json', '--chaos-seed', '7', '--out', (Plan-Path 'late-data'), '--force')
    Assert-Exit $p 0 'chaos plan late-data'
    Assert-Match $p.Text 'late\s+21 of 456 eligible\s+4\.61%\s+\(configured 5\.00%\)\s+arrive after their window closed' 'late tally'
    Assert-Match $p.Text 'windowing\s+1 h tumbling event-time windows, allowed lateness 10 min' 'windowing'
    Assert-Match $p.Text 'arrivals\s+228 windowed events \(OrderCreated, PaymentCompleted\), by stream time: 219 on time, 0 within the allowed lateness, 9 after their window closed, 0 lost' 'arrivals'
    Assert-Match $p.Text 'delivery-plan\.jsonl\s+sha256 ddb558b944f9ae3dd952cd6db36599b01140a967b344fbea12161f6d39e197e5' 'plan hash'
}

Test-Case 'MV-5.4' 'Zero faults: both targets report the true windows' {
    $d = Deliver 'windowed-none' 'correct' 'wnone-correct'
    Assert-Exit $d 0 'deliver windowed-none correct'
    Assert-Match $d.Text 'actual-windows\.json\s+sha256 2d7b96bf' 'windows file listed'
    Assert-Match $d.Text '0 events not counted in their window: they arrived after it closed' 'nothing dropped'
    Assert-Exit (Deliver 'windowed-none' 'naive' 'wnone-naive') 0 'deliver windowed-none naive'
    foreach ($target in 'correct', 'naive') {
        $hash = Hash-Of "wnone-$target" 'actual-windows.json'
        Assert-That ($hash -eq $trueWindows) "$target actual-windows.json hash is $hash"
        $v = Validate 'windowed-none' "wnone-$target"
        Assert-Exit $v 0 "validate windowed-none $target"
        Assert-Match $v.Text 'Windows \(1 h tumbling event-time windows, allowed lateness 10 min\)' "$target windows section"
        Assert-Match $v.Text 'checked\s+41 reported windows against 41 expected' "$target windows checked"
        Assert-Match $v.Text 'Result: PASS \(the actual state matches the expected state and satisfies every invariant; every window has its true values\)' "$target result"
    }
}

Test-Case 'MV-5.5' 'Delays within the allowed lateness: correct passes, naive does not' {
    Assert-Exit (Deliver 'windowed-delays' 'correct' 'wdel-correct') 0 'deliver correct'
    Assert-Exit (Deliver 'windowed-delays' 'naive' 'wdel-naive') 0 'deliver naive'
    $c = Validate 'windowed-delays' 'wdel-correct'
    Assert-Exit $c 0 'validate correct'
    Assert-Match $c.Text 'Result: PASS \(.*every window has its true values\)' 'correct result'
    $n = Validate 'windowed-delays' 'wdel-naive' @('--limit', '100')
    Assert-Exit $n 1 'validate naive'
    Assert-Match $n.Text 'window-undercount\s+2\b' 'undercount'
    Assert-Match $n.Text 'window-overcount\s+11\b' 'overcount'
    Assert-Match $n.Text 'explained\s+13 of 13 window findings are linked to late, lost, misplaced or duplicated events; 0 are not explained by any delivery fault' 'explained'
    Assert-Match $n.Text 'Result: FAIL \(70 findings, 13 window findings\)' 'naive result'
    Assert-Match $n.Text '\[2026-01-02T19:00Z, 20:00Z\) window-undercount  paymentsCompleted is 2, expected 3; revenueMinor is 67330, expected 120958' 'short window'
    Assert-Match $n.Text 'cause: evt_ord_000002_2 PaymentCompleted at 2026-01-02T19:54:49\.906Z, delivered during the window starting 2026-01-02T20:00Z \[delay\]' 'short window cause'
    Assert-Match $n.Text '\[2026-01-02T20:00Z, 21:00Z\) window-overcount   paymentsCompleted is 3, expected 2; revenueMinor is 93191, expected 39563' 'long window'
}

Test-Case 'MV-5.6' 'Late data: dropped events are explained by their late arrival' {
    $d = Deliver 'late-data' 'correct' 'late-correct'
    Assert-Exit $d 0 'deliver late-data correct'
    Assert-Match $d.Text '9 events not counted in their window: they arrived after it closed' 'dropped'
    Assert-Match $d.Text 'actual-windows\.json\s+sha256 c4972ff9eba16ac9d9d006f340b2a9d239d556d537b5816e9cba863b7f4b5957' 'correct windows hash'
    Assert-Exit (Deliver 'late-data' 'naive' 'late-naive') 0 'deliver late-data naive'
    $c = Validate 'late-data' 'late-correct' @('--limit', '2')
    Assert-Exit $c 1 'validate correct'
    Assert-Match $c.Text 'findings\s+0\n' 'no entity findings'
    Assert-Match $c.Text 'window-undercount\s+7\b' 'undercount'
    Assert-Match $c.Text 'window-overcount\s+0\b' 'no overcount'
    Assert-Match $c.Text 'explained\s+7 of 7 window findings' 'explained'
    Assert-Match $c.Text '\[2026-01-01T14:00Z, 15:00Z\) window-undercount  paymentsCompleted is 3, expected 4; revenueMinor is 61320, expected 83806' 'first finding'
    Assert-Match $c.Text 'cause: evt_ord_000012_2 PaymentCompleted at 2026-01-01T14:05:30\.532Z, arrived AFTER its window closed \(stream time 2026-01-01T15:29:33\.886Z, 19\.6 min past the close at 2026-01-01T15:10Z\): dropped by a pipeline with this lateness, .*\[late\]' 'first cause'
    Assert-Match $c.Text 'Result: FAIL \(0 findings, 7 window findings\)' 'correct result'
    $n = Validate 'late-data' 'late-naive' @('--limit', '0')
    Assert-Exit $n 1 'validate naive'
    Assert-Match $n.Text 'window-undercount\s+7\b' 'naive undercount'
    Assert-Match $n.Text 'window-overcount\s+6\b' 'naive overcount'
    Assert-Match $n.Text 'Result: FAIL \(19 findings, 13 window findings\)' 'naive result'
}

Test-Case 'MV-5.7' 'Explain a late event' {
    $e = Invoke-DataForge @('explain', '--run', $runA, '--plan', (Plan-Path 'late-data'), '--event', 'evt_ord_000012_2')
    Assert-Exit $e 0 'explain'
    Assert-Match $e.Text 'window\s+\[2026-01-01T14:00Z, 15:00Z\), closes at 2026-01-01T15:10Z \(1 h tumbling event-time windows, allowed lateness 10 min\)' 'window line'
    Assert-Match $e.Text '#97\s+2026-01-01T15:29:33\.887Z\s+\+5,043,355 ms\s+DELIVERED\s+late: held until after evt_ord_000013_3, which is past the window close, \+5,043,355 ms' 'attempt line'
    Assert-Match $e.Text 'Window: arrives AFTER its window closed \(stream time 2026-01-01T15:29:33\.886Z, 19\.6 min past the close\)\. A pipeline with this allowed lateness drops it\.' 'arrival line'
    Assert-Match $e.Text 'Aggregate order: OUT OF ORDER' 'aggregate order'
}

Test-Case 'MV-5.8' 'Same inputs, same bytes' {
    Assert-Exit (Deliver 'late-data' 'naive' 'late-naive-2') 0 'deliver naive again'
    $first = Hash-Of 'late-naive' 'actual-windows.json'
    $second = Hash-Of 'late-naive-2' 'actual-windows.json'
    Assert-That ($first -eq $lateNaiveWindows) "naive windows hash is $first"
    Assert-That ($second -eq $first) 'naive windows differ between deliveries'
    $r1 = Out-Path 'late-naive-1.json'
    $r2 = Out-Path 'late-naive-2.json'
    Assert-Exit (Validate 'late-data' 'late-naive' @('--report', $r1)) 1 'report 1'
    Assert-Exit (Validate 'late-data' 'late-naive-2' @('--report', $r2)) 1 'report 2'
    Assert-That ((Get-Sha256 $r1) -eq (Get-Sha256 $r2)) 'reports differ'
}

Test-Case 'MV-5.9' 'A hand-edited windows file' {
    $edited = Out-Path 'edited'
    Copy-Item (Out-Path 'wnone-correct') $edited -Recurse
    $path = Join-Path $edited 'actual-windows.json'
    $w = Get-Content $path -Raw | ConvertFrom-Json
    $w.windows[5].revenueMinor += 100
    $w.windows += $w.windows[0]
    $w.windows += [pscustomobject]@{ windowStartMs = 1800000; windowEndMs = 5400000; ordersCreated = 0; paymentsCompleted = 0; revenueMinor = 0 }
    $w | ConvertTo-Json -Depth 5 | Set-Content $path
    $v = Validate 'windowed-none' 'edited'
    Assert-Exit $v 1 'validate edited'
    Assert-Match $v.Text 'EDITED since delivery \(checksum differs from target-run\.json\)' 'edited flag'
    Assert-Match $v.Text 'window-overcount\s+1\b' 'overcount'
    Assert-Match $v.Text 'duplicate-window\s+1\b' 'duplicate'
    Assert-Match $v.Text 'misaligned-window\s+1\b' 'misaligned'
    Assert-Match $v.Text 'explained\s+0 of 3 window findings .*; 3 are not explained by any delivery fault' 'unexplained'
    Assert-Match $v.Text '\[2026-01-01T00:30Z, 01:30Z\) misaligned-window\s+\[1800000, 5400000\) is not a window of 3600000 ms aligned to the epoch; its values are not compared' 'misaligned line'
    Assert-Match $v.Text 'checked\s+43 reported windows against 41 expected' 'checked'
    Assert-Match $v.Text '\[2026-01-01T05:00Z, 06:00Z\) duplicate-window\s+listed 2 times; the first one is compared' 'duplicate line'
    Assert-Match $v.Text 'cause: not a delivery effect; the target listed this window wrongly' 'structural cause'
    Assert-Match $v.Text '\[2026-01-01T10:00Z, 11:00Z\) window-overcount\s+revenueMinor is 50171, expected 50071\n\s+cause: none found; no abnormal delivery of an event counted in this window' 'overcount without cause'
    Assert-Match $v.Text 'Result: FAIL \(0 findings, 3 window findings\)' 'result'
}

Test-Case 'MV-5.10' 'Windows through Kafka' {
    Assert-Exit (Invoke-Native 'docker' @('compose', 'up', '-d', '--wait')) 0 'docker compose up'
    $k = Deliver 'late-data' 'correct' 'k-late-correct' @('--transport', 'kafka')
    Assert-Exit $k 0 'deliver kafka correct'
    Assert-Match $k.Text 'sent\s+472 records, 0 planned failures not sent' 'sent'
    Assert-Match $k.Text '9 events not counted in their window' 'dropped'
    Assert-Exit (Deliver 'late-data' 'naive' 'k-late-naive' @('--transport', 'kafka')) 0 'deliver kafka naive'
    Assert-That ((Hash-Of 'k-late-correct' 'actual-windows.json') -eq $lateCorrectWindows) 'kafka correct windows hash'
    Assert-That ((Hash-Of 'late-correct' 'actual-windows.json') -eq $lateCorrectWindows) 'memory correct windows hash'
    Assert-That ((Hash-Of 'k-late-naive' 'actual-windows.json') -eq $lateNaiveWindows) 'kafka naive windows hash'
    Assert-That ((Hash-Of 'k-late-correct' 'target-run.json') -eq (Hash-Of 'late-correct' 'target-run.json')) 'target-run.json differs'
    $log = Get-Content (Join-Path (Out-Path 'k-late-correct') 'consumer.log') -Raw
    Assert-Match $log 'actual-windows\.json' 'consumer log lists the windows file'
    $v = Validate 'late-data' 'k-late-correct' @('--limit', '0')
    Assert-Exit $v 1 'validate kafka correct'
    Assert-Match $v.Text 'Result: FAIL \(0 findings, 7 window findings\)' 'kafka result'
}

Test-Case 'MV-5.11' 'The specification''s example size' {
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-standard.json', '--seed', '42', '--out', $runStd)) 0 'generate run-std'
    $expect = @{
        'windowed-delays' = @{
            Plan = @('arrivals\s+9,749 windowed events .*: 9,570 on time, 179 within the allowed lateness, 0 after their window closed, 0 lost')
            Validate = @('checked\s+168 reported windows against 168 expected', 'Result: PASS \(')
            Exit = 0
        }
        'late-data' = @{
            Plan = @('late\s+955 of 18,366 eligible\s+5\.20%\s+\(configured 5\.00%\)', 'arrivals\s+9,749 windowed events .*: 9,216 on time, 27 within the allowed lateness, 506 after their window closed, 0 lost')
            Validate = @('window-undercount\s+160\b', 'explained\s+160 of 160 window findings', 'Result: FAIL \(0 findings, 160 window findings\)')
            Exit = 1
        }
    }
    foreach ($profile in 'windowed-delays', 'late-data') {
        $planDir = Out-Path "std-plan-$profile"
        $p = Invoke-DataForge @('chaos', 'plan', '--run', $runStd, '--profile', "chaos-profiles/$profile.json", '--chaos-seed', '7', '--out', $planDir)
        Assert-Exit $p 0 "plan $profile"
        foreach ($pattern in $expect[$profile].Plan) { Assert-Match $p.Text $pattern "$profile plan" }
        Assert-Exit (Deliver $profile 'correct' "std-$profile" @() $runStd $planDir) 0 "deliver $profile"
        $v = Validate $profile "std-$profile" @('--limit', '0') $runStd $planDir
        Assert-Exit $v $expect[$profile].Exit "validate $profile"
        foreach ($pattern in $expect[$profile].Validate) { Assert-Match $v.Text $pattern "$profile validate" }
    }
}

Test-Case 'MV-5.12' 'Bad input is refused with the reason' {
    $lateOnly = Out-Path 'late-only.json'
    Set-Content $lateOnly '{ "formatVersion": 1, "name": "late-only", "faults": { "late": { "rate": 0.1 } } }'
    $p = Invoke-DataForge @('chaos', 'plan', '--run', $runA, '--profile', $lateOnly, '--chaos-seed', '7', '--out', (Out-Path 'never'))
    Assert-Exit $p 2 'late without windowing'
    Assert-Match $p.Text 'faults\.late: needs a "windowing" section: a late event is late relative to the close of its window' 'late message'

    $noWindows = Out-Path 'no-windows'
    Copy-Item (Out-Path 'wnone-correct') $noWindows -Recurse
    Remove-Item (Join-Path $noWindows 'actual-windows.json')
    $v1 = Validate 'windowed-none' 'no-windows'
    Assert-Exit $v1 2 'windowed plan without windows'
    Assert-Match $v1.Text 'The plan defines event-time windows \(1 h tumbling event-time windows, allowed lateness 10 min\), but no windows were found for this target\.' 'missing windows message'

    $v2 = Validate 'spec-example' 'spec-naive' @('--windows', (Join-Path (Out-Path 'wnone-correct') 'actual-windows.json'))
    Assert-Exit $v2 2 'windows without a contract'
    Assert-Match $v2.Text 'holds per-window metrics, but there is no windowing contract to check them against\.' 'no contract message'
    Assert-Match $v2.Text 'The plan \(profile spec-example\) has no "windowing" section\.' 'no windowing section'

    $bad = Out-Path 'bad-windows.json'
    Set-Content $bad '{ "format": "dataforge.actual-windows", "formatVersion": 1, "windows": [ { "windowStartMs": 0, "windowEndMs": 3600000, "ordersCreated": 1.5, "revenue": 3 } ] }'
    $v3 = Validate 'windowed-none' 'wnone-correct' @('--windows', $bad)
    Assert-Exit $v3 2 'invalid windows file'
    foreach ($pattern in 'Invalid actual windows:', 'windows\.0\.ordersCreated:', 'windows\.0\.paymentsCompleted:', 'windows\.0\.revenueMinor:', 'windows\.0: Unrecognized key: "revenue"') {
        Assert-Match $v3.Text $pattern 'invalid windows message'
    }
}

Test-Case 'MV-5.13' 'The determinism guard covers the windows module' {
    $probe = 'packages\core\src\windows\guard-probe.ts'
    Set-Content $probe 'export const probe = (): number => Math.random() + Date.now();'
    try {
        $lint = Invoke-Pnpm @('lint')
        Assert-Exit $lint 1 'lint with probe'
        Assert-Match $lint.Text 'guard-probe\.ts' 'probe reported'
        Assert-Match $lint.Text "'Math\.random' is restricted" 'Math.random flagged'
        Assert-Match $lint.Text "'Date\.now' is restricted" 'Date.now flagged'
    } finally {
        Remove-Item $probe -ErrorAction SilentlyContinue
    }
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint without probe'
}

Complete-Verification 'Milestone 5'

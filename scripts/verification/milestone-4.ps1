<#
.SYNOPSIS
    Runs every Milestone 4 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-4.md case by case (same IDs, same commands,
    same expected values). Writes only to out\self-check, never to out\mv where the hand-run
    tests live. Works in Windows PowerShell 5.1 and PowerShell 7.
    Needs Docker Desktop: it starts the Kafka broker (docker compose up -d --wait), and MV-4.11
    stops it and starts it again. Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-4.1 (pnpm install, check, build) when the workspace is already installed and built.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-4.ps1
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
$naiveSpecTargetRun = '62E37D930F2B321E8590593B137A4EFD550CA4C35A8CD51E64697D8D54299D86'
$naiveSpecReport = '51C6D6331A95CCF3CB0DDD1C94B90AD98E9CEC5C3E50D73A30A865F864945B44'

function Invoke-Native {
    param([string]$Command, [string[]]$Arguments)
    $lines = & $Command @Arguments 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($lines -join "`n") }
}

function Plan-Path([string]$Profile) { Join-Path $out "plan-$Profile" }

function Invoke-Deliver {
    param([string]$Run, [string]$Plan, [string]$Target, [string]$Out, [string[]]$Extra = @())
    Invoke-DataForge (@('deliver', '--run', $Run, '--plan', $Plan, '--target', $Target, '--out', $Out) + $Extra)
}

function Deliver-Kafka {
    param([string]$Profile, [string]$Target, [string]$Name, [string[]]$Extra = @())
    Invoke-Deliver $runA (Plan-Path $Profile) $Target (Join-Path $out $Name) (@('--transport', 'kafka') + $Extra)
}

function Deliver-Memory {
    param([string]$Profile, [string]$Target, [string]$Name)
    Invoke-Deliver $runA (Plan-Path $Profile) $Target (Join-Path $out $Name)
}

function Validate-Delivery {
    param([string]$Profile, [string]$Name, [string[]]$Extra = @(), [string]$Run = $runA)
    Invoke-DataForge (@('validate', '--run', $Run, '--actual', (Join-Path (Join-Path $out $Name) 'actual-state.json'), '--plan', (Plan-Path $Profile)) + $Extra)
}

function Read-Json([string]$Path) { Get-Content $Path -Raw | ConvertFrom-Json }
function Read-JsonLines([string]$Path) { @(Get-Content $Path | ForEach-Object { $_ | ConvertFrom-Json }) }
function Hash-Of([string]$Name, [string]$File) { Get-Sha256 (Join-Path (Join-Path $out $Name) $File) }

Write-Host "DataForge Milestone 4 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

Test-Case 'MV-4.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    foreach ($project in 'packages/kafka', 'apps/consumer') {
        Assert-Match $check.Text "$project typecheck: Done" "$project type-checked"
    }
    Assert-Match $check.Text 'Test Suites:\s+24 passed, 24 total' 'pnpm check suites'
    Assert-Match $check.Text 'Tests:\s+330 passed, 330 total' 'pnpm check tests'
    Assert-That ($check.Text -notmatch 'error TS\d+') 'pnpm check reported TypeScript errors'
    $build = Invoke-Pnpm @('build')
    Assert-Exit $build 0 'pnpm build'
    foreach ($project in 'packages/kafka', 'apps/consumer', 'apps/cli') {
        Assert-Match $build.Text "$project build: Done" "$project built"
    }
}

Test-Case 'MV-4.2' 'Start Kafka and run the integration tests' {
    Assert-Exit (Invoke-Native 'docker' @('compose', 'up', '-d', '--wait')) 0 'docker compose up'
    $ps = Invoke-Native 'docker' @('compose', 'ps', '--format', '{{.Service}} {{.Image}} {{.Status}}')
    Assert-Match $ps.Text 'kafka apache/kafka:4\.3\.2 Up .*\(healthy\)' 'broker healthy'
    $it = Invoke-Pnpm @('test:integration')
    Assert-Exit $it 0 'pnpm test:integration'
    # Counts as of Milestone 7 (D-5.2, D-7.3, Milestone 8): later milestones add integration suites to the same run.
    Assert-Match $it.Text 'Test Suites:\s+11 passed, 11 total' 'integration suites'
    Assert-Match $it.Text 'Tests:\s+132 passed, 132 total' 'integration tests'
}

Test-Case 'MV-4.3' 'Zero faults through Kafka' {
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '42', '--out', $runA)) 0 'generate run-a'
    foreach ($profile in 'none', 'spec-example', 'duplicates-only', 'flaky-network', 'lossy') {
        $plan = Invoke-DataForge @('chaos', 'plan', '--run', $runA, '--profile', "chaos-profiles/$profile.json", '--chaos-seed', '7', '--out', (Plan-Path $profile))
        Assert-Exit $plan 0 "chaos plan $profile"
    }
    foreach ($target in 'correct', 'naive') {
        $d = Deliver-Kafka 'none' $target "k-none-$target"
        Assert-Exit $d 0 "deliver none $target"
        Assert-Match $d.Text "DataForge deliver: target $target \(.*\), through Kafka" "$target title"
        Assert-Match $d.Text 'kafka\s+localhost:9092 \(cluster \S+\), topic dataforge\.\d{8}T\d{9}Z-[0-9a-f]{6} \(1 partition\)' "$target kafka line"
        Assert-Match $d.Text 'consumer\s+process \d+, group dataforge-consumer\.\S+, joined after [\d.]+ s \(partitions 0\)' "$target consumer line"
        Assert-Match $d.Text 'sent\s+472 records, 0 planned failures not sent; speed max, [\d.]+ s' "$target sent"
        Assert-Match $d.Text 'completion\s+consumer-group lag 0, [\d.]+ s after the last record' "$target completion"
        Assert-Match $d.Text 'delivered\s+472 messages: 472 distinct events, 0 redeliveries; 0 failed attempts never reached the target' "$target delivered"
        $hash = Hash-Of "k-none-$target" 'actual-state.json'
        Assert-That ($hash -eq $expectedActual) "$target actual-state.json hash is $hash"
        $v = Validate-Delivery 'none' "k-none-$target"
        Assert-Exit $v 0 "validate none $target"
        Assert-Match $v.Text 'Result: PASS' "$target result"
    }
    $log = Get-Content (Join-Path $out 'k-none-correct\consumer.log') -Raw
    Assert-Match $log 'DataForge consumer: target correct' 'consumer log title'
    Assert-Match $log 'joined\s+partitions 0 after' 'consumer joined'
    Assert-Match $log 'consumed\s+472 records: 472 distinct events, 0 redeliveries' 'consumer consumed'
    $consumer = (Read-Json (Join-Path $out 'k-none-correct\kafka-run.json')).consumer
    Assert-That ($consumer.exitCode -eq 0) "consumer exit code $($consumer.exitCode)"
    Assert-That ($consumer.target -eq 'correct') "consumer target $($consumer.target)"
    Assert-That ($consumer.pid -gt 0 -and $consumer.pid -ne $PID) "consumer pid $($consumer.pid)"
}

Test-Case 'MV-4.4' 'Equivalence: the specification''s example through Kafka equals the offline run' {
    foreach ($target in 'correct', 'naive') {
        Assert-Exit (Deliver-Memory 'spec-example' $target "m-spec-$target") 0 "deliver memory $target"
        Assert-Exit (Deliver-Kafka 'spec-example' $target "k-spec-$target") 0 "deliver kafka $target"
        foreach ($file in 'actual-state.json', 'target-run.json') {
            $m = Hash-Of "m-spec-$target" $file
            $k = Hash-Of "k-spec-$target" $file
            Assert-That ($m -eq $k) "$target $file differs: memory $m, kafka $k"
        }
    }
    Assert-That ((Hash-Of 'k-spec-naive' 'actual-state.json') -eq $naiveSpecActual) 'naive actual-state.json hash'
    Assert-That ((Hash-Of 'k-spec-naive' 'target-run.json') -eq $naiveSpecTargetRun) 'naive target-run.json hash'
    $mr = Join-Path $out 'm-spec-naive-report.json'
    $kr = Join-Path $out 'k-spec-naive-report.json'
    Assert-Exit (Validate-Delivery 'spec-example' 'm-spec-naive' @('--report', $mr)) 1 'validate memory naive'
    $v = Validate-Delivery 'spec-example' 'k-spec-naive' @('--report', $kr, '--limit', '0')
    Assert-Exit $v 1 'validate kafka naive'
    Assert-Match $v.Text 'findings\s+48' 'naive findings'
    Assert-Match $v.Text 'explained\s+48 of 48 findings are linked to abnormal deliveries; 0 are not explained by any delivery fault' 'naive explained'
    Assert-Match $v.Text 'evt_ord_000045_1\s+OrderCreated\s+arrived after evt_ord_000045_2 \[reorder\]\s+7 findings' 'top cause'
    Assert-Match $v.Text 'Result: FAIL \(48 findings\)' 'naive result'
    Assert-That ((Get-Sha256 $mr) -eq (Get-Sha256 $kr)) 'reports differ'
    Assert-That ((Get-Sha256 $kr) -eq $naiveSpecReport) "report hash is $(Get-Sha256 $kr)"
    $c = Validate-Delivery 'spec-example' 'k-spec-correct'
    Assert-Exit $c 0 'validate kafka correct'
}

Test-Case 'MV-4.5' 'The records on Kafka: key, headers, value, and a duplicate' {
    $d = Deliver-Kafka 'duplicates-only' 'naive' 'k-dup-naive'
    Assert-Exit $d 0 'deliver duplicates-only naive'
    Assert-Match $d.Text 'sent\s+527 records, 0 planned failures not sent' 'sent'
    Assert-Match $d.Text 'delivered\s+527 messages: 472 distinct events, 55 redeliveries' 'delivered'
    $topic = (Read-Json (Join-Path $out 'k-dup-naive\kafka-run.json')).kafka.topic
    $records = @(& docker compose exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:19092 --topic $topic --from-beginning --max-messages 527 --formatter-property print.key=true --formatter-property print.headers=true --formatter-property print.offset=true 2>$null)
    Assert-That ($records.Count -eq 527) "records on the topic: $($records.Count)"
    $first = $records[0] -split "`t"
    Assert-That ($first[0] -eq 'Offset:0') "first offset $($first[0])"
    Assert-That ($first[1] -eq 'attemptId:att_prd_000001_1_1,attemptNumber:1,deliverySequence:1,scheduledDeliveryTimeMs:0,scheduledDeliveryTime:2026-01-01T00:00:00.000Z') "first headers $($first[1])"
    Assert-That ($first[2] -eq 'prd_000001') "first key $($first[2])"
    Assert-Match $first[3] '^\{"event":\{"aggregateId":"prd_000001",.*"eventTime":"2026-01-01T00:00:00\.000Z","format":"dataforge\.delivery-record","formatVersion":1\}$' 'first value'
    $dup = @($records | Where-Object { $_ -match 'evt_ord_000018_3"' })
    Assert-That ($dup.Count -eq 2) "records of evt_ord_000018_3: $($dup.Count)"
    $heads = @($dup | ForEach-Object { ($_ -split "`t")[0..2] -join '  ' })
    Assert-Match ($heads -join "`n") 'Offset:123  attemptId:att_ord_000018_3_1,attemptNumber:1,deliverySequence:124,scheduledDeliveryTimeMs:60284611,scheduledDeliveryTime:2026-01-01T16:44:44\.611Z  ord_000018' 'first copy'
    Assert-Match ($heads -join "`n") 'Offset:124  attemptId:att_ord_000018_3_2,attemptNumber:2,deliverySequence:125,scheduledDeliveryTimeMs:60310971,scheduledDeliveryTime:2026-01-01T16:45:10\.971Z  ord_000018' 'second copy'
    Assert-That (@($dup | ForEach-Object { ($_ -split "`t")[3] } | Sort-Object -Unique).Count -eq 1) 'the two values differ'
    $v = Validate-Delivery 'duplicates-only' 'k-dup-naive' @('--limit', '200')
    Assert-Exit $v 1 'validate'
    Assert-Match $v.Text 'order\s+ord_000018\s+double-processing\s+amountPaidMinor is 7000, expected 3500 \(2x\); paymentAttempts is 3, expected 2' 'double charge'
    Assert-Match $v.Text 'order\s+ord_000018\s+double-processing\s+amountPaidMinor 7000 exceeds totalMinor 3500 \[order\.paid-within-total\]' 'overpaid invariant'
}

Test-Case 'MV-4.6' 'The delivery log: planned failures are never sent' {
    $d = Deliver-Kafka 'flaky-network' 'correct' 'k-flaky-correct'
    Assert-Exit $d 0 'deliver flaky-network correct'
    Assert-Match $d.Text 'sent\s+509 records, 33 planned failures not sent' 'sent'
    Assert-Match $d.Text 'delivered\s+509 messages: 472 distinct events, 37 redeliveries; 33 failed attempts never reached the target' 'delivered'
    $log = Read-JsonLines (Join-Path $out 'k-flaky-correct\delivery-log.jsonl')
    $sent = @($log | Where-Object { $_.outcome -eq 'sent' })
    $failed = @($log | Where-Object { $_.outcome -eq 'planned-failure' })
    Assert-That ($sent.Count -eq 509) "sent entries $($sent.Count)"
    Assert-That ($failed.Count -eq 33) "planned-failure entries $($failed.Count)"
    Assert-That (@($failed | Where-Object { $null -ne $_.offset -or $null -ne $_.partition }).Count -eq 0) 'a planned failure has an offset'
    $sample = @($log | Where-Object { $_.eventId -eq 'evt_ord_000015_2' } | ForEach-Object { "$($_.attemptId) $($_.outcome) $($_.offset)" })
    Assert-That (($sample -join '; ') -eq 'att_ord_000015_2_1 planned-failure ; att_ord_000015_2_2 planned-failure ; att_ord_000015_2_3 sent 83; att_ord_000015_2_4 sent 84; att_ord_000015_2_5 sent 85') "evt_ord_000015_2: $($sample -join '; ')"
    $processed = @(Get-Content (Join-Path $out 'k-flaky-correct\processing-log.jsonl'))
    Assert-That ($processed.Count -eq 509) "processing log entries $($processed.Count)"
    Assert-Exit (Validate-Delivery 'flaky-network' 'k-flaky-correct') 0 'validate'
}

Test-Case 'MV-4.7' 'Paced delivery: plan time compressed by --speed' {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $d = Deliver-Kafka 'spec-example' 'correct' 'k-paced' @('--speed', '40000')
    $seconds = $watch.Elapsed.TotalSeconds
    Assert-Exit $d 0 'deliver paced'
    Assert-Match $d.Text 'sent\s+486 records, 0 planned failures not sent; speed 40000x, [\d.]+ s, largest drift \d+ ms' 'sent line'
    Assert-That ((Hash-Of 'k-paced' 'actual-state.json') -eq $expectedActual) 'paced actual-state.json hash'
    $execution = (Read-Json (Join-Path $out 'k-paced\kafka-run.json')).execution
    Assert-That ($execution.speed -eq 40000) "speed $($execution.speed)"
    Assert-That ($execution.durationMs -ge 4307) "durationMs $($execution.durationMs)"
    Assert-That ($execution.maxDriftMs -ge 0 -and $execution.maxDriftMs -lt 1000) "maxDriftMs $($execution.maxDriftMs)"
    Assert-That ($seconds -ge 4.3) "the delivery took $seconds s"
    $last = (Get-Content (Join-Path $out 'k-paced\delivery-log.jsonl') | Select-Object -Last 1) | ConvertFrom-Json
    Assert-That ($last.dueAtMs -eq 4307) "last dueAtMs $($last.dueAtMs)"
    Assert-That ($last.scheduledDeliveryTimeMs -eq 172303920) "last scheduledDeliveryTimeMs $($last.scheduledDeliveryTimeMs)"
    Write-Note ("took {0:N1} s, largest drift {1} ms" -f $seconds, $execution.maxDriftMs)
}

Test-Case 'MV-4.8' 'Three partitions: per-key order holds, the correct target still passes' {
    $d = Deliver-Kafka 'flaky-network' 'correct' 'k-p3-correct' @('--partitions', '3')
    Assert-Exit $d 0 'deliver three partitions'
    Assert-Match $d.Text 'topic dataforge\.\S+ \(3 partitions\)' 'three partitions'
    Assert-Match $d.Text 'joined after [\d.]+ s \(partitions 0, 1, 2\)' 'assigned'
    Assert-That ((Hash-Of 'k-p3-correct' 'actual-state.json') -eq $expectedActual) 'actual-state.json hash'
    Assert-Exit (Validate-Delivery 'flaky-network' 'k-p3-correct') 0 'validate'
    $processed = Read-JsonLines (Join-Path $out 'k-p3-correct\processing-log.jsonl')
    $planned = @(Read-JsonLines (Join-Path (Plan-Path 'flaky-network') 'delivery-plan.jsonl') | Where-Object { $_.plannedOutcome -eq 'delivered' })
    $byKey = @{}; foreach ($r in $processed) { $byKey[$r.aggregateId] += @($r.attemptId) }
    $keys = @($planned | Group-Object aggregateId)
    $differ = @($keys | Where-Object { ($_.Group.attemptId -join ',') -ne ($byKey[$_.Name] -join ',') }).Count
    Assert-That ($keys.Count -eq 157) "aggregates $($keys.Count)"
    Assert-That ($differ -eq 0) "$differ aggregates out of their planned order"
    Assert-That (@($processed | Group-Object partition).Count -eq 3) 'partitions used'
    $later = 0; for ($i = 1; $i -lt $processed.Count; $i++) { if ($processed[$i].deliverySequence -lt $processed[$i - 1].deliverySequence) { $later++ } }
    Assert-That ($later -gt 0) 'no record was handled out of global delivery order'
    Write-Note "records handled after a record planned later: $later"
}

Test-Case 'MV-4.9' 'Lost events through Kafka' {
    $d = Deliver-Kafka 'lossy' 'correct' 'k-lossy-correct'
    Assert-Exit $d 0 'deliver lossy'
    Assert-Match $d.Text 'sent\s+471 records, 104 planned failures not sent' 'sent'
    Assert-Match $d.Text 'delivered\s+471 messages: 450 distinct events, 21 redeliveries; 104 failed attempts never reached the target' 'delivered'
    Assert-Match $d.Text 'parked\s+35 events never applied \(what they wait for never arrived\): evt_ord_000014_4, evt_ord_000015_3' 'parked'
    Assert-Exit (Deliver-Memory 'lossy' 'correct' 'm-lossy-correct') 0 'deliver memory'
    Assert-That ((Hash-Of 'k-lossy-correct' 'actual-state.json') -eq (Hash-Of 'm-lossy-correct' 'actual-state.json')) 'lossy actual states differ'
    $v = Validate-Delivery 'lossy' 'k-lossy-correct' @('--limit', '0')
    Assert-Exit $v 1 'validate'
    Assert-Match $v.Text 'findings\s+81' 'findings'
    Assert-Match $v.Text 'missing-entity\s+40' 'missing entities'
    Assert-Match $v.Text 'explained\s+81 of 81 findings' 'explained'
    Assert-Match $v.Text 'Result: FAIL \(81 findings\)' 'result'
}

Test-Case 'MV-4.10' 'The specification''s example size through Kafka' {
    $runStandard = Join-Path $out 'run-standard'
    $planStandard = Join-Path $out 'plan-standard'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-standard.json', '--seed', '42', '--out', $runStandard)) 0 'generate standard'
    Assert-Exit (Invoke-DataForge @('chaos', 'plan', '--run', $runStandard, '--profile', 'chaos-profiles/spec-example.json', '--chaos-seed', '7', '--out', $planStandard)) 0 'plan standard'
    Assert-Exit (Invoke-Deliver $runStandard $planStandard 'naive' (Join-Path $out 'm-standard-naive')) 0 'deliver memory'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $d = Invoke-Deliver $runStandard $planStandard 'naive' (Join-Path $out 'k-standard-naive') @('--transport', 'kafka')
    $seconds = $watch.Elapsed.TotalSeconds
    Assert-Exit $d 0 'deliver kafka'
    Assert-Match $d.Text 'sent\s+19,050 records, 0 planned failures not sent' 'sent'
    Assert-Match $d.Text 'delivered\s+19,050 messages: 18,479 distinct events, 571 redeliveries' 'delivered'
    Assert-That ($seconds -lt 60) "took $seconds s"
    Assert-That ((Hash-Of 'k-standard-naive' 'actual-state.json') -eq (Hash-Of 'm-standard-naive' 'actual-state.json')) 'standard actual states differ'
    $v = Invoke-DataForge @('validate', '--run', $runStandard, '--actual', (Join-Path $out 'k-standard-naive\actual-state.json'), '--plan', $planStandard, '--limit', '0')
    Assert-Exit $v 1 'validate'
    Assert-Match $v.Text 'findings\s+1,897' 'findings'
    Assert-Match $v.Text 'explained\s+1,897 of 1,897 findings' 'explained'
    Write-Note ("took {0:N1} s" -f $seconds)
}

Test-Case 'MV-4.11' 'Kafka unavailable' {
    try {
        Assert-Exit (Invoke-Native 'docker' @('compose', 'stop', 'kafka')) 0 'docker compose stop'
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $d = Deliver-Kafka 'none' 'correct' 'k-down'
        $seconds = $watch.Elapsed.TotalSeconds
        Assert-Exit $d 3 'deliver without Kafka'
        Assert-Match $d.Text 'Kafka is not reachable at localhost:9092: Connection error \(ECONNREFUSED\)' 'message'
        Assert-Match $d.Text 'Start it with "docker compose up -d --wait"' 'advice'
        Assert-That ($seconds -lt 30) "took $seconds s"
        Assert-That (-not (Test-Path (Join-Path $out 'k-down\actual-state.json'))) 'an actual state was written'
        $it = Invoke-Pnpm @('test:integration')
        Assert-That ($it.Code -ne 0) 'pnpm test:integration passed without Kafka'
        Assert-Match $it.Text 'KAFKA UNAVAILABLE: the integration tests need a running Kafka broker and did not run\.' 'integration message'
        Assert-Match $it.Text 'Start it with:\s+docker compose up -d --wait' 'integration advice'
    } finally {
        $up = Invoke-Native 'docker' @('compose', 'up', '-d', '--wait')
    }
    Assert-Exit $up 0 'docker compose up again'
}

Test-Case 'MV-4.12' 'Invalid options are rejected before touching Kafka' {
    $d = @('deliver', '--run', $runA, '--plan', (Plan-Path 'none'), '--target', 'naive', '--out', $never)
    $cases = @(
        @{ Extra = @('--transport', 'carrier-pigeon'); Pattern = 'Unknown transport "carrier-pigeon"\. Transports: memory, kafka\.' },
        @{ Extra = @('--speed', '10'); Pattern = '--speed applies only to --transport kafka\.' },
        @{ Extra = @('--transport', 'kafka', '--speed', 'fast'); Pattern = '--speed must be "max" or a positive number of simulated milliseconds per real millisecond \(for example 3600\), got "fast"\.' },
        @{ Extra = @('--transport', 'kafka', '--partitions', '0'); Pattern = '--partitions must be a whole number from 1 to 64, got "0"\.' },
        @{ Extra = @('--transport', 'kafka', '--brokers', 'localhost'); Pattern = 'Invalid Kafka broker list "localhost": "localhost" is not host:port\.' }
    )
    foreach ($case in $cases) {
        $r = Invoke-DataForge ($d + $case.Extra)
        Assert-Exit $r 2 ($case.Extra -join ' ')
        Assert-Match $r.Text $case.Pattern ($case.Extra -join ' ')
    }
    $env:KAFKA_BROKERS = 'not a broker'
    try {
        $r = Invoke-DataForge ($d + @('--transport', 'kafka'))
    } finally {
        Remove-Item Env:KAFKA_BROKERS
    }
    Assert-Exit $r 2 'KAFKA_BROKERS'
    Assert-Match $r.Text 'Invalid Kafka broker list "not a broker": "not a broker" is not host:port\. .*\(from KAFKA_BROKERS\)' 'KAFKA_BROKERS message'
    Assert-That (-not (Test-Path $never)) 'out\self-check\never was created'
}

Test-Case 'MV-4.13' 'The Kafka client stays out of the pure packages' {
    $targetsProbe = Join-Path $root 'packages\targets\src\guard-probe.ts'
    $kafkaProbe = Join-Path $root 'packages\kafka\src\guard-probe.ts'
    try {
        Set-Content $targetsProbe "import 'kafkajs';"
        Set-Content $kafkaProbe 'export const probe = (): number => Date.now();'
        $blocked = Invoke-Pnpm @('lint')
        Assert-That ($blocked.Code -ne 0) 'lint passed with the probes'
        Assert-Match $blocked.Text 'packages[\\/]targets[\\/]src[\\/]guard-probe\.ts' 'targets probe reported'
        Assert-Match $blocked.Text "'kafkajs' import is restricted from being used by a pattern\. The simulation core must stay framework- and infrastructure-independent" 'kafkajs message'
        Assert-Match $blocked.Text 'packages[\\/]kafka[\\/]src[\\/]guard-probe\.ts' 'kafka probe reported'
        Assert-Match $blocked.Text "'Date\.now' is restricted" 'Date.now message'
    } finally {
        Remove-Item $targetsProbe, $kafkaProbe -ErrorAction SilentlyContinue
    }
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint after removing the probes'
}

Complete-Verification 'Milestone 4'

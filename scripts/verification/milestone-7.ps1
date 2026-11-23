<#
.SYNOPSIS
    Runs every Milestone 7 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-7.md case by case (same IDs, same requests, same
    expected values). It never touches the data of the hand-run steps: it recreates its own database
    (dataforge_selfcheck), starts its own API on port 3107 with its own work directory, uses its own
    Kafka topics, and writes only to out\self-check. Needs Docker Desktop (Kafka and PostgreSQL).
    The external pipeline of MV-7.11 is the standalone consumer, finished through
    scripts\verification\external-pipeline.js instead of Ctrl+C (a background process cannot receive
    Ctrl+C on Windows). MV-7.15 kills the API instead of pressing Ctrl+C in its window.
    Works in Windows PowerShell 5.1 and PowerShell 7. Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-7.1 (pnpm install, check, build) when the workspace is already installed and built.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-7.ps1
#>
param([switch]$SkipInstall)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
$ProgressPreference = 'SilentlyContinue'

$port = 3107
$api = "http://127.0.0.1:$port"
$selfCheckDb = 'postgresql://dataforge:dataforge@localhost:5433/dataforge_selfcheck'
$workDir = Join-Path $out 'executions'
$suffix = (Get-Date).ToString('HHmmss')
$topic = "selfcheck-shop-orders-$suffix"
$group = "selfcheck-shop-pipeline-$suffix"

$referenceFiles = @('delivery-plan.jsonl', 'chaos-profile.resolved.json', 'delivery-summary.json', 'actual-state.json', 'target-run.json', 'validation-report.json')
# The naive target under spec-example, chaos seed 7, small scenario, seed 42: the CLI writes the same bytes.
$naiveFiles = @{
    'delivery-plan.jsonl' = '0C08D623A42034548EE3AD76AE21B8C9638A735CBF687AA72D90C5A584CC6232'
    'chaos-profile.resolved.json' = '759A85738A32CD3BF6CED386FEFAF76F52DF33DD7DE65CD49EC70142C1A33D65'
    'delivery-summary.json' = '63887F16C26B5F8C08977A63CADA00A35BC5E5D3E1278FD148732B75E12C3B6D'
    'actual-state.json' = 'A47FBBB75451D59707B0E69CF2FEBDAF5D96BC845A94746285AE68DA46A81877'
    'target-run.json' = '62E37D930F2B321E8590593B137A4EFD550CA4C35A8CD51E64697D8D54299D86'
    'validation-report.json' = '51C6D6331A95CCF3CB0DDD1C94B90AD98E9CEC5C3E50D73A30A865F864945B44'
}
# The correct target under spec-example: the same in memory and through Kafka.
$correctState = 'af4a8046f579eb7123f45b68c594c548a7543fb522dc411ee0930f7e8455aa74'
$correctTargetRun = '65a16da07bca7938c3349cf128de4c7d6d34be01fb870e17e9ef67180e87480f'
$correctReport = '5028cbda4e905c80ce2b0d5d7a75e22cda0fd7dd5fef5dd28c27bab409e48b30'
$externalReport = 'EADFEFF2AF880EEBA0DD284523CFB38531C77AD77731C2F8F73EF723787592C7'

$savedEnv = @{ DATABASE_URL = $env:DATABASE_URL; API_PORT = $env:API_PORT; API_HOST = $env:API_HOST; EXECUTION_WORK_DIR = $env:EXECUTION_WORK_DIR; KAFKA_BROKERS = $env:KAFKA_BROKERS }
$script:ApiProcess = $null
$script:ApiStarts = 0
$script:Pipeline = $null

function Invoke-Native {
    param([string]$Command, [string[]]$Arguments, [string]$InputText)
    if ($PSBoundParameters.ContainsKey('InputText')) {
        $lines = $InputText | & $Command @Arguments 2>&1 | ForEach-Object { "$_" }
    } else {
        $lines = & $Command @Arguments 2>&1 | ForEach-Object { "$_" }
    }
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($lines -join "`n") }
}

function Invoke-Sql {
    param([string]$Sql)
    Invoke-Native 'docker' @('compose', 'exec', '-T', 'postgres', 'psql', '-U', 'dataforge', '-d', 'dataforge_selfcheck', '-v', 'ON_ERROR_STOP=1') -InputText $Sql
}

function Invoke-KafkaTopics {
    param([string[]]$Arguments)
    Invoke-Native 'docker' (@('compose', 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'localhost:19092') + $Arguments)
}

# One HTTP request through curl.exe: the status code and the body, whatever the status.
function Invoke-Http {
    param([string]$Method = 'GET', [string]$Path, [string]$BodyFile)
    $arguments = @('-s', '-X', $Method, '-w', "`n%{http_code}")
    if ($BodyFile) { $arguments += @('-H', 'Content-Type: application/json', '--data-binary', "@$BodyFile") }
    $lines = @(& curl.exe @arguments "$api$Path" 2>&1 | ForEach-Object { "$_" })
    $status = if ($lines.Count -gt 0) { [int]$lines[$lines.Count - 1] } else { 0 }
    $body = if ($lines.Count -gt 1) { ($lines[0..($lines.Count - 2)] -join "`n") } else { '' }
    [pscustomobject]@{ Status = $status; Body = $body }
}

function Get-Json([string]$Path) { Invoke-RestMethod -Uri "$api$Path" }

function Post-Json {
    param([string]$Path, [hashtable]$Body)
    Invoke-RestMethod -Method Post -Uri "$api$Path" -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 5)
}

function Wait-Run([string]$Id, [int]$TimeoutSeconds = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 200
        $run = Get-Json "/runs/$Id"
    } while (($run.status -eq 'queued' -or $run.status -eq 'running') -and (Get-Date) -lt $deadline)
    $run
}

function Wait-Execution([string]$Id, [int]$TimeoutSeconds = 120) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $execution = Get-Json "/executions/$Id"
    } while (($execution.status -eq 'queued' -or $execution.status -eq 'running') -and (Get-Date) -lt $deadline)
    $execution
}

function Start-Execution {
    param([string]$Profile, [hashtable]$Target, [int]$Version = 1)
    $execution = Post-Json '/executions' @{ runId = $script:run.id; chaosProfileId = $script:profiles[$Profile]; chaosProfileVersion = $Version; chaosSeed = 7; target = $Target }
    $script:accepted = $execution.status
    Wait-Execution $execution.id
}

function Save-ExecutionFiles([string]$Id, [string]$Directory, [string[]]$Names) {
    New-Item -ItemType Directory -Force $Directory | Out-Null
    foreach ($name in $Names) {
        Invoke-WebRequest -UseBasicParsing -Uri "$api/executions/$Id/files/$name" -OutFile (Join-Path $Directory $name)
    }
}

function Start-Api {
    $env:DATABASE_URL = $selfCheckDb
    $env:API_PORT = "$port"
    $env:API_HOST = '127.0.0.1'
    $env:EXECUTION_WORK_DIR = $workDir
    $env:KAFKA_BROKERS = 'localhost:9092'
    $script:ApiStarts += 1
    $log = Join-Path $out "api-$($script:ApiStarts).log"
    $node = (Get-Command node).Source
    $script:ApiProcess = Start-Process -FilePath $node -ArgumentList 'apps/api/dist/main.js' -PassThru -NoNewWindow `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        if ($script:ApiProcess.HasExited) { return $false }
        if ((Invoke-Http -Path '/health').Status -eq 200) { return $true }
    }
    $false
}

function Stop-Api {
    if ($null -ne $script:ApiProcess -and -not $script:ApiProcess.HasExited) {
        Stop-Process -Id $script:ApiProcess.Id -Force
        $script:ApiProcess.WaitForExit(10000) | Out-Null
    }
    $script:ApiProcess = $null
}

function Api-Log {
    $log = Join-Path $out "api-$($script:ApiStarts).log"
    ((Get-Content $log -Raw) + "`n" + (Get-Content "$log.err" -Raw)) -replace '\x1b\[[0-9;]*m', ''
}

function Short([string]$Hash) { $Hash.Substring(0, 16).ToUpperInvariant() }

Write-Host "DataForge Milestone 7 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

try {

Test-Case 'MV-7.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    foreach ($project in 'packages/core', 'packages/chaos', 'packages/targets', 'packages/validation', 'packages/kafka', 'packages/execution', 'apps/api', 'apps/consumer', 'apps/cli') {
        Assert-Match $check.Text "$project typecheck: Done" "$project type-checked"
    }
    Assert-Match $check.Text 'Test Suites:\s+38 passed, 38 total' 'pnpm check suites'
    Assert-Match $check.Text 'Tests:\s+451 passed, 451 total' 'pnpm check tests'
    $build = Invoke-Pnpm @('build')
    Assert-Exit $build 0 'pnpm build'
    Assert-Match $build.Text 'packages/execution build: Done' 'execution package built'
}

Test-Case 'MV-7.2' 'Services, the migration and the integration suite' {
    Assert-Exit (Invoke-Native 'docker' @('compose', 'up', '-d', '--wait')) 0 'docker compose up -d --wait'
    Assert-Exit (Invoke-Native 'node' @('apps/api/scripts/recreate-database.js', $selfCheckDb, '--no-migrate')) 0 'recreate dataforge_selfcheck'
    $env:DATABASE_URL = $selfCheckDb
    $migrate = Invoke-Pnpm @('db:migrate')
    Assert-Exit $migrate 0 'pnpm db:migrate'
    Assert-Match $migrate.Text 'Applying migration `20261123140000_test_executions`' 'Milestone 7 migration applied'
    $tables = Invoke-Sql '\dt'
    foreach ($table in 'chaos_profile', 'chaos_profile_version', 'test_execution', 'delivery_attempt', 'execution_file', 'validation_report', 'validation_finding', 'window_finding') {
        Assert-Match $tables.Text "public \| $table " "table $table"
    }
    Assert-Match $tables.Text '\(14 rows\)' 'fourteen tables'
    Remove-Item Env:DATABASE_URL
    $integration = Invoke-Pnpm @('test:integration')
    Assert-Exit $integration 0 'pnpm test:integration'
    Assert-Match $integration.Text 'Test Suites:\s+11 passed, 11 total' 'integration suites'
    Assert-Match $integration.Text 'Tests:\s+132 passed, 132 total' 'integration tests'
}

Test-Case 'MV-7.3' 'Start the API, register a scenario and generate a run' {
    Assert-That (Start-Api) 'the API did not answer /health within 30 s'
    $small = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
    $script:run = Wait-Run (Post-Json '/runs' @{ scenarioId = $small.id; seed = 42 }).id
    Assert-That ($run.status -eq 'succeeded' -and $run.eventCount -eq 472) "run $($run.status) $($run.eventCount)"
    Assert-That ($run.files.'events.jsonl'.sha256 -eq '01b57d640ab12e33702ccb72339fd00552e6b37b3fddce4dff7a5a8c0cca42de') 'the run of Milestone 6'
}

Test-Case 'MV-7.4' 'Chaos profiles: register, refuse invalid and duplicate, version' {
    $script:profiles = @{}
    foreach ($name in 'spec-example', 'late-data', 'none') {
        $created = Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile "chaos-profiles\$name.json"
        $script:profiles[$name] = $created.id
        Assert-That ($created.latestVersion -eq 1) "$name version $($created.latestVersion)"
    }
    $spec = Get-Json "/chaos-profiles/$($profiles['spec-example'])"
    Assert-That ($spec.versions[0].profileHash -eq 'sha256:abd6a63c5aec0e082fca427a28eaabc2c1c4f67d2b0c0728619c53e6c9163a2b') "spec-example hash $($spec.versions[0].profileHash)"
    $v1 = Get-Json "/chaos-profiles/$($profiles['spec-example'])/versions/1"
    Assert-That ($v1.definition.faults.duplicate.rate -eq 0.03 -and $v1.definition.faults.transientFailure.maxRetries -eq 3) 'resolved definition'
    $bad = Join-Path $out 'bad-profile.json'
    Set-Content -Path $bad -Encoding Ascii -Value '{"formatVersion":1,"name":"bad","faults":{"delay":{"rate":2},"transientFailure":{"rate":0.1,"failures":{"min":1,"max":5},"maxRetries":2}}}'
    $invalid = Invoke-Http -Method POST -Path '/chaos-profiles' -BodyFile $bad
    Assert-That ($invalid.Status -eq 400) "invalid profile HTTP $($invalid.Status)"
    Assert-That ($invalid.Body -eq '{"message":["faults.delay.rate: Too big: expected number to be <=1","faults.transientFailure.failures.max: cannot exceed maxRetries (2) unless allowLoss is true: an event that fails more often than it is retried is lost"],"error":"Bad Request","statusCode":400}') "invalid body $($invalid.Body)"
    $duplicate = Invoke-Http -Method POST -Path '/chaos-profiles' -BodyFile 'chaos-profiles\spec-example.json'
    Assert-That ($duplicate.Status -eq 409) "duplicate HTTP $($duplicate.Status)"
    Assert-Match $duplicate.Body ([regex]::Escape("A chaos profile named \`"spec-example\`" already exists (id $($profiles['spec-example'])); add a version with POST /chaos-profiles/$($profiles['spec-example'])/versions.")) 'duplicate message'
    $doc = Get-Content chaos-profiles\spec-example.json -Raw | ConvertFrom-Json
    $doc.faults.duplicate.rate = 0.2
    $changed = Join-Path $out 'spec-example-20.json'
    $doc | ConvertTo-Json -Depth 10 | Set-Content -Path $changed -Encoding Ascii
    $v2 = Invoke-Http -Method POST -Path "/chaos-profiles/$($profiles['spec-example'])/versions" -BodyFile $changed
    Assert-That ($v2.Status -eq 201 -and ($v2.Body | ConvertFrom-Json).version -eq 2) "new version HTTP $($v2.Status)"
    $same = Invoke-Http -Method POST -Path "/chaos-profiles/$($profiles['spec-example'])/versions" -BodyFile 'chaos-profiles\spec-example.json'
    Assert-That ($same.Status -eq 200 -and ($same.Body | ConvertFrom-Json).version -eq 1) "identical to version 1: HTTP $($same.Status)"
    Assert-That (@((Get-Json '/chaos-profiles').chaosProfiles).Count -eq 3) 'three profiles'
}

Test-Case 'MV-7.5' 'A passing execution: the correct target under the spec example' {
    $script:correct = Start-Execution 'spec-example' @{ type = 'reference'; name = 'correct' }
    Assert-That ($accepted -eq 'queued') "accepted as $accepted"
    Assert-That ($correct.status -eq 'completed' -and $correct.verdict -eq 'PASS' -and $correct.findingCount -eq 0 -and $null -eq $correct.error) "execution $($correct.status) $($correct.verdict) $($correct.error)"
    Assert-That ($correct.attemptCount -eq 486 -and $correct.delivery.attemptsByKind.duplicate -eq 14 -and $correct.delivery.faults.reorder.faultedEvents -eq 8) 'delivery summary'
    $result = $correct.targetResult
    Assert-That ($result.delivery.messages -eq 486 -and $result.delivery.distinctEvents -eq 472 -and $result.delivery.redeliveries -eq 14) 'target received'
    Assert-That ($result.counters.duplicatesIgnored -eq 14 -and $result.counters.eventsParked -eq 11 -and $result.parkedEvents -eq 0) 'target counters'
    Assert-That ((@($correct.files.PSObject.Properties.Name) -join ',') -eq ($referenceFiles -join ',')) "files $(@($correct.files.PSObject.Properties.Name) -join ',')"
    Assert-That ($correct.files.'actual-state.json'.sha256 -eq $correctState) "actual-state.json $($correct.files.'actual-state.json'.sha256)"
}

Test-Case 'MV-7.6' 'A failing execution: the naive target, its report, findings and causes' {
    $script:naive = Start-Execution 'spec-example' @{ type = 'reference'; name = 'naive' }
    Assert-That ($naive.status -eq 'completed' -and $naive.verdict -eq 'FAIL' -and $naive.findingCount -eq 48) "execution $($naive.status) $($naive.verdict) $($naive.findingCount)"
    $report = Get-Json "/executions/$($naive.id)/report"
    $counts = $report.counts.byCategory
    Assert-That ($counts.'field-mismatch' -eq 14 -and $counts.'status-mismatch' -eq 8 -and $counts.'double-processing' -eq 8 -and $counts.'invariant-violation' -eq 18) 'counts by category'
    Assert-That ($report.counts.explained -eq 48 -and $report.counts.unexplained -eq 0) 'every finding explained'
    Assert-That ($report.rootCauses[0].cause.eventId -eq 'evt_ord_000045_1' -and $report.rootCauses[0].findings -eq 7) "first root cause $($report.rootCauses[0].cause.eventId)"
    $doubled = Get-Json "/executions/$($naive.id)/findings?category=double-processing&limit=3"
    $first = $doubled.findings[0]
    Assert-That ($doubled.total -eq 8 -and $first.entityId -eq 'cus_000009' -and $first.message -eq 'orderCount is 23, expected 22') "first double-processing finding $($first.entityId): $($first.message)"
    Assert-That ($first.causes[0].eventId -eq 'evt_ord_000078_1' -and $first.causes[0].deliveries -eq 2 -and ($first.causes[0].faults -join ',') -eq 'duplicate') 'its cause'
    $attempts = @((Get-Json "/executions/$($naive.id)/attempts?eventId=evt_ord_000078_1").attempts)
    Assert-That (($attempts | ForEach-Object { "$($_.attemptId):$($_.kind):$($_.deliverySequence)" }) -join ',' -eq 'att_ord_000078_1_1:original:42,att_ord_000078_1_2:duplicate:43') "attempts $(($attempts | ForEach-Object { $_.attemptId }) -join ',')"
    Assert-That ($attempts[1].derivedFrom.attemptId -eq 'att_ord_000078_1_1' -and $attempts[1].derivedFrom.offsetMs -eq 16614) 'the duplicate is derived from the original'
}

Test-Case 'MV-7.7' 'The same bytes as the CLI' {
    $dir = Join-Path $out 'api-naive'
    Save-ExecutionFiles $naive.id $dir $referenceFiles
    $cliRun = Join-Path $out 'cli-run'
    $cliPlan = Join-Path $out 'cli-plan'
    $cliOut = Join-Path $out 'cli-naive'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '42', '--out', $cliRun)) 0 'generate'
    Assert-Exit (Invoke-DataForge @('chaos', 'plan', '--run', $cliRun, '--profile', 'chaos-profiles/spec-example.json', '--chaos-seed', '7', '--out', $cliPlan)) 0 'chaos plan'
    Assert-Exit (Invoke-DataForge @('deliver', '--run', $cliRun, '--plan', $cliPlan, '--target', 'naive', '--out', $cliOut)) 0 'deliver'
    Assert-Exit (Invoke-DataForge @('validate', '--run', $cliRun, '--actual', (Join-Path $cliOut 'actual-state.json'), '--plan', $cliPlan, '--report', (Join-Path $cliOut 'validation-report.json'))) 1 'validate'
    foreach ($name in $referenceFiles) {
        $cliFile = if ($name -like 'delivery-*' -or $name -like 'chaos-*') { Join-Path $cliPlan $name } else { Join-Path $cliOut $name }
        $fromApi = Get-Sha256 (Join-Path $dir $name)
        Assert-That ($fromApi -eq (Get-Sha256 $cliFile)) "$name differs from the CLI"
        Assert-That ($fromApi -eq $naiveFiles[$name]) "$name hash $fromApi"
    }
}

Test-Case 'MV-7.8' "An order's canonical timeline and its delivery timeline" {
    $events = @((Get-Json "/runs/$($run.id)/events?aggregateId=ord_000045").events)
    $delivered = @((Get-Json "/executions/$($naive.id)/attempts?aggregateId=ord_000045").attempts)
    Write-Note ("canonical: " + (($events | ForEach-Object { "$($_.sequence):$($_.type)" }) -join ', '))
    Write-Note ("delivered: " + (($delivered | ForEach-Object { "$($_.deliverySequence):$($_.eventId):$((@($_.faults | ForEach-Object { $_.type })) -join '+')" }) -join ', '))
    Assert-That (($events | ForEach-Object { "$($_.sequence):$($_.type)" }) -join ',' -eq '147:OrderCreated,149:PaymentCompleted,196:ShipmentCreated,466:ShipmentDelivered') "canonical timeline $(($events | ForEach-Object { $_.eventId }) -join ',')"
    Assert-That (($delivered | ForEach-Object { "$($_.deliverySequence):$($_.eventId)" }) -join ',' -eq '153:evt_ord_000045_2,154:evt_ord_000045_1,479:evt_ord_000045_4,480:evt_ord_000045_3') "delivery timeline $(($delivered | ForEach-Object { $_.eventId }) -join ',')"
    Assert-That ($delivered[1].faults[0].type -eq 'reorder' -and $delivered[1].faults[0].behindEventId -eq 'evt_ord_000045_2') 'the first reorder fault'
    Assert-That ($delivered[3].faults[0].type -eq 'reorder' -and $delivered[3].faults[0].behindEventId -eq 'evt_ord_000045_4') 'the second reorder fault'
    $statusFinding = @((Get-Json "/executions/$($naive.id)/findings?entityType=order&entityId=ord_000045").findings)
    Write-Note ('ord_000045 findings: ' + (($statusFinding | ForEach-Object { "$($_.category): $($_.message)" }) -join ' | '))
    Assert-That ($statusFinding.Count -ge 1 -and ($statusFinding | Where-Object { $_.category -eq 'status-mismatch' })) 'a status-mismatch finding for the reordered order'
}

Test-Case 'MV-7.9' 'Windows and late data' {
    $late = Start-Execution 'late-data' @{ type = 'reference'; name = 'naive' }
    Assert-That ($late.status -eq 'completed' -and $late.verdict -eq 'FAIL' -and $late.findingCount -eq 19 -and $late.windowFindingCount -eq 13) "late-data $($late.verdict) $($late.findingCount) $($late.windowFindingCount)"
    $windows = (Get-Json "/executions/$($late.id)/report").windows
    Assert-That ($windows.counts.byCategory.'window-undercount' -eq 7 -and $windows.counts.byCategory.'window-overcount' -eq 6 -and $windows.counts.unexplained -eq 0) 'window counts'
    $first = @((Get-Json "/executions/$($late.id)/window-findings?limit=2").findings)[0]
    Assert-That ($first.category -eq 'window-undercount' -and $first.windowStartMs -eq 50400000 -and $first.message -eq 'paymentsCompleted is 3, expected 4; revenueMinor is 61320, expected 83806') "first window finding $($first.message)"
    Assert-That ($first.causes[0].eventId -eq 'evt_ord_000012_2' -and $first.causes[0].arrival -eq 'after-close') 'late cause'
    Assert-That ($null -ne $late.files.'actual-windows.json') 'actual-windows.json'
}

Test-Case 'MV-7.10' 'An execution through Kafka' {
    $script:kafka = Start-Execution 'spec-example' @{ type = 'reference'; name = 'correct'; transport = 'kafka' }
    Assert-That ($kafka.status -eq 'completed' -and $kafka.verdict -eq 'PASS' -and $null -eq $kafka.error) "kafka execution $($kafka.status) $($kafka.error)"
    Assert-That ($kafka.kafka.topic -match '^dataforge\.' -and $kafka.kafka.partitions -eq 1 -and $kafka.kafka.sent -eq 486 -and $kafka.kafka.plannedFailures -eq 0) "kafka $($kafka.kafka | ConvertTo-Json -Compress)"
    Assert-That ($kafka.target.partitions -eq 1 -and $kafka.target.speed -eq 'max' -and $kafka.target.timeoutSeconds -eq 60) 'target defaults'
    Assert-That ($kafka.files.'actual-state.json'.sha256 -eq $correctState -and $kafka.files.'target-run.json'.sha256 -eq $correctTargetRun -and $kafka.files.'validation-report.json'.sha256 -eq $correctReport) 'the same files as in memory'
    Assert-That (@($kafka.files.PSObject.Properties.Name).Count -eq 8) "$(@($kafka.files.PSObject.Properties.Name).Count) files"
    $first = @((Get-Json "/executions/$($kafka.id)/attempts?limit=3").attempts)
    Assert-That (($first | ForEach-Object { "$($_.kafka.outcome):$($_.kafka.partition):$($_.kafka.offset)" }) -join ',' -eq 'sent:0:0,sent:0:1,sent:0:2') 'offsets of the first attempts'
    Assert-That (Test-Path (Join-Path $kafka.workDirectory 'consumer.log')) "consumer.log in $($kafka.workDirectory)"
    Write-Note "topic $($kafka.kafka.topic), $($kafka.kafka.durationMs) ms"
}

Test-Case 'MV-7.11' 'An external pipeline: produce, wait, submit, validate' {
    Assert-Match (Invoke-KafkaTopics @('--create', '--topic', $topic, '--partitions', '1')).Text "Created topic $topic\." 'topic created'
    $pipelineOut = Join-Path $out 'pipeline'
    New-Item -ItemType Directory -Force $pipelineOut | Out-Null
    $node = (Get-Command node).Source
    $script:Pipeline = Start-Process -FilePath $node -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $out 'pipeline.log') -RedirectStandardError (Join-Path $out 'pipeline.err') `
        -ArgumentList @('scripts/verification/external-pipeline.js', $pipelineOut, '--brokers', 'localhost:9092', '--topic', $topic, '--group', $group, '--target', 'naive')
    # Windows PowerShell 5.1 reports no ExitCode for a Start-Process process unless its handle was opened while it ran.
    $null = $script:Pipeline.Handle
    $deadline = (Get-Date).AddSeconds(30)
    do { Start-Sleep -Milliseconds 200 } until (((Get-Content (Join-Path $out 'pipeline.log') -Raw) -match 'external-pipeline: ready') -or (Get-Date) -gt $deadline)
    $external = Start-Execution 'spec-example' @{ type = 'external'; topic = $topic; groupId = $group }
    Assert-That ($external.status -eq 'awaiting_actual_state' -and $null -eq $external.error) "external $($external.status) $($external.error)"
    Assert-That ($external.kafka.topic -eq $topic -and $external.kafka.sent -eq 486 -and $null -eq $external.targetResult) 'delivered to the topic'
    Assert-That ((@($external.files.PSObject.Properties.Name) -join ',') -eq 'delivery-plan.jsonl,chaos-profile.resolved.json,delivery-summary.json,delivery-log.jsonl,kafka-run.json') 'files while waiting'
    Assert-That ((Invoke-Http -Path "/executions/$($external.id)/report").Status -eq 409) 'no report while waiting'

    Set-Content (Join-Path $pipelineOut 'finish') 'x'
    Assert-That ($script:Pipeline.WaitForExit(30000) -and $script:Pipeline.ExitCode -eq 0) 'the pipeline finished'
    Assert-Match (Get-Content (Join-Path $out 'pipeline.log') -Raw) 'consumed    486 records: 472 distinct events, 14 redeliveries' 'pipeline consumed'

    $badBody = Join-Path $out 'bad-submission.json'
    Set-Content -Path $badBody -Encoding Ascii -Value '{"actualState":{"format":"dataforge.actual-state"}}'
    $refused = Invoke-Http -Method POST -Path "/executions/$($external.id)/actual-state" -BodyFile $badBody
    Assert-That ($refused.Status -eq 400) "invalid submission HTTP $($refused.Status)"
    Assert-Match $refused.Body '^\{"message":\["actualState\.formatVersion: ' 'paths prefixed with actualState'
    $body = Join-Path $out 'submission.json'
    Set-Content -Path $body -Encoding Ascii -NoNewline -Value ('{"actualState":' + (Get-Content (Join-Path $pipelineOut 'actual-state.json') -Raw) + '}')
    $done = Invoke-Http -Method POST -Path "/executions/$($external.id)/actual-state" -BodyFile $body
    $completed = $done.Body | ConvertFrom-Json
    Assert-That ($done.Status -eq 200 -and $completed.status -eq 'completed' -and $completed.verdict -eq 'FAIL' -and $completed.findingCount -eq 48) "submission HTTP $($done.Status) $($completed.status) $($completed.findingCount)"
    Assert-That ((Invoke-Http -Method POST -Path "/executions/$($external.id)/actual-state" -BodyFile $body).Status -eq 409) 'a second submission is refused'
    Save-ExecutionFiles $external.id (Join-Path $out 'api-external') @('validation-report.json', 'actual-state.json')
    Assert-That ((Get-Sha256 (Join-Path $out 'api-external\actual-state.json')) -eq $naiveFiles['actual-state.json']) 'the pipeline state equals the naive target in memory'
    $cliReport = Join-Path $out 'cli-external-report.json'
    Assert-Exit (Invoke-DataForge @('validate', '--run', (Join-Path $out 'cli-run'), '--actual', (Join-Path $pipelineOut 'actual-state.json'), '--plan', (Join-Path $out 'cli-plan'), '--report', $cliReport)) 1 'CLI validate'
    $reportHash = Get-Sha256 (Join-Path $out 'api-external\validation-report.json')
    Assert-That ($reportHash -eq (Get-Sha256 $cliReport) -and $reportHash -eq $externalReport) "report $reportHash"
    Assert-Match (Api-Log) "Execution $($external.id) delivered in \d+ ms; awaiting the external pipeline's actual state" 'runner log'
}

Test-Case 'MV-7.12' 'External failures: a missing topic, a group without a consumer' {
    $missing = Start-Execution 'none' @{ type = 'external'; topic = 'no-such-topic'; groupId = $group }
    Assert-That ($missing.status -eq 'failed') "missing topic $($missing.status)"
    Assert-That ($missing.error -eq 'Topic "no-such-topic" does not exist. An external execution produces to your pipeline''s topic: create it, and start your pipeline on it, before the execution.') "error $($missing.error)"
    $idle = Start-Execution 'none' @{ type = 'external'; topic = $topic; groupId = $group }
    Assert-That ($idle.status -eq 'failed' -and $null -eq $idle.attemptCount) "idle group $($idle.status)"
    Assert-That ($idle.error -eq "Consumer group `"$group`" has no active member (group state Empty). Start your pipeline, consuming `"$topic`" with group `"$group`", before the execution: without an active member the group's lag never reaches zero.") "error $($idle.error)"
}

Test-Case 'MV-7.13' 'Invalid execution requests' {
    $bad = Join-Path $out 'bad-execution.json'
    Set-Content -Path $bad -Encoding Ascii -Value ('{"runId":"' + $run.id + '","chaosProfileId":"' + $profiles['none'] + '","chaosSeed":"two words","target":{"type":"reference","name":"clever","partitions":2}}')
    $invalid = Invoke-Http -Method POST -Path '/executions' -BodyFile $bad
    Assert-That ($invalid.Status -eq 400) "invalid HTTP $($invalid.Status)"
    Assert-That ($invalid.Body -eq '{"message":["chaosSeed: Invalid seed \"two words\": use 1-128 characters from A-Z, a-z, 0-9, \".\", \"_\", \":\" and \"-\"","target.name: Invalid option: expected one of \"correct\"|\"naive\""],"error":"Bad Request","statusCode":400}') "invalid body $($invalid.Body)"
    $memory = Join-Path $out 'memory-partitions.json'
    Set-Content -Path $memory -Encoding Ascii -Value ('{"runId":"' + $run.id + '","chaosProfileId":"' + $profiles['none'] + '","chaosSeed":7,"target":{"type":"reference","name":"correct","partitions":2}}')
    $partitions = Invoke-Http -Method POST -Path '/executions' -BodyFile $memory
    Assert-That ($partitions.Status -eq 400 -and $partitions.Body -eq '{"message":["target.partitions: applies only to \"transport\": \"kafka\""],"error":"Bad Request","statusCode":400}') "partitions $($partitions.Body)"
    $unknown = Join-Path $out 'unknown-run.json'
    Set-Content -Path $unknown -Encoding Ascii -Value ('{"runId":"01a20000-0000-7000-8000-000000000000","chaosProfileId":"' + $profiles['none'] + '","chaosSeed":7,"target":{"type":"reference","name":"correct"}}')
    $notFound = Invoke-Http -Method POST -Path '/executions' -BodyFile $unknown
    Assert-That ($notFound.Status -eq 404 -and $notFound.Body -match 'Run 01a20000-0000-7000-8000-000000000000 not found\.') "unknown run $($notFound.Status)"
    $std = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-standard.json
    $pending = Post-Json '/runs' @{ scenarioId = $std.id; seed = 42 }
    $early = Join-Path $out 'early.json'
    Set-Content -Path $early -Encoding Ascii -Value ('{"runId":"' + $pending.id + '","chaosProfileId":"' + $profiles['none'] + '","chaosSeed":7,"target":{"type":"reference","name":"correct"}}')
    $conflict = Invoke-Http -Method POST -Path '/executions' -BodyFile $early
    Assert-That ($conflict.Status -eq 409) "run not succeeded HTTP $($conflict.Status)"
    Assert-Match $conflict.Body "Run $($pending.id) is (queued|running); start an execution once it has succeeded\." 'not succeeded message'
    Assert-That ((Wait-Run $pending.id 120).status -eq 'succeeded') 'the standard run finished'
    $file = Invoke-Http -Path "/executions/$($naive.id)/files/notes.txt"
    Assert-That ($file.Status -eq 400) "bad file name HTTP $($file.Status)"
    $absent = Invoke-Http -Path "/executions/$($naive.id)/files/kafka-run.json"
    Assert-That ($absent.Status -eq 404 -and $absent.Body -match 'has no kafka-run\.json: only a Kafka execution has one\.') "absent file $($absent.Body)"
}

Test-Case 'MV-7.14' 'A tampered attempt or finding is never served' {
    $refused = Invoke-Sql "UPDATE delivery_attempt SET kind = 'retry' WHERE execution_id = '$($naive.id)' AND delivery_sequence = 43;"
    Assert-Match $refused.Text 'ERROR:  delivery_attempt rows are immutable' 'update refused by the trigger'
    $tamper = @"
BEGIN;
ALTER TABLE delivery_attempt DISABLE TRIGGER delivery_attempt_immutable;
UPDATE delivery_attempt SET scheduled_delivery_time_ms = scheduled_delivery_time_ms + 1 WHERE execution_id = '$($naive.id)' AND delivery_sequence = 43;
ALTER TABLE delivery_attempt ENABLE TRIGGER delivery_attempt_immutable;
ALTER TABLE validation_finding DISABLE TRIGGER validation_finding_immutable;
UPDATE validation_finding SET message = 'nothing to see here' WHERE execution_id = '$($naive.id)' AND ordinal = 1;
ALTER TABLE validation_finding ENABLE TRIGGER validation_finding_immutable;
COMMIT;
"@
    $changed = Invoke-Sql $tamper
    Assert-Exit $changed 0 'tamper transaction'
    $plan = Invoke-Http -Path "/executions/$($naive.id)/files/delivery-plan.jsonl"
    Assert-That ($plan.Status -eq 500) "tampered plan HTTP $($plan.Status)"
    Assert-Match $plan.Body ([regex]::Escape("{`"statusCode`":500,`"error`":`"Execution Integrity Error`",`"message`":`"delivery-plan.jsonl rebuilt from the database does not match the checksum recorded when execution $($naive.id) made it (recorded sha256 $($naiveFiles['delivery-plan.jsonl'].ToLowerInvariant()), 167512 bytes; rebuilt sha256 ")) 'plan integrity error'
    $report = Invoke-Http -Path "/executions/$($naive.id)/files/validation-report.json"
    Assert-That ($report.Status -eq 500) "tampered report HTTP $($report.Status)"
    Assert-Match $report.Body 'validation-report\.json rebuilt from the database does not match the checksum' 'report integrity error'
    Assert-That ((Invoke-Http -Path "/executions/$($naive.id)/files/actual-state.json").Status -eq 200) 'actual-state.json still served'
    Assert-That ((Invoke-Http -Path "/executions/$($correct.id)/files/delivery-plan.jsonl").Status -eq 200) 'other executions still served'
    Assert-Match (Api-Log) "ERROR \[Executions\] .*Integrity check failed for execution $($naive.id)" 'integrity error logged'
}

Test-Case 'MV-7.15' 'Restart: an interrupted execution runs again' {
    $slow = Post-Json '/executions' @{ runId = $run.id; chaosProfileId = $profiles['spec-example']; chaosProfileVersion = 1; chaosSeed = 7; target = @{ type = 'reference'; name = 'correct'; transport = 'kafka'; speed = 5000 } }
    $deadline = (Get-Date).AddSeconds(30)
    do { Start-Sleep -Milliseconds 500 } until ((Get-Json "/executions/$($slow.id)").status -eq 'running' -or (Get-Date) -gt $deadline)
    Start-Sleep -Seconds 5
    Stop-Api
    $status = Invoke-Sql "SELECT status, attempt_count FROM test_execution WHERE id = '$($slow.id)';"
    Assert-Match $status.Text '(?m)^\s*running\s+\|\s*$' 'left running, nothing stored'
    $rows = Invoke-Sql "SELECT count(*) FROM delivery_attempt WHERE execution_id = '$($slow.id)';"
    Assert-Match $rows.Text '(?m)^\s+0$' 'no attempt rows'
    Assert-That (Start-Api) 'the API did not restart'
    Assert-Match (Api-Log) "Resuming 1 queued execution\(s\): $($slow.id)" 'resuming line'
    $done = Wait-Execution $slow.id 120
    Assert-That ($done.status -eq 'completed' -and $done.verdict -eq 'PASS') "after restart $($done.status) $($done.verdict) $($done.error)"
    Assert-That ($done.files.'actual-state.json'.sha256 -eq $correctState) 'the same state as before'
    Assert-That ($done.kafka.durationMs -ge 30000) "paced delivery took $($done.kafka.durationMs) ms"
    Write-Note "paced delivery $($done.kafka.durationMs) ms"
}

Test-Case 'MV-7.16' 'Execution history' {
    $all = Get-Json "/executions?runId=$($run.id)"
    Assert-That ($all.total -eq 8) "total $($all.total)"
    $statuses = (@($all.executions) | ForEach-Object { $_.status }) -join ','
    Assert-That ($statuses -eq 'completed,failed,failed,completed,completed,completed,completed,completed') "statuses newest first: $statuses"
    $failed = Get-Json "/executions?runId=$($run.id)&verdict=FAIL"
    Assert-That ($failed.total -eq 3) "FAIL $($failed.total)"
    Assert-That ((Get-Json "/executions?status=failed").total -eq 2) 'failed executions'
    Assert-That ((Get-Json "/executions?chaosProfileId=$($profiles['late-data'])").total -eq 1) 'by chaos profile'
}

Test-Case 'MV-7.17' 'The execution steps stay deterministic' {
    $probe = 'packages\execution\src\guard-probe.ts'
    Set-Content $probe "import { readFileSync } from 'node:fs';`nimport { Kafka } from 'kafkajs';`nexport const probe = [readFileSync, Kafka, Date.now()];"
    try {
        $lint = Invoke-Pnpm @('lint')
        Assert-Exit $lint 1 'lint with the probe'
        Assert-Match $lint.Text "'node:fs' import is restricted from being used by a pattern\. The simulation core performs no I/O" 'file system refused'
        Assert-Match $lint.Text "'kafkajs' import is restricted from being used by a pattern" 'Kafka client refused'
        Assert-Match $lint.Text 'Business time comes from the simulation clock, not the machine clock' 'Date.now refused'
    } finally {
        Remove-Item $probe -ErrorAction SilentlyContinue
    }
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint without the probe'
}

} finally {
    Stop-Api
    if ($null -ne $script:Pipeline -and -not $script:Pipeline.HasExited) { Stop-Process -Id $script:Pipeline.Id -Force }
    foreach ($name in $savedEnv.Keys) {
        if ($null -eq $savedEnv[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $savedEnv[$name] }
    }
}

Complete-Verification 'Milestone 7'

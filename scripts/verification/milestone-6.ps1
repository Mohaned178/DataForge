<#
.SYNOPSIS
    Runs every Milestone 6 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-6.md case by case (same IDs, same requests, same
    expected values). It never touches the data of the hand-run steps: it recreates its own database
    (dataforge_selfcheck), starts its own API on port 3106 and writes only to out\self-check.
    Needs Docker Desktop: it starts the Compose services (docker compose up -d --wait) and, in
    MV-6.15, stops PostgreSQL for a moment and starts it again.
    Works in Windows PowerShell 5.1 and PowerShell 7. Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-6.1 (pnpm install, check, build) when the workspace is already installed and built.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-6.ps1
#>
param([switch]$SkipInstall)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$port = 3106
$api = "http://127.0.0.1:$port"
$selfCheckDb = 'postgresql://dataforge:dataforge@localhost:5433/dataforge_selfcheck'
$emptyDb = 'postgresql://dataforge:dataforge@localhost:5433/dataforge_selfcheck_empty'
$runFiles = @('events.jsonl', 'expected-state.json', 'scenario.resolved.json', 'manifest.json')
$small42 = @{
    'events.jsonl' = '01B57D640AB12E33702CCB72339FD00552E6B37B3FDDCE4DFF7A5A8C0CCA42DE'
    'expected-state.json' = '3546842D89241F81B31BD2BFAA11916FFF0EE04CC400195A70B4C2E6BEFF2101'
    'scenario.resolved.json' = 'F642FB41261117D68DDE26C14B0859B6FD01D898C1C3C0DC5FCF8354E1978714'
    'manifest.json' = 'E58BD81FB8F519B236585CE1BCA12CB9CD86E15638ADF42EEF9D292814867456'
}
$standard42 = @{
    'events.jsonl' = 'E50C2D7714C78069B4AA80E87EA084D9B5406A2474D2EA05B6ED661AA4FC4157'
    'expected-state.json' = 'BDDC639A821F02F995933B415C069DEFA972BFF6BF551061145AA49AE16D67E5'
    'scenario.resolved.json' = '1B8725DB1100A2E956062052BA07761000A966338A9F94095E7DAB3F3D5F70EA'
    'manifest.json' = '8EA0A368DF43AE6EEE3C177F19AEAA400E7E2887FDE4D4BCD2EBDCF4A0784776'
}
$seed7EventsSha = 'e344107c323c7f6c75b2b01a5c45061fa757ee5f40cb90eb516d1854e0ac16f9'
$seed7EventCount = 467
$tamperEventsSha = 'fe4679ad886ae4bda50e44022b889868ba1472c56e71cc785e791a7ced2a22e3'

$savedEnv = @{ DATABASE_URL = $env:DATABASE_URL; API_PORT = $env:API_PORT; API_HOST = $env:API_HOST }
$script:ApiProcess = $null
$script:ApiStarts = 0

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
    param([string]$Sql, [string]$Database = 'dataforge_selfcheck')
    Invoke-Native 'docker' @('compose', 'exec', '-T', 'postgres', 'psql', '-U', 'dataforge', '-d', $Database, '-v', 'ON_ERROR_STOP=1') -InputText $Sql
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
    Invoke-RestMethod -Method Post -Uri "$api$Path" -ContentType 'application/json' -Body ($Body | ConvertTo-Json)
}

function Wait-Run([string]$Id, [int]$TimeoutSeconds = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 200
        $run = Get-Json "/runs/$Id"
    } while (($run.status -eq 'queued' -or $run.status -eq 'running') -and (Get-Date) -lt $deadline)
    $run
}

function Save-RunFiles([string]$Id, [string]$Directory) {
    New-Item -ItemType Directory -Force $Directory | Out-Null
    foreach ($file in $runFiles) {
        Invoke-WebRequest -UseBasicParsing -Uri "$api/runs/$Id/files/$file" -OutFile (Join-Path $Directory $file)
    }
}

function Set-ApiEnvironment([string]$DatabaseUrl) {
    $env:DATABASE_URL = $DatabaseUrl
    $env:API_PORT = "$port"
    $env:API_HOST = '127.0.0.1'
}

function Start-Api {
    Set-ApiEnvironment $selfCheckDb
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

# The API log of the current start, without colour codes: Nest writes LOG lines to stdout and
# ERROR lines to stderr.
function Api-Log {
    $log = Join-Path $out "api-$($script:ApiStarts).log"
    ((Get-Content $log -Raw) + "`n" + (Get-Content "$log.err" -Raw)) -replace '\x1b\[[0-9;]*m', ''
}

function Short([string]$Hash) { $Hash.Substring(0, 16).ToUpperInvariant() }

Write-Host "DataForge Milestone 6 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

try {

Test-Case 'MV-6.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    $install = Invoke-Pnpm @('install')
    Assert-Exit $install 0 'pnpm install'
    Assert-That (Test-Path 'apps\api\src\generated\prisma\client.ts') 'the Prisma client was not generated (apps\api\src\generated\prisma)'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    foreach ($project in 'packages/core', 'packages/chaos', 'packages/targets', 'packages/validation', 'packages/kafka', 'apps/api', 'apps/consumer', 'apps/cli') {
        Assert-Match $check.Text "$project typecheck: Done" "$project type-checked"
    }
    Assert-Match $check.Text 'Test Suites:\s+34 passed, 34 total' 'pnpm check suites'
    Assert-Match $check.Text 'Tests:\s+421 passed, 421 total' 'pnpm check tests'
    Assert-That ($check.Text -notmatch 'error TS\d+') 'pnpm check reported TypeScript errors'
    $build = Invoke-Pnpm @('build')
    Assert-Exit $build 0 'pnpm build'
    Assert-Match $build.Text 'apps/api build: Done' 'API built'
}

Test-Case 'MV-6.2' 'Start PostgreSQL with an empty database and apply the migrations' {
    Assert-Exit (Invoke-Native 'docker' @('compose', 'up', '-d', '--wait')) 0 'docker compose up -d --wait'
    $ps = Invoke-Native 'docker' @('compose', 'ps', '--format', '{{.Service}} {{.Image}} {{.Status}}')
    Assert-Match $ps.Text 'kafka apache/kafka:4\.3\.2 Up .*\(healthy\)' 'Kafka healthy'
    Assert-Match $ps.Text 'postgres postgres:18\.7-alpine Up .*\(healthy\)' 'PostgreSQL healthy'
    Assert-Exit (Invoke-Native 'node' @('apps/api/scripts/recreate-database.js', $selfCheckDb, '--no-migrate')) 0 'recreate dataforge_selfcheck'
    $env:DATABASE_URL = $selfCheckDb
    $migrate = Invoke-Pnpm @('db:migrate')
    Assert-Exit $migrate 0 'pnpm db:migrate'
    Assert-Match $migrate.Text 'Applying migration `20261122232906_init`' 'migration applied'
    Assert-Match $migrate.Text 'All migrations have been successfully applied\.' 'migrations complete'
    Assert-Match (Invoke-Pnpm @('db:migrate')).Text 'No pending migrations to apply\.' 'second migrate has nothing to do'
    $tables = Invoke-Sql '\dt'
    foreach ($table in '_prisma_migrations', 'canonical_event', 'expected_state_snapshot', 'scenario', 'scenario_version', 'simulation_run') {
        Assert-Match $tables.Text "public \| $table " "table $table"
    }
    Assert-Match $tables.Text '\(6 rows\)' 'six tables'
    Remove-Item Env:DATABASE_URL
}

Test-Case 'MV-6.3' 'The integration suite against Kafka and PostgreSQL' {
    $integration = Invoke-Pnpm @('test:integration')
    Assert-Exit $integration 0 'pnpm test:integration'
    Assert-Match $integration.Text 'Test Suites:\s+6 passed, 6 total' 'integration suites'
    Assert-Match $integration.Text 'Tests:\s+67 passed, 67 total' 'integration tests'
}

Test-Case 'MV-6.4' 'Start the API and check its health' {
    Assert-That (Start-Api) 'the API did not answer /health within 30 s'
    Assert-Match (Api-Log) "DataForge API listening on http://127\.0\.0\.1:$port \(engine 0\.1\.0, database localhost:5433/dataforge_selfcheck\)\. Ctrl\+C stops it\." 'listening line'
    $health = Get-Json '/health'
    Assert-That ($health.status -eq 'ok' -and $health.database -eq 'up' -and $health.engineVersion -eq '0.1.0') "health: $($health | ConvertTo-Json -Compress)"
}

Test-Case 'MV-6.5' 'Register a scenario' {
    $script:small = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
    Assert-That ($small.name -eq 'ecommerce-small' -and $small.latestVersion -eq 1) "scenario: $($small | ConvertTo-Json -Compress)"
    Assert-That ($small.versions[0].scenarioHash -eq 'sha256:3afbcf1ac2460a195a0e6306bd5ea1e1d3655b8d80f1d356958e60109e901158') "version 1 hash $($small.versions[0].scenarioHash)"
    $v1 = Get-Json "/scenarios/$($small.id)/versions/1"
    Assert-That ($v1.definition.orders.count -eq 120 -and $v1.definition.orders.customerCancellationRate -eq 0.08) 'resolved definition'
    Assert-That (@((Get-Json '/scenarios').scenarios).Count -eq 1) 'one scenario listed'
}

Test-Case 'MV-6.6' 'An invalid or duplicate scenario is refused' {
    $bad = Join-Path $out 'bad-scenario.json'
    Set-Content -Path $bad -Encoding Ascii -Value '{"formatVersion":1,"name":"bad","orders":{"count":-1},"customers":{"count":"many"},"colour":"blue"}'
    $invalid = Invoke-Http -Method POST -Path '/scenarios' -BodyFile $bad
    Assert-That ($invalid.Status -eq 400) "invalid scenario HTTP $($invalid.Status)"
    Assert-That ($invalid.Body -eq '{"message":["customers.count: Invalid input: expected number, received string","orders.count: Too small: expected number to be >=0","Unrecognized key: \"colour\""],"error":"Bad Request","statusCode":400}') "invalid body $($invalid.Body)"
    $duplicate = Invoke-Http -Method POST -Path '/scenarios' -BodyFile 'scenarios\ecommerce-small.json'
    Assert-That ($duplicate.Status -eq 409) "duplicate HTTP $($duplicate.Status)"
    Assert-Match $duplicate.Body ([regex]::Escape("A scenario named \`"ecommerce-small\`" already exists (id $($small.id)); add a version with POST /scenarios/$($small.id)/versions.")) 'duplicate message'
    Assert-That (@((Get-Json '/scenarios').scenarios).Count -eq 1) 'still one scenario'
}

Test-Case 'MV-6.7' 'A changed definition is a new immutable version' {
    $doc = Get-Content scenarios\ecommerce-small.json -Raw | ConvertFrom-Json
    $doc.orders.count = 60
    $changed = Join-Path $out 'small-60.json'
    $doc | ConvertTo-Json -Depth 10 | Set-Content -Path $changed -Encoding Ascii
    $created = Invoke-Http -Method POST -Path "/scenarios/$($small.id)/versions" -BodyFile $changed
    $v2 = $created.Body | ConvertFrom-Json
    Assert-That ($created.Status -eq 201 -and $v2.version -eq 2) "new version HTTP $($created.Status) version $($v2.version)"
    Assert-That ($v2.scenarioHash -eq 'sha256:e9f36f6060b18a82451010a108501fb4898ebae7c91ab7d4ccca34ed37fd548a') "version 2 hash $($v2.scenarioHash)"
    $again = Invoke-Http -Method POST -Path "/scenarios/$($small.id)/versions" -BodyFile $changed
    Assert-That ($again.Status -eq 200 -and ($again.Body | ConvertFrom-Json).version -eq 2) "identical to version 2: HTTP $($again.Status)"
    $first = Invoke-Http -Method POST -Path "/scenarios/$($small.id)/versions" -BodyFile 'scenarios\ecommerce-small.json'
    Assert-That ($first.Status -eq 200 -and ($first.Body | ConvertFrom-Json).version -eq 1) "identical to version 1: HTTP $($first.Status)"
    $versions = @((Get-Json "/scenarios/$($small.id)").versions)
    Assert-That ($versions.Count -eq 2) "$($versions.Count) versions"
    Assert-That ((Get-Json "/scenarios/$($small.id)/versions/1").definition.orders.count -eq 120) 'version 1 unchanged'
    $doc.name = 'renamed'
    $renamed = Join-Path $out 'renamed.json'
    $doc | ConvertTo-Json -Depth 10 | Set-Content -Path $renamed -Encoding Ascii
    $refused = Invoke-Http -Method POST -Path "/scenarios/$($small.id)/versions" -BodyFile $renamed
    Assert-That ($refused.Status -eq 400) "renamed HTTP $($refused.Status)"
    Assert-Match $refused.Body ([regex]::Escape('name: the document is named \"renamed\" but this scenario is \"ecommerce-small\"; a new name is a new scenario (POST /scenarios)')) 'renamed message'
}

Test-Case 'MV-6.8' 'Start a run and follow it to the end' {
    $script:run = Post-Json '/runs' @{ scenarioId = $small.id; version = 1; seed = 42 }
    Assert-That ($run.status -eq 'queued' -and $run.seed -eq '42' -and $run.engineVersion -eq '0.1.0') "accepted run: $($run.status) seed $($run.seed)"
    $script:run = Wait-Run $run.id
    Assert-That ($run.status -eq 'succeeded' -and $run.eventCount -eq 472 -and $null -eq $run.error) "run: $($run.status) $($run.eventCount) $($run.error)"
    Assert-That ([string]$run.requestedAt -le [string]$run.startedAt -and [string]$run.startedAt -le [string]$run.finishedAt) 'timestamps in order'
    Assert-That ($run.files.'events.jsonl'.sha256 -eq $small42['events.jsonl'].ToLowerInvariant() -and $run.files.'events.jsonl'.bytes -eq 146142) 'events.jsonl checksum'
    Assert-That ($run.summary.orders -eq 120 -and $run.summary.payments -eq 137 -and $run.summary.shipments -eq 98 -and $run.summary.revenueMinor -eq 2525664) 'summary'
    Assert-Match (Api-Log) "\[RunRunner\] .*Run $($run.id) succeeded: 472 events in \d+ ms" 'runner log'
}

Test-Case 'MV-6.9' 'Download a run: the same bytes as generate, and verify passes' {
    $dir = Join-Path $out 'api-small-42'
    Save-RunFiles $run.id $dir
    $cli = Join-Path $out 'cli-small-42'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios/ecommerce-small.json', '--seed', '42', '--out', $cli)) 0 'generate'
    foreach ($file in $runFiles) {
        $fromApi = Get-Sha256 (Join-Path $dir $file)
        Assert-That ($fromApi -eq (Get-Sha256 (Join-Path $cli $file))) "$file differs from generate"
        Assert-That ($fromApi -eq $small42[$file]) "$file hash $fromApi"
    }
    $verify = Invoke-DataForge @('verify', '--run', $dir)
    Assert-Exit $verify 0 'verify'
    Assert-Match $verify.Text 'Result: PASS' 'verify passes'
    Assert-That (([regex]::Matches($verify.Text, '\sOK')).Count -eq 7) 'seven OK lines'
}

Test-Case 'MV-6.10' "The specification's example size" {
    $script:std = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-standard.json
    $stdRun = Wait-Run (Post-Json '/runs' @{ scenarioId = $std.id; seed = 42 }).id 120
    Assert-That ($stdRun.status -eq 'succeeded' -and $stdRun.eventCount -eq 18479) "standard run: $($stdRun.status) $($stdRun.eventCount)"
    $dir = Join-Path $out 'api-std-42'
    Save-RunFiles $stdRun.id $dir
    foreach ($file in $runFiles) {
        $hash = Get-Sha256 (Join-Path $dir $file)
        Assert-That ($hash -eq $standard42[$file]) "$file hash $hash"
    }
    Assert-Match (Invoke-DataForge @('verify', '--run', $dir)).Text 'Result: PASS' 'verify passes'
    $logLine = [regex]::Match((Api-Log), "Run $($stdRun.id) succeeded: 18479 events in (\d+) ms")
    Assert-That $logLine.Success 'runner log line'
    if ($logLine.Success) { Write-Note "stored 18,479 events in $($logLine.Groups[1].Value) ms" }
}

Test-Case 'MV-6.11' 'Run history, the same inputs twice, and stored events' {
    foreach ($seed in 42, 7) {
        $r = Wait-Run (Post-Json '/runs' @{ scenarioId = $small.id; version = 1; seed = $seed }).id
        Assert-That ($r.status -eq 'succeeded') "seed $seed run $($r.status)"
    }
    $history = Get-Json "/runs?scenarioId=$($small.id)"
    Assert-That ($history.total -eq 3) "total $($history.total)"
    $runs = @($history.runs)
    Assert-That (($runs | ForEach-Object { $_.seed }) -join ',' -eq '7,42,42') "seeds newest first: $(($runs | ForEach-Object { $_.seed }) -join ',')"
    Assert-That ($runs[1].files.'events.jsonl'.sha256 -eq $runs[2].files.'events.jsonl'.sha256) 'the two seed-42 runs differ'
    Assert-That ($runs[0].files.'events.jsonl'.sha256 -ne $runs[1].files.'events.jsonl'.sha256) 'seed 7 equals seed 42'
    Write-Note "seed 7: $($runs[0].eventCount) events, events.jsonl $(Short $runs[0].files.'events.jsonl'.sha256)"
    Assert-That ($runs[0].eventCount -eq $seed7EventCount) "seed 7 event count $($runs[0].eventCount)"
    Assert-That ($runs[0].files.'events.jsonl'.sha256 -eq $seed7EventsSha) "seed 7 checksum $($runs[0].files.'events.jsonl'.sha256)"
    Assert-That (@((Get-Json '/runs?status=succeeded&limit=1').runs).Count -eq 1) 'limit=1'
    $timeline = @((Get-Json "/runs/$($run.id)/events?aggregateId=ord_000088").events)
    Assert-That (($timeline | ForEach-Object { $_.sequence }) -join ',' -eq '27,28,57,155') "timeline sequences $(($timeline | ForEach-Object { $_.sequence }) -join ',')"
    Assert-That (($timeline | ForEach-Object { $_.type }) -join ',' -eq 'OrderCreated,PaymentCompleted,ShipmentCreated,ShipmentDelivered') 'timeline types'
    $cliTimeline = Invoke-DataForge @('timeline', '--run', (Join-Path $out 'cli-small-42'), '--aggregate', 'ord_000088')
    Assert-Match $cliTimeline.Text 'Timeline of ord_000088: 4 event\(s\)' 'CLI timeline'
    $page = Get-Json "/runs/$($run.id)/events?type=PaymentFailed&limit=5"
    $sequences = @($page.events | ForEach-Object { $_.sequence })
    Assert-That ($sequences.Count -eq 5 -and @($page.events | Where-Object { $_.type -ne 'PaymentFailed' }).Count -eq 0) 'five PaymentFailed events'
    Assert-That (($sequences -join ',') -eq (($sequences | Sort-Object) -join ',')) 'in sequence order'
    Assert-That ($page.nextSequence -gt $sequences[4]) "nextSequence $($page.nextSequence)"
    Write-Note "PaymentFailed page: $($sequences -join ', '), next $($page.nextSequence)"
}

Test-Case 'MV-6.12' 'Invalid run requests' {
    $bad = Join-Path $out 'bad-run.json'
    Set-Content -Path $bad -Encoding Ascii -Value '{"scenarioId":"not-an-id","seed":"two words","speed":2}'
    $invalid = Invoke-Http -Method POST -Path '/runs' -BodyFile $bad
    Assert-That ($invalid.Status -eq 400) "invalid run HTTP $($invalid.Status)"
    Assert-That ($invalid.Body -eq '{"message":["scenarioId: must be a scenario id (a UUID)","seed: Invalid seed \"two words\": use 1-128 characters from A-Z, a-z, 0-9, \".\", \"_\", \":\" and \"-\"","Unrecognized key: \"speed\""],"error":"Bad Request","statusCode":400}') "invalid run body $($invalid.Body)"
    $noVersion = Join-Path $out 'no-version.json'
    Set-Content -Path $noVersion -Encoding Ascii -Value ('{"scenarioId":"' + $small.id + '","seed":1,"version":9}')
    $missing = Invoke-Http -Method POST -Path '/runs' -BodyFile $noVersion
    Assert-That ($missing.Status -eq 404) "missing version HTTP $($missing.Status)"
    Assert-Match $missing.Body ([regex]::Escape("Scenario $($small.id) has no version 9.")) 'missing version message'
    $unknown = Invoke-Http -Path '/runs/01a20000-0000-7000-8000-000000000000'
    Assert-That ($unknown.Status -eq 404) "unknown run HTTP $($unknown.Status)"
    Assert-Match $unknown.Body 'Run 01a20000-0000-7000-8000-000000000000 not found\.' 'unknown run message'
    $file = Invoke-Http -Path "/runs/$($run.id)/files/secrets.txt"
    Assert-That ($file.Status -eq 400) "bad file name HTTP $($file.Status)"
    Assert-Match $file.Body 'must be one of the run files: events\.jsonl, expected-state\.json, scenario\.resolved\.json, manifest\.json' 'bad file name message'
    $status = Invoke-Http -Path '/runs?status=done'
    Assert-That ($status.Status -eq 400) "bad status HTTP $($status.Status)"
    Assert-Match $status.Body ([regex]::Escape('status: Invalid option: expected one of \"queued\"|\"running\"|\"succeeded\"|\"failed\"')) 'bad status message'
    Assert-That ((Get-Json '/runs').total -eq 4) 'no run was created by an invalid request'
}

Test-Case 'MV-6.13' 'A tampered stored event is never served' {
    $victim = Wait-Run (Post-Json '/runs' @{ scenarioId = $small.id; version = 1; seed = 'tamper' }).id
    Assert-That ($victim.status -eq 'succeeded') "tamper run $($victim.status)"
    Assert-That ($victim.files.'events.jsonl'.sha256 -eq $tamperEventsSha) "tamper run checksum $($victim.files.'events.jsonl'.sha256)"
    $refused = Invoke-Sql "UPDATE canonical_event SET payload = jsonb_set(payload, '{amountMinor}', '1') WHERE run_id = '$($victim.id)' AND sequence = 1;"
    Assert-Match $refused.Text 'ERROR:  canonical_event rows are immutable' 'update refused by the trigger'
    $tamper = @"
BEGIN;
ALTER TABLE canonical_event DISABLE TRIGGER canonical_event_immutable;
UPDATE canonical_event SET payload = jsonb_set(payload, '{amountMinor}', '1')
  WHERE run_id = '$($victim.id)' AND sequence = (SELECT min(sequence) FROM canonical_event WHERE run_id = '$($victim.id)' AND type = 'PaymentCompleted');
ALTER TABLE canonical_event ENABLE TRIGGER canonical_event_immutable;
COMMIT;
"@
    $changed = Invoke-Sql $tamper
    Assert-Exit $changed 0 'tamper transaction'
    Assert-Match $changed.Text 'UPDATE 1' 'one row changed'
    $download = Invoke-Http -Path "/runs/$($victim.id)/files/events.jsonl"
    Assert-That ($download.Status -eq 500) "tampered download HTTP $($download.Status)"
    Assert-Match $download.Body ([regex]::Escape("{`"statusCode`":500,`"error`":`"Run Integrity Error`",`"message`":`"events.jsonl rebuilt from the database does not match the checksum recorded when run $($victim.id) was generated (recorded sha256 $tamperEventsSha, 142705 bytes; rebuilt sha256 ")) 'integrity error'
    Assert-Match $download.Body '142701 bytes\)\. The stored run was modified\."\}$' 'rebuilt size'
    Assert-That ((Invoke-Http -Path "/runs/$($victim.id)/files/expected-state.json").Status -eq 200) 'expected-state.json still served'
    Assert-That ((Invoke-Http -Path "/runs/$($run.id)/files/events.jsonl").Status -eq 200) 'other runs still served'
    Assert-Match (Api-Log) "ERROR \[Runs\] .*Integrity check failed for run $($victim.id)" 'integrity error logged'
}

Test-Case 'MV-6.14' "Restart: history survives, and a killed API's runs are completed" {
    $queued = foreach ($i in 1..5) { (Post-Json '/runs' @{ scenarioId = $std.id; seed = 42 }).id }
    Stop-Api
    $statuses = Invoke-Sql 'SELECT status, count(*) FROM simulation_run GROUP BY status ORDER BY status;'
    Write-Note (($statuses.Text -split "`n" | Where-Object { $_ -match '\|' -and $_ -notmatch 'status' } | ForEach-Object { ($_ -replace '\s+', ' ').Trim() }) -join '; ')
    Assert-Match $statuses.Text 'queued\s+\|' 'runs left queued by the killed API'
    $partial = Invoke-Sql "SELECT count(*) AS rows FROM canonical_event e JOIN simulation_run r ON r.id = e.run_id WHERE r.status <> 'succeeded';"
    Assert-Match $partial.Text '(?m)^\s+0$' 'unfinished runs have no stored events'
    Assert-That (Start-Api) 'the API did not restart'
    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Seconds 1
        $runs = @((Get-Json "/runs?scenarioId=$($std.id)").runs)
    } while (@($runs | Where-Object { $_.status -ne 'succeeded' }).Count -gt 0 -and (Get-Date) -lt $deadline)
    Assert-That ($runs.Count -eq 6) "$($runs.Count) standard runs"
    Assert-That (@($runs | Where-Object { $_.status -eq 'succeeded' -and $_.eventCount -eq 18479 -and $_.files.'events.jsonl'.sha256 -eq $standard42['events.jsonl'].ToLowerInvariant() }).Count -eq 6) 'all six succeeded with the same checksum'
    $resumed = [regex]::Match((Api-Log), 'Resuming (\d+) unfinished run\(s\)')
    Assert-That ($resumed.Success -and [int]$resumed.Groups[1].Value -ge 4) 'resuming line'
    if ($resumed.Success) { Write-Note "resumed $($resumed.Groups[1].Value) run(s)" }
    Assert-That ((Get-Json '/runs').total -eq 10) "total $((Get-Json '/runs').total)"
}

Test-Case 'MV-6.15' 'The API without PostgreSQL, or without migrations' {
    Assert-Exit (Invoke-Native 'docker' @('compose', 'stop', 'postgres')) 0 'stop postgres'
    $down = Invoke-Http -Path '/health'
    Assert-That ($down.Status -eq 503) "health HTTP $($down.Status) with the database stopped"
    Assert-Match $down.Body '^\{"status":"unavailable","database":"down","engineVersion":"0\.1\.0","detail":".+"\}$' 'health body while down'
    Assert-Exit (Invoke-Native 'docker' @('compose', 'up', '-d', '--wait', 'postgres')) 0 'start postgres'
    $up = Invoke-Http -Path '/health'
    Assert-That ($up.Status -eq 200 -and $up.Body -eq '{"status":"ok","database":"up","engineVersion":"0.1.0"}') "health after restart HTTP $($up.Status)"
    Stop-Api

    Assert-Exit (Invoke-Native 'docker' @('compose', 'stop', 'postgres')) 0 'stop postgres'
    Set-ApiEnvironment $selfCheckDb
    $unreachable = Invoke-Pnpm @('--silent', 'api')
    Assert-Exit $unreachable 3 'API with PostgreSQL stopped'
    Assert-Match $unreachable.Text ([regex]::Escape('PostgreSQL is unavailable at localhost:5433/dataforge_selfcheck: connection refused (ECONNREFUSED)')) 'unavailable message'
    Assert-Match $unreachable.Text ([regex]::Escape('Start it with "docker compose up -d --wait" (see compose.yaml), or point DATABASE_URL at a running PostgreSQL.')) 'start hint'
    Assert-Exit (Invoke-Native 'docker' @('compose', 'up', '-d', '--wait', 'postgres')) 0 'start postgres'
    Assert-Exit (Invoke-Native 'node' @('apps/api/scripts/recreate-database.js', $emptyDb, '--no-migrate')) 0 'create an empty database'
    Set-ApiEnvironment $emptyDb
    $unmigrated = Invoke-Pnpm @('--silent', 'api')
    Assert-Exit $unmigrated 3 'API on an empty database'
    Assert-Match $unmigrated.Text ([regex]::Escape('The database localhost:5433/dataforge_selfcheck_empty is not migrated (pending: 20261122232906_init).')) 'not migrated message'
    Assert-Match $unmigrated.Text ([regex]::Escape('Apply the migrations with "pnpm db:migrate".')) 'migrate hint'
    Invoke-Sql 'DROP DATABASE dataforge_selfcheck_empty;' 'postgres' | Out-Null
}

Test-Case 'MV-6.16' 'The engine stays free of NestJS and Prisma' {
    $probe = 'packages\core\src\run\guard-probe.ts'
    Set-Content $probe "import { Injectable } from '@nestjs/common';`nimport { PrismaClient } from '@prisma/client';`nexport const probe = [Injectable, PrismaClient];"
    try {
        $lint = Invoke-Pnpm @('lint')
        Assert-Exit $lint 1 'lint with the probe'
        Assert-Match $lint.Text "'@nestjs/common' import is restricted from being used by a pattern\. The simulation core must stay framework- and infrastructure-independent" 'Nest import refused'
        Assert-Match $lint.Text "'@prisma/client' import is restricted from being used by a pattern" 'Prisma import refused'
    } finally {
        Remove-Item $probe -ErrorAction SilentlyContinue
    }
    Assert-That (-not (Test-Path $probe)) 'probe left behind'
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint without the probe'
}

} finally {
    Stop-Api
    foreach ($name in $savedEnv.Keys) {
        if ($null -eq $savedEnv[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $savedEnv[$name] }
    }
}

Complete-Verification 'Milestone 6'

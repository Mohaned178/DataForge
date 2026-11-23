<#
.SYNOPSIS
    Runs every Milestone 9 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-9.md case by case (same IDs, same data, same expected
    values). It never touches the data of the hand-run steps: it recreates its own database
    (dataforge_selfcheck), starts its own API on port 3109 and its own web server on port 5209, uses its
    own work directory and Kafka topics, and writes only to out\self-check. Needs Docker Desktop (Kafka and
    PostgreSQL).

    A script cannot click, so the clicking is done by the Playwright suite (MV-9.3: a real browser drives the
    editors, the launch forms and the live pages against the real API, PostgreSQL and Kafka, in its own
    database and on its own ports). Everything else is checked from the outside: the API calls the browser
    makes are made here directly (the same bodies), and each page is opened in a real browser engine
    (headless Microsoft Edge or Google Chrome, found in their usual folders), given time to load its data, and
    the text it rendered is checked. What stays for your eyes: layout, colours and the diagram.

    Works in Windows PowerShell 5.1 and PowerShell 7. Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-9.1 (pnpm install, check, build) when the workspace is already installed and built.

.PARAMETER SkipEndToEnd
    Skip MV-9.3 (the Playwright suite, which downloads a browser the first time and takes about a minute).

.PARAMETER NoBrowser
    Skip the checks that read rendered pages (no Edge or Chrome available).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-9.ps1
#>
param([switch]$SkipInstall, [switch]$SkipEndToEnd, [switch]$NoBrowser)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
$ProgressPreference = 'SilentlyContinue'

$apiPort = 3109
$webPort = 5209
$api = "http://127.0.0.1:$apiPort"
$web = "http://127.0.0.1:$webPort"
$selfCheckDb = 'postgresql://dataforge:dataforge@localhost:5433/dataforge_selfcheck'
$workDir = Join-Path $out 'executions'
$missingId = '01a2059d-1421-7651-8848-976194c3e863'
# Unique per run: Kafka keeps its topics until the broker is recreated, and a second run must not meet the first one's.
$runSuffix = (Get-Date).ToString('HHmmss')
$topic = "selfcheck-m9-orders-$runSuffix"
$group = "selfcheck-m9-pipeline-$runSuffix"

$savedEnv = @{ DATABASE_URL = $env:DATABASE_URL; API_PORT = $env:API_PORT; API_HOST = $env:API_HOST; EXECUTION_WORK_DIR = $env:EXECUTION_WORK_DIR; KAFKA_BROKERS = $env:KAFKA_BROKERS; WEB_PORT = $env:WEB_PORT; WEB_HOST = $env:WEB_HOST; WEB_API_URL = $env:WEB_API_URL }
$script:ApiProcess = $null
$script:ApiStarts = 0
$script:WebProcess = $null
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

function Invoke-KafkaTopics {
    param([string[]]$Arguments)
    Invoke-Native 'docker' (@('compose', 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'localhost:19092') + $Arguments)
}

# One HTTP request through curl.exe: the status code, the content type and the body, whatever the status.
function Invoke-HttpAt {
    param([string]$Base, [string]$Path, [string]$Method = 'GET', [string]$BodyFile)
    $arguments = @('-s', '-X', $Method, '-w', "`n%{http_code}`n%{content_type}")
    if ($BodyFile) { $arguments += @('-H', 'Content-Type: application/json', '--data-binary', "@$BodyFile") }
    $lines = @(& curl.exe @arguments "$Base$Path" 2>&1 | ForEach-Object { "$_" })
    $count = $lines.Count
    $type = if ($count -ge 1) { $lines[$count - 1] } else { '' }
    $status = if ($count -ge 2) { [int]$lines[$count - 2] } else { 0 }
    $body = if ($count -ge 3) { ($lines[0..($count - 3)] -join "`n") } else { '' }
    [pscustomobject]@{ Status = $status; Type = $type; Body = $body }
}

function Invoke-Http {
    param([string]$Path, [string]$Method = 'GET', [string]$BodyFile)
    Invoke-HttpAt $api $Path $Method $BodyFile
}

function Get-Json([string]$Path) { Invoke-RestMethod -Uri "$api$Path" }

function Post-Json {
    param([string]$Path, [hashtable]$Body)
    Invoke-RestMethod -Method Post -Uri "$api$Path" -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 5)
}

# A JSON body written to a file (ASCII), as the browser would send it.
function Save-Body([string]$Name, [string]$Json) {
    $path = Join-Path $out $Name
    Set-Content -Path $path -Encoding Ascii -NoNewline -Value $Json
    $path
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

# The request the execution form sends: a seed typed as text, the target as the form builds it.
function Start-Execution {
    param([string]$Profile, [hashtable]$Target, [string]$ChaosSeed = '7')
    $execution = Post-Json '/executions' @{ runId = $script:run.id; chaosProfileId = $script:profiles[$Profile]; chaosSeed = $ChaosSeed; target = $Target }
    Wait-Execution $execution.id
}

function Start-Api {
    $env:DATABASE_URL = $selfCheckDb
    $env:API_PORT = "$apiPort"
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
        if ((Invoke-Http '/health').Status -eq 200) { return $true }
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

# The built web UI (vite preview) on its own port, forwarding /api to the self-check API.
function Start-Web {
    $env:WEB_PORT = "$webPort"
    $env:WEB_HOST = '127.0.0.1'
    $env:WEB_API_URL = $api
    $log = Join-Path $out 'web.log'
    $node = (Get-Command node).Source
    $vite = Join-Path $root 'apps\web\node_modules\vite\bin\vite.js'
    $script:WebProcess = Start-Process -FilePath $node -ArgumentList @($vite, 'preview') -WorkingDirectory (Join-Path $root 'apps\web') -PassThru -NoNewWindow `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        if ($script:WebProcess.HasExited) { return $false }
        if ((Invoke-HttpAt $web '/').Status -eq 200) { return $true }
    }
    $false
}

function Stop-Web {
    if ($null -ne $script:WebProcess -and -not $script:WebProcess.HasExited) {
        Stop-Process -Id $script:WebProcess.Id -Force
        $script:WebProcess.WaitForExit(10000) | Out-Null
    }
    $script:WebProcess = $null
}

# ---- rendered pages -------------------------------------------------------------------------------

function Find-Browser {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($candidate in $candidates) { if ($candidate -and (Test-Path $candidate)) { return $candidate } }
    $null
}

$browser = if ($NoBrowser) { $null } else { Find-Browser }
$profileDir = Join-Path $out 'browser-profile'

# The text a page shows once it has loaded its data: the DOM after the page's scripts ran, without markup.
function Get-Rendered([string]$Path) {
    $previous = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    try {
        # Piped to Out-String on purpose: msedge.exe and chrome.exe are GUI programs, and PowerShell neither waits for
        # them nor captures their output unless the call is piped.
        $dom = & $browser --headless=new --disable-gpu "--user-data-dir=$profileDir" --virtual-time-budget=12000 --dump-dom "$web$Path" 2>$null | Out-String
    } finally {
        [Console]::OutputEncoding = $previous
    }
    $text = [regex]::Replace($dom, '(?s)<(script|style|title)[^>]*>.*?</\1>', ' ')
    # Inline tags vanish (so "<span>OrderCreated</span>: reorder" reads as one phrase), every other tag is a break.
    $text = [regex]::Replace($text, '</?(span|code|a|strong|em|b|small|output)(\s[^>]*)?>', '')
    $text = [regex]::Replace($text, '<[^>]+>', ' ')
    $text = $text.Replace('&amp;', '&').Replace('&lt;', '<').Replace('&gt;', '>').Replace('&quot;', '"').Replace('&#39;', "'")
    [regex]::Replace($text, '\s+', ' ')
}

# Asserts that the page at $Path shows every pattern of $Show and none of $Hide (regular expressions).
function Assert-Page {
    param([string]$Path, [string[]]$Show, [string[]]$Hide = @())
    if ($NoBrowser) { Write-Note "not checked (-NoBrowser): $Path"; return }
    if ($null -eq $browser) { $script:CaseFailures.Add("$Path - no Microsoft Edge or Google Chrome found to render it (install one, or pass -NoBrowser)"); return }
    $text = Get-Rendered $Path
    if ($text.Length -lt 40) { $script:CaseFailures.Add("$Path - the page rendered nothing: $text"); return }
    foreach ($pattern in $Show) { Assert-That ($text -match $pattern) "$Path - the page does not show /$pattern/" }
    foreach ($pattern in $Hide) { Assert-That ($text -notmatch $pattern) "$Path - the page shows /$pattern/" }
}

Write-Host "DataForge Milestone 9 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
if ($NoBrowser) { Write-Host 'Rendered-page checks are skipped (-NoBrowser).' }
elseif ($null -eq $browser) { Write-Host 'No Microsoft Edge or Google Chrome found: the rendered-page checks will fail. Install one, or pass -NoBrowser.' }
else { Write-Host "Rendering pages with $browser" }
Write-Host ''

try {

Test-Case 'MV-9.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    foreach ($project in 'packages/core', 'packages/chaos', 'packages/targets', 'packages/validation', 'packages/kafka', 'packages/execution', 'apps/api', 'apps/consumer', 'apps/cli', 'apps/web', 'apps/e2e') {
        Assert-Match $check.Text "$project typecheck: Done" "$project type-checked"
    }
    Assert-Match $check.Text 'Test Suites:\s+40 passed, 40 total' 'pnpm check Jest suites'
    Assert-Match $check.Text 'Tests:\s+451 passed, 451 total' 'pnpm check Jest tests'
    Assert-Match $check.Text 'Test Files\s+12 passed \(12\)' 'pnpm check Vitest files'
    Assert-Match $check.Text 'Tests\s+181 passed \(181\)' 'pnpm check Vitest tests'
    $build = Invoke-Pnpm @('build')
    Assert-Exit $build 0 'pnpm build'
    Assert-Match $build.Text 'apps/web build: .*built in' 'web built'
    Assert-That (Test-Path (Join-Path $root 'apps\web\dist\index.html')) 'apps\web\dist\index.html exists'
}

Test-Case 'MV-9.2' 'Services, the migration and the integration suite' {
    Assert-Exit (Invoke-Native 'docker' @('compose', 'up', '-d', '--wait')) 0 'docker compose up -d --wait'
    Assert-Exit (Invoke-Native 'node' @('apps/api/scripts/recreate-database.js', $selfCheckDb, '--no-migrate')) 0 'recreate dataforge_selfcheck'
    $env:DATABASE_URL = $selfCheckDb
    $migrate = Invoke-Pnpm @('db:migrate')
    Assert-Exit $migrate 0 'pnpm db:migrate'
    Remove-Item Env:DATABASE_URL
    $integration = Invoke-Pnpm @('test:integration')
    Assert-Exit $integration 0 'pnpm test:integration'
    Assert-Match $integration.Text 'Test Suites:\s+11 passed, 11 total' 'integration suites'
    Assert-Match $integration.Text 'Tests:\s+132 passed, 132 total' 'integration tests'
}

Test-Case 'MV-9.3' 'The end-to-end suite: a real browser, the full flow' -Skip:$SkipEndToEnd {
    $browserInstall = Invoke-Pnpm @('--filter', '@dataforge/e2e', 'install-browser')
    Assert-Exit $browserInstall 0 'playwright install chromium-headless-shell'
    $e2e = Invoke-Pnpm @('test:e2e')
    Assert-Exit $e2e 0 'pnpm test:e2e'
    Assert-Match $e2e.Text '11 passed' 'eleven end-to-end tests passed'
    Assert-That ($e2e.Text -notmatch '\d+ failed') 'no end-to-end test failed'
    foreach ($title in 'an invalid scenario shows every problem', 'launches a run from the form and follows it to success', 'the naive target under spec-example fails', 'a live page keeps its data while the API cannot be reached', 'a double click on Start run starts one run') {
        Assert-Match $e2e.Text ([regex]::Escape($title)) "test '$title' ran"
    }
    $ports = @(Get-NetTCPConnection -LocalPort 3209, 5309 -State Listen -ErrorAction SilentlyContinue)
    Assert-That ($ports.Count -eq 0) 'the suite left no server on its ports 3209 and 5309'
    Write-Note (($e2e.Text -split "`n" | Where-Object { $_ -match '\d+ passed \(' }) -join ' ').Trim()
}

Test-Case 'MV-9.4' 'Start the API and the UI; the new pages, empty and linked' {
    Assert-That (Start-Api) 'the API did not answer /health within 30 s'
    Assert-That (Start-Web) 'the web server did not answer within 30 s'
    foreach ($path in '/scenarios', '/scenarios/new', "/scenarios/$missingId", "/scenarios/$missingId/versions/new", '/chaos-profiles', '/chaos-profiles/new', '/runs/new', '/executions/new') {
        $page = Invoke-HttpAt $web $path
        Assert-That ($page.Status -eq 200 -and $page.Type -match 'text/html' -and $page.Body -match '<div id="root">') "deep link $path HTTP $($page.Status) $($page.Type)"
    }
    Assert-Page '/executions' @('ExecutionsRunsScenariosChaos profiles', 'New execution', 'No executions yet', 'POST /executions', 'start one here')
    Assert-Page '/runs' @('New run', 'No runs yet', 'POST /runs', 'start one here')
    Assert-Page '/scenarios' @('Scenarios', 'New scenario', 'No scenarios yet', 'Create the first one')
    Assert-Page '/chaos-profiles' @('Chaos profiles', 'New chaos profile', 'No chaos profiles yet', 'Create the first one')
    Assert-Page '/runs/new' @('New run', 'A run needs a scenario', 'Create one first')
    Assert-Page '/executions/new' @('New execution', 'needs a run that has succeeded and a chaos profile', 'Start a run', 'create a chaos profile')
}

Test-Case 'MV-9.5' 'The dry-run endpoints: valid, invalid, and nothing stored' {
    $smallFile = Join-Path $root 'scenarios\ecommerce-small.json'
    $valid = Invoke-Http -Path '/scenarios/validate' -Method POST -BodyFile $smallFile
    Assert-That ($valid.Status -eq 200 -and $valid.Type -match 'json') "scenario dry run HTTP $($valid.Status) $($valid.Type)"
    $answer = $valid.Body | ConvertFrom-Json
    Assert-That ($answer.valid -eq $true -and $answer.name -eq 'ecommerce-small' -and $answer.scenarioHash -match '^sha256:[0-9a-f]{64}$') "scenario dry run $($valid.Body.Substring(0, [Math]::Min(120, $valid.Body.Length)))"
    Assert-That ($answer.definition.orders.count -eq 120 -and $answer.definition.simulation.durationMs -eq 172800000) 'the resolved definition'
    $script:smallHash = $answer.scenarioHash
    Assert-That ((Invoke-Http -Path '/scenarios').Body -eq '{"scenarios":[]}') 'the dry run stored nothing'

    $bad = Save-Body 'bad-scenario.json' '{"formatVersion":1,"name":"bad","customers":{"count":"many"},"colour":"blue"}'
    $dry = Invoke-Http -Path '/scenarios/validate' -Method POST -BodyFile $bad
    $create = Invoke-Http -Path '/scenarios' -Method POST -BodyFile $bad
    Assert-That ($dry.Status -eq 400 -and $create.Status -eq 400) "invalid HTTP $($dry.Status) and $($create.Status)"
    Assert-That ($dry.Body -eq $create.Body) 'the dry run and the create endpoint answer identically'
    Assert-That ($dry.Body -eq '{"message":["customers.count: Invalid input: expected number, received string","Unrecognized key: \"colour\""],"error":"Bad Request","statusCode":400}') "the problems: $($dry.Body)"
    Assert-That ((Invoke-Http -Path '/scenarios').Body -eq '{"scenarios":[]}') 'an invalid create stored nothing'

    $profileFile = Join-Path $root 'chaos-profiles\spec-example.json'
    $profile = Invoke-Http -Path '/chaos-profiles/validate' -Method POST -BodyFile $profileFile
    $profileAnswer = $profile.Body | ConvertFrom-Json
    Assert-That ($profile.Status -eq 200 -and $profileAnswer.valid -eq $true -and $profileAnswer.name -eq 'spec-example' -and $profileAnswer.profileHash -match '^sha256:[0-9a-f]{64}$') "profile dry run HTTP $($profile.Status)"
    Assert-That ((Invoke-Http -Path '/chaos-profiles').Body -eq '{"chaosProfiles":[]}') 'the profile dry run stored nothing'
    $loses = Save-Body 'loses.json' '{"formatVersion":1,"name":"loses","faults":{"transientFailure":{"rate":0.1,"failures":{"min":1,"max":5},"maxRetries":2}}}'
    $refusedDry = Invoke-Http -Path '/chaos-profiles/validate' -Method POST -BodyFile $loses
    $refusedCreate = Invoke-Http -Path '/chaos-profiles' -Method POST -BodyFile $loses
    Assert-That ($refusedDry.Status -eq 400 -and $refusedDry.Body -eq $refusedCreate.Body) 'the loss rule: the dry run and the create endpoint answer identically'
    Assert-Match $refusedDry.Body 'faults\.transientFailure\.failures\.max: cannot exceed maxRetries \(2\) unless allowLoss is true' 'the loss rule is named with its path'

    $broken = Save-Body 'broken.json' '{"formatVersion":'
    $syntax = Invoke-Http -Path '/scenarios/validate' -Method POST -BodyFile $broken
    Assert-That ($syntax.Status -eq 400) "a body that is not JSON: HTTP $($syntax.Status)"
}

Test-Case 'MV-9.6' 'The scenario editor: what it sends, and what it shows' {
    $created = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
    $script:scenario = $created
    Assert-That ($created.name -eq 'ecommerce-small' -and $created.latestVersion -eq 1 -and $created.versions[0].scenarioHash -eq $script:smallHash) "created $($created.latestVersion) $($created.versions[0].scenarioHash)"
    $again = Invoke-Http -Path '/scenarios' -Method POST -BodyFile (Join-Path $root 'scenarios\ecommerce-small.json')
    Assert-That ($again.Status -eq 409) "the same name again: HTTP $($again.Status)"
    Assert-Match $again.Body "A scenario named \\`"ecommerce-small\\`" already exists \(id $($created.id)\)" 'the name-taken message'
    Assert-Page '/scenarios' @('ecommerce-small', 'v1', 'Latest version')
    Assert-Page '/scenarios/new' @('New scenario', 'Start from', 'ecommerce-small', 'ecommerce-standard', 'A blank document', 'Document \(JSON\)', 'Format', 'Save as a new scenario')
    Assert-Page "/scenarios/$($created.id)" @('ecommerce-small', 'Summary', 'Versions', 'v1', 'New version', 'New run', 'Version 1', 'The resolved definition of version 1', '"durationMs": 172800000')
    Assert-Page "/scenarios/$($created.id)?saved=1" @('Saved as version 1\.')
    Assert-Page "/scenarios/$missingId" @('Not found')
}

Test-Case 'MV-9.7' 'The chaos profile editor: four profiles from the examples, the loss rule refused' {
    $script:profiles = @{}
    foreach ($name in 'none', 'spec-example', 'late-data', 'lossy') {
        $created = Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile "chaos-profiles\$name.json"
        Assert-That ($created.name -eq $name -and $created.latestVersion -eq 1) "profile $name created"
        $script:profiles[$name] = $created.id
    }
    Assert-Page '/chaos-profiles' @('none', 'spec-example', 'late-data', 'lossy', 'v1')
    Assert-Page '/chaos-profiles/new' @('New chaos profile', 'Start from', 'windowed-delays', 'late-data', 'A blank document', 'Save as a new chaos profile')
    Assert-Page "/chaos-profiles/$($script:profiles['spec-example'])" @('spec-example', 'Versions', 'v1', 'New version', 'New execution', '"formatVersion": 1')
}

Test-Case 'MV-9.8' 'Launch a run: the same bytes as the command line' {
    $queued = Post-Json '/runs' @{ scenarioId = $scenario.id; seed = '42' }
    Assert-That ($queued.status -eq 'queued' -and $queued.seed -eq '42') "accepted $($queued.status) $($queued.seed)"
    $script:run = Wait-Run $queued.id
    Assert-That ($run.status -eq 'succeeded' -and $run.eventCount -eq 472) "run $($run.status) $($run.eventCount)"
    $cli = Join-Path $out 'cli-run'
    Assert-Exit (Invoke-DataForge @('generate', '--scenario', 'scenarios\ecommerce-small.json', '--seed', '42', '--out', $cli)) 0 'dataforge generate'
    foreach ($name in 'events.jsonl', 'expected-state.json', 'scenario.resolved.json') {
        $cliHash = (Get-Sha256 (Join-Path $cli $name)).ToLowerInvariant()
        Assert-That ($run.files.$name.sha256 -eq $cliHash) "$name differs from the command line: API $($run.files.$name.sha256), CLI $cliHash"
    }
    Write-Note "events.jsonl $($run.files.'events.jsonl'.sha256)"
    $big = Wait-Run (Post-Json '/runs' @{ scenarioId = $scenario.id; seed = '9007199254740993' }).id
    Assert-That ($big.status -eq 'succeeded' -and $big.seed -eq '9007199254740993') "a seed typed as text keeps every digit: $($big.seed)"
    Assert-Page "/runs/$($run.id)" @('What was generated', 'ecommerce-small v1', 'Expected final state', '25,256\.64 USD', '01b57d640ab12e33', '3546842d89241f81', 'f642fb41261117d6', 'New execution', 'Stored canonical events')
    Assert-Page "/runs/new?scenarioId=$($scenario.id)" @('New run', 'Scenario', 'ecommerce-small', 'Latest \(v1\)', 'Seed', 'Any text or whole number', 'Start run')
}

Test-Case 'MV-9.9' 'Launch executions: a failing test is found, a correct one passes' {
    $naive = Start-Execution 'spec-example' @{ type = 'reference'; name = 'naive'; transport = 'memory' }
    $script:naive = $naive
    Assert-That ($naive.verdict -eq 'FAIL' -and $naive.attemptCount -eq 486 -and $naive.findingCount -eq 48) "naive: $($naive.verdict) $($naive.attemptCount) $($naive.findingCount)"
    $script:pass = Start-Execution 'none' @{ type = 'reference'; name = 'correct'; transport = 'memory' }
    Assert-That ($pass.verdict -eq 'PASS' -and $pass.attemptCount -eq 472 -and $pass.findingCount -eq 0) "pass: $($pass.verdict) $($pass.attemptCount) $($pass.findingCount)"
    $kafka = Start-Execution 'spec-example' @{ type = 'reference'; name = 'naive'; transport = 'kafka'; partitions = 1; speed = 'max'; timeoutSeconds = 120 }
    Assert-That ($kafka.status -eq 'completed' -and $kafka.verdict -eq 'FAIL' -and $kafka.findingCount -eq 48 -and $kafka.kafka.sent -eq 486) "kafka: $($kafka.status) $($kafka.findingCount) $($kafka.kafka.sent)"
    $script:kafka = $kafka
    Assert-That ($kafka.files.'actual-state.json'.sha256 -eq $naive.files.'actual-state.json'.sha256) 'through Kafka, the same state as in memory'
    Assert-Page "/executions/$($naive.id)" @('Verdict FAIL', '48 findings: 48 explained by a delivery fault, 0 not explained by delivery\.', 'Delivery attempts 486', 'Root causes', 'evt_ord_000045_1 OrderCreated: reorder; overtaken by evt_ord_000045_2')
    Assert-Page "/executions/$($pass.id)" @('Verdict PASS', 'No findings: the target ended in the expected state\.', 'Delivery attempts 472')
    Assert-Page "/executions/$($naive.id)/aggregates/ord_000045?finding=18" @('Order ord_000045', 'Canonical timeline', 'Delivery timeline', 'out of order', 'overtaken by evt_ord_000045_2')
    Assert-Page "/executions/$($kafka.id)/aggregates/ord_000088" @('Kafka', 'partition 0, offset 27', 'partition 0, offset 159')
    Assert-Page "/executions/new?runId=$($run.id)&chaosProfileId=$($profiles['spec-example'])" @('New execution', 'ecommerce-small v1 . seed 42', 'spec-example', 'Latest \(v1\)', 'Reference target: correct', 'Reference target: naive', 'Your own pipeline', 'Transport', 'Start execution')
}

Test-Case 'MV-9.10' 'Versions: an identical document is the existing version, a changed one is the next' {
    $file = Join-Path $root 'scenarios\ecommerce-small.json'
    $same = Invoke-Http -Path "/scenarios/$($scenario.id)/versions" -Method POST -BodyFile $file
    $sameVersion = $same.Body | ConvertFrom-Json
    Assert-That ($same.Status -eq 200 -and $sameVersion.version -eq 1 -and $sameVersion.scenarioHash -eq $script:smallHash) "identical: HTTP $($same.Status) version $($sameVersion.version)"
    $document = Get-Content $file -Raw | ConvertFrom-Json
    $document.description = 'A small store, tested from the browser.'
    $changedFile = Save-Body 'small-v2.json' ($document | ConvertTo-Json -Depth 10)
    $dry = (Invoke-Http -Path '/scenarios/validate' -Method POST -BodyFile $changedFile).Body | ConvertFrom-Json
    $changed = Invoke-Http -Path "/scenarios/$($scenario.id)/versions" -Method POST -BodyFile $changedFile
    $changedVersion = $changed.Body | ConvertFrom-Json
    Assert-That ($changed.Status -eq 201 -and $changedVersion.version -eq 2) "changed: HTTP $($changed.Status) version $($changedVersion.version)"
    Assert-That ($changedVersion.scenarioHash -eq $dry.scenarioHash -and $changedVersion.scenarioHash -ne $script:smallHash) 'the dry run hashed it as the stored version'
    $detail = Get-Json "/scenarios/$($scenario.id)"
    Assert-That ($detail.latestVersion -eq 2 -and @($detail.versions).Count -eq 2) 'the scenario has two versions'
    $otherName = Save-Body 'other-name.json' '{"formatVersion":1,"name":"another-name"}'
    $mismatch = Invoke-Http -Path "/scenarios/$($scenario.id)/versions" -Method POST -BodyFile $otherName
    Assert-That ($mismatch.Status -eq 400 -and $mismatch.Body -match 'name: the document is named \\"another-name\\" but this scenario is \\"ecommerce-small\\"') "a new name is a new scenario: HTTP $($mismatch.Status)"
    Assert-Page "/scenarios/$($scenario.id)?saved=2" @('Saved as version 2\.', 'v2', 'v1', 'Version 2', 'A small store, tested from the browser\.')
    Assert-Page "/scenarios/$($scenario.id)/versions/new" @('New version of ecommerce-small', 'Save as a new version', 'Format')
    Assert-Page "/runs/new?scenarioId=$($scenario.id)" @('Latest \(v2\)', 'v1', 'v2')
}

Test-Case 'MV-9.11' 'Refusals: what the API says to a launch it cannot accept' {
    $badSeed = Save-Body 'bad-seed.json' ('{"scenarioId":"' + $scenario.id + '","seed":"two words"}')
    $refused = Invoke-Http -Path '/runs' -Method POST -BodyFile $badSeed
    Assert-That ($refused.Status -eq 400) "run with an invalid seed: HTTP $($refused.Status)"
    Assert-Match $refused.Body '^\{"message":\["seed: Invalid seed \\"two words\\"' 'the seed problem is named by path'
    $memory = Save-Body 'memory-partitions.json' ('{"runId":"' + $run.id + '","chaosProfileId":"' + $profiles['none'] + '","chaosSeed":"7","target":{"type":"reference","name":"correct","transport":"memory","partitions":2}}')
    $partitions = Invoke-Http -Path '/executions' -Method POST -BodyFile $memory
    Assert-That ($partitions.Status -eq 400 -and $partitions.Body -eq '{"message":["target.partitions: applies only to \"transport\": \"kafka\""],"error":"Bad Request","statusCode":400}') "partitions on the memory transport: $($partitions.Body)"
    $std = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-standard.json
    $pending = Post-Json '/runs' @{ scenarioId = $std.id; seed = '42' }
    $early = Save-Body 'early.json' ('{"runId":"' + $pending.id + '","chaosProfileId":"' + $profiles['none'] + '","chaosSeed":"7","target":{"type":"reference","name":"correct"}}')
    $conflict = Invoke-Http -Path '/executions' -Method POST -BodyFile $early
    Assert-That ($conflict.Status -eq 409) "an execution on a run that is not ready: HTTP $($conflict.Status)"
    Assert-Match $conflict.Body "Run $($pending.id) is (queued|running); start an execution once it has succeeded\." 'the not-ready message'
    Assert-That ((Wait-Run $pending.id 120).status -eq 'succeeded') 'the standard run finished'
    Write-Note 'The double click (one request, not two) and the form-level checks are covered by the component tests and the end-to-end suite; the guide has you try the double click.'
}

Test-Case 'MV-9.12' 'Live monitoring: a paced execution moves by itself' {
    $slow = Post-Json '/executions' @{ runId = $run.id; chaosProfileId = $profiles['none']; chaosSeed = '7'; target = @{ type = 'reference'; name = 'correct'; transport = 'kafka'; speed = 5000 } }
    $deadline = (Get-Date).AddSeconds(30)
    do { Start-Sleep -Milliseconds 500 } until ((Get-Json "/executions/$($slow.id)").status -eq 'running' -or (Get-Date) -gt $deadline)
    Assert-That ((Get-Json "/executions/$($slow.id)").status -eq 'running') 'the paced execution is running'
    Assert-Page "/executions/$($slow.id)" @('This execution is running', 'waiting for', 'this page updates by itself until it ends') @('Reload', 'Validation report')
    Assert-Page "/executions/$($slow.id)/aggregates/ord_000088" @('Not available yet')
    $done = Wait-Execution $slow.id 120
    Assert-That ($done.status -eq 'completed' -and $done.verdict -eq 'PASS' -and $done.kafka.durationMs -ge 30000) "paced execution: $($done.status) $($done.verdict) $($done.kafka.durationMs) ms"
    Write-Note "paced delivery $($done.kafka.durationMs) ms"
    Assert-Page "/executions/$($slow.id)" @('Verdict PASS', 'Validation report') @('This execution is running')
}

Test-Case 'MV-9.13' 'An external pipeline through the UI: awaiting, submit, validate' {
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
    Assert-That ($external.kafka.topic -eq $topic -and $external.kafka.sent -eq 486) 'delivered to the topic'
    Assert-Page "/executions/$($external.id)" @("Waiting for the pipeline's final state", $topic, $group, 'actual-state\.json', 'actual-windows\.json', 'only for a windowed profile', 'Submit and validate') @('Validation report')
    Set-Content (Join-Path $pipelineOut 'finish') 'x'
    Assert-That ($script:Pipeline.WaitForExit(30000) -and $script:Pipeline.ExitCode -eq 0) 'the pipeline finished'
    $state = Join-Path $pipelineOut 'actual-state.json'
    Assert-That (Test-Path $state) 'the pipeline wrote actual-state.json'
    # The body the browser sends when you choose that file: { "actualState": <the file> }.
    $bad = Save-Body 'bad-submission.json' '{"actualState":{"format":"dataforge.actual-state"}}'
    $refused = Invoke-Http -Path "/executions/$($external.id)/actual-state" -Method POST -BodyFile $bad
    Assert-That ($refused.Status -eq 400) "an invalid state: HTTP $($refused.Status)"
    Assert-Match $refused.Body '^\{"message":\["actualState\.formatVersion: ' 'the problems carry the actualState path'
    $submission = Save-Body 'submission.json' ('{"actualState":' + (Get-Content $state -Raw) + '}')
    $done = Invoke-Http -Path "/executions/$($external.id)/actual-state" -Method POST -BodyFile $submission
    $completed = $done.Body | ConvertFrom-Json
    Assert-That ($done.Status -eq 200 -and $completed.status -eq 'completed' -and $completed.verdict -eq 'FAIL' -and $completed.findingCount -eq 48) "submission HTTP $($done.Status) $($completed.status) $($completed.findingCount)"
    Assert-That ((Get-Sha256 $state).ToLowerInvariant() -eq $naive.files.'actual-state.json'.sha256) 'the pipeline state equals the naive target in memory'
    Assert-Page "/executions/$($external.id)" @('Verdict FAIL', '48 findings: 48 explained by a delivery fault') @("Waiting for the pipeline's final state")
}

Test-Case 'MV-9.14' 'An external pipeline that is not there: the reason is shown' {
    $missing = Start-Execution 'none' @{ type = 'external'; topic = 'no-such-topic'; groupId = $group }
    Assert-That ($missing.status -eq 'failed') "missing topic $($missing.status)"
    Assert-That ($missing.error -eq 'Topic "no-such-topic" does not exist. An external execution produces to your pipeline''s topic: create it, and start your pipeline on it, before the execution.') "error $($missing.error)"
    Assert-Page "/executions/$($missing.id)" @('This execution could not complete', 'Topic "no-such-topic" does not exist', 'has no verdict') @('Validation report')
}

Test-Case 'MV-9.15' 'The web app stays in the browser' {
    $probe = 'apps\web\src\guard-probe.ts'
    Set-Content $probe "import { sha256Hex } from '@dataforge/core';`nimport { readFileSync } from 'node:fs';`nimport { Kafka } from 'kafkajs';`nexport const probe = [sha256Hex, readFileSync, Kafka];"
    try {
        $lint = Invoke-Pnpm @('lint')
        Assert-Exit $lint 1 'lint with the probe'
        Assert-Match $lint.Text "'@dataforge/core' import is restricted from being used by a pattern\. The web UI reads the HTTP API only" 'engine refused'
        Assert-Match $lint.Text "'node:fs' import is restricted from being used by a pattern" 'file system refused'
        Assert-Match $lint.Text "'kafkajs' import is restricted from being used by a pattern" 'Kafka client refused'
    } finally {
        Remove-Item $probe -ErrorAction SilentlyContinue
    }
    Assert-Exit (Invoke-Pnpm @('lint')) 0 'lint without the probe'
}

} finally {
    Stop-Api
    Stop-Web
    if ($null -ne $script:Pipeline -and -not $script:Pipeline.HasExited) { Stop-Process -Id $script:Pipeline.Id -Force }
    foreach ($name in $savedEnv.Keys) {
        if ($null -eq $savedEnv[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $savedEnv[$name] }
    }
}

Complete-Verification 'Milestone 9'

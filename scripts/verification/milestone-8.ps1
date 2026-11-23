<#
.SYNOPSIS
    Runs every Milestone 8 manual verification case and checks its expected result.

.DESCRIPTION
    Mirrors docs/manual-verification/milestone-8.md case by case (same IDs, same data, same expected
    values). It never touches the data of the hand-run steps: it recreates its own database
    (dataforge_selfcheck), starts its own API on port 3108 and its own web server on port 5208, uses its own
    work directory and Kafka topics, and writes only to out\self-check. Needs Docker Desktop (Kafka and
    PostgreSQL).

    The web UI is a browser application, and a script cannot click. What it can do is open each page in a
    real browser engine (headless Microsoft Edge or Google Chrome, found in their usual folders), let the
    page load its data, and read the text the page rendered. Every "look for" line of the guide that is
    about text on a page is asserted that way. What stays for your eyes: layout, colours and the diagram.
    Without a browser the script fails; -NoBrowser skips the rendered-page checks and says so.

    Works in Windows PowerShell 5.1 and PowerShell 7. Exit code 0 means every case passed.

.PARAMETER SkipInstall
    Skip MV-8.1 (pnpm install, check, build) when the workspace is already installed and built.

.PARAMETER NoBrowser
    Skip the checks that read rendered pages (no Edge or Chrome available).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-8.ps1
#>
param([switch]$SkipInstall, [switch]$NoBrowser)

. (Join-Path $PSScriptRoot '_helpers.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$out = Join-Path $root 'out\self-check'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
$ProgressPreference = 'SilentlyContinue'

$apiPort = 3108
$webPort = 5208
$api = "http://127.0.0.1:$apiPort"
$web = "http://127.0.0.1:$webPort"
$selfCheckDb = 'postgresql://dataforge:dataforge@localhost:5433/dataforge_selfcheck'
$workDir = Join-Path $out 'executions'
$missingId = '01a2059d-1421-7651-8848-976194c3e863'

$savedEnv = @{ DATABASE_URL = $env:DATABASE_URL; API_PORT = $env:API_PORT; API_HOST = $env:API_HOST; EXECUTION_WORK_DIR = $env:EXECUTION_WORK_DIR; KAFKA_BROKERS = $env:KAFKA_BROKERS; WEB_PORT = $env:WEB_PORT; WEB_HOST = $env:WEB_HOST; WEB_API_URL = $env:WEB_API_URL }
$script:ApiProcess = $null
$script:ApiStarts = 0
$script:WebProcess = $null

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

# One HTTP request through curl.exe: the status code, the content type and the body, whatever the status.
function Invoke-HttpAt {
    param([string]$Base, [string]$Path)
    $lines = @(& curl.exe -s -w "`n%{http_code}`n%{content_type}" "$Base$Path" 2>&1 | ForEach-Object { "$_" })
    $count = $lines.Count
    $type = if ($count -ge 1) { $lines[$count - 1] } else { '' }
    $status = if ($count -ge 2) { [int]$lines[$count - 2] } else { 0 }
    $body = if ($count -ge 3) { ($lines[0..($count - 3)] -join "`n") } else { '' }
    [pscustomobject]@{ Status = $status; Type = $type; Body = $body }
}

function Invoke-Http { param([string]$Path) Invoke-HttpAt $api $Path }

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
    param([string]$Profile, [hashtable]$Target)
    $execution = Post-Json '/executions' @{ runId = $script:run.id; chaosProfileId = $script:profiles[$Profile]; chaosProfileVersion = 1; chaosSeed = 7; target = $Target }
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

# The page's DOM after it loaded its data, as markup: for what the text cannot say (the lines of the diagram).
function Get-Dom([string]$Path) {
    $previous = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    try {
        & $browser --headless=new --disable-gpu "--user-data-dir=$profileDir" --virtual-time-budget=12000 --dump-dom "$web$Path" 2>$null | Out-String
    } finally {
        [Console]::OutputEncoding = $previous
    }
}

# Asserts how many elements of the diagram a page has: $Counts maps a class attribute prefix to its count.
function Assert-Diagram {
    param([string]$Path, [hashtable]$Counts)
    if ($NoBrowser) { Write-Note "diagram not checked (-NoBrowser): $Path"; return }
    if ($null -eq $browser) { $script:CaseFailures.Add("$Path - no browser to render the diagram"); return }
    $dom = Get-Dom $Path
    foreach ($prefix in $Counts.Keys) {
        $found = [regex]::Matches($dom, [regex]::Escape('class="' + $prefix)).Count
        Assert-That ($found -eq $Counts[$prefix]) "$Path - the diagram has $found elements of class $prefix, expected $($Counts[$prefix])"
    }
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

Write-Host "DataForge Milestone 8 self-check - node $(node --version), pnpm $(pnpm --version), PowerShell $($PSVersionTable.PSVersion)"
if ($NoBrowser) { Write-Host 'Rendered-page checks are skipped (-NoBrowser).' }
elseif ($null -eq $browser) { Write-Host 'No Microsoft Edge or Google Chrome found: the rendered-page checks will fail. Install one, or pass -NoBrowser.' }
else { Write-Host "Rendering pages with $browser" }
Write-Host ''

try {

Test-Case 'MV-8.1' 'Install, build and run the automated checks' -Skip:$SkipInstall {
    Assert-Exit (Invoke-Pnpm @('install')) 0 'pnpm install'
    $check = Invoke-Pnpm @('check')
    Assert-Exit $check 0 'pnpm check'
    foreach ($project in 'packages/core', 'packages/chaos', 'packages/targets', 'packages/validation', 'packages/kafka', 'packages/execution', 'apps/api', 'apps/consumer', 'apps/cli', 'apps/web') {
        Assert-Match $check.Text "$project typecheck: Done" "$project type-checked"
    }
    Assert-Match $check.Text 'Test Suites:\s+40 passed, 40 total' 'pnpm check Jest suites'
    Assert-Match $check.Text 'Tests:\s+451 passed, 451 total' 'pnpm check Jest tests'
    Assert-Match $check.Text 'Test Files\s+7 passed \(7\)' 'pnpm check Vitest files'
    Assert-Match $check.Text 'Tests\s+108 passed \(108\)' 'pnpm check Vitest tests'
    $build = Invoke-Pnpm @('build')
    Assert-Exit $build 0 'pnpm build'
    Assert-Match $build.Text 'apps/web build: .*built in' 'web built'
    Assert-That (Test-Path (Join-Path $root 'apps\web\dist\index.html')) 'apps\web\dist\index.html exists'
}

Test-Case 'MV-8.2' 'Services, the migration and the integration suite' {
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

Test-Case 'MV-8.3' 'Start the API and the UI; deep links and the /api proxy' {
    Assert-That (Start-Api) 'the API did not answer /health within 30 s'
    Assert-That (Start-Web) 'the web server did not answer within 30 s'
    $health = Invoke-HttpAt $web '/api/health'
    Assert-That ($health.Status -eq 200 -and $health.Type -match 'json') "/api/health HTTP $($health.Status) $($health.Type)"
    Assert-That ($health.Body -eq (Invoke-Http '/health').Body) '/api/health through the proxy equals the API answer'
    foreach ($path in '/', '/runs', '/executions', "/executions/$missingId", "/executions/$missingId/aggregates/ord_000001") {
        $page = Invoke-HttpAt $web $path
        Assert-That ($page.Status -eq 200 -and $page.Type -match 'text/html' -and $page.Body -match '<div id="root">') "deep link $path HTTP $($page.Status) $($page.Type)"
    }
    $asset = [regex]::Match((Invoke-HttpAt $web '/').Body, '/assets/index-[A-Za-z0-9_-]+\.js').Value
    Assert-That ($asset -ne '' -and (Invoke-HttpAt $web $asset).Status -eq 200) "the script $asset is served"
    $empty = Invoke-HttpAt $web '/api/runs'
    Assert-That ($empty.Status -eq 200 -and $empty.Body -match '"total":0') "an empty history through the proxy: $($empty.Body)"
    Assert-Page '/executions' @('No executions yet', 'POST /executions')
    Assert-Page '/runs' @('No runs yet', 'POST /runs')
}

Test-Case 'MV-8.4' 'Create the data: a run, four profiles and five executions' {
    $small = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
    $script:run = Wait-Run (Post-Json '/runs' @{ scenarioId = $small.id; seed = 42 }).id
    Assert-That ($run.status -eq 'succeeded' -and $run.eventCount -eq 472) "run $($run.status) $($run.eventCount)"
    $script:profiles = @{}
    foreach ($name in 'none', 'spec-example', 'late-data', 'lossy') {
        $script:profiles[$name] = (Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile "chaos-profiles\$name.json").id
    }
    $script:pass = Start-Execution 'none' @{ type = 'reference'; name = 'correct' }
    Assert-That ($pass.verdict -eq 'PASS' -and $pass.attemptCount -eq 472 -and $pass.findingCount -eq 0) "pass: $($pass.verdict) $($pass.attemptCount) $($pass.findingCount)"
    $script:naive = Start-Execution 'spec-example' @{ type = 'reference'; name = 'naive' }
    Assert-That ($naive.verdict -eq 'FAIL' -and $naive.attemptCount -eq 486 -and $naive.findingCount -eq 48) "naive: $($naive.verdict) $($naive.attemptCount) $($naive.findingCount)"
    $script:late = Start-Execution 'late-data' @{ type = 'reference'; name = 'correct' }
    Assert-That ($late.verdict -eq 'FAIL' -and $late.findingCount -eq 0 -and $late.windowFindingCount -eq 7) "late: $($late.verdict) $($late.findingCount) $($late.windowFindingCount)"
    $script:lossy = Start-Execution 'lossy' @{ type = 'reference'; name = 'correct' }
    Assert-That ($lossy.verdict -eq 'FAIL' -and $lossy.attemptCount -eq 575 -and $lossy.findingCount -eq 81) "lossy: $($lossy.verdict) $($lossy.attemptCount) $($lossy.findingCount)"
    $script:kafka = Start-Execution 'spec-example' @{ type = 'reference'; name = 'naive'; transport = 'kafka' }
    Assert-That ($kafka.status -eq 'completed' -and $kafka.verdict -eq 'FAIL' -and $kafka.findingCount -eq 48 -and $kafka.kafka.sent -eq 486) "kafka: $($kafka.status) $($kafka.findingCount) $($kafka.kafka.sent)"
    Assert-That ($naive.delivery.ordering.outOfOrderEvents -eq 10 -and $naive.delivery.ordering.inversionPairs -eq 11 -and $naive.delivery.ordering.aggregatesAffected -eq 9) 'the ordering of the specification example'
}

Test-Case 'MV-8.5' 'Run history and run detail' {
    Assert-Page '/runs' @('Runs', 'ecommerce-small', 'succeeded', '\b472\b')
    Assert-Page "/runs/$($run.id)" @('What was generated', 'ecommerce-small v1', 'Expected final state', '25,256\.64 USD', 'Events by type', 'PaymentCompleted 108', 'manifest\.json', 'Executions of this run', 'Stored canonical events', 'evt_prd_000001_1')
    Assert-Page "/runs/$($run.id)?aggregateId=ord_000018" @('evt_ord_000018_3', 'PaymentCompleted') @('evt_prd_000001_1')
    Assert-Page "/runs?status=failed" @('No runs match these filters')
}

Test-Case 'MV-8.6' 'Execution history and its filters' {
    Assert-Page '/executions' @('Executions', 'late-data', 'lossy', 'spec-example', '0 \+ 7 windows', '\b575\b', 'PASS', 'FAIL')
    Assert-Page '/executions?verdict=PASS' @('none') @('spec-example', 'lossy')
    Assert-Page "/executions?runId=$($run.id)&status=completed" @('Remove the Run filter|ecommerce-small')
    Assert-Page '/executions?status=failed' @('No executions match these filters')
}

Test-Case 'MV-8.7' 'A passing execution' {
    Assert-Page "/executions/$($pass.id)" @('Verdict PASS', 'The target ended in the expected state\.', 'No findings: the target ended in the expected state\.', 'Delivery attempts 472') @('Window findings', 'Root causes')
}

Test-Case 'MV-8.8' 'A failing execution: report, findings and root causes' {
    Assert-Page "/executions/$($naive.id)" @(
        'Verdict FAIL', '48 findings: 48 explained by a delivery fault, 0 not explained by delivery\.',
        'Delivery attempts 486', 'Events out of order 10', 'duplicate 3\.0% 3\.0% 14 472 14 extra deliveries',
        'field-mismatch 14', 'status-mismatch 8', 'double-processing 8', 'invariant-violation 18',
        'Root causes', 'evt_ord_000045_1 OrderCreated: reorder; overtaken by evt_ord_000045_2', 'Showing 1.25 of 48')
    Assert-Page "/executions/$($naive.id)?open=12&offset=0" @('amountPaidMinor is 7000, expected 3500 \(2x\); paymentAttempts is 3, expected 2', 'Expected Actual', 'evt_ord_000018_3 PaymentCompleted: duplicate; delivered 2 times', 'Timelines')
    Assert-Page "/executions/$($naive.id)?category=status-mismatch" @('status is SHIPPED, expected DELIVERED', 'Showing 1.8 of 8') @('double-processing 8 .* orderCount')
    Assert-Page "/executions/$($naive.id)?offset=25" @('Showing 26.48 of 48')
}

Test-Case 'MV-8.9' 'Drill-down: a reordered order (wrong status) and a double charge' {
    $delivered = @((Get-Json "/executions/$($naive.id)/attempts?aggregateId=ord_000045").attempts)
    Assert-That (($delivered | ForEach-Object { "$($_.deliverySequence):$($_.eventId)" }) -join ',' -eq '153:evt_ord_000045_2,154:evt_ord_000045_1,479:evt_ord_000045_4,480:evt_ord_000045_3') 'delivery order of ord_000045'
    Assert-Page "/executions/$($naive.id)/aggregates/ord_000045?finding=18" @(
        'Order ord_000045', 'Opened from finding 19', 'status is SHIPPED, expected DELIVERED',
        'Events 4 Delivery attempts 4 Out of order 2 Lost 0', 'Canonical timeline', 'Delivery timeline',
        'out of order', 'overtaken by evt_ord_000045_2', 'overtaken by evt_ord_000045_4',
        'Reordered behind evt_ord_000045_2, the next event of its aggregate')
    Assert-Page "/executions/$($naive.id)/aggregates/ord_000018?finding=12&event=evt_ord_000018_3" @(
        'Order ord_000018', 'Opened from finding 13', 'amountPaidMinor is 7000, expected 3500 \(2x\)',
        'Events 5 Delivery attempts 6 Out of order 0', 'duplicated', 'Extra copy 1 of 1', 'Redelivered 26\.4 s after att_ord_000018_3_1', 'delayed')
    Assert-Diagram "/executions/$($naive.id)/aggregates/ord_000018" @{ 'lane-line ' = 6; 'lane-line lane-line--duplicate' = 1; 'lane-dot' = 11 }
    Assert-Diagram "/executions/$($naive.id)/aggregates/ord_000045" @{ 'lane-line ' = 4 }
    Assert-Page "/executions/$($naive.id)/aggregates/cus_000009?finding=1" @('Customer cus_000009', 'orderCount is 23, expected 22', 'evt_ord_000078_1 OrderCreated: duplicate; delivered 2 times')
}

Test-Case 'MV-8.10' 'Window findings and late data' {
    Assert-Page "/executions/$($late.id)" @('Window findings', 'After its window closed 9', 'window-undercount', 'paymentsCompleted is 3, expected 4; revenueMinor is 61320, expected 83806', 'Showing 1.7 of 7', 'No findings: the target ended in the expected state\.')
    Assert-Page "/executions/$($late.id)?wopen=0" @('after-close', 'evt_ord_000012_2')
    Assert-Page "/executions/$($late.id)/events/evt_ord_000012_2?windowFinding=0" @('Order ord_000012', 'Opened from window finding 1', 'Events 4 Delivery attempts 4 Out of order 1', 'late', 'Late: held until after its window closed, behind evt_ord_000013_3, 1 h 24 min later')
}

Test-Case 'MV-8.11' 'An execution through Kafka: partition and offset' {
    Assert-Page "/executions/$($kafka.id)" @('Kafka', 'Records sent 486', 'delivery-log\.jsonl', 'kafka-run\.json')
    Assert-Page "/executions/$($kafka.id)/aggregates/ord_000088" @('Kafka', 'partition 0, offset 27', 'partition 0, offset 56', 'partition 0, offset 57', 'partition 0, offset 159', 'out of order')
    Assert-Page "/executions/$($naive.id)/aggregates/ord_000088" @('Delivery timeline') @('partition 0, offset')
    Assert-Diagram "/executions/$($naive.id)/aggregates/ord_000088" @{ 'lane-line ' = 4 }
}

Test-Case 'MV-8.12' 'A lost event' {
    Assert-Page "/executions/$($lossy.id)" @('Verdict FAIL', '81 findings: 81 explained', 'missing-entity 40', 'evt_ord_000015_2 PaymentFailed: lost')
    Assert-Page "/executions/$($lossy.id)/aggregates/ord_000041" @('Order ord_000041', 'Lost 1 Duplicated 0 Retried 1', 'lost', 'retried', 'failed, never sent', 'Delivery failure 3 of 4')
    # Nothing of the lost payment reached the target: 3 events with a delivery have a line, the lost one has none.
    Assert-Diagram "/executions/$($lossy.id)/aggregates/ord_000041" @{ 'lane-line ' = 3; 'lane-dot lane-dot--flagged' = 1; 'lane-dot' = 7 }
}

Test-Case 'MV-8.13' 'Failure states: unknown id, malformed id, tampered data, API stopped' {
    Assert-Page "/executions/$missingId" @('Not found')
    Assert-Page '/executions/not-an-id' @('The API rejected this request', 'must be a execution id')
    Assert-Page "/runs/$missingId" @('Not found')
    Assert-Page "/executions/$($naive.id)/aggregates/ord_999999" @('no stored events for', 'ord_999999')

    $victim = Wait-Run (Post-Json '/runs' @{ scenarioId = $run.scenario.id; seed = 'tamper' }).id
    Assert-That ($victim.status -eq 'succeeded') "tamper run $($victim.status)"
    $tamper = @"
BEGIN;
ALTER TABLE canonical_event DISABLE TRIGGER canonical_event_immutable;
UPDATE canonical_event SET payload = payload - 'amountMinor'
  WHERE run_id = '$($victim.id)' AND sequence = (SELECT min(sequence) FROM canonical_event WHERE run_id = '$($victim.id)' AND type = 'PaymentCompleted');
ALTER TABLE canonical_event ENABLE TRIGGER canonical_event_immutable;
COMMIT;
"@
    $changed = Invoke-Sql $tamper
    Assert-Exit $changed 0 'tamper transaction'
    $events = Invoke-Http "/runs/$($victim.id)/events?type=PaymentCompleted"
    Assert-That ($events.Status -eq 500 -and $events.Body -match 'Run Integrity Error' -and $events.Body -match 'payload\.amountMinor') "tampered events HTTP $($events.Status) $($events.Body)"
    Assert-Page "/runs/$($victim.id)?type=PaymentCompleted" @('Integrity error: stored data no longer matches its checksum', 'Restore the database') @('The API failed')
    Assert-Page "/runs/$($victim.id)?type=OrderCreated" @('evt_ord_\d+_1', 'OrderCreated') @('Integrity error')

    Stop-Api
    $down = Invoke-HttpAt $web '/api/health'
    Assert-That ($down.Status -eq 502 -and $down.Type -match 'text/plain' -and $down.Body -eq '') "the proxy without an API: HTTP $($down.Status) $($down.Type) body '$($down.Body)'"
    Assert-Page '/executions' @('The API is not reachable', 'pnpm api', 'Try again')
    Assert-That (Start-Api) 'the API did not restart'
    Assert-Page '/executions' @('Test executions', 'late-data') @('The API is not reachable')
}

Test-Case 'MV-8.14' 'The web app stays in the browser' {
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

Test-Case 'MV-8.15' 'A running execution: its view, and a timeline that is not available yet' {
    $body = @{ runId = $run.id; chaosProfileId = $profiles['spec-example']; chaosProfileVersion = 1; chaosSeed = 7; target = @{ type = 'reference'; name = 'correct'; transport = 'kafka'; speed = 5000 } }
    $slow = Post-Json '/executions' $body
    Start-Sleep -Seconds 3
    $now = Get-Json "/executions/$($slow.id)"
    Assert-That ($now.status -eq 'running' -and $null -eq $now.verdict) "the paced execution is $($now.status) $($now.verdict) after 3 s"
    $attempts = Invoke-Http "/executions/$($slow.id)/attempts?aggregateId=ord_000088"
    Assert-That ($attempts.Status -eq 409) "attempts of a running execution: HTTP $($attempts.Status)"
    Assert-Page "/executions/$($slow.id)" @('This execution is running', 'this page updates by itself until it ends') @('Reload', 'Validation report', 'Findings')
    Assert-Page "/executions/$($slow.id)/aggregates/ord_000088" @('Not available yet')
    $done = Wait-Execution $slow.id 120
    Assert-That ($done.status -eq 'completed' -and $done.verdict -eq 'PASS' -and $done.kafka.durationMs -ge 30000) "paced execution: $($done.status) $($done.verdict) $($done.kafka.durationMs) ms"
    Write-Note "paced delivery $($done.kafka.durationMs) ms"
    Assert-Page "/executions/$($slow.id)" @('Verdict PASS', 'The target ended in the expected state\.') @('This execution is running')
    Assert-Page "/executions/$($slow.id)/aggregates/ord_000088" @('Order ord_000088', 'Canonical timeline', 'partition 0, offset 27') @('Not available yet')
}

} finally {
    Stop-Api
    Stop-Web
    foreach ($name in $savedEnv.Keys) {
        if ($null -eq $savedEnv[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $savedEnv[$name] }
    }
}

Complete-Verification 'Milestone 8'

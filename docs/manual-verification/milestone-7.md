# Manual Verification — Milestone 7: Test Executions Through the API

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. Each case builds on the earlier ones, so run them in order, in the same window (the
**first window**). MV-7.3 starts the API in a **second window**; MV-7.11 starts your "pipeline" in a
**third window**. Every case from MV-7.2 on needs Docker Desktop.

What is new in this milestone:

- **Chaos profiles in the API**, like scenarios: a profile file posted as it is becomes version 1;
  a changed definition is a new immutable version.
- **Test executions.** `POST /executions` tests a stored run under a chaos profile version and a
  chaos seed against a **target**: a reference target (`correct` or `naive`) in memory or through
  Kafka, or an **external pipeline** (your own consumer, on your own topic and consumer group). The
  execution runs in the background: `queued`, `running`, then `completed` with a **verdict** (`PASS`
  or `FAIL`: was the target right?) or `failed` with an **error** (the execution could not complete,
  for example Kafka down). An external execution waits in `awaiting_actual_state` until you submit
  the state your pipeline ended in.
- **Everything is stored and queryable:** every delivery attempt (and, through Kafka, its partition
  and offset), the report, every finding with its causes. The files of an execution are rebuilt from
  the database and checked against their recorded checksums, and are byte for byte what
  `dataforge chaos plan`, `deliver` and `validate --report` write for the same inputs.
- **`@dataforge/execution`**, a new package, holds those steps for both the CLI and the API.
- HTTP status codes used below: **200** OK, **201** created, **202** accepted (work continues in the
  background), **400** invalid request, **404** not found, **409** conflict (not in the right state),
  **500** integrity error. `curl.exe` shows the status code where it matters (write `curl.exe`, not
  `curl`: in Windows PowerShell 5.1 `curl` is an alias of `Invoke-WebRequest`).

Self-check: `scripts/verification/milestone-7.ps1` runs these same cases with the same expected values
and prints PASS/FAIL per case. It uses its own database (`dataforge_selfcheck`), port (3107), work
directory and Kafka topics, so it does not touch the data of the steps below; it writes to
`out\self-check`, the hand-run steps to `out\mv\m7`. Its "pipeline" in MV-7.11 is finished by a small
helper instead of Ctrl+C, and in MV-7.15 it kills the API instead of pressing Ctrl+C.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-7.ps1
```

---

## MV-7.1 — Install, build and run the automated checks

- **Verifies:** the workspace, with the new package, installs, type-checks, lints and passes every
  automated test, without Docker.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `pnpm -r typecheck` lists nine projects, each `Done`, now including
  `packages/execution`; nothing after `$ eslint .`; `Test Suites: 38 passed, 38 total` and
  `Tests: 451 passed, 451 total`; the build shows `packages/execution build: Done` and
  `apps/api build: Done`.
- **How to read it:** the CLI tests and their golden hashes are the same as before: the steps moved
  from the CLI into `@dataforge/execution` without changing a byte of their output.
- **Failure:** a TypeScript or lint error, or a failing test.

## MV-7.2 — Services, the migration and the integration suite

- **Verifies:** the new migration applies, and the integration suite proves the API's files equal the
  CLI's (in memory and through Kafka), the external pipeline, integrity checks and recovery.
- **Preconditions:** Docker Desktop running; MV-7.1.

```powershell
docker compose down -v
docker compose up -d --wait
pnpm db:migrate
'\dt' | docker compose exec -T postgres psql -U dataforge -d dataforge
pnpm test:integration
```

- **Expected:** `pnpm db:migrate` prints `Applying migration 20261122232906_init`,
  `Applying migration 20261123140000_test_executions` and `All migrations have been successfully
  applied.` `\dt` lists 14 tables, among them the eight new ones: `chaos_profile`,
  `chaos_profile_version`, `delivery_attempt`, `execution_file`, `test_execution`,
  `validation_finding`, `validation_report`, `window_finding`. The suite ends with
  `Test Suites: 9 passed, 9 total` and `Tests: 96 passed, 96 total` (about two minutes).
- **How to read it:** `down -v` deletes the database volume and the Kafka topics, so the cases below
  start empty and the numbers they show are exact. The suite uses its own database (`dataforge_test`).
- **Failure:** a migration error, missing tables, or a failing integration test.

## MV-7.3 — Start the API, register a scenario and generate a run

- **Verifies:** the API starts with the new modules, and a run is ready to be tested.
- **Preconditions:** MV-7.2.

Open a **second PowerShell window** and start the API there; leave it running:

```powershell
Set-Location F:\DataForge
pnpm api
```

Then, in the **first window** (the two functions are used by every case below):

```powershell
$api = 'http://127.0.0.1:3000'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force out\mv\m7 | Out-Null
function Wait-Execution($id) {
    do { Start-Sleep -Milliseconds 300; $e = Invoke-RestMethod "$api/executions/$id" } while ($e.status -eq 'queued' -or $e.status -eq 'running')
    $e
}
function Start-Execution($profileId, $target) {
    $body = @{ runId = $run.id; chaosProfileId = $profileId; chaosProfileVersion = 1; chaosSeed = 7; target = $target } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri "$api/executions" -ContentType 'application/json' -Body $body
}
$small = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
$run = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $small.id; seed = 42 } | ConvertTo-Json)
Start-Sleep -Seconds 2
$run = Invoke-RestMethod "$api/runs/$($run.id)"
$run | Format-List status, eventCount
```

- **Expected:** the second window lists the new routes (`Mapped {/chaos-profiles, POST} route`,
  `Mapped {/executions, POST} route`, `Mapped {/executions/:id/actual-state, POST} route`, ...) and ends
  with `DataForge API listening on http://127.0.0.1:3000 (engine 0.1.0, database
  localhost:5433/dataforge). Ctrl+C stops it.` The first window shows `status succeeded`,
  `eventCount 472`.
- **How to read it:** this is the run of Milestone 6 (scenario `ecommerce-small`, seed 42). Every
  execution below tests it, with chaos seed 7 and version 1 of its profile (`Start-Execution`).
- **Failure:** the API does not start, or the run is not `succeeded`.

## MV-7.4 — Chaos profiles: register, refuse invalid and duplicate, version

- **Verifies:** a profile file becomes version 1 with every default filled in; an invalid one is
  refused with the path of each problem, a duplicate name with 409; a changed definition is version 2,
  an identical one returns the existing version.
- **Preconditions:** MV-7.3.

```powershell
$spec = Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile chaos-profiles\spec-example.json
$lateData = Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile chaos-profiles\late-data.json
$none = Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile chaos-profiles\none.json
$spec.versions | Format-Table version, profileHash
(Invoke-RestMethod "$api/chaos-profiles/$($spec.id)/versions/1").definition.faults.transientFailure
Set-Content out\mv\m7\bad-profile.json '{"formatVersion":1,"name":"bad","faults":{"delay":{"rate":2},"transientFailure":{"rate":0.1,"failures":{"min":1,"max":5},"maxRetries":2}}}' -Encoding Ascii
curl.exe -s -w "  HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@out\mv\m7\bad-profile.json" "$api/chaos-profiles"
curl.exe -s -w "  HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@chaos-profiles\spec-example.json" "$api/chaos-profiles"
$doc = Get-Content chaos-profiles\spec-example.json -Raw | ConvertFrom-Json
$doc.faults.duplicate.rate = 0.2
$doc | ConvertTo-Json -Depth 10 | Set-Content out\mv\m7\spec-example-20.json -Encoding Ascii
curl.exe -s -o NUL -w "new version: HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@out\mv\m7\spec-example-20.json" "$api/chaos-profiles/$($spec.id)/versions"
curl.exe -s -o NUL -w "identical: HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@chaos-profiles\spec-example.json" "$api/chaos-profiles/$($spec.id)/versions"
(Invoke-RestMethod "$api/chaos-profiles").chaosProfiles | Format-Table name, latestVersion
```

- **Expected:** version `1`, profileHash
  `sha256:abd6a63c5aec0e082fca427a28eaabc2c1c4f67d2b0c0728619c53e6c9163a2b`; the resolved
  `transientFailure` shows `rate 0`, `maxRetries 3`, `allowLoss False` (defaults the file left out).
  The bad profile: `{"message":["faults.delay.rate: Too big: expected number to be <=1",
  "faults.transientFailure.failures.max: cannot exceed maxRetries (2) unless allowLoss is true: an event
  that fails more often than it is retried is lost"],"error":"Bad Request","statusCode":400}  HTTP 400`.
  The duplicate: `A chaos profile named "spec-example" already exists (id ...); add a version with POST
  /chaos-profiles/.../versions.`, `HTTP 409`. Then `new version: HTTP 201`, `identical: HTTP 200`.
  The list: `late-data 1`, `none 1`, `spec-example 2`.
- **How to read it:** the profile is validated by the same schema as `dataforge chaos plan`, so the
  API reports the same problems, the loss rule included. Version 1 never changes: the executions below
  name it.
- **Failure:** another hash, a profile accepted that should be refused, or a version changed in place.

## MV-7.5 — A passing execution: the correct target under the spec example

- **Verifies:** an execution is accepted at once, runs in the background, and ends `completed` with
  verdict `PASS`, with the delivery it planned and what the target did.
- **Preconditions:** MV-7.4.

```powershell
$accepted = Start-Execution $spec.id @{ type = 'reference'; name = 'correct' }
$accepted.status
$correct = Wait-Execution $accepted.id
$correct | Format-List status, verdict, error, attemptCount, findingCount
$correct.target | Format-List
$correct.delivery.attemptsByKind | Format-List
$correct.targetResult.delivery | Format-List
$correct.targetResult.counters | Format-List
$correct.files.PSObject.Properties.Name
```

- **Expected:** `queued`; then `status completed`, `verdict PASS`, empty `error`, `attemptCount 486`,
  `findingCount 0`; the target `type reference`, `name correct`, `transport memory`; attempts
  `original 472`, `retry 0`, `duplicate 14`; the target received `messages 486`, `distinctEvents 472`,
  `redeliveries 14`, `failedAttempts 0`; counters `eventsParked 11`, `duplicatesIgnored 14`; six files:
  `delivery-plan.jsonl`, `chaos-profile.resolved.json`, `delivery-summary.json`, `actual-state.json`,
  `target-run.json`, `validation-report.json`.
- **How to read it:** the spec example (5% delayed, 3% duplicated, 2% reordered) planned 14
  duplicate attempts; the correct target ignored all 14 (it is idempotent) and parked 11 events until
  their predecessors arrived, so its state is exactly the expected one. The second window logs
  `[ExecutionRunner] Execution ... completed in ... ms: PASS`.
- **Failure:** another status or verdict, other counts, or an error.

## MV-7.6 — A failing execution: the naive target, its report, findings and causes

- **Verifies:** the naive target fails the same test; the report counts the findings by category,
  each finding names the delivery faults behind it, and the attempts of the guilty event can be
  looked up.
- **Preconditions:** MV-7.5.

```powershell
$naive = Wait-Execution (Start-Execution $spec.id @{ type = 'reference'; name = 'naive' }).id
$naive | Format-List status, verdict, findingCount
$report = Invoke-RestMethod "$api/executions/$($naive.id)/report"
$report.counts.byCategory
$report.counts | Format-List explained, unexplained
$report.rootCauses[0].cause | Format-List eventId, faults, overtakenBy
$report.rootCauses[0].findings
$doubled = Invoke-RestMethod "$api/executions/$($naive.id)/findings?category=double-processing&limit=3"
$doubled.total
$doubled.findings[0] | Format-List entityType, entityId, message
$doubled.findings[0].causes[0] | Format-List eventId, eventType, deliveries, faults
(Invoke-RestMethod "$api/executions/$($naive.id)/attempts?eventId=evt_ord_000078_1").attempts | Format-Table deliverySequence, attemptId, kind, scheduledDeliveryTimeMs
```

- **Expected:** `status completed`, `verdict FAIL`, `findingCount 48`. By category: `field-mismatch 14`,
  `status-mismatch 8`, `double-processing 8`, `invariant-violation 18`, the others 0; `explained 48`,
  `unexplained 0`. The first root cause is `evt_ord_000045_1` (`faults {reorder}`, overtaken by
  `evt_ord_000045_2`) behind 7 findings. `double-processing` has 8 findings; the first is `customer
  cus_000009`, `orderCount is 23, expected 22`, caused by `evt_ord_000078_1`, `OrderCreated`,
  `deliveries 2`, `faults {duplicate}`. Its attempts: `42 att_ord_000078_1_1 original 33212526` and
  `43 att_ord_000078_1_2 duplicate 33229140`.
- **How to read it:** the naive target counts every copy, so the duplicated `OrderCreated` of order
  78 counted the order twice for customer 9: the double processing the specification asks DataForge
  to find. Both attempts carry the same `eventId` and different `attemptId`s; the duplicate came
  16,614 ms of simulation time after the original. The verdict is the target's (`FAIL`), while the
  execution itself `completed`.
- **Failure:** another verdict or count, a finding without causes, or attempts that do not match.

## MV-7.7 — The same bytes as the CLI

- **Verifies:** the six files of the naive execution are byte for byte what the CLI writes for the
  same run, profile, chaos seed and target.
- **Preconditions:** MV-7.6.

```powershell
$files = 'delivery-plan.jsonl', 'chaos-profile.resolved.json', 'delivery-summary.json', 'actual-state.json', 'target-run.json', 'validation-report.json'
New-Item -ItemType Directory -Force out\mv\m7\api-naive | Out-Null
foreach ($f in $files) { Invoke-WebRequest -UseBasicParsing "$api/executions/$($naive.id)/files/$f" -OutFile "out\mv\m7\api-naive\$f" }
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\m7\cli-run --force
pnpm --silent dataforge chaos plan --run out\mv\m7\cli-run --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out\mv\m7\cli-plan --force
pnpm --silent dataforge deliver --run out\mv\m7\cli-run --plan out\mv\m7\cli-plan --target naive --out out\mv\m7\cli-naive --force
pnpm --silent dataforge validate --run out\mv\m7\cli-run --actual out\mv\m7\cli-naive\actual-state.json --plan out\mv\m7\cli-plan --report out\mv\m7\cli-naive\validation-report.json --limit 0
foreach ($f in $files) {
    $cli = if ($f -like 'delivery-*' -or $f -like 'chaos-*') { "out\mv\m7\cli-plan\$f" } else { "out\mv\m7\cli-naive\$f" }
    '{0,-28} {1} {2}' -f $f, (Get-FileHash "out\mv\m7\api-naive\$f").Hash.Substring(0, 16), ((Get-FileHash "out\mv\m7\api-naive\$f").Hash -eq (Get-FileHash $cli).Hash)
}
```

- **Expected:** `validate` ends with `Result: FAIL (48 findings)`. Every line ends with `True`:

  ```text
  delivery-plan.jsonl          0C08D623A4203454 True
  chaos-profile.resolved.json  759A85738A32CD3B True
  delivery-summary.json        63887F16C26B5F8C True
  actual-state.json            A47FBBB75451D597 True
  target-run.json              62E37D930F2B321E True
  validation-report.json       51C6D6331A95CCF3 True
  ```

  (`Substring(0, 16)` shows the first 16 characters of each SHA-256.)
- **How to read it:** the API stores the plan as rows and the report as rows of findings, and rebuilds
  each file from them; equal checksums mean nothing was lost or changed on the way through the
  database, and that the API and the CLI run the same steps (`@dataforge/execution`).
- **Failure:** any `False`, or other checksums.

## MV-7.8 — An order's canonical timeline and its delivery timeline

- **Verifies:** the events of one order, as they happened (the run) and as they were delivered (the
  execution), side by side: the explanation of a status finding.
- **Preconditions:** MV-7.6.

```powershell
(Invoke-RestMethod "$api/runs/$($run.id)/events?aggregateId=ord_000045").events | Format-Table sequence, eventId, type
(Invoke-RestMethod "$api/executions/$($naive.id)/attempts?aggregateId=ord_000045").attempts | Format-Table deliverySequence, eventId, kind, @{ n = 'faults'; e = { ($_.faults | ForEach-Object { "$($_.type) behind $($_.behindEventId)" }) -join ', ' } }
(Invoke-RestMethod "$api/executions/$($naive.id)/findings?entityType=order&entityId=ord_000045").findings | Format-Table category, message
```

- **Expected:** the run: `147 evt_ord_000045_1 OrderCreated`, `149 evt_ord_000045_2 PaymentCompleted`,
  `196 evt_ord_000045_3 ShipmentCreated`, `466 evt_ord_000045_4 ShipmentDelivered`. The delivery:
  `153 evt_ord_000045_2`, `154 evt_ord_000045_1 ... reorder behind evt_ord_000045_2`,
  `479 evt_ord_000045_4`, `480 evt_ord_000045_3 ... reorder behind evt_ord_000045_4`. The findings of
  the order: `status-mismatch status is SHIPPED, expected DELIVERED`, a `field-mismatch`
  (`amountPaidMinor is 0, expected 6310; ...`) and two `invariant-violation`s.
- **How to read it:** two reorder faults swapped both pairs of events. The naive target received the
  payment before the order existed, so the payment was lost, and the delivery before the shipment, so
  the shipment's late arrival set the status back to `SHIPPED`: the order ends shipped, unpaid and
  undelivered. These two lists are the "canonical timeline next to the delivery timeline" a UI will
  show.
- **Failure:** other sequences, a missing reorder, or no status finding.

## MV-7.9 — Windows and late data

- **Verifies:** an execution under a windowed profile validates the target's event-time windows too,
  and explains each wrong window by the late event behind it.
- **Preconditions:** MV-7.4.

```powershell
$late = Wait-Execution (Start-Execution $lateData.id @{ type = 'reference'; name = 'naive' }).id
$late | Format-List verdict, findingCount, windowFindingCount
(Invoke-RestMethod "$api/executions/$($late.id)/report").windows.counts.byCategory
$w = (Invoke-RestMethod "$api/executions/$($late.id)/window-findings?limit=1").findings[0]
$w | Format-List category, windowStartMs, windowEndMs, message
$w.causes[0] | Format-List eventId, arrival, windowCloseMs, streamTimeMs
```

- **Expected:** `verdict FAIL`, `findingCount 19`, `windowFindingCount 13`; `window-undercount 7`,
  `window-overcount 6`; the first window finding `window-undercount`, `50400000`, `54000000`,
  `paymentsCompleted is 3, expected 4; revenueMinor is 61320, expected 83806`, caused by
  `evt_ord_000012_2`, `arrival after-close`, `windowCloseMs 54600000`, `streamTimeMs 55773886`.
- **How to read it:** the payment belongs to the window [14:00, 15:00) of the first day (50,400,000 ms
  after the epoch). It arrived when the stream had reached 55,773,886 ms, after the window had closed
  (54,600,000 ms: its end plus 10 minutes of allowed lateness), so the naive target counted it in the
  next window: one window short, the next one long.
- **Failure:** no window findings, or a window finding without a late cause.

## MV-7.10 — An execution through Kafka

- **Verifies:** the same test through a real Kafka broker and the reference consumer process: every
  attempt is a record with a partition and an offset, and the target ends in the same state as in
  memory.
- **Preconditions:** MV-7.5.

```powershell
$kafka = Wait-Execution (Start-Execution $spec.id @{ type = 'reference'; name = 'correct'; transport = 'kafka' }).id
$kafka | Format-List status, verdict, error, workDirectory
$kafka.target
$kafka.kafka
(Invoke-RestMethod "$api/executions/$($kafka.id)/attempts?limit=3").attempts | Format-Table deliverySequence, attemptId, @{ n = 'kafka'; e = { "$($_.kafka.outcome) p$($_.kafka.partition) @$($_.kafka.offset)" } }
foreach ($f in 'actual-state.json', 'target-run.json', 'validation-report.json') { '{0,-24} {1}' -f $f, ($kafka.files.$f.sha256 -eq $correct.files.$f.sha256) }
$kafka.files.PSObject.Properties.Name
```

- **Expected:** `status completed`, `verdict PASS`, empty `error`, a `workDirectory` under your temp
  directory (`...\dataforge-executions\<execution id>`). The target shows `transport kafka`,
  `partitions 1`, `speed max`, `timeoutSeconds 60`. `kafka`: a topic `dataforge.<date>-<id>`,
  `partitions 1`, `sent 486`, `plannedFailures 0`, a `durationMs` under a second (548 ms in the dry run) and `lagZeroAfterMs` of a few milliseconds. The first
  attempts: `1 att_prd_000001_1_1 sent p0 @0`, `2 ... sent p0 @1`, `3 ... sent p0 @2`. The three
  comparisons print `True`. Eight files: the six of MV-7.5 plus `delivery-log.jsonl` and
  `kafka-run.json`.
- **How to read it:** DataForge created a new topic, started the consumer as its own process, produced
  every delivered attempt in delivery order, waited for zero consumer-group lag and asked the consumer
  to finish. With one partition the consumer sees exactly the planned order, so its state and report
  equal the in-memory execution's. `consumer.log` and `producer.log` in the work directory are the
  Kafka client logs of both processes.
- **Failure:** `failed` with an error (is Kafka up?), or a `False`.

## MV-7.11 — An external pipeline: produce, wait, submit, validate

- **Verifies:** DataForge tests a consumer it did not start: it produces to your topic, waits until
  your consumer group has committed every record, and validates the state you submit.
- **Preconditions:** MV-7.10 (Kafka up).

The "pipeline" is the standalone reference consumer, run by you, with the naive target. First create
its topic, in the **first window**:

```powershell
docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:19092 --create --if-not-exists --topic shop-orders --partitions 1
```

Open a **third PowerShell window** and start the pipeline there; leave it running:

```powershell
Set-Location F:\DataForge
node apps\consumer\dist\main.js --brokers localhost:9092 --topic shop-orders --group shop-pipeline --target naive --out out\mv\m7\pipeline --force
```

When it prints `joined partitions 0 ...; consuming (Ctrl+C to finish and write the state)`, go back
to the **first window**:

```powershell
$ext = Wait-Execution (Start-Execution $spec.id @{ type = 'external'; topic = 'shop-orders'; groupId = 'shop-pipeline' }).id
$ext | Format-List status, error, attemptCount
$ext.kafka | Format-List topic, groupId, partitions, sent
$ext.files.PSObject.Properties.Name
curl.exe -s -w "  HTTP %{http_code}`n" "$api/executions/$($ext.id)/report"
```

- **Expected (so far):** `status awaiting_actual_state`, no `error`, `attemptCount 486`; `topic
  shop-orders`, `groupId shop-pipeline`, `partitions 1`, `sent 486`; five files: `delivery-plan.jsonl`,
  `chaos-profile.resolved.json`, `delivery-summary.json`, `delivery-log.jsonl`, `kafka-run.json`; the
  report is not there yet: `... is awaiting_actual_state; its report exists once it has completed.
  ... HTTP 409`.

Now press **Ctrl+C in the third window**. The pipeline prints `consumed 486 records: 472 distinct
events, 14 redeliveries` and `output ... out\mv\m7\pipeline (actual-state.json, consumer-report.json,
processing-log.jsonl)`, and exits. Back in the **first window**, submit what it wrote:

```powershell
Set-Content out\mv\m7\bad-submission.json '{"actualState":{"format":"dataforge.actual-state"}}' -Encoding Ascii
curl.exe -s -w "  HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@out\mv\m7\bad-submission.json" "$api/executions/$($ext.id)/actual-state"
$body = '{"actualState":' + (Get-Content out\mv\m7\pipeline\actual-state.json -Raw) + '}'
[System.IO.File]::WriteAllText("$pwd\out\mv\m7\submission.json", $body)
$done = Invoke-RestMethod -Method Post -Uri "$api/executions/$($ext.id)/actual-state" -ContentType 'application/json' -InFile out\mv\m7\submission.json
$done | Format-List status, verdict, findingCount
curl.exe -s -o NUL -w "second submission: HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@out\mv\m7\submission.json" "$api/executions/$($ext.id)/actual-state"
Invoke-WebRequest -UseBasicParsing "$api/executions/$($ext.id)/files/validation-report.json" -OutFile out\mv\m7\external-report.json
pnpm --silent dataforge validate --run out\mv\m7\cli-run --actual out\mv\m7\pipeline\actual-state.json --plan out\mv\m7\cli-plan --report out\mv\m7\cli-external-report.json --limit 0
(Get-FileHash out\mv\m7\external-report.json).Hash
(Get-FileHash out\mv\m7\external-report.json).Hash -eq (Get-FileHash out\mv\m7\cli-external-report.json).Hash
(Get-FileHash out\mv\m7\pipeline\actual-state.json).Hash -eq (Get-FileHash out\mv\m7\cli-naive\actual-state.json).Hash
```

- **Expected:** the bad submission: `{"message":["actualState.formatVersion: formatVersion must be 1",
  "actualState.products: Invalid input: expected array, received undefined", ...],"error":"Bad Request","statusCode":400}  HTTP 400` (every problem with its path, prefixed by
  `actualState`). The real one: `status completed`, `verdict FAIL`, `findingCount 48`; then
  `second submission: HTTP 409`. `validate` ends with `Result: FAIL (48 findings)`; the report hash is
  `EADFEFF2AF880EEBA0DD284523CFB38531C77AD77731C2F8F73EF723787592C7` and both comparisons print `True`.
- **How to read it:** before the first record DataForge checked that `shop-orders` exists and that
  `shop-pipeline` has an active member and no unconsumed records; after the last one it waited until
  the group had committed everything (zero lag). It knows nothing of the pipeline but its topic and
  group. Your pipeline's state equals the naive target's in memory (MV-7.7), and the API judges it
  exactly as `dataforge validate` judges the file. The report differs from MV-7.7's only in its
  `target`, which is `null`: DataForge did not see what the pipeline received.
- **Failure:** the execution `failed` (read its `error`), a submission accepted twice, or a `False`.

## MV-7.12 — External failures: a missing topic, a group without a consumer

- **Verifies:** an external execution that cannot work fails early, before producing anything, with
  what to do.
- **Preconditions:** MV-7.11 (the pipeline in the third window has stopped).

```powershell
$missing = Wait-Execution (Start-Execution $none.id @{ type = 'external'; topic = 'no-such-topic'; groupId = 'shop-pipeline' }).id
$missing | Format-List status, error
$idle = Wait-Execution (Start-Execution $none.id @{ type = 'external'; topic = 'shop-orders'; groupId = 'shop-pipeline' }).id
$idle | Format-List status, error, attemptCount
```

- **Expected:** `status failed`, `error Topic "no-such-topic" does not exist. An external execution
  produces to your pipeline's topic: create it, and start your pipeline on it, before the execution.`
  Then `status failed`, `error Consumer group "shop-pipeline" has no active member (group state
  Empty). Start your pipeline, consuming "shop-orders" with group "shop-pipeline", before the
  execution: without an active member the group's lag never reaches zero.`, and no `attemptCount`.
- **How to read it:** without an active consumer the lag would never reach zero, so DataForge refuses
  to start rather than time out. `failed` is the execution's status, not a verdict on any pipeline.
- **Failure:** an execution that waits, or produces records, instead of failing.

## MV-7.13 — Invalid execution requests

- **Verifies:** bad requests are refused with what is wrong, and an execution needs a succeeded run.
- **Preconditions:** MV-7.4.

```powershell
Set-Content out\mv\m7\bad-execution.json ('{"runId":"' + $run.id + '","chaosProfileId":"' + $none.id + '","chaosSeed":"two words","target":{"type":"reference","name":"clever"}}') -Encoding Ascii
curl.exe -s -w "  HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@out\mv\m7\bad-execution.json" "$api/executions"
Set-Content out\mv\m7\memory-partitions.json ('{"runId":"' + $run.id + '","chaosProfileId":"' + $none.id + '","chaosSeed":7,"target":{"type":"reference","name":"correct","partitions":2}}') -Encoding Ascii
curl.exe -s -w "  HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@out\mv\m7\memory-partitions.json" "$api/executions"
$std = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-standard.json
$pending = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $std.id; seed = 42 } | ConvertTo-Json)
Set-Content out\mv\m7\early.json ('{"runId":"' + $pending.id + '","chaosProfileId":"' + $none.id + '","chaosSeed":7,"target":{"type":"reference","name":"correct"}}') -Encoding Ascii
curl.exe -s -w "  HTTP %{http_code}`n" -X POST -H "Content-Type: application/json" --data-binary "@out\mv\m7\early.json" "$api/executions"
curl.exe -s -w "  HTTP %{http_code}`n" "$api/executions/$($naive.id)/files/kafka-run.json"
```

- **Expected:** `{"message":["chaosSeed: Invalid seed \"two words\": use 1-128 characters from A-Z,
  a-z, 0-9, \".\", \"_\", \":\" and \"-\"","target.name: Invalid option: expected one of
  \"correct\"|\"naive\""],"error":"Bad Request","statusCode":400}  HTTP 400`. Then
  `{"message":["target.partitions: applies only to \"transport\": \"kafka\""],...}  HTTP 400`. Then
  `Run ... is queued; start an execution once it has succeeded.  HTTP 409` (`running` instead of
  `queued` if the run had already started). Last, `Execution ... has no kafka-run.json: only a Kafka
  execution has one.  HTTP 404`.
- **How to read it:** an execution needs the run's events, which exist once the run has succeeded; the
  run you just started becomes `succeeded` a second later. Kafka options (`partitions`, `speed`,
  `timeoutSeconds`) are refused for the in-memory transport, as `dataforge deliver` refuses them.
- **Failure:** an execution created by any of these requests.

## MV-7.14 — A tampered attempt or finding is never served

- **Verifies:** stored attempts and findings cannot be changed by mistake, and a deliberate change is
  detected: the file is refused instead of being served differently.
- **Preconditions:** MV-7.6.

```powershell
"UPDATE delivery_attempt SET kind = 'retry' WHERE execution_id = '$($naive.id)' AND delivery_sequence = 43;" | docker compose exec -T postgres psql -U dataforge -d dataforge
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
$tamper | docker compose exec -T postgres psql -U dataforge -d dataforge
curl.exe -s -w "  HTTP %{http_code}`n" "$api/executions/$($naive.id)/files/delivery-plan.jsonl"
curl.exe -s -w "  HTTP %{http_code}`n" "$api/executions/$($naive.id)/files/validation-report.json"
curl.exe -s -o NUL -w "actual-state.json: HTTP %{http_code}`n" "$api/executions/$($naive.id)/files/actual-state.json"
curl.exe -s -o NUL -w "another execution: HTTP %{http_code}`n" "$api/executions/$($correct.id)/files/delivery-plan.jsonl"
```

- **Expected:** the first `UPDATE` fails: `ERROR:  delivery_attempt rows are immutable`. The
  transaction prints `UPDATE 1` twice and `COMMIT`. Then `{"statusCode":500,"error":"Execution
  Integrity Error","message":"delivery-plan.jsonl rebuilt from the database does not match the checksum
  recorded when execution ... made it (recorded sha256 0c08d623..., 167512 bytes; rebuilt sha256 ...,
  167512 bytes). The stored execution was modified."}  HTTP 500`, the same kind of answer for
  `validation-report.json`, then `actual-state.json: HTTP 200` and `another execution: HTTP 200`. The
  second window logs `ERROR [Executions] Integrity check failed for execution ...`.
- **How to read it:** a trigger refuses every update of attempts, files, reports and findings; with it
  disabled (as someone with table rights could), the change is still caught, because each file is
  rebuilt and compared with the checksum recorded when the execution made it. One millisecond on one
  attempt is enough. The other files of the execution, and other executions, are still served.
- **Failure:** the first update succeeds, or a tampered file is served with `200`.

## MV-7.15 — Restart: an interrupted execution runs again

- **Verifies:** an execution interrupted by stopping the API is not lost and not recorded as a
  failure: the next start runs it again from the beginning, with the same result.
- **Preconditions:** MV-7.10.

Start an execution through Kafka that is paced to take about 35 seconds (`speed 5000`: 5,000 ms of
simulation time per real millisecond), in the **first window**:

```powershell
$slow = Start-Execution $spec.id @{ type = 'reference'; name = 'correct'; transport = 'kafka'; speed = 5000 }
Start-Sleep -Seconds 8
(Invoke-RestMethod "$api/executions/$($slow.id)").status
```

When it prints `running`, press **Ctrl+C in the second window** (the API stops: its last lines
include `Execution ... was interrupted by the stop and stays running until the next start`). Then, in
the **first window**:

```powershell
"SELECT status, attempt_count FROM test_execution WHERE id = '$($slow.id)';" | docker compose exec -T postgres psql -U dataforge -d dataforge
```

Start the API again in the **second window** (`pnpm api`) and, in the **first window**:

```powershell
$again = Wait-Execution $slow.id
$again | Format-List status, verdict, error
$again.kafka | Format-List topic, durationMs
$again.files.'actual-state.json'.sha256 -eq $correct.files.'actual-state.json'.sha256
```

- **Expected:** `running`; the database shows `running |` with no attempt count (nothing was stored).
  On the second start, the second window logs `[ExecutionRunner] Resuming 1 queued execution(s): ...`
  and, about 35 seconds later, `Execution ... completed in ... ms: PASS`. The first window shows `status
  completed`, `verdict PASS`, a new topic, `durationMs` about 34500, and `True`.
- **How to read it:** an execution writes all of its results in one transaction at the end, so an
  interrupted one has nothing to clean up. On start-up, executions left `running` by a stopped API
  are queued again; planning is deterministic, so the second delivery (on a new topic) gives the same
  state. An external execution interrupted like this would instead be `failed`: DataForge cannot reset
  your pipeline.
- **Failure:** the execution is `failed`, stays `running`, or ends with another state.

## MV-7.16 — Execution history

- **Verifies:** executions are listed newest first and can be filtered.
- **Preconditions:** MV-7.15.

```powershell
$history = Invoke-RestMethod "$api/executions?runId=$($run.id)"
$history.total
$history.executions | Format-Table status, verdict, @{ n = 'profile'; e = { $_.chaosProfile.name } }, @{ n = 'target'; e = { "$($_.target.type) $($_.target.name)$($_.target.topic) $($_.target.transport)" } }
(Invoke-RestMethod "$api/executions?runId=$($run.id)&verdict=FAIL").total
(Invoke-RestMethod "$api/executions?status=failed").total
(Invoke-RestMethod "$api/executions?chaosProfileId=$($lateData.id)").total
```

- **Expected:** `8`; newest first: `completed PASS spec-example reference correct kafka` (MV-7.15),
  `failed none external shop-orders`, `failed none external no-such-topic`, `completed FAIL
  spec-example external shop-orders`, `completed PASS spec-example reference correct kafka`,
  `completed FAIL late-data reference naive memory`, `completed FAIL spec-example reference naive
  memory`, `completed PASS spec-example reference correct memory`. Then `3`, `2` and `1`.
- **Failure:** another order or count.

## MV-7.17 — The execution steps stay deterministic

- **Verifies:** the pure parts of `@dataforge/execution` are held to the determinism rules of the
  engine: no file system, no Kafka client, no machine clock.
- **Preconditions:** MV-7.1.

```powershell
Set-Content packages\execution\src\guard-probe.ts "import { readFileSync } from 'node:fs';`nimport { Kafka } from 'kafkajs';`nexport const probe = [readFileSync, Kafka, Date.now()];"
pnpm lint
Remove-Item packages\execution\src\guard-probe.ts
pnpm lint
```

- **Expected:** the first `pnpm lint` fails with three errors in `guard-probe.ts`: `'node:fs' import is
  restricted from being used by a pattern. The simulation core performs no I/O...`, `'kafkajs' import
  is restricted from being used by a pattern...`, and `... Business time comes from the simulation
  clock, not the machine clock.` The second `pnpm lint` passes.
- **How to read it:** only `kafka-delivery.ts` and `consumer-process.ts` may do I/O; planning, the file
  formats, validation and the external checks must give the same output for the same input, as in
  the CLI.
- **Failure:** the probe passes lint.

To stop everything afterwards: Ctrl+C in the second window (the API), then `docker compose down`
(PostgreSQL keeps its data; `docker compose down -v` deletes it).

# Manual Verification — Milestone 6: Persistence (PostgreSQL + Prisma) + API Foundation (NestJS)

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. Each case builds on the earlier ones, so run them in order, in the same window (the
**first window**). MV-6.4 starts the API in a **second window**, which stays open until MV-6.15.
Every case from MV-6.2 on needs Docker Desktop.

What is new in this milestone:

- **PostgreSQL** runs next to Kafka in `compose.yaml`, published on host port **5433** (5432 is
  often taken by a local PostgreSQL installation). Its data lives in a Docker volume, so it survives
  `docker compose down`; `docker compose down -v` deletes it.
- **The API** (`pnpm api`, `http://127.0.0.1:3000`) stores **scenarios** and their **versions**
  (each version is an immutable, resolved scenario definition) and **runs** (one version simulated
  with one seed). A run is generated in the background: `POST /runs` answers at once with
  `queued`, then the run becomes `running` and `succeeded` (or `failed`).
- **Run files.** A succeeded run gives back the four files of a run directory
  (`GET /runs/<id>/files/<name>`), rebuilt from the database rows and checked against the checksums
  recorded when the run was generated. They are byte for byte what `dataforge generate` writes.
- HTTP status codes used below: **200** OK, **201** created, **202** accepted (work continues in the
  background), **400** invalid request, **404** not found, **409** conflict, **500** server-side
  integrity error, **503** database unavailable. `curl.exe` (part of Windows) is used where the status
  code matters; `Invoke-RestMethod` where only the answer does. Write `curl.exe`, not `curl`: in
  Windows PowerShell 5.1 `curl` is an alias of `Invoke-WebRequest`.
- API process exit codes, as for the CLI: **2** invalid configuration, **3** infrastructure
  unavailable (PostgreSQL down or not migrated, port taken).

Self-check: `scripts/verification/milestone-6.ps1` runs these same cases with the same expected values
and prints PASS/FAIL per case. It uses its own database (`dataforge_selfcheck`) and port (3106) and
starts and stops its own API, so it does not touch the data of the steps below. It writes to
`out\self-check`; the hand-run steps use `out\mv`. Stop the API of the second window before you run it
only if you changed `API_PORT` to 3106.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-6.ps1
```

---

## MV-6.1 — Install, build and run the automated checks

- **Verifies:** the workspace installs (including the generated Prisma client), type-checks, lints
  and passes every automated test, without Docker.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
Test-Path apps\api\src\generated\prisma\client.ts
pnpm check
pnpm build
```

- **Expected:** on a first install, `pnpm install` prints `apps/api postinstall: ... Generated Prisma
  Client (7.10.1)` (when everything is installed already, `Already up to date`); `Test-Path` shows
  `True`; `pnpm -r typecheck` lists eight projects (now including `apps/api`), each `Done`; nothing after
  `$ eslint .`; `Test Suites: 34 passed, 34 total` and `Tests: 421 passed, 421 total`; the build
  shows `apps/api build: Done`.
- **How to read it:** `pnpm test` starts Jest with Node's `--experimental-vm-modules` flag, which
  NestJS 12 and Prisma 7 need (ADR-0011); you do not see a warning about it.
- **Failure:** any `error TS...`, an ESLint error, a failed test, or an `ERR_PNPM_...` message.

## MV-6.2 — Start PostgreSQL with an empty database and apply the migrations

- **Verifies:** Compose starts a healthy PostgreSQL from a pinned image next to Kafka, and the
  committed migration creates the schema.
- **Preconditions:** Docker Desktop running; MV-6.1.

```powershell
docker compose down -v
docker compose up -d --wait
docker compose ps --format "{{.Service}} {{.Image}} {{.Status}}"
pnpm db:migrate
'\dt' | docker compose exec -T postgres psql -U dataforge -d dataforge
```

- **Expected:** `docker compose ps` lists `kafka apache/kafka:4.3.2 Up ... (healthy)` and
  `postgres postgres:18.7-alpine Up ... (healthy)`. `pnpm db:migrate` prints
  `Applying migration 20261122232906_init` and `All migrations have been successfully applied.`
  `\dt` lists six tables: `_prisma_migrations`, `canonical_event`, `expected_state_snapshot`,
  `scenario`, `scenario_version`, `simulation_run`.
- **How to read it:** `down -v` deleted the database volume, so the cases below start from an empty
  database and the numbers they show (version 1, 2 runs, ...) are exact. A second
  `pnpm db:migrate` prints `No pending migrations to apply.`
- **Failure:** a service not `(healthy)`, a migration error, or missing tables.

## MV-6.3 — The integration suite against Kafka and PostgreSQL

- **Verifies:** the Prisma and API tests against the real database: constraints and immutability,
  every endpoint, byte-identical run files for two seeds and the specification-sized scenario, a
  tampered row, restart recovery, the API process's exit codes; plus the Kafka suite of earlier
  milestones.
- **Preconditions:** MV-6.2.

```powershell
pnpm test:integration
```

- **Expected:** `Test Suites: 6 passed, 6 total` and `Tests: 67 passed, 67 total`, in about 70 s.
  One line `ExperimentalWarning: VM Modules is an experimental feature ...` may be printed at the
  start; it is the flag of MV-6.1.
- **How to read it:** the tests use their own database, `dataforge_test`, which they drop and
  recreate on every run, so your data in `dataforge` is untouched. With PostgreSQL stopped the run
  fails at once with `POSTGRESQL UNAVAILABLE: the integration tests need a running PostgreSQL and
  did not run.` and the command to start it (with Kafka stopped, `KAFKA UNAVAILABLE`).
- **Failure:** any failed test.

## MV-6.4 — Start the API and check its health

- **Verifies:** the API starts against the migrated database and reports the database and engine.
- **Preconditions:** MV-6.2; the build of MV-6.1.

Open a **second PowerShell window** and start the API there; leave it running:

```powershell
Set-Location F:\DataForge
pnpm api
```

Then, in the **first window**:

```powershell
$api = 'http://127.0.0.1:3000'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force out\mv | Out-Null
Invoke-RestMethod "$api/health"
```

- **Expected:** the second window ends its start-up log with
  `[DataForgeApi] DataForge API listening on http://127.0.0.1:3000 (engine 0.1.0, database
  localhost:5433/dataforge). Ctrl+C stops it.` The first window shows `status ok`, `database up`,
  `engineVersion 0.1.0`.
- **How to read it:** the lines `Mapped {/runs, POST} route` and so on list every endpoint. The API
  only listens on 127.0.0.1: it has no authentication, so it stays on your machine.
  `$ProgressPreference` hides the download progress bar, which makes `Invoke-WebRequest` in Windows
  PowerShell 5.1 many times slower on large files (MV-6.10).
- **Failure:** the API exits, or `Invoke-RestMethod` reports that it cannot connect.

## MV-6.5 — Register a scenario

- **Verifies:** a scenario file posted as it is becomes scenario version 1, with its resolved
  definition (every default filled in) and its hash.
- **Preconditions:** MV-6.4 (API running).

```powershell
$small = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
$small | Format-List id, name, latestVersion
$small.versions | Format-Table version, scenarioHash
$v1 = Invoke-RestMethod "$api/scenarios/$($small.id)/versions/1"
$v1.definition.orders | Format-List count, customerCancellationRate
(Invoke-RestMethod "$api/scenarios").scenarios | Format-Table name, latestVersion
```

- **Expected:** `name ecommerce-small`, `latestVersion 1`, an `id` like
  `01a205a8-54c9-75d7-9402-0773f937ab0e` (yours differs); version `1` with scenarioHash
  `sha256:3afbcf1ac2460a195a0e6306bd5ea1e1d3655b8d80f1d356958e60109e901158`; `count 120`,
  `customerCancellationRate 0.08`; the list shows one scenario.
- **How to read it:** the hash is the fingerprint of the resolved definition. The same file always
  gives the same hash, whoever posts it and whenever.
- **Failure:** another status, another hash, or the scenario missing from the list.

## MV-6.6 — An invalid or duplicate scenario is refused

- **Verifies:** an invalid scenario is rejected with `400` and the path of every problem (the same
  validation as the CLI), nothing is stored, and a second scenario with an existing name is refused
  with `409`.
- **Preconditions:** MV-6.5.

```powershell
Set-Content -Path out\mv\bad-scenario.json -Encoding Ascii -Value '{"formatVersion":1,"name":"bad","orders":{"count":-1},"customers":{"count":"many"},"colour":"blue"}'
curl.exe -s -w "\nHTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@out\mv\bad-scenario.json" "$api/scenarios"
curl.exe -s -w "\nHTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@scenarios\ecommerce-small.json" "$api/scenarios"
(Invoke-RestMethod "$api/scenarios").scenarios.Count
```

- **Expected:** first
  `{"message":["customers.count: Invalid input: expected number, received string","orders.count: Too small: expected number to be >=0","Unrecognized key: \"colour\""],"error":"Bad Request","statusCode":400}`
  and `HTTP 400`; then `A scenario named \"ecommerce-small\" already exists (id <id>); add a version
  with POST /scenarios/<id>/versions.` with `"statusCode":409` and `HTTP 409`; the count is `1`.
- **Failure:** `HTTP 201` for either, a problem without its path, or a count other than 1.

## MV-6.7 — A changed definition is a new immutable version

- **Verifies:** posting a changed file creates version 2 (`201`); posting a file identical to an
  existing version returns that version (`200`) instead of a duplicate; version 1 is unchanged; a
  document with another name is refused.
- **Preconditions:** MV-6.5.

```powershell
$doc = Get-Content scenarios\ecommerce-small.json -Raw | ConvertFrom-Json
$doc.orders.count = 60
$doc | ConvertTo-Json -Depth 10 | Set-Content -Path out\mv\small-60.json -Encoding Ascii
curl.exe -s -o out\mv\v2.json -w "HTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@out\mv\small-60.json" "$api/scenarios/$($small.id)/versions"
(Get-Content out\mv\v2.json -Raw | ConvertFrom-Json) | Format-List version, scenarioHash
curl.exe -s -o out\mv\v2-again.json -w "HTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@out\mv\small-60.json" "$api/scenarios/$($small.id)/versions"
(Get-Content out\mv\v2-again.json -Raw | ConvertFrom-Json).version
curl.exe -s -o out\mv\v1-again.json -w "HTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@scenarios\ecommerce-small.json" "$api/scenarios/$($small.id)/versions"
(Get-Content out\mv\v1-again.json -Raw | ConvertFrom-Json).version
(Invoke-RestMethod "$api/scenarios/$($small.id)").versions | Format-Table version, scenarioHash
(Invoke-RestMethod "$api/scenarios/$($small.id)/versions/1").definition.orders.count
$doc.name = 'renamed'
$doc | ConvertTo-Json -Depth 10 | Set-Content -Path out\mv\renamed.json -Encoding Ascii
curl.exe -s -w "\nHTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@out\mv\renamed.json" "$api/scenarios/$($small.id)/versions"
```

- **Expected:** `HTTP 201`, `version 2`, scenarioHash
  `sha256:e9f36f6060b18a82451010a108501fb4898ebae7c91ab7d4ccca34ed37fd548a`; then `HTTP 200` and
  `2`; then `HTTP 200` and `1`; the table lists versions 1 and 2 with their two hashes; version 1
  still has `120` orders; the renamed document gives
  `name: the document is named \"renamed\" but this scenario is \"ecommerce-small\"; a new name is a
  new scenario (POST /scenarios)` and `HTTP 400`.
- **How to read it:** versions are never edited. The database itself refuses an update of a version
  (MV-6.13 shows the same protection for stored events).
- **Failure:** a third version, version 1 changed, or the renamed document accepted.

## MV-6.8 — Start a run and follow it to the end

- **Verifies:** `POST /runs` answers `202` at once with a `queued` run, which the background runner
  moves to `running` and `succeeded`; the finished run carries its counts, checksums and summary.
- **Preconditions:** MV-6.7.

```powershell
$run = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $small.id; version = 1; seed = 42 } | ConvertTo-Json)
$run | Format-List id, status, seed, engineVersion
do { Start-Sleep -Milliseconds 200; $run = Invoke-RestMethod "$api/runs/$($run.id)" } while ($run.status -eq 'queued' -or $run.status -eq 'running')
$run | Format-List status, eventCount, requestedAt, startedAt, finishedAt, error
$run.files.'events.jsonl' | Format-List sha256, bytes
$run.summary | Format-List orders, payments, shipments, revenueMinor
```

- **Expected:** first `status queued`, `seed 42`, `engineVersion 0.1.0`; then `status succeeded`,
  `eventCount 472`, three times in increasing order and an empty `error`; events.jsonl
  `sha256 01b57d640ab12e33702ccb72339fd00552e6b37b3fddce4dff7a5a8c0cca42de`, `bytes 146142`; summary
  `orders 120`, `payments 137`, `shipments 98`, `revenueMinor 2525664`. The second window logs
  `[RunRunner] Run <id> succeeded: 472 events in ... ms`.
- **How to read it:** the seed was sent as the number 42 and is stored as `"42"`: 42 and "42" are
  the same seed, as in the CLI. The checksum is the one `dataforge generate` prints for this scenario
  and seed (Milestone 1).
- **Failure:** `failed` (read `error`), another event count or checksum, or a run that never leaves
  `queued`.

## MV-6.9 — Download a run: the same bytes as `generate`, and `verify` passes

- **Verifies:** the four files rebuilt from the database are byte-identical to the files the CLI
  writes for the same scenario and seed, and form a run directory that `dataforge verify` accepts.
- **Preconditions:** MV-6.8.

```powershell
$dir = 'out\mv\api-small-42'
New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($file in 'events.jsonl', 'expected-state.json', 'scenario.resolved.json', 'manifest.json') {
    Invoke-WebRequest -UseBasicParsing -Uri "$api/runs/$($run.id)/files/$file" -OutFile (Join-Path $dir $file)
}
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\cli-small-42 --force | Out-Null
foreach ($file in 'events.jsonl', 'expected-state.json', 'scenario.resolved.json', 'manifest.json') {
    $fromApi = (Get-FileHash (Join-Path $dir $file)).Hash
    $fromCli = (Get-FileHash (Join-Path 'out\mv\cli-small-42' $file)).Hash
    '{0,-24} {1}  {2}' -f $file, $fromApi.Substring(0, 16), $(if ($fromApi -eq $fromCli) { 'identical' } else { 'DIFFERENT' })
}
pnpm --silent dataforge verify --run $dir
```

- **Expected:**

  ```text
  events.jsonl             01B57D640AB12E33  identical
  expected-state.json      3546842D89241F81  identical
  scenario.resolved.json   F642FB41261117D6  identical
  manifest.json            E58BD81FB8F519B2  identical
  ```

  and `verify` ends with `Result: PASS` after seven `OK` lines (checksums, parse, replay, state,
  reproduce).
- **How to read it:** the API never stored these files as text. It stored 472 event rows, a snapshot
  and a manifest, and rebuilt each file with the same core code the CLI uses. `identical` means
  everything you did with run directories in Milestones 1 to 5 works on a run from the database.
- **Failure:** any `DIFFERENT`, a failed download, or a verify step other than `OK`.

## MV-6.10 — The specification's example size

- **Verifies:** the specification-sized scenario (1,000 customers, 5,000 orders, 18,479 events) is
  stored in a few seconds and comes back with the bytes `generate` produces.
- **Preconditions:** MV-6.4.

```powershell
$std = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-standard.json
$stdRun = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $std.id; seed = 42 } | ConvertTo-Json)
do { Start-Sleep -Milliseconds 500; $stdRun = Invoke-RestMethod "$api/runs/$($stdRun.id)" } while ($stdRun.status -eq 'queued' -or $stdRun.status -eq 'running')
$stdRun | Format-List status, eventCount
$stdDir = 'out\mv\api-std-42'
New-Item -ItemType Directory -Force $stdDir | Out-Null
foreach ($file in 'events.jsonl', 'expected-state.json', 'scenario.resolved.json', 'manifest.json') {
    Invoke-WebRequest -UseBasicParsing -Uri "$api/runs/$($stdRun.id)/files/$file" -OutFile (Join-Path $stdDir $file)
}
Get-ChildItem $stdDir | ForEach-Object { '{0,-24} {1}' -f $_.Name, (Get-FileHash $_.FullName).Hash.Substring(0, 16) }
pnpm --silent dataforge verify --run $stdDir | Select-Object -Last 1
```

- **Expected:** `status succeeded`, `eventCount 18479`; the hashes

  ```text
  events.jsonl             E50C2D7714C78069
  expected-state.json      BDDC639A821F02F9
  manifest.json            8EA0A368DF43AE6E
  scenario.resolved.json   1B8725DB1100A2E9
  ```

  (the same as `pnpm dataforge generate --scenario scenarios/ecommerce-standard.json --seed 42`
  writes) and `Result: PASS`. The second window logs `succeeded: 18479 events in` about 1,500 to
  2,000 ms.
- **Failure:** `failed`, other hashes, or a run that takes much longer than 10 seconds.

## MV-6.11 — Run history, the same inputs twice, and stored events

- **Verifies:** run history newest first with filters; two runs of the same version and seed store
  identical results, a different seed different ones; stored events can be queried by aggregate, type
  and sequence range, matching `dataforge timeline`.
- **Preconditions:** MV-6.8, MV-6.9.

```powershell
foreach ($seed in 42, 7) {
    $r = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $small.id; version = 1; seed = $seed } | ConvertTo-Json)
    do { Start-Sleep -Milliseconds 200; $r = Invoke-RestMethod "$api/runs/$($r.id)" } while ($r.status -eq 'queued' -or $r.status -eq 'running')
}
$history = Invoke-RestMethod "$api/runs?scenarioId=$($small.id)"
$history.total
$history.runs | Format-Table @{ n = 'run'; e = { $_.id.Substring(0, 13) } }, seed, status, eventCount, @{ n = 'events.jsonl sha256'; e = { $_.files.'events.jsonl'.sha256.Substring(0, 16) } }
(Invoke-RestMethod "$api/runs?status=succeeded&limit=1").runs.Count
$timeline = Invoke-RestMethod "$api/runs/$($run.id)/events?aggregateId=ord_000088"
$timeline.events | Format-Table sequence, aggregateVersion, type, eventTimeMs
pnpm --silent dataforge timeline --run out\mv\cli-small-42 --aggregate ord_000088
$page = Invoke-RestMethod "$api/runs/$($run.id)/events?type=PaymentFailed&limit=5"
$page.events | Format-Table sequence, aggregateId, type
$page.nextSequence
```

- **Expected:** `total` `3`; the table, newest first: seed `7` with `eventCount 467` and events.jsonl
  `e344107c323c7f6c`, then seed `42` with `472` and `01b57d640ab12e33`, twice; the `limit=1` query
  returns `1` run. The aggregate query lists four events, sequences `27`, `28`, `57`, `155` with
  versions `1` to `4` (`OrderCreated`, `PaymentCompleted`, `ShipmentCreated`,
  `ShipmentDelivered`), and `timeline` shows the same four sequences. The type query lists five
  `PaymentFailed` events, sequences `23`, `32`, `75`, `82`, `93`, and `nextSequence` `105`.
- **How to read it:** same scenario version + seed + engine version, same checksums, in the database
  as on disk. `nextSequence` is what you pass as `fromSequence` to read the next page.
- **Failure:** the two seed-42 runs with different checksums, history out of order, or events of
  another aggregate in the timeline.

## MV-6.12 — Invalid run requests

- **Verifies:** a bad seed, a malformed or unknown scenario id, a missing version and unknown fields
  are refused with the right status and the path of each problem.
- **Preconditions:** MV-6.7.

```powershell
Set-Content -Path out\mv\bad-run.json -Encoding Ascii -Value '{"scenarioId":"not-an-id","seed":"two words","speed":2}'
curl.exe -s -w "\nHTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@out\mv\bad-run.json" "$api/runs"
Set-Content -Path out\mv\no-version.json -Encoding Ascii -Value ('{"scenarioId":"' + $small.id + '","seed":1,"version":9}')
curl.exe -s -w "\nHTTP %{http_code}\n" -H "Content-Type: application/json" --data-binary "@out\mv\no-version.json" "$api/runs"
curl.exe -s -w "\nHTTP %{http_code}\n" "$api/runs/01a20000-0000-7000-8000-000000000000"
curl.exe -s -w "\nHTTP %{http_code}\n" "$api/runs/$($run.id)/files/secrets.txt"
curl.exe -s -w "\nHTTP %{http_code}\n" "$api/runs?status=done"
```

- **Expected:**
  - `"scenarioId: must be a scenario id (a UUID)"`, `"seed: Invalid seed \"two words\": use 1-128
    characters from A-Z, a-z, 0-9, \".\", \"_\", \":\" and \"-\""`, `"Unrecognized key: \"speed\""`,
    `HTTP 400`;
  - `Scenario <id> has no version 9.`, `HTTP 404`;
  - `Run 01a20000-0000-7000-8000-000000000000 not found.`, `HTTP 404`;
  - `must be one of the run files: events.jsonl, expected-state.json, scenario.resolved.json,
    manifest.json`, `HTTP 400`;
  - `status: Invalid option: expected one of \"queued\"|\"running\"|\"succeeded\"|\"failed\"`,
    `HTTP 400`.
- **Failure:** any `HTTP 202` or `200`, or a problem reported without its field.

## MV-6.13 — A tampered stored event is never served

- **Verifies:** the database refuses to update a stored event; and if a row is changed anyway (by
  someone who disables that protection), downloading the run's events fails with an integrity error
  instead of serving a different file, while the untouched files still download.
- **Preconditions:** MV-6.8.

```powershell
$victim = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $small.id; version = 1; seed = 'tamper' } | ConvertTo-Json)
do { Start-Sleep -Milliseconds 200; $victim = Invoke-RestMethod "$api/runs/$($victim.id)" } while ($victim.status -eq 'queued' -or $victim.status -eq 'running')
"UPDATE canonical_event SET payload = jsonb_set(payload, '{amountMinor}', '1') WHERE run_id = '$($victim.id)' AND sequence = 1;" | docker compose exec -T postgres psql -U dataforge -d dataforge
@"
BEGIN;
ALTER TABLE canonical_event DISABLE TRIGGER canonical_event_immutable;
UPDATE canonical_event SET payload = jsonb_set(payload, '{amountMinor}', '1')
  WHERE run_id = '$($victim.id)' AND sequence = (SELECT min(sequence) FROM canonical_event WHERE run_id = '$($victim.id)' AND type = 'PaymentCompleted');
ALTER TABLE canonical_event ENABLE TRIGGER canonical_event_immutable;
COMMIT;
"@ | docker compose exec -T postgres psql -U dataforge -d dataforge -v ON_ERROR_STOP=1
curl.exe -s -w "\nHTTP %{http_code}\n" "$api/runs/$($victim.id)/files/events.jsonl"
curl.exe -s -o NUL -w "expected-state.json HTTP %{http_code}\n" "$api/runs/$($victim.id)/files/expected-state.json"
curl.exe -s -o NUL -w "seed 42 events.jsonl HTTP %{http_code}\n" "$api/runs/$($run.id)/files/events.jsonl"
```

- **Expected:** the first statement fails with `ERROR:  canonical_event rows are immutable`. The
  second prints `BEGIN`, `ALTER TABLE`, `UPDATE 1`, `ALTER TABLE`, `COMMIT`. The download then answers
  `{"statusCode":500,"error":"Run Integrity Error","message":"events.jsonl rebuilt from the database
  does not match the checksum recorded when run <id> was generated (recorded sha256
  fe4679ad886ae4bda50e44022b889868ba1472c56e71cc785e791a7ced2a22e3, 142705 bytes; rebuilt sha256
  625b9df6..., 142701 bytes). The stored run was modified."}` and `HTTP 500`; `expected-state.json
  HTTP 200`; `seed 42 events.jsonl HTTP 200`. The second window logs `ERROR [Runs] Integrity check
  failed for run <id>: ...`.
- **How to read it:** the recorded checksum is the one the run had when it was generated; the file
  rebuilt from the modified row is 4 bytes shorter, because one payment amount became `1`. A changed
  event is detected, not served, and other runs are unaffected.
- **Failure:** the first update succeeds, or the download answers `HTTP 200`.

## MV-6.14 — Restart: history survives, and a killed API's runs are completed

- **Verifies:** runs stored in PostgreSQL survive an API restart, and runs that a killed API left
  `queued` or `running` are completed on the next start, with the same results.
- **Preconditions:** MV-6.10 (the specification-sized scenario is registered); the API running in the
  second window.

In the first window, queue five specification-sized runs and kill the API at once:

```powershell
$queued = foreach ($i in 1..5) { (Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $std.id; seed = 42 } | ConvertTo-Json)).id }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*apps/api/dist/main.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
'SELECT status, count(*) FROM simulation_run GROUP BY status ORDER BY status;' | docker compose exec -T postgres psql -U dataforge -d dataforge
```

In the second window (pnpm reports that the command failed: the API was killed), start it again:

```powershell
pnpm api
```

Back in the first window:

```powershell
do { Start-Sleep -Seconds 1; $runs = (Invoke-RestMethod "$api/runs?scenarioId=$($std.id)").runs } while (@($runs | Where-Object { $_.status -ne 'succeeded' }).Count -gt 0)
$runs | Format-Table @{ n = 'run'; e = { $_.id.Substring(0, 13) } }, status, eventCount, @{ n = 'events.jsonl sha256'; e = { $_.files.'events.jsonl'.sha256.Substring(0, 16) } }
(Invoke-RestMethod "$api/runs").total
```

- **Expected:** the query after the kill shows `queued` and `running` rows next to the `succeeded`
  ones: `queued | 4`, `running | 1`, `succeeded | 5` (how many were still queued depends on how fast
  the kill came; at least four are). On the restart the second window logs
  `[RunRunner] Resuming 5 unfinished run(s): ...` (or 4) and then one `succeeded: 18479 events` line
  per run. The table lists six runs of `ecommerce-standard`, all `succeeded`, all `18479` events and
  `e50c2d7714c78069`; the total is `10`.
- **How to read it:** a run's rows are written in one transaction, so a killed run left no partial
  data, and generation is deterministic, so running it again gives the same result as an
  uninterrupted run (the same checksum as MV-6.10).
- **Failure:** a run stuck in `queued` or `running`, a `failed` run, a different checksum, or runs
  missing from history after the restart.

## MV-6.15 — The API without PostgreSQL, or without migrations

- **Verifies:** while the API runs, `/health` reports a stopped database with `503` and recovers when
  it is back; the API refuses to start, with exit code 3 and the command to run, when PostgreSQL is
  down or the database is not migrated.
- **Preconditions:** the API running in the second window (MV-6.14).

```powershell
docker compose stop postgres
curl.exe -s -w "\nHTTP %{http_code}\n" "$api/health"
docker compose up -d --wait postgres
curl.exe -s -w "\nHTTP %{http_code}\n" "$api/health"
```

Now stop the API: press **Ctrl+C in the second window**. Then, in the first window:

```powershell
docker compose stop postgres
pnpm --silent api
"exit code $LASTEXITCODE"
docker compose up -d --wait postgres
'CREATE DATABASE dataforge_mv_empty;' | docker compose exec -T postgres psql -U dataforge -d postgres
$env:DATABASE_URL = 'postgresql://dataforge:dataforge@localhost:5433/dataforge_mv_empty'
pnpm --silent api
"exit code $LASTEXITCODE"
Remove-Item Env:DATABASE_URL
'DROP DATABASE dataforge_mv_empty;' | docker compose exec -T postgres psql -U dataforge -d postgres
```

- **Expected:** with PostgreSQL stopped, `/health` answers
  `{"status":"unavailable","database":"down","engineVersion":"0.1.0","detail":"..."}` and `HTTP 503`;
  after `up -d --wait` it answers `{"status":"ok","database":"up","engineVersion":"0.1.0"}` and
  `HTTP 200`, without restarting the API. The first `pnpm api` prints
  `PostgreSQL is unavailable at localhost:5433/dataforge: connection refused (ECONNREFUSED)` and
  `Start it with "docker compose up -d --wait" (see compose.yaml), or point DATABASE_URL at a running
  PostgreSQL.`, then `exit code 3`. The second prints `The database localhost:5433/dataforge_mv_empty is
  not migrated (pending: 20261122232906_init).` and `Apply the migrations with "pnpm db:migrate".`,
  then `exit code 3`.
- **How to read it:** the `[Nest] ... LOG` lines before the message are the start-up; the API exits
  before it listens. The CLI uses the same exit code, 3, when Kafka is unavailable.
- **Failure:** `/health` answering `200` while PostgreSQL is stopped, an API that starts anyway, or an
  exit code other than 3.

## MV-6.16 — The engine stays free of NestJS and Prisma

- **Verifies:** the ESLint guard keeps the API's frameworks out of the simulation core.
- **Preconditions:** MV-6.1.

```powershell
Set-Content packages\core\src\run\guard-probe.ts "import { Injectable } from '@nestjs/common';`nimport { PrismaClient } from '@prisma/client';`nexport const probe = [Injectable, PrismaClient];"
pnpm lint
$LASTEXITCODE
Remove-Item packages\core\src\run\guard-probe.ts
pnpm lint
$LASTEXITCODE
```

- **Expected:** the first `pnpm lint` reports `packages\core\src\run\guard-probe.ts` with
  `'@nestjs/common' import is restricted from being used by a pattern. The simulation core must stay
  framework- and infrastructure-independent` and the same for `'@prisma/client'`, and exits with `1`;
  after removing the probe, `pnpm lint` exits `0`.
- **Failure:** the first lint passes, or the probe file is left behind.

To stop everything afterwards: Ctrl+C in the second window (if the API runs), then
`docker compose down` (keeps the database) or `docker compose down -v` (deletes it).

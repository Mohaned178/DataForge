# Manual Verification — Milestone 8: Web UI, Run History and Report Explorer

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. Each case builds on the earlier ones, so run them in order, in the same window (the
**first window**). MV-8.3 starts the API in a **second window** and the web UI in a **third window**.
Every case from MV-8.2 on needs Docker Desktop. Cases that say "Open" need a web browser.

What is new in this milestone:

- **A web UI** (`apps/web`, React + Vite) over the HTTP API. It is **read-only**: it shows what the API
  stores, it does not create anything. You create data with the API (as in Milestone 7) and look at it
  in the browser. The API did not change.
- **Run history and run detail:** the simulated worlds, their expected state, their files, their stored
  canonical events.
- **Execution history and the report explorer:** the verdict, what the faulty delivery did, the
  findings per category, the root causes, every finding with its differences and causes.
- **The drill-down, the heart of the milestone.** From a finding you open one aggregate (an order, a
  customer, a product) and see its **canonical timeline** (what happened in the simulated world)
  **next to its delivery timeline** (what reached the target, and how): an event that arrived
  before its predecessor, a duplicate, a delay, a lost event, the Kafka partition and offset.
- **How the browser reaches the API:** the web server forwards everything under `/api` to the API
  (`/api/executions` is the API's `/executions`). The API needs no CORS and stays reachable from this
  machine only.
- Reading the screen: every status and verdict is shown as a word as well as a colour; the pages
  follow the system's light or dark setting; every filter, page and open finding is in the address,
  so any view can be copied as a link.
- HTTP status codes: **200** OK, **400** invalid request, **404** not found, **500** integrity error,
  **502** the web server could not reach the API.

Self-check: `scripts/verification/milestone-8.ps1` runs these same cases with the same expected
values and prints PASS/FAIL per case. It uses its own database (`dataforge_selfcheck`), ports (API
3108, web 5208), work directory and Kafka topics, so it does not touch the data of the steps below;
it writes to `out\self-check`. A script cannot click, so for each page it opens the page in a real
browser engine (headless Microsoft Edge or Google Chrome), waits for the page to load its data and
checks the text the page shows. What it cannot judge is how the page looks: that is what the "Look
for" lines of the cases below are for.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-8.ps1
```

---

## MV-8.1 — Install, build and run the automated checks

- **Verifies:** the workspace, with the new web app, installs, type-checks, lints and passes every
  automated test, without Docker.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `pnpm -r typecheck` lists ten projects, each `Done`, now including `apps/web`; nothing
  after `$ eslint .`; the Jest run ends `Test Suites: 38 passed, 38 total` and
  `Tests: 451 passed, 451 total`, and the web tests follow it: `Test Files  7 passed (7)` and
  `Tests  108 passed (108)`. The build ends with `apps/web build: ... built in ...` and
  `apps/api build: Done`; `apps\web\dist\index.html` exists.
- **How to read it:** `pnpm test` now runs the engine's tests (Jest) and the web app's (Vitest). The Jest
  numbers are the same as in Milestone 7: the UI changed no engine code.
- **Failure:** a TypeScript or lint error, a failing test, or a build error.

## MV-8.2 — Services, the migration and the integration suite

- **Verifies:** the services start and the integration suite passes, including the new **contract
  test**: the real API answers a run and five executions, and every response must parse with the web
  app's schemas. It also proves that the UI's count of out-of-order events, summed over every
  aggregate, equals the delivery summary's.
- **Preconditions:** Docker Desktop running; MV-8.1.

```powershell
docker compose down -v
docker compose up -d --wait
pnpm db:migrate
pnpm test:integration
```

- **Expected:** `pnpm db:migrate` ends `All migrations have been successfully applied.` The suite ends
  with `Test Suites: 10 passed, 10 total` and `Tests: 112 passed, 112 total` (about two to three
  minutes); the new file is `apps/api/integration/web-contract.test.ts`.
- **How to read it:** `down -v` deletes the database volume and the Kafka topics, so the cases below
  start empty and the numbers they show are exact. The suite uses its own database (`dataforge_test`).
- **Failure:** a migration error, or a failing integration test. A failure in `web-contract.test.ts`
  means the API and the web app's schemas no longer agree.

## MV-8.3 — Start the API and the UI; deep links and the proxy

- **Verifies:** the UI is served, a reload of any address shows the app (not API JSON), `/api` reaches
  the API, and an empty system says how to fill it.
- **Preconditions:** MV-8.2 (the build of MV-8.1 must exist: `apps\web\dist`).

Open a **second PowerShell window** and start the API there; leave it running:

```powershell
Set-Location F:\DataForge
pnpm api
```

Open a **third PowerShell window** and start the UI there; leave it running:

```powershell
Set-Location F:\DataForge
pnpm web
```

Then, in the **first window** (the variables are used by every case below):

```powershell
$api = 'http://127.0.0.1:3000'
$web = 'http://127.0.0.1:5173'
$ProgressPreference = 'SilentlyContinue'
curl.exe -s "$web/api/health"
''
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$web/executions/anything"
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$web/runs"
curl.exe -s "$web/api/runs"
''
Start-Process "$web/executions"
```

- **Expected:** the third window prints `Local:   http://127.0.0.1:5173/`. The first window prints the
  health answer `{"status":"ok","database":"up","engineVersion":"0.1.0"}`, then `200 text/html` twice (the
  app, for addresses the API would not know) and `{"runs":[],"total":0,"limit":50,"offset":0}`. The browser
  opens on **Executions**.
- **Look for:** the heading **Executions**, the sentence "No executions yet. Start one through the API:
  `POST /executions` ...". Click **Runs** in the top bar: "No runs yet ... `POST /runs` ...".
- **How to read it:** `/api/health` is the API's own `/health`, reached through the web server. A
  `text/html` answer for `/executions/anything` shows the web server returns the app for every address,
  so reloading a deep link works. The API's own path `/executions/<id>` is *not* what the browser asks for.
- **Failure:** the web server does not start (is `apps\web\dist` there? is port 5173 free?); `/api/health`
  fails; a deep link answers anything but `200 text/html`.

## MV-8.4 — Create the data: a run, four profiles and five executions

- **Verifies:** the data the next cases look at: a run and five test executions through the API, with
  the numbers of Milestones 6 and 7.
- **Preconditions:** MV-8.3.

```powershell
function Wait-Execution($id) {
    do { Start-Sleep -Milliseconds 300; $e = Invoke-RestMethod "$api/executions/$id" } while ($e.status -eq 'queued' -or $e.status -eq 'running')
    $e
}
function Start-Execution($profile, $target) {
    $body = @{ runId = $run.id; chaosProfileId = $profiles[$profile]; chaosProfileVersion = 1; chaosSeed = 7; target = $target } | ConvertTo-Json -Depth 5
    Wait-Execution (Invoke-RestMethod -Method Post -Uri "$api/executions" -ContentType 'application/json' -Body $body).id
}
$small = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
$run = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $small.id; seed = 42 } | ConvertTo-Json)
Start-Sleep -Seconds 2
$run = Invoke-RestMethod "$api/runs/$($run.id)"
$profiles = @{}
foreach ($name in 'none', 'spec-example', 'late-data', 'lossy') {
    $profiles[$name] = (Invoke-RestMethod -Method Post -Uri "$api/chaos-profiles" -ContentType 'application/json' -InFile "chaos-profiles\$name.json").id
}
$pass  = Start-Execution 'none' @{ type = 'reference'; name = 'correct' }
$naive = Start-Execution 'spec-example' @{ type = 'reference'; name = 'naive' }
$late  = Start-Execution 'late-data' @{ type = 'reference'; name = 'correct' }
$lossy = Start-Execution 'lossy' @{ type = 'reference'; name = 'correct' }
$kafka = Start-Execution 'spec-example' @{ type = 'reference'; name = 'naive'; transport = 'kafka' }
$run | Format-List status, eventCount
$pass, $naive, $late, $lossy, $kafka | Format-Table @{n='profile';e={$_.chaosProfile.name}}, @{n='target';e={"$($_.target.name) $($_.target.transport)"}}, status, verdict, attemptCount, findingCount, windowFindingCount
```

- **Expected:** `status succeeded`, `eventCount 472`; then five rows:

  | profile | target | status | verdict | attemptCount | findingCount | windowFindingCount |
  | --- | --- | --- | --- | --- | --- | --- |
  | none | correct memory | completed | PASS | 472 | 0 | |
  | spec-example | naive memory | completed | FAIL | 486 | 48 | |
  | late-data | correct memory | completed | FAIL | 472 | 0 | 7 |
  | lossy | correct memory | completed | FAIL | 575 | 81 | |
  | spec-example | naive kafka | completed | FAIL | 486 | 48 | |

- **How to read it:** one world (scenario `ecommerce-small`, seed 42), five tests of it. `correct` is the
  reference pipeline written to handle faults properly, `naive` assumes perfect delivery. The lossy
  profile allows events to be lost, and no pipeline can rebuild an event it never received, so even the
  correct target fails (D-3.1); late data fails the windows for the same reason (D-5.1).
- **Failure:** a number differs, or an execution is `failed` (the Kafka one needs Kafka: `docker compose ps`).

## MV-8.5 — Run history and run detail

- **Verifies:** the run history lists what the API holds; the run page shows the run's inputs, expected
  state, files, executions and stored events.
- **Preconditions:** MV-8.4.

```powershell
Start-Process "$web/runs"
Start-Process "$web/runs/$($run.id)"
Start-Process "$web/runs/$($run.id)?aggregateId=ord_000018"
```

- **Look for:**
  - `/runs`: one row: `ecommerce-small v1`, seed `42`, **succeeded**, `472` events. The run ID is shown as its
    last eight characters, with the whole ID as a tooltip. The **Status** filter, set to `failed`, shows
    "No runs match these filters" and changes the address.
  - The run page: **What was generated** (scenario `ecommerce-small v1`, seed, engine `0.1.0`, `472`
    events), **Expected final state** (Revenue `25,256.64 USD`), **Events by type** (for example
    `PaymentCompleted` `108`), **Files** (`events.jsonl`, `expected-state.json`, `scenario.resolved.json`
    with checksums, and `manifest.json`), **Executions of this run** (five rows) and **Stored canonical
    events** (25 per page, starting with `evt_prd_000001_1`).
  - Third page: only the events of the order `ord_000018` (`evt_ord_000018_1` to `evt_ord_000018_5`); clicking
    an aggregate ID in the events table does the same.
- **Failure:** a number differs, a filter does not change the list, or the page is blank.

## MV-8.6 — Execution history and its filters

- **Verifies:** the history of tests, newest first, with filters kept in the address.
- **Preconditions:** MV-8.4.

```powershell
Start-Process "$web/executions"
Start-Process "$web/executions?verdict=PASS"
Start-Process "$web/executions?runId=$($run.id)&status=completed"
```

- **Look for:**
  - `/executions`: five rows, newest first. Each shows its target (`naive · kafka`), **status** and
    **verdict** as words, attempts, and findings (`0 + 7 windows` for the late-data execution: no entity
    findings, seven window findings).
  - `?verdict=PASS`: only the `none` profile execution. The **Verdict** control shows `PASS`.
  - The third address: a chip "Run ..." with a **x** that removes the run filter.
  - Click an execution's ID: its report (MV-8.7, MV-8.8).
- **Failure:** a filter is ignored, or a count differs.

## MV-8.7 — A passing execution

- **Verifies:** a correct target under no faults ends in the expected state, and the page says so.
- **Preconditions:** MV-8.4.

```powershell
Start-Process "$web/executions/$($pass.id)"
```

- **Look for:** **Status** `completed`, **Verdict** `PASS`; **Delivery** with `472` attempts; the report says "The
  target ended in the expected state."; **Findings** says "No findings: the target ended in the expected
  state."; there is no **Root causes** and no **Window findings** section; **Files** lists the download links
  (`delivery-plan.jsonl`, `validation-report.json`, ...).
- **Failure:** a verdict or number differs.

## MV-8.8 — A failing execution: report, findings and root causes

- **Verifies:** the report of the naive target under the specification's example faults (5% delay, 3%
  duplicates, 2% reordering): what the delivery did, what is wrong, and why.
- **Preconditions:** MV-8.4.

```powershell
Start-Process "$web/executions/$($naive.id)"
Start-Process "$web/executions/$($naive.id)?open=12"
Start-Process "$web/executions/$($naive.id)?category=status-mismatch"
Start-Process "$web/executions/$($naive.id)?offset=25"
```

- **Look for:**
  - The first page: **Verdict** `FAIL`. **Delivery**: `486` attempts, `14` duplicates, `10` events out of order in
    `9` aggregates; the faults table shows each fault's configured and observed rate (`duplicate` `3.0%`
    `3.0%`, `14` faulted, `14 extra deliveries`). **What the reference target received:** `486` messages, `14`
    redeliveries, `updatesLost 6`. **Validation report:** "48 findings: 48 explained by a delivery fault, 0 not
    explained by delivery."; findings by category `field-mismatch 14`, `status-mismatch 8`, `double-processing 8`,
    `invariant-violation 18`; **Root causes**, the first being `evt_ord_000045_1 OrderCreated: reorder; overtaken
    by evt_ord_000045_2` with `7` findings, each with a link to its order's timeline. **Findings:** the first 25
    of 48.
  - `?open=12`: finding 13 is open: `amountPaidMinor is 7000, expected 3500 (2x); paymentAttempts is 3,
    expected 2`: **a customer charged twice**. Its table of expected against actual, its cause
    (`evt_ord_000018_3 PaymentCompleted: duplicate; delivered 2 times`) and links to **Timelines**. The
    triangle button next to the number opens and closes a finding; the address gains and loses `open=12`.
  - `?category=status-mismatch`: 8 findings, the first `status is SHIPPED, expected DELIVERED`; the
    **Category** control shows it. Choosing another category, or **All**, returns to the first page.
  - `?offset=25`: "Showing 26-48 of 48" and the Previous link.
- **How to read it:** a **finding** is one way the actual state is wrong; its **causes** are the abnormal
  deliveries of the events behind it, most likely first. "Not explained by delivery" would mean no fault
  touched the entity, which would point at the target, not at the delivery.
- **Failure:** a number differs; opening a finding changes the page of the list; a filter is ignored.

## MV-8.9 — Drill-down: a reordered order (wrong status) and a double charge

- **Verifies:** the timelines of one aggregate, the canonical one next to the delivery one, and how
  a reorder and a duplicate look.
- **Preconditions:** MV-8.4.

```powershell
Start-Process "$web/executions/$($naive.id)/aggregates/ord_000045?finding=18"
Start-Process "$web/executions/$($naive.id)/aggregates/ord_000018?finding=12&event=evt_ord_000018_3"
Start-Process "$web/executions/$($naive.id)/aggregates/cus_000009?finding=1"
```

- **Look for:**
  - **Order `ord_000045`** (opened from finding 19, `status is SHIPPED, expected DELIVERED`). Summary: `4` events,
    `4` delivery attempts, `2` out of order. **Event lanes**: events `v1` to `v4` on the top lane in the order they
    happened, deliveries `#153`, `#154`, `#479`, `#480` below, in the order they reached the target. Lines join
    each event to its delivery; **the lines cross twice**: `v1` and `v2` arrived swapped, and so did `v3` and
    `v4`. **Canonical timeline** (left): four rows in version order, `v1` and `v3` marked **out of order** and
    **reordered**, "overtaken by `evt_ord_000045_2`" and "... `evt_ord_000045_4`". **Delivery timeline**
    (right): four rows in delivery order, with "Reordered behind `evt_ord_000045_2`, the next event of its
    aggregate, ... later". This is why the naive target ended with `SHIPPED`: it applied "shipment created"
    after "delivered" and never saw the delivery in order.
  - **Order `ord_000018`**, the double charge (finding 13): `5` events, `6` attempts, `0` out of order. The
    payment `v3` is marked **duplicated**: two delivery rows, the second `duplicate` with "Extra copy 1 of 1" and
    "Redelivered 26.4 s after att_ord_000018_3_1". `v4` is marked **delayed**. The line diagram shows a second,
    dashed line for the duplicate, and the payment's event is highlighted because the address names it.
  - **Customer `cus_000009`** (finding 2, `orderCount is 23, expected 22`): the finding's causes list the
    duplicated `evt_ord_000078_1 OrderCreated`, and **Timelines** links to every aggregate involved.
  - On any timeline: **click an event** (its name in a table, or its circle in the diagram; Enter or Space
    on a circle works too): the same event is highlighted in both tables and in the diagram, and the
    address gains `event=...`; click it again to release it. Hovering a row highlights it without
    changing the address.
- **How to read it:** the top lane never changes, whatever the chaos profile does; that is the canonical
  history. Only the bottom lane moves. Crossing lines are the whole bug: the target saw the events in a
  different order from the one in which they happened.
- **Failure:** the lanes or tables are missing or disagree (the number of lines must equal the number of
  delivery rows), a marker is wrong, or selecting an event does nothing.

## MV-8.10 — Window findings and late data

- **Verifies:** event-time windows: a correct pipeline drops an event that arrives after its window closed,
  and the report explains the wrong window by that late event.
- **Preconditions:** MV-8.4.

```powershell
Start-Process "$web/executions/$($late.id)"
Start-Process "$web/executions/$($late.id)?wopen=0"
Start-Process "$web/executions/$($late.id)/events/evt_ord_000012_2?windowFinding=0"
```

- **Look for:**
  - The first page: **Delivery** has a **Windows** part ("Tumbling event-time windows of 1 h with 10 min of
    allowed lateness"; `219` on time, `9` after its window closed); **Findings** says "No findings"; **Window
    findings** shows `7` of category `window-undercount`, the first
    `paymentsCompleted is 3, expected 4; revenueMinor is 61320, expected 83806`.
  - `?wopen=0`: the first window finding is open: its cause is `evt_ord_000012_2`, arrived `after-close`, with a
    link **timeline**.
  - The third address is an *event* address: the page finds the aggregate of the event and opens the
    timeline of `ord_000012` with the finding on top: `4` events, `1` out of order; `v2` is marked **late**, and
    its delivery says "Late: held until after its window closed, behind `evt_ord_000013_3`, 1 h 24 min later".
- **Failure:** the window counts differ, or the event link does not end on the order's timeline.

## MV-8.11 — An execution through Kafka: partition and offset

- **Verifies:** the same test through a real Kafka broker shows where each record went.
- **Preconditions:** MV-8.4 (the Kafka execution).

```powershell
Start-Process "$web/executions/$($kafka.id)"
Start-Process "$web/executions/$($kafka.id)/aggregates/ord_000088"
Start-Process "$web/executions/$($naive.id)/aggregates/ord_000088"
```

- **Look for:**
  - The first page: a **Kafka** part (topic `dataforge.<execution id>`, consumer group, `1` partition, `486`
    records sent, `0` planned failures) and, under **Files**, `delivery-log.jsonl` and `kafka-run.json` besides
    the files of an in-memory execution. The findings are the same `48` as in memory.
  - The second page: the delivery timeline has a **Kafka** column: `partition 0, offset 27` for `v1`, `offset
    56` for `v3`, `offset 57` for `v2` (the reordered payment), `offset 159` for `v4`. The offset is one less
    than the delivery position (`#58` is offset `57`): one partition keeps the plan's order exactly.
  - The third page, the same order in memory: no **Kafka** column.
- **Failure:** the offsets differ, or the Kafka column shows for the in-memory execution.

## MV-8.12 — A lost event

- **Verifies:** an event whose every delivery attempt failed shows as lost, with its failed attempts.
- **Preconditions:** MV-8.4 (the lossy execution).

```powershell
Start-Process "$web/executions/$($lossy.id)"
Start-Process "$web/executions/$($lossy.id)/aggregates/ord_000041"
```

- **Look for:**
  - The first page: `81 findings: 81 explained ...`; `missing-entity 40`; the first root cause
    `evt_ord_000015_2 PaymentFailed: lost; ...`.
  - `ord_000041`: `4` events and `6` attempts; `1` lost, `1` retried. The payment `v3` is marked **lost** and
    **retried**: three delivery rows, each `failed, never sent`, the last "Delivery failure 3 of 4"; in the
    diagram its circle is red and has **no line to the delivery lane**, because nothing of it was delivered:
    the bottom lane shows only what reached the target (three deliveries for the other three events), and
    the failed attempts are in the table.
- **How to read it:** a failed attempt never reaches the target, so it is not on the delivery lane. This
  event had four planned failures and the profile allows two retries (`maxRetries` 2): the original and two retries
  were attempted, all three failed, and DataForge gave up, so the event is lost. With `allowLoss` false such a
  profile is refused.
- **Failure:** the lost event shows as delivered, or a number differs.

## MV-8.13 — Failure states: unknown id, malformed id, tampered data, API stopped

- **Verifies:** each way a page can fail is reported differently, and says what to do.
- **Preconditions:** MV-8.4.

```powershell
Start-Process "$web/executions/01a2059d-1421-7651-8848-976194c3e863"
Start-Process "$web/executions/not-an-id"
Start-Process "$web/executions/$($naive.id)/aggregates/ord_999999"
$victim = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $small.id; seed = 'tamper' } | ConvertTo-Json)
Start-Sleep -Seconds 2
$tamper = @"
BEGIN;
ALTER TABLE canonical_event DISABLE TRIGGER canonical_event_immutable;
UPDATE canonical_event SET payload = payload - 'amountMinor'
  WHERE run_id = '$($victim.id)' AND sequence = (SELECT min(sequence) FROM canonical_event WHERE run_id = '$($victim.id)' AND type = 'PaymentCompleted');
ALTER TABLE canonical_event ENABLE TRIGGER canonical_event_immutable;
COMMIT;
"@
$tamper | docker compose exec -T postgres psql -U dataforge -d dataforge -v ON_ERROR_STOP=1
curl.exe -s "$api/runs/$($victim.id)/events?type=PaymentCompleted"
''
Start-Process "$web/runs/$($victim.id)?type=PaymentCompleted"
Start-Process "$web/runs/$($victim.id)?type=OrderCreated"
```

- **Expected:** the SQL prints `BEGIN`, `ALTER TABLE`, `UPDATE 1`, `ALTER TABLE`, `COMMIT`. The `curl.exe` line prints
  `{"statusCode":500,"error":"Run Integrity Error","message":"Stored event ... is not a valid canonical event:
  payload.amountMinor: Invalid input: expected number, received undefined"}`.
- **Look for:**
  - Unknown ID (a valid-looking ID nothing has): **Not found**. Malformed ID: **The API rejected this request** ("must
    be a execution id (a UUID)"). An aggregate the run does not have: "This run has no stored events for
    `ord_999999`", and no empty tables.
  - The tampered run with `type=PaymentCompleted`: a red panel **Integrity error: stored data no longer matches
    its checksum**, with the API's message and "Restore the database ...". It is *not* the ordinary "The API
    failed". With `type=OrderCreated` the same page lists its events normally: only the damaged events are
    refused.

Now stop the API: in the **second window** press Ctrl+C. Then, in the first window:

```powershell
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$web/api/health"
Start-Process "$web/executions"
```

- **Expected:** `502 text/plain`; the browser shows a red panel **The API is not reachable**, with `pnpm api` and
  a **Try again** button.

Start the API again in the second window (`pnpm api`), then click **Try again**: the list appears.

- **How to read it:** the web server answers 502 with no body when it cannot reach the API, and the UI tells
  that apart from the API's own JSON errors. A downloaded file (the links under **Files**) is rebuilt and
  checked against its checksum; the pages check that every stored row is still a valid event or attempt.
- **Failure:** a state shows the wrong panel, a blank page, or an endless "Loading".

## MV-8.14 — The web app stays in the browser

- **Verifies:** lint refuses engine, Node and server-framework imports in the web app, so it can only learn
  what the API tells it.
- **Preconditions:** MV-8.1.

```powershell
Set-Content apps\web\src\guard-probe.ts "import { sha256Hex } from '@dataforge/core';`nimport { readFileSync } from 'node:fs';`nimport { Kafka } from 'kafkajs';`nexport const probe = [sha256Hex, readFileSync, Kafka];"
pnpm lint
Remove-Item apps\web\src\guard-probe.ts
pnpm lint
```

- **Expected:** the first `pnpm lint` fails, listing `'@dataforge/core' import is restricted from being used by a
  pattern. The web UI reads the HTTP API only...`, the same for `'node:fs'` and `'kafkajs'`; after the
  probe is removed `pnpm lint` passes.
- **Failure:** the probe is accepted, or lint fails without it.

## MV-8.15 — A running execution: its view, and a timeline that is not available yet

- **Verifies:** an execution that has not finished says so, and its timelines are refused until it has delivered;
  Reload shows the result.
- **Preconditions:** MV-8.4 (the variables and `Wait-Execution`).

```powershell
$body = @{ runId = $run.id; chaosProfileId = $profiles['spec-example']; chaosProfileVersion = 1; chaosSeed = 7; target = @{ type = 'reference'; name = 'correct'; transport = 'kafka'; speed = 5000 } } | ConvertTo-Json -Depth 5
$slow = Invoke-RestMethod -Method Post -Uri "$api/executions" -ContentType 'application/json' -Body $body
Start-Sleep -Seconds 3
Start-Process "$web/executions/$($slow.id)"
Start-Process "$web/executions/$($slow.id)/aggregates/ord_000088"
curl.exe -s -w " [%{http_code}]`n" "$api/executions/$($slow.id)/attempts?aggregateId=ord_000088"
$slow = Wait-Execution $slow.id
$slow | Format-List status, verdict, @{n='ms';e={$_.kafka.durationMs}}
```

- **Expected:** the `curl.exe` line prints a `409` (`[409]`) with a message that the execution has not delivered yet.
  After about 35 seconds `Wait-Execution` returns: `status completed`, `verdict PASS`, `ms` above 30000 (the delivery
  was paced at 5000 simulated milliseconds per real millisecond).
- **Look for:** the first page (opened while it runs) has **Status** `running`, no verdict, and the notice "This execution is
  running. DataForge runs one execution at a time in the background. Use Reload to see its progress."; there is no
  validation report. The second page says **Not available yet**. Click **Reload** on the first page once the PowerShell
  command has returned (or open it again): **Verdict** `PASS`, "The target ended in the expected state.", and the
  timeline of `ord_000088` now opens, with Kafka offsets (`partition 0, offset 27`...).
- **How to read it:** a running execution has no results yet, so a page cannot show them; **Not available yet** is the
  API refusing (409), not a fault. The UI does not refresh by itself (live monitoring is Milestone 9).
- **Failure:** the execution is not shown as running while it runs, its timeline opens early, or Reload does not
  show the verdict.
---

## Known limitations

- The views of an execution waiting for an external pipeline (`awaiting_actual_state`) and of one that failed are
  covered by automated tests only; the guide shows `running` and the "not available yet" refusal (MV-8.15).
- The UI is read-only and does not refresh by itself: use **Reload** or **Try again** (live monitoring,
  launching executions and editing profiles are Milestone 9).
- Pages show what is stored after checking that each row is still a valid event or attempt; only the file
  downloads compare with the recorded checksums (a changed value that is still valid shows on a page, and
  is caught by the download).
- No charts and no dependency graph: tables and one diagram cover this milestone (spec: "when needed").
- The API does not serve the built UI: `pnpm web` does (`vite preview`), which is for use on this
  machine, not a production server (Milestone 10).

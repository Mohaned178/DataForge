# Manual Verification — Milestone 9: Web UI, Configure and Launch

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. Each case builds on the earlier ones, so run them in order, in the same window (the
**first window**). MV-9.4 starts the API in a **second window** and the web UI in a **third window**.
Every case from MV-9.2 on needs Docker Desktop. Cases that say "Open" or "Click" need a web browser;
this guide is where you do the clicking that a script cannot.

What is new in this milestone:

- **The UI writes.** Milestone 8 only showed what the API stored. Now you can do the whole test from the
  browser: write a scenario and a chaos profile, generate a run, start a test execution, watch it, and read
  the report.
- **Editors, not builders.** A scenario or chaos profile is a JSON text, the same file the command line takes.
  You can start from one of the repository's examples (they are the files in `scenarios\` and
  `chaos-profiles\`) or from a blank document. The browser checks that the text is JSON (and says at which line
  and column it is not); then the **API** checks everything else with the very schema that saving uses, and
  lists each problem with its path. Save is possible only for text the API has just accepted. Nothing is
  saved by checking: two new API endpoints, `POST /scenarios/validate` and `POST /chaos-profiles/validate`,
  answer what saving would, and store nothing.
- **Immutable versions.** A saved scenario or profile is never edited. A changed document is a new version; a
  document identical to one that exists is that version ("nothing new was stored").
- **Launch forms.** `New run` (scenario, version, seed) and `New execution` (run, chaos profile and version, chaos
  seed, and the target: the `correct` or `naive` reference target in memory or through Kafka, or **your own
  pipeline**). The seed is sent exactly as you type it. A double click starts one run, not two.
- **Live pages.** A run or execution that is `queued` or `running` updates by itself, one second after each
  answer, and stops when it ends. If the API cannot be reached the page keeps what it showed, says so, and
  recovers by itself. There is no Reload button any more.
- **An end-to-end test suite** (`apps/e2e`, Playwright): a real browser does what you do in MV-9.6 to MV-9.12,
  against its own API, web server and database, and checks the numbers earlier milestones pinned.
- HTTP status codes: **200** OK (or an identical version), **201** created, **202** accepted (a run or execution
  was queued), **400** invalid request, **409** not possible in the current state.

Self-check: `scripts/verification/milestone-9.ps1` runs these same cases with the same expected values and
prints PASS/FAIL per case. It uses its own database (`dataforge_selfcheck`), ports (API 3109, web 5209), work
directory and Kafka topics, so it does not touch the data of the steps below; it writes to `out\self-check`. A
script cannot click, so it runs the Playwright suite (MV-9.3) as its clicking, makes the API calls the browser
makes, and opens each page in a real browser engine (headless Microsoft Edge or Google Chrome) to check the text
it shows. What it cannot judge is how a page looks: that is what the "Look for" lines are for.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-9.ps1
```

---

## MV-9.1 — Install, build and run the automated checks

- **Verifies:** the workspace, with the new end-to-end package, installs, type-checks, lints and passes every
  automated test, without Docker and without a browser.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `pnpm -r typecheck` lists eleven projects, each `Done`, now including `apps/e2e`; nothing after
  `$ eslint .`; the Jest run ends `Test Suites: 38 passed, 38 total` and `Tests: 451 passed, 451 total` (the engine did
  not change), and the web tests follow it: `Test Files  12 passed (12)` and `Tests  181 passed (181)` (it was 7 and
  108). The build ends with `apps/web build: ... built in ...` and `apps/api build: Done`.
- **How to read it:** the 73 new web tests cover the editors, the launch forms, the live pages and the external
  submission, with the API stubbed at `fetch`.
- **Failure:** a TypeScript or lint error, a failing test, or a build error.

## MV-9.2 — Services, the migration and the integration suite

- **Verifies:** the services start and the integration suite passes, including the two dry-run endpoints and the
  extended **contract test** (the real API answers what the editors and forms send, and the UI's schemas parse it).
- **Preconditions:** Docker Desktop running; MV-9.1.

```powershell
docker compose down -v
docker compose up -d --wait
pnpm db:migrate
pnpm test:integration
```

- **Expected:** `pnpm db:migrate` ends `All migrations have been successfully applied.` The suite ends with
  `Test Suites: 11 passed, 11 total` and `Tests: 132 passed, 132 total` (about two to three minutes). The new file is
  `apps/api/integration/validation.test.ts`; `web-contract.test.ts` has seven new tests.
- **How to read it:** `down -v` deletes the database volume (the run history) and the Kafka topics, so the cases below
  start empty and the numbers they show are exact. The suite uses its own database (`dataforge_test`).
- **Failure:** a migration error or a failing integration test. A failure in `validation.test.ts` means a dry run
  and the create endpoint no longer answer identically; one in `web-contract.test.ts` means the API and the UI's
  schemas disagree.

## MV-9.3 — The end-to-end suite: a real browser, the full flow

- **Verifies:** the whole product works from the browser, driven by Playwright: invalid and valid documents in the
  editors, registering a scenario and profiles from the examples, a run launched from the form whose checksums are
  the command line's, a failing and a passing execution, a root cause that opens an order's timelines, a new version,
  a refused launch, an execution through Kafka that is followed live, and a live page that survives the API being
  unreachable.
- **Preconditions:** MV-9.2 (Docker, built applications). The first time, a browser is downloaded (123.8 MiB, 288 MB on disk).

```powershell
pnpm --filter @dataforge/e2e install-browser
pnpm test:e2e
```

- **Expected:** the first time, `install-browser` prints `Downloading Chrome Headless Shell 159.0.8154.6 (playwright
  chromium-headless-shell v1255) from https://cdn.playwright.dev/...`, a progress bar `of 123.8 MiB`, and `... downloaded to
  C:\Users\<you>\AppData\Local\ms-playwright\chromium_headless_shell-1255`; after that it prints only the command line
  (`$ node support/install-browser.js`). `pnpm test:e2e` builds, starts its own API (port 3209) and web server (port 5309) on a scratch database
  (`dataforge_e2e_test`), and prints eleven lines starting with a check mark, then `11 passed` (about one minute). The
  tests are, in order: an empty installation points at the first thing to create; an invalid scenario shows every
  problem with its path and cannot be saved; registers the small scenario and the chaos profiles from the repository
  examples; launches a run from the form and follows it to success; the naive target under spec-example fails with
  every finding explained; the correct target under the fault-free profile passes; a changed document becomes the next
  version of a scenario; a run that has not succeeded is refused by the API; an execution through Kafka is followed
  live; a live page keeps its data while the API cannot be reached; a double click on Start run starts one run, not two.
- **How to read it:** the command installs through `support\install-browser.js`, which switches off Playwright's clean-up of
  "unused" browsers (`PLAYWRIGHT_SKIP_BROWSER_GC`): Playwright's own `install` deletes cached browsers that no Playwright
  installation it knows of uses, and the first download on this machine did exactly that to two revisions (see the roadmap).
  The suite starts and stops its own servers and database, so it does not matter whether your own
  API is running (it uses ports 3209 and 5309, not 3000 and 5173), and it never touches your `dataforge` database.
  Its numbers are the ones earlier milestones pinned: the small scenario with seed 42 has 472 events and the
  command line's checksums; the naive target under `spec-example` with chaos seed 7 has 486 attempts and 48
  findings.
- **Failure:** any line with a cross instead of a check mark. The browser's trace of a failed test is under
  `out\e2e\test-results`.

## MV-9.4 — Start the API and the UI; the new pages, empty and linked

- **Verifies:** the new routes are served (a reload of any address shows the app), and an empty system says what to
  create first and links to it.
- **Preconditions:** MV-9.2 (the build of MV-9.1 must exist: `apps\web\dist`).

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
foreach ($path in '/scenarios', '/scenarios/new', '/chaos-profiles', '/chaos-profiles/new', '/runs/new', '/executions/new') {
    $page = Invoke-WebRequest -UseBasicParsing "$web$path"
    '{0,-22} {1} {2}' -f $path, $page.StatusCode, $page.Headers['Content-Type']
}
Start-Process "$web/executions"
Start-Process "$web/scenarios"
Start-Process "$web/runs/new"
```

- **Expected:** six lines, each `200 text/html`. The API window prints `DataForge API listening on
  http://127.0.0.1:3000`.
- **Look for:** the header now has four links: **Executions**, **Runs**, **Scenarios**, **Chaos profiles**. The
  executions page has a **New execution** button and "No executions yet ... `POST /executions` ... or start one
  here". `/scenarios` says "No scenarios yet" with a "Create the first one" link. `/runs/new` says "A run needs a
  scenario" with a link to create one.
- **Failure:** a deep link answers with anything but the app, the API window shows an error, or a page shows
  "The API is not reachable" (the API or PostgreSQL is not running).

## MV-9.5 — The dry-run endpoints: valid, invalid, and nothing stored

- **Verifies:** `POST /scenarios/validate` and `POST /chaos-profiles/validate` check a document exactly as saving
  would, give an invalid document the identical `400`, and store nothing.
- **Preconditions:** MV-9.4.

```powershell
$answer = Invoke-RestMethod -Method Post -Uri "$api/scenarios/validate" -ContentType 'application/json' -InFile scenarios\ecommerce-small.json
$answer | Format-List valid, name, scenarioHash
$answer.definition.orders.count
Invoke-RestMethod "$api/scenarios" | ConvertTo-Json -Compress

Set-Content out\bad-scenario.json -Encoding Ascii -Value '{"formatVersion":1,"name":"bad","customers":{"count":"many"},"colour":"blue"}'
'dry run:'; curl.exe -s -w " [%{http_code}]`n" -X POST -H "Content-Type: application/json" --data-binary "@out\bad-scenario.json" "$api/scenarios/validate"
'create: '; curl.exe -s -w " [%{http_code}]`n" -X POST -H "Content-Type: application/json" --data-binary "@out\bad-scenario.json" "$api/scenarios"

Set-Content out\loses.json -Encoding Ascii -Value '{"formatVersion":1,"name":"loses","faults":{"transientFailure":{"rate":0.1,"failures":{"min":1,"max":5},"maxRetries":2}}}'
curl.exe -s -w " [%{http_code}]`n" -X POST -H "Content-Type: application/json" --data-binary "@out\loses.json" "$api/chaos-profiles/validate"
Invoke-RestMethod "$api/chaos-profiles" | ConvertTo-Json -Compress
```

- **Expected:**
  - the first `Format-List` shows `valid : True`, `name : ecommerce-small` and a `scenarioHash` of the form
    `sha256:` plus 64 hexadecimal characters; `orders.count` is `120`; the list of scenarios is
    `{"scenarios":[]}` (the dry run stored nothing);
  - the dry run and the create endpoint print the **same line**, ending `[400]`:
    `{"message":["customers.count: Invalid input: expected number, received string","Unrecognized key: \"colour\""],"error":"Bad Request","statusCode":400}`;
  - the loss rule is refused with `faults.transientFailure.failures.max: cannot exceed maxRetries (2) unless allowLoss
    is true: an event that fails more often than it is retried is lost`, `[400]`; the list of chaos profiles is
    `{"chaosProfiles":[]}`.
- **How to read it:** each problem is `path: message`; an unknown key has no path. These are the lines the editor
  shows you in MV-9.6. The hash is what the stored version will get, so the editor can tell you in advance that a
  document equals an existing version (MV-9.10).
- **Failure:** the two `400` lines differ, anything is stored, or a valid document is refused.

## MV-9.6 — The scenario editor

- **Verifies:** the editor shows a syntax error with its place, lists the API's problems with their paths, enables
  Save only for a document the API has accepted, saves, and refuses a name that is taken.
- **Preconditions:** MV-9.5.

```powershell
Start-Process "$web/scenarios/new"
```

In the browser, in this order:

1. Click in the **Document (JSON)** box, select everything and type `{ "formatVersion": 1, "name": }`.
2. Replace the text with `{ "formatVersion": 1, "name": "bad", "customers": { "count": "many" }, "colour": "blue" }`.
3. In **Start from**, choose `ecommerce-small`. Wait a moment, then click **Save as a new scenario**.
4. Go to `/scenarios/new` again, choose `ecommerce-small` again, wait for **Valid**, and click **Save as a new scenario**.

Then, in PowerShell:

```powershell
$scenario = (Invoke-RestMethod "$api/scenarios").scenarios | Where-Object { $_.name -eq 'ecommerce-small' }
$stored = Invoke-RestMethod "$api/scenarios/$($scenario.id)"
$stored.versions | Format-Table version, scenarioHash
$stored.versions[0].scenarioHash -eq $answer.scenarioHash
```

- **Expected:**
  1. a yellow box **Not valid JSON.** with the browser's message and `(line 1, column 31)`; nothing is sent to the API,
     and **Save as a new scenario** is greyed out;
  2. a yellow box **2 problems in the scenario**, listing `customers.count` "Invalid input: expected number, received
     string" and "Unrecognized key: "colour""; Save is greyed out;
  3. the text becomes the file `scenarios\ecommerce-small.json`; after about half a second a green box **Valid** says
     "The API accepts this scenario: ecommerce-small, hash sha256:..."; under it a collapsed line **The resolved
     definition (every default filled in)** opens the text a stored version would hold; Save becomes active; clicking it opens `/scenarios/<id>?saved=1` with "Saved as
     version 1." and a versions table with one row, `v1`;
  4. a yellow box **The API cannot do this now** saying `A scenario named "ecommerce-small" already exists (id ...)`;
     you stay in the editor and nothing new is stored;
  - PowerShell: one version row, and the last line prints `True`: the hash the dry run gave in MV-9.5 is the hash of
    the stored version.
- **Look for:** changing the text after **Valid** makes Save grey again until the new text is checked ("Checking with
  the API..."). **Format** re-indents valid text.
- **Failure:** Save is active for text the API refused, a problem has no path, the saved hash differs from the dry
  run's, or the second save stores another scenario.

## MV-9.7 — The chaos profile editor

- **Verifies:** the same editor for chaos profiles, including the loss rule, and four profiles from the examples.
- **Preconditions:** MV-9.6.

```powershell
Start-Process "$web/chaos-profiles/new"
```

In the browser:

1. Replace the text with `{ "formatVersion": 1, "name": "loses", "faults": { "transientFailure": { "rate": 0.1, "failures": { "min": 1, "max": 5 }, "maxRetries": 2 } } }`.
2. For each of `none`, `spec-example`, `late-data` and `lossy`: go to `/chaos-profiles/new`, choose it in **Start from**,
   wait for **Valid**, click **Save as a new chaos profile**.

Then, in PowerShell:

```powershell
$profiles = @{}
(Invoke-RestMethod "$api/chaos-profiles").chaosProfiles | ForEach-Object { $profiles[$_.name] = $_.id }
$profiles.Keys | Sort-Object
```

- **Expected:** step 1 shows **1 problem in the chaos profile**: `faults.transientFailure.failures.max` "cannot exceed
  maxRetries (2) unless allowLoss is true: an event that fails more often than it is retried is lost"; Save is greyed
  out. Each saved profile opens its page with "Saved as version 1." PowerShell prints four names: `late-data`, `lossy`,
  `none`, `spec-example`.
- **How to read it:** `lossy` is valid because it says `allowLoss: true`: losing events is allowed only when the
  profile asks for it (ADR-0007). The `loses` document is the same profile without that line.
- **Failure:** the loss rule is not reported, or a profile that the dry run accepted is refused on save.

## MV-9.8 — Launch a run: the same bytes as the command line

- **Verifies:** a run launched from the form is followed to success by the page itself, and its three files are
  byte-identical to `dataforge generate` for the same scenario and seed (so the editor did not alter the scenario).
- **Preconditions:** MV-9.6.

```powershell
Start-Process "$web/scenarios/$($scenario.id)"
```

In the browser: click **New run**; the scenario is already chosen; in **Seed** type `42`; click **Start run**.

Then, in PowerShell:

```powershell
pnpm dataforge generate --scenario scenarios\ecommerce-small.json --seed 42 --out out\mv\cli-run
$run = (Invoke-RestMethod "$api/runs").runs[0]
$run | Format-List status, seed, eventCount
'events.jsonl', 'expected-state.json', 'scenario.resolved.json' | ForEach-Object {
    [pscustomobject]@{ File = $_; Same = ((Get-FileHash "out\mv\cli-run\$_" -Algorithm SHA256).Hash.ToLower() -eq $run.files.$_.sha256) }
} | Format-Table
```

- **Expected:** the browser opens `/runs/<id>`; the notice "This run has not finished (queued)" may flash and the page
  becomes **Status** `succeeded` by itself (nothing to click or reload), with **Events** `472`, the **Expected final
  state** and a Files table whose first digits are `01b57d640ab12e33` (`events.jsonl`), `3546842d89241f81`
  (`expected-state.json`) and `f642fb41261117d6` (`scenario.resolved.json`). PowerShell prints `status succeeded`,
  `seed 42`, `eventCount 472`, and `Same True` for all three files.
- **How to read it:** `01b57d64...` is the checksum pinned by the engine's golden test since Milestone 1. The UI, the
  API and the command line all give the same world for the same scenario and seed.
- **Failure:** the page stays `queued` or `running` after a few seconds, or any `Same` is `False`.

## MV-9.9 — Launch executions: a failing test is found, a correct one passes

- **Verifies:** the execution form for a reference target in memory and through Kafka; the live page; the report;
  the drill-down from a root cause.
- **Preconditions:** MV-9.7 and MV-9.8.

```powershell
Start-Process "$web/runs/$($run.id)"
```

In the browser, three times, click **New execution** (the run is already chosen), then:

1. **Chaos profile** `spec-example`, **Chaos seed** `7`, **Reference target: naive**, transport **In memory**;
   **Start execution**. When the report shows, in **Root causes** click the link `ord_000045`.
2. **Chaos profile** `none`, **Chaos seed** `7`, **Reference target: correct**, **In memory**; **Start execution**.
3. **Chaos profile** `spec-example`, **Chaos seed** `7`, **Reference target: naive**, transport **Through Kafka**,
   **Speed** `max`; **Start execution**.

Then, in PowerShell:

```powershell
(Invoke-RestMethod "$api/executions").executions | Format-Table @{n='target';e={ "$($_.target.name) $($_.target.transport)" }}, status, verdict, attemptCount, findingCount
```

- **Expected:**
  1. the page opens `/executions/<id>` and is complete almost at once: **Verdict** `FAIL`, **Delivery attempts**
     `486`, "48 findings: 48 explained by a delivery fault, 0 not explained by delivery."; the link opens
     `/executions/<id>/aggregates/ord_000045?event=...` with **Canonical timeline** and **Delivery timeline** and an
     event marked **out of order**;
  2. **Verdict** `PASS`, **Delivery attempts** `472`, "No findings: the target ended in the expected state.";
  3. `FAIL` again with 48 findings; its page has a **Kafka** section with **Records sent** `486`, and the drill-down
     shows `partition 0, offset N` for each delivery;
  - PowerShell prints three rows, newest first: `naive kafka completed FAIL 486 48`, `correct memory completed PASS
    472 0`, `naive memory completed FAIL 486 48`.
- **How to read it:** the naive target assumes perfect delivery; under `spec-example` (3% duplicates, 2% reorders,
  5% delays) it double-counts and overwrites, and every finding names the delivery fault behind it. The correct
  target is idempotent and order-aware, and passes when nothing is lost.
- **Failure:** the page does not change by itself from queued/running, a verdict differs, or a finding is "not
  explained by delivery".

## MV-9.10 — Versions: identical is the existing version, changed is the next

- **Verifies:** a scenario is never edited; "New version" starts from the latest resolved definition, says in advance
  when the text equals a version, and saves a changed document as the next version.
- **Preconditions:** MV-9.6.

```powershell
Start-Process "$web/scenarios/$($scenario.id)"
```

In the browser: click **New version**. Look at the box under the text. Click **Save as a new version** without
changing anything. Then, in the text, change the value of the `"description"` line to `A small store, tested from the
browser.`, wait for the box to update, and click **Save as a new version**.
Finally click **New run** and open the **Version** list.

Then, in PowerShell:

```powershell
$stored = Invoke-RestMethod "$api/scenarios/$($scenario.id)"
$stored.versions | Format-Table version, scenarioHash
```

- **Expected:** the editor starts with the latest version's resolved definition (every default filled in, so it is longer
  than the file) and the green box adds "It is identical to **version 1**: saving returns that version and stores
  nothing new." Saving it shows a blue box "This document is identical to version 1, so nothing new was stored." After
  the change, **Valid** no longer mentions version 1; saving opens `/scenarios/<id>?saved=2` with "Saved as version 2."
  and two rows, `v2` above `v1`. The **Version** list of **New run** offers `Latest (v2)`, `v1` and `v2`. PowerShell
  lists two versions with different hashes.
- **How to read it:** a run is bound to one version, so the runs of MV-9.8 stay what they were. Only a change that
  matters to the simulation changes its output; a description does not.
- **Failure:** a second row for the unchanged text, the first version changed, or "identical" shown for a changed
  document.

## MV-9.11 — Refusals: what a launch the API cannot accept looks like

- **Verifies:** the form's own checks, the API's refusals shown with their paths, a double click, and a run that is
  not ready.
- **Preconditions:** MV-9.10.

```powershell
$before = (Invoke-RestMethod "$api/runs").total
Start-Process "$web/runs/new?scenarioId=$($scenario.id)"
```

In the browser, on the **New run** form:

1. Click **Start run** with **Seed** empty.
2. Type `two words` in **Seed** and click **Start run**.
3. Replace the seed with `double` and **double-click** **Start run**.

Then, in PowerShell:

```powershell
(Invoke-RestMethod "$api/runs").total - $before
$standard = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -ContentType 'application/json' -InFile scenarios\ecommerce-standard.json
$ids = 1..6 | ForEach-Object { (Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType 'application/json' -Body (@{ scenarioId = $standard.id; seed = "burst-$_" } | ConvertTo-Json)).id }
Start-Process "$web/executions/new?runId=$($ids[-1])"
```

In the browser, within about nine seconds: type `7` in **Chaos seed** and click **Start execution**.

- **Expected:**
  1. "Complete the form" with `seed` and the sentence "enter a seed (any text or whole number...)"; nothing is sent;
  2. **The API refused the run**: `seed` "Invalid seed "two words": use 1-128 characters from A-Z, a-z, 0-9, ".", "_", ":"
     and "-"", and the button is active again;
  3. you land on one new run page, and the first PowerShell line prints `1` (one run, not two);
  - the **Run** list of the execution form shows the new run with `· queued` (or `· running`) after its name; after
    **Start execution** a yellow box **The API cannot do this now**: `Run <id> is queued; start an execution once it has
    succeeded.` (`running` if it had started); you stay on the form.
- **How to read it:** the API starts one run at a time, so of six specification-sized runs the last waits several
  seconds. The form lists a run that is not ready (you can link to one), and the API explains why it cannot be used.
- **Failure:** a request is sent for an empty seed, the refusal has no path, the double click makes two runs, or the
  not-ready run is accepted.

## MV-9.12 — Live monitoring: a paced execution, and the API going away

- **Verifies:** a page follows a run or execution without a click, and survives the API being stopped.
- **Preconditions:** MV-9.9 (the second window has the API running).

```powershell
$run = (Invoke-RestMethod "$api/runs?scenarioId=$($scenario.id)").runs | Where-Object { $_.seed -eq '42' } | Select-Object -First 1
Start-Process "$web/executions/new?runId=$($run.id)&chaosProfileId=$($profiles['none'])"
```

In the browser: **Chaos seed** `7`, **Reference target: correct**, transport **Through Kafka**, **Speed** `5000`; **Start
execution**. Watch the page for about half a minute. About ten seconds in, go to the **second window**, press **Ctrl+C**
to stop the API, and wait five seconds. Then start it again with `pnpm api` and keep watching. (The automated check of this
case stopped the API by killing its process instead, because a background process cannot receive Ctrl+C; the documented
stop, Ctrl+C, leaves an interrupted execution `running` for the next start in the same way, ADR-0012.)

- **Expected:** the page says "This execution is queued|running: waiting for N s" with N counting up, and "this page
  updates by itself until it ends"; there is no Reload button and no validation report. After you stop the API, within a
  few seconds a yellow notice appears above the page: **The latest refresh failed.** "This page shows what the API said
  a moment ago, and keeps trying." The page does not turn into an error page. When the API is back the notice goes by
  itself; the execution (interrupted by the stop) is run again from the start, so the page shows `running` (it may show
  `queued` for an instant first) and, about 35 seconds after the restart, **Verdict** `PASS` and the validation report,
  without you touching it. The notice read `The API could not be reached: 502 Bad Gateway` (the web server could not reach
  the API).
- **How to read it:** speed `5000` plays the plan in compressed real time (a simulated day in about 17 seconds), which
  is what makes the execution slow enough to watch. An execution that a stop interrupts is run again from scratch
  (Milestone 7): the same result.
- **Failure:** the page needs a click to change, turns into an error page when the API stops, never recovers, or the
  verdict is not `PASS`.

## MV-9.13 — Your own pipeline, through the UI

- **Verifies:** an execution against an external pipeline waits for its state, takes the state from two file pickers
  in the browser, and validates it.
- **Preconditions:** MV-9.9; Kafka running (MV-9.2).

```powershell
docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:19092 --create --if-not-exists --topic mv-orders --partitions 1
Remove-Item out\mv\pipeline -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force out\mv\pipeline | Out-Null
```

Open a **fourth PowerShell window** and start the pipeline there; it prints `external-pipeline: ready` when it has
joined its consumer group:

```powershell
Set-Location F:\DataForge
node scripts\verification\external-pipeline.js out\mv\pipeline --brokers localhost:9092 --topic mv-orders --group mv-pipeline --target naive
```

In the first window:

```powershell
Start-Process "$web/executions/new?runId=$($run.id)&chaosProfileId=$($profiles['spec-example'])"
```

In the browser: **Chaos seed** `7`; choose **Your own pipeline**; **Topic** `mv-orders`; **Consumer group**
`mv-pipeline`; **Start execution**. When the page says "Waiting for the pipeline's final state", tell the pipeline to
finish, in the first window:

```powershell
Set-Content out\mv\pipeline\finish 'x'
```

Then, in the browser, under **Submit the pipeline's final state**, choose `F:\DataForge\out\mv\pipeline\actual-state.json`
for **actual-state.json** and click **Submit and validate**.

- **Expected:** the execution page says "Waiting for the pipeline's final state" with the topic `mv-orders` and the group
  `mv-pipeline`, two file pickers (the windows file "only for a windowed profile") and a **Submit and validate**
  button that is greyed out until a file is chosen. The fourth window prints `consumed    486 records: 472 distinct
  events, 14 redeliveries` and exits. After the submit the page becomes the report: **Verdict** `FAIL`, "48 findings: 48
  explained by a delivery fault". Choosing a file that is not JSON, or a state the API refuses, lists the problems
  instead and the execution keeps waiting.
- **How to read it:** DataForge produced the plan to your topic, saw your consumer group reach zero lag, and validated
  what your pipeline ended up with. Here the "pipeline" is the naive reference consumer, so the result is the same as
  MV-9.9, step 1.
- **Failure:** the page does not wait, Submit is active with no file, the report differs from MV-9.9's, or a refused
  state changes the execution. (A pipeline that finishes at once, and an execution that fails with "has no active member",
  mean a `finish` file was left in the folder: the first command above removes it.)

## MV-9.14 — A pipeline that is not there: the reason is shown

- **Verifies:** an external execution that cannot start fails with its reason, shown on the page.
- **Preconditions:** MV-9.9.

```powershell
Start-Process "$web/executions/new?runId=$($run.id)&chaosProfileId=$($profiles['none'])"
```

In the browser: **Chaos seed** `7`; **Your own pipeline**; **Topic** `no-such-topic`; **Consumer group** `mv-pipeline`;
**Start execution**.

- **Expected:** the page becomes red: **This execution could not complete**, `Topic "no-such-topic" does not exist. An
  external execution produces to your pipeline's topic: create it, and start your pipeline on it, before the execution.`,
  and "A failed execution has no verdict".
- **How to read it:** a failed execution says nothing about the target; it means the test could not be run.
- **Failure:** the page keeps waiting, shows a verdict, or shows no reason.

## MV-9.15 — The web app stays in the browser

- **Verifies:** the editors validate on the server because the web app may not import the engine; the lint rule that
  enforces it still works.
- **Preconditions:** MV-9.1.

```powershell
Set-Content apps\web\src\guard-probe.ts "import { sha256Hex } from '@dataforge/core';`nimport { readFileSync } from 'node:fs';`nimport { Kafka } from 'kafkajs';`nexport const probe = [sha256Hex, readFileSync, Kafka];"
pnpm lint
Remove-Item apps\web\src\guard-probe.ts
pnpm lint
```

- **Expected:** the first `pnpm lint` fails, listing `'@dataforge/core' import is restricted from being used by a
  pattern. The web UI reads the HTTP API only...`, the same for `'node:fs'` and `'kafkajs'`; after the probe is removed
  `pnpm lint` passes.
- **Failure:** the probe is accepted, or lint fails without it.

---

## Known limitations

- The editors are plain text boxes: no syntax colouring, folding or completion. A mistake is reported with its line and
  column instead. A code editor can replace the one component if the documents outgrow it.
- Validation happens on the server, so the editor needs the API: with it stopped, a document that parses shows "The API
  is not reachable" and cannot be saved.
- The Playwright suite does not start an external pipeline; that flow is covered by the form's component tests, the
  Milestone 7 integration tests of the API, and MV-9.13.
- The browser's file picker cannot be driven from the self-check; it posts the same body to the API instead
  (`{ "actualState": ... }`).
- Chromium is the only browser the end-to-end suite uses; the light theme and a phone-width layout were not looked at.
- The pages still do not verify checksums of what they show (ADR-0013, decision 10); only file downloads do.

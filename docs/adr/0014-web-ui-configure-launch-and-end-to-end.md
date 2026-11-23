# ADR-0014: The web UI writes: JSON editors checked by the API, launch forms, live pages and a Playwright suite

Status: Accepted (Milestone 9).

## Context

Milestone 8 made the stored runs and executions explorable and kept the UI read-only. Milestone 9 closes the
loop in the browser: author a scenario and a chaos profile, generate a run, launch a test execution against any
target the API supports, watch it until it ends, and read the report. It also adds the end-to-end tests the
specification names (Playwright), because "the UI works" should be a command's answer.

The roadmap's first sketch of this milestone said the editors would reuse the Zod schemas. ADR-0013 (decision 3)
forbids it: `@dataforge/*`, `node:*` and the server frameworks may not be imported by `apps/web/src`, and the
scenario schema hashes with `node:crypto`. This ADR records how validation works instead.

## Decisions

1. **The editors are JSON text editors, not forms.** A scenario has about thirty fields and a chaos profile
   several fault sections; a form for each is a visual scenario builder in all but name, and the specification
   excludes those from the MVP (section 11). A code-editor component (Monaco, CodeMirror) is a large dependency
   for what a monospace text area and a list of problems do. The document is the very file the command line takes
   (`scenarios/*.json`, `chaos-profiles/*.json`), so what the UI saves can be run by the CLI and the other way round.
   Starting points are the repository's own example files, imported as text by Vite (`?raw`), so a template is never
   a copy that can drift and a template saved unchanged has exactly the golden hashes of the file.
2. **Validation stays on the server, with the same schema.** Alternatives: import the engine's schemas into the
   browser (needs `node:crypto` out of the scenario module and the ADR-0013 lint rule loosened, so browser code
   could use the engine unnoticed); duplicate the rules in the UI (two definitions that drift). Two read-only
   endpoints, `POST /scenarios/validate` and `POST /chaos-profiles/validate`, take the create endpoints' body,
   schema and validation pipe. The browser keeps one check: the text is valid JSON (with the line and column of a
   mistake). This replaces the roadmap's "reusing the Zod schemas".
3. **A dry run reports an invalid document with the same `400` as saving.** Alternative: `200 { valid: false,
   issues }` with a formatter of its own. The shared pipe makes the messages identical by construction, the UI reads
   one error shape for every write, and an integration test posts the same bad bodies to both endpoints and
   compares the whole responses. A valid document answers `200 { valid: true, name, <hash>, definition }`: the
   resolved definition and the hash a stored version would get. The dry run checks the document only: whether a
   name is taken is a matter for saving, which answers `409` (shown at the editor).
4. **Save is enabled only for text the API has just accepted.** The result of a check is stored with the text it
   answers; any edit makes the previous answer stale, so the editor says "checking" and Save is off until the new
   text is accepted. An in-flight check for old text is aborted and its answer ignored.
5. **Versions are never edited.** "New version" starts from the latest resolved definition and saves with the
   existing endpoint: `201` is a new version (the UI opens the document with `saved=<n>`), `200` is the existing
   version whose resolved definition is identical (the UI says so and stores nothing). The editor also says so in
   advance, by comparing the dry run's hash with the versions' hashes.
6. **Scenarios and chaos profiles share their pages.** They are the same thing to the UI (a named document with
   immutable versions, edited as JSON, checked, saved), differing in words, routes, endpoints and templates. One
   description per kind (`documents/kinds.ts`) drives the list, detail and editor pages. This is the one abstraction
   the milestone adds; without it six near-identical pages would be written twice.
7. **Launch forms send what the strict schemas accept.** The seed is the text typed (a large whole number never
   goes through `Number`; the API normalizes `42` and `"42"`), the chaos profile version is a number or absent for
   "latest", and a target's options are present only if they apply and were filled in: the memory transport rejects
   `partitions`, `speed` and `timeoutSeconds`, and `timeoutSeconds` lives inside `target`, not at the top level of
   the request. The bodies are built by two pure functions, tested for every target kind, and the contract test posts
   them to the real API. A form fails fast on what is missing, and shows the API's own problems (with their paths)
   for the rest.
8. **A double submit is one submit.** Two identical requests are two runs (D-6.1). The submit button is disabled
   while a request is in flight, and a ref (not only state, which is too slow for a fast double click) makes a second
   call a no-op.
9. **After a launch the UI opens the created resource.** Its page is live, so the user watches the run or execution
   without searching for it, and its address is what to share. A run that has not succeeded can still be chosen by
   link (`/executions/new?runId=`): the form lists it, and the API's `409` explains why it cannot be used yet.
10. **Live monitoring is polling, chained after each answer.** Alternatives: server-sent events or WebSockets (an API
    surface and a connection to manage, for a status the API already serves; the API reports status, not progress, so
    there is nothing finer to push). A page whose run or execution is `queued` or `running` asks again one second
    after the previous answer arrived, never before: the API's event loop is busy while it generates or delivers in
    memory, and requests must not queue behind it. It stops when the resource ends. A refresh that fails keeps the
    last data on screen with a notice and tries again; only a failure before any data arrived is an error page. The
    hook is separate from `useResource`, because driving the polling through `reload()` would dim the page on every
    tick and replace it with an error on the first hiccup.
11. **Still no TanStack Query.** ADR-0013 left it open for this milestone. Two pages poll, there is no cache to share
    and a write is a function that returns a promise. Revisit if a third consumer of cached data appears.
12. **External pipelines get a submission form.** An execution awaiting an external pipeline's state offers two file
    pickers (`actual-state.json`, and `actual-windows.json` for a windowed profile). The browser checks only that each
    file is JSON; the contract is the API's, which lists every problem with its path and changes nothing when it
    refuses. The files travel as the request body (up to the API's 64 MB limit).
13. **Playwright, in its own workspace app.** `@playwright/test` 1.65.1 in `apps/e2e`, so Vitest (`apps/web/src/**`),
    Jest (`**/test/**`) and the type-aware ESLint of the web app never see its specs, and `pnpm check` needs neither a
    browser nor infrastructure. It wants Chromium revision 1255; this machine's cache (`%LOCALAPPDATA%\ms-playwright`)
    held 1243 and 1248 when the milestone started, so the headless shell is downloaded once (123.8 MiB, 288 MB unpacked;
    `pnpm --filter @dataforge/e2e install-browser`). Checked 2026-11-23 against `playwright-core`'s `browsers.json`. Playwright's
    install also deletes cached browsers that no registered Playwright installation uses, and the first download here removed
    two such revisions of the shared cache (1248). The repository's command therefore runs the install through
    `support/install-browser.js`, which sets `PLAYWRIGHT_SKIP_BROWSER_GC`, so it only adds.
14. **The suite owns what it tests.** Its own database (`dataforge_e2e_test`, dropped and migrated on every run by the
    API's existing recreate script, which refuses any name that is not a scratch name), its own ports (3209 and 5309),
    its own API and web processes. Every setting is passed explicitly, the API's working directory has no `.env`, and
    `reuseExistingServer` is off, so a developer's configuration can never point it at real data and a server that is
    already running is never mistaken for the one under test. The servers are started with `node` directly, not
    through `pnpm`, because stopping a pnpm wrapper on Windows can leave its child holding the port; the API starts in
    the process that prepared its database. Its oracles are numbers earlier milestones pinned: the CLI's checksums for
    the small scenario with seed 42, and `spec-example` with chaos seed 7 (486 attempts; the naive target: 48 findings,
    all explained). The suite needs Kafka and PostgreSQL, like the integration suite, and a CI job starts them.
15. **What the end-to-end suite does not cover.** An external pipeline would need a consumer process and a topic the
    suite creates; that flow is covered by the form's component tests, the Milestone 7 integration tests of the API,
    and the manual guide, which uses the existing `external-pipeline.js`.

## Consequences

- The UI and the API change together: the contract test now also parses the scenario and chaos-profile responses the
  UI reads, the dry-run answers, and the response of every write, and posts the bodies the forms build.
- `@dataforge/web` is no longer read-only; ADR-0013's consequences about reading ("The UI does not refresh by itself")
  are superseded for runs and executions.
- The API gains two endpoints and no state. Everything else it exposes is unchanged, and so are the CLI's outputs and
  every golden hash.
- `pnpm test:e2e` is a third kind of test run, after `pnpm check` (no infrastructure) and `pnpm test:integration`
  (Kafka and PostgreSQL): it also needs a browser. The integration run grows from 10 suites and 112 tests to 11 and 132.
- A text area has no syntax highlighting or folding; a mistake is reported with its line and column instead. If the
  documents grow beyond what a text area handles, a code editor can replace the one component.

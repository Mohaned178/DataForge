# ADR-0013: The web UI: a read-only React app over the API, a proxy under /api, schemas at the boundary

Status: Accepted (Milestone 8).

## Context

Milestones 6 and 7 stored runs and test executions behind an HTTP API. Milestone 8 makes them
explorable: run and execution history, the report of an execution, and, for a finding, the canonical
timeline of an aggregate next to its delivery timeline, where the explanation of a wrong result lives
(spec 6: Frontend, "Result exploration, Failure reports"; spec 6 also says not to build the whole
frontend before the testing workflow works, which is why this milestone is read-only and launching and
editing wait for Milestone 9). The UI must not change the API, and must not learn anything about the
system except what the API says.

The versions below are majors this repository had not used before, so they were tried in this
repository first (2026-11-23): `pnpm install` needs no build-script approval; `tsc` with the
repository's strict options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `vite build`,
Vitest in jsdom and type-aware ESLint on `.tsx` all pass; `vite preview` serves deep links and proxies.

## Decisions

1. **Toolchain: React 19.3.1, Vite 8.3.8 with `@vitejs/plugin-react` 6.3.0, React Router 8.5.2, Vitest
   5.1.1 with jsdom 31.0.1, React Testing Library 16.3.3 (`@testing-library/dom` 10.4.2 as its peer),
   jest-dom 8.0.0, user-event 14.6.13, `eslint-plugin-react-hooks` 7.1.1.** All pinned, as everywhere
   (spec 5). They are the spec's stack at the versions current when the milestone started. TypeScript
   stays 6.0.3 (ADR-0005). The web package has no `"type": "module"` and its Vite configuration is
   `vite.config.mts`: the pure modules of the UI (`src/api/schemas.ts`, `src/lib/*`) are loaded by the
   API's Jest integration test, and as CommonJS-format files they compile there without extensions in
   their imports.
2. **The browser reaches the API through a proxy under `/api`**, in the dev server and in `vite preview`
   (`server.proxy` and `preview.proxy`), the prefix removed before the API sees the path. Alternatives:
   CORS on the API (a change to the API, and a reason to let it listen beyond this machine, against D-6.2),
   or the API serving the built UI (couples two release units; Milestone 10 may revisit). The prefix is
   necessary: the API's paths (`/runs`, `/executions/:id`) are also the UI's routes, and a proxy by bare path
   would send a reload of `/executions/<id>` to the API. Spike: deep links answer with the app; with the API
   stopped the proxy answers `502 text/plain` with no body, which the client tells apart from the API's JSON
   errors, so "the API is down" and "the API said no" are different screens. The proxy target comes from
   `WEB_API_URL`, by default `http://<API_HOST>:<API_PORT>` of the repository's `.env`, so one `.env`
   configures both.
3. **Response types are Zod schemas in the web app, validated at runtime, and a contract test holds them
   to the real API.** Alternative: `import type` from the packages and the API's view files. Spike:
   `@dataforge/validation`'s types pull in `core` sources that need Node's types (`node:crypto`, `Buffer`),
   so the web tsconfig would have to include Node's types and browser code could use `process` unnoticed;
   and the run and execution views declare `Date` where JSON carries strings. A lint rule forbids
   `@dataforge/*`, `node:*`, NestJS, Prisma and KafkaJS in `apps/web/src`. The schemas describe only what
   the pages read and ignore other fields, so an API that adds a field does not break the UI; a field the UI
   reads that disappears or changes type is reported with its path (`ResponseShapeError`).
   `apps/api/integration/web-contract.test.ts` builds a run and five executions through the real API (memory
   and Kafka, a windowed profile, a lossy one) and parses every response with the same schemas.
4. **Data loading is a 50-line hook, not TanStack Query.** This milestone reads a handful of endpoints, with
   no cache to share, no mutation and no polling. The hook aborts a superseded request, stores each answer
   with the key it answers (so a late answer is never shown) and keeps the previous data on screen while a
   reload is in flight. Milestone 9 (launch, live monitoring) may adopt TanStack Query and replace one file.
5. **The address is the state.** React Router with browser history; filters, the page, the open finding and
   the focused event are query parameters, so a failing finding can be sent as a link. Window findings use their
   own parameters (`wcategory`, `woffset`, `wopen`) so two lists on one page do not disturb each other.
6. **Plain CSS and one hand-written SVG; no chart library, no React Flow.** Spec 5 says "when needed". A table,
   a badge and a few lines do what this milestone shows; the entity dependency graph and per-window charts are
   candidates for later. Every status and verdict is a word as well as a colour; the pages follow the system's
   light or dark setting.
7. **The drill-down keeps each timeline in its own order and joins them by `eventId`.** A true time axis would
   crush events minutes apart when a delay moves a delivery by hours; with two orders an inversion is a visible
   crossing of lines, and the exact times are in the tables. **"Out of order" is the delivery summary's own
   definition** (an event whose first delivered attempt is later than that of a later version of its
   aggregate; failed attempts do not count, lost events are left out), implemented once in
   `src/lib/timeline.ts`. The contract test sums the UI's classification over every aggregate of five real
   executions and requires it to equal the summary's `outOfOrderEvents`, `inversionPairs` and
   `aggregatesAffected`, and requires every event the validator says was overtaken to be the one the UI finds.
8. **An entity's aggregate is derived from its ID** (`ord_n`, `cus_n`, `prd_n` are aggregates; `pay_n_k` and
   `shp_n` live in `ord_n`; ADR-0004), with one tested function, and a finding without causes (not explained
   by delivery) can still be followed to its own aggregate. A window cause carries only an `eventId`, so its
   aggregate is resolved through `GET /executions/:id/attempts?eventId=` (the `/events/:eventId` route), not by
   parsing the ID.
9. **Tests: Vitest with `fetch` stubbed at the boundary, fixtures captured from real executions.** The client,
   schemas and pages run unmodified; `scripts/capture-fixtures.mjs` regenerates the fixtures from a running
   API, and the contract test keeps their shape true. `pnpm test` runs Jest then Vitest (`test:node`,
   `test:web`), so `pnpm check` and CI cover the UI without a new step; Jest ignores `apps/web`. Browser
   end-to-end tests are Milestone 9 (Playwright).
10. **Pages check that rows are valid; downloads check checksums.** A modified stored value that is still a valid
    event, attempt or finding is shown by a page and refused by the file download (ADR-0011, ADR-0012). A row
    that is no longer valid is a `500 ... Integrity Error`, which the UI shows as its own panel (never as an
    ordinary failure). Verifying checksums from the UI would mean downloading every file; not done.

## Consequences

- The UI and the API are released together: a changed response is caught by the contract test, and shown
  by the UI as "Unexpected response from the API" naming the field.
- `@dataforge/web` has no dependency on any other package of the workspace, so `pnpm build` builds it in any
  order and the API's integration test imports its pure modules by path.
- The web server is `vite preview`: fine on this machine, not a production server (Milestone 10).
- The pinned Jest totals of the earlier self-checks that pin the integration run (Milestones 4, 6, 7) changed
  from 9 suites and 96 tests to 10 and 112, because of the contract test.
- The UI does not refresh by itself: a queued or running execution is refreshed with Reload.

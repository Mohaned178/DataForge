# ADR-0011: Persistence and API: Prisma 7 and NestJS 12 in one app, events as rows, files rebuilt and checked

Status: Accepted (Milestone 6). Decisions 8 (API on 127.0.0.1 only) and 9 (PostgreSQL keeps its volume) were confirmed by the product owner on 2026-11-23 (D-6.2, D-6.3).

## Context

Milestone 6 makes scenarios and simulation runs durable and queryable behind an HTTP API (spec
sections 5 and 6: Persistence Layer, Backend API). Until now a run existed only as a directory of
four files written by `dataforge generate`. The API must store the same run, let a client browse it,
and give back exactly the files the CLI writes, so that everything built on run directories
(`verify`, chaos planning, delivery, validation) keeps working on a run that came from the database.
The roadmap left three questions open: the Prisma version (the npm `latest` tag pointed to a release
candidate), the bulk insert strategy, and how background runs report their status.

## Decisions

1. **Prisma 7.10.1, pinned; the 8.0 release candidate is not used.** On 2026-11-23 `prisma@latest`
   was `8.0.0-rc.34` and `@prisma/client@latest` was `7.10.1`. Prisma 7's TypeScript client is
   generated into `apps/api/src/generated/prisma` (`prisma-client` generator, `moduleFormat = "cjs"`,
   extensionless imports, not committed: `pnpm install` and the API build generate it) and talks to
   PostgreSQL through the `@prisma/adapter-pg` driver adapter. There is no native query engine; the
   build scripts of `prisma` and `@prisma/engines` stay denied in `pnpm-workspace.yaml`, because the
   CLI fetches the migration engine on first use. Configuration is in `apps/api/prisma.config.ts`,
   which reads `DATABASE_URL` (the repository's `.env` is loaded when it exists, as by the CLI).

2. **NestJS 12.6, the current major, although it is ESM-only.** The repository stays CommonJS: Node
   24 loads ES modules from `require` natively, which a spike confirmed for a compiled Nest 12 app
   with dependency injection and validation. Under Jest, both Nest 12 and the Prisma 7 client (which
   loads its query compiler with a dynamic `import()`) need Node's `--experimental-vm-modules` flag,
   so `pnpm test` and `pnpm test:integration` start Jest with it (and hide its one-line warning).
   Nest 11 (CommonJS, npm tag `legacy`) would not remove the flag, since Prisma needs it too. Nest 12
   also brings a built-in `StandardSchemaValidationPipe`: route parameters declare a Zod schema
   (`@Body({ schema })`), so no validation library is added. The scenario body is validated by the
   core `scenarioSchema` itself, so the API reports the same problems, by path, as the CLI.
   Decorator metadata (`experimentalDecorators`, `emitDecoratorMetadata`) is enabled for the API and
   the Jest transform only.

3. **Prisma lives inside `apps/api`, not in a `packages/persistence`.** The API is the only user of
   the database; the CLI stays file-based. `@dataforge/kafka` became a package because two apps drive
   deliveries; nothing like that exists here yet. The ESLint guard keeps `@prisma/*` and `@nestjs/*`
   out of the four pure packages, and the generated client is excluded from lint.

4. **Tables** (migration `prisma/migrations/<timestamp>_init`):

   | Table | Key | Holds |
   | --- | --- | --- |
   | `scenario` | `id` (UUIDv7), unique `name` | A named scenario. |
   | `scenario_version` | `id`; unique `(scenario_id, version)` and `(scenario_id, scenario_hash)` | The resolved definition (JSONB) and its hash. |
   | `simulation_run` | `id` | Scenario version, seed, engine version, status, error, requested/started/finished times, event count, manifest and expected-state summary (JSONB). |
   | `canonical_event` | `(run_id, sequence)`; unique `(run_id, event_id)` and `(run_id, aggregate_id, aggregate_version)` | The envelope as columns, the payload as JSONB. |
   | `expected_state_snapshot` | `run_id` | The expected state (JSONB) and the SHA-256 of `expected-state.json`. |

   A trigger refuses every `UPDATE` of `scenario_version` and `canonical_event`: a changed definition
   is a new version, and the canonical history of a run is never modified (spec 4.2). Deleting a run
   removes its events and snapshot (cascade); a version with runs cannot be deleted. IDs of these
   application records are UUIDv7 (time-ordered). They are not simulation data: no run file contains
   one, which is why the API's files equal the CLI's. Timestamps are wall-clock application metadata,
   never simulation time.

5. **The run files are rebuilt from rows and checked before they are sent.** The run-file format
   (`RUN_FILES`, the manifest schema and `buildRunFiles`) moved from the CLI into `@dataforge/core`,
   so `generate` and the API build the four files with one function (CLI output unchanged: the golden
   hashes of both example scenarios are pinned in `packages/core/test/run-files.test.ts`). The API
   stores rows, not file text, so events are queryable by sequence, type and aggregate. A download
   (`GET /runs/:id/files/<name>`) rebuilds the file with the core serializers and compares it with the
   checksum and size the manifest recorded when the run was generated; a mismatch is an integrity
   error (HTTP 500, `Run Integrity Error`), never a silently different file. A row that is no longer a
   canonical event fails the event schema, in the event pages too.

6. **Bulk insert: one `INSERT ... SELECT FROM unnest(...)` per 5,000 events.** Spike, 20,000 events
   into PostgreSQL 18.7: `createMany` about 3.6 s whatever the chunk size (2,000, 5,000, 10,000),
   `unnest` with one array per column about 0.9 s. `COPY` would need another dependency and its own
   connection. The SQL is in one function (`prisma-run-store.ts`) and its column list matches the
   schema; the byte-identical export tests prove the round trip. The specification-sized scenario
   (18,479 events) is stored in about 1.5 s including generation.

7. **Background runs: an in-process queue, status in the database.** `POST /runs` records a `queued`
   run and answers `202`. `RunRunner` processes one run at a time: it claims the run with a
   conditional update (`queued` to `running`; a run is never processed twice), generates it, and
   writes events, snapshot, manifest and status `succeeded` in one transaction, so a run is either
   complete or has no rows. A failure is recorded as `failed` with the error. On start-up, runs left
   `running` or `queued` by a stopped or killed API are queued again and generated from scratch;
   generation is deterministic, so the result is the same. A run records the engine version it was
   requested for and is only generated by that engine. No queue library or Redis (spec 5); one API
   instance per database is assumed.

8. **Start-up checks and exit codes, as in the CLI.** The API refuses to start, with exit code 3 and
   the command to run, when PostgreSQL is unreachable or a committed migration is not applied, and
   with exit code 2 for invalid configuration (`DATABASE_URL`, `API_HOST`, `API_PORT`). It listens on
   `127.0.0.1:3000` by default: it has no authentication (spec 11), so it stays on the machine.
   `GET /health` answers `503` while the database is down and recovers without a restart.

9. **Infrastructure.** PostgreSQL `postgres:18.7-alpine` in `compose.yaml` with a health check and a
   named volume (run history survives `docker compose down`; `down -v` removes it), published on host
   port 5433 by default, because a local PostgreSQL installation commonly holds 5432 on Windows (it
   does on the development machine). PostgreSQL 19.0 was released three days before this decision;
   18.7 is the mature line that Prisma 7 documents. The integration suite recreates its own database
   (`dataforge_test`, from `TEST_DATABASE_URL`) on every run; the helper refuses to drop a database
   whose name does not end in `_test` or `_selfcheck`.

## Consequences

- A run can travel between the API and the CLI as files: download the four files into a directory
  and every CLI command accepts it.
- Every Jest run uses an experimental Node flag. If Jest or Node change that support, the API tests
  are the first to break; the fallback is Nest 11 plus an ESM-capable test transform for Prisma.
- Generation runs on the API's event loop: requests wait while a large run is simulated (about 0.6 s
  for the specification-sized scenario). Worker threads stay out until profiling in Milestone 10
  shows they are needed (spec 5).
- An export reads a whole run into memory (about 6 MB for 18,479 events); streaming is a Milestone 10
  item if profiling at the scenario limits calls for it.

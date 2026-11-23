# Performance at the scenario limits

Measured in Milestone 10 with `pnpm profile` (`scripts/profile/profile.mjs`), on 2026-11-23, to answer the
questions the roadmap left open: does generation need streaming, and does the API need worker threads
(specification section 5: "do not introduce worker threads until profiling proves they are needed")?

Machine: Windows 11, Node.js 24.21.0, Docker Desktop with the Compose PostgreSQL service, one run per cell
(these are single measurements, not averages). Every stage ran with the default Node heap; none needed
`--max-old-space-size`.

## What was measured

- **CLI stages** run as separate processes of the built CLI. *Peak* is the process's own peak resident set
  size (`process.resourceUsage().maxRSS`), so each row is that stage alone.
- **API stages** drive a running API through HTTP. *Peak* there is the working set of the API process **at the
  end of the stage**. The API process lives across stages and Node returns memory to the operating system
  lazily, so these numbers are a ceiling for the process, not the cost of one stage. *Worst /health* is the
  slowest answer to a `GET /health` sent every 100 ms during the stage: how long a busy event loop made a
  client wait.
- The profile is the example `spec-example` (5% delayed, 3% duplicated, 2% reordered), chaos seed 7, the
  `correct` target in memory, seed 42. The three sizes are the specification's example size, five times that,
  and the scenario limits of `SCENARIO_LIMITS` (100,000 orders, 100,000 customers, 10,000 products).

## Results

| Stage | 5,000 orders (18,479 events) | 25,000 orders (92,433 events) | 100,000 orders (455,251 events) |
| --- | --- | --- | --- |
| `generate` | 0.7 s, 196 MB | 2.1 s, 482 MB | 12.3 s, 1,439 MB |
| `verify` | 0.8 s, 236 MB | 2.7 s, 542 MB | 14.3 s, 1,532 MB |
| `chaos plan` | 0.9 s, 236 MB | 2.7 s, 461 MB | 13.9 s, 1,709 MB |
| `deliver` (`correct`, memory) | 0.7 s, 205 MB | 1.9 s, 437 MB | 8.8 s, 1,462 MB |
| `validate` | 0.9 s, 256 MB | 2.8 s, 445 MB | 12.2 s, 1,870 MB |
| API: generate and store a run | 1.9 s; worst /health 0.3 s | 10.0 s; worst /health 1.6 s | 43.3 s; worst /health 9.4 s |
| API: download `events.jsonl` | 0.3 s; worst /health 0.1 s | 1.2 s; worst /health 0.7 s | 6.3 s; worst /health 3.7 s |
| API: download `expected-state.json` | 0.2 s; worst /health 0.0 s | 0.7 s; worst /health 0.3 s | 2.8 s; worst /health 1.4 s |
| API: execution (`correct`, memory) | 2.9 s; worst /health 1.0 s | 12.5 s; worst /health 5.0 s | 64.9 s; worst /health 28.4 s |
| API process working set at the end | 1.6 GB | 1.7 GB | 1.9 GB (1.4 to 1.9 GB across the stages) |

File sizes at the limit: `events.jsonl` 139 MB, `expected-state.json` 130 MB, `delivery-plan.jsonl` 157 MB,
`actual-state.json` 130 MB. A run downloaded from the API at the limit is byte-identical to the one the CLI
wrote (`events.jsonl` sha256 `3e85627d...`, both).

## What it shows

1. **Everything scales linearly.** Twenty times the orders (5,000 to 100,000) costs about 13 to 23 times the time in
   every stage; nothing is quadratic. The whole offline loop (generate, verify, plan, deliver, validate) at
   the limit takes about a minute.
2. **Memory stays under 2 GB per CLI stage at the limit**, within Node's default heap on a 64-bit machine. The
   largest holder is the validation stage (1.9 GB): both states, the plan and the findings.
3. **The API's cost is its event loop, not its memory.** While it generates, stores, serves or executes at the
   limit, it answers nothing else: 9.4 s while generating a run, 3.7 s while serving the events file, 28.4 s
   while running an execution (plan, deliver and validate in the API process). At the specification's size
   the same stages stall it for 0.3 to 1.0 s, which the web UI's one-second polling never shows.
4. **Reading the stored events is not the bottleneck.** Downloading the 139 MB `events.jsonl` rebuilds and
   checksums it in 6.3 s.

## Decisions this led to (ADR-0015)

- **No streaming generation or serialization.** The limits fit in memory with room to spare, and the one
  place where streaming would help most, the download, must verify the whole file's checksum before sending a
  byte (the API's integrity rule, ADR-0011), which needs the whole content anyway or two passes over the
  database for a saving that does not change a stall of seconds.
- **No worker threads yet.** The evidence is a 28 s stall at the largest size a user can ask for, on a
  single-user local tool, against a design that has to move 130 MB documents across a thread boundary or give
  the worker its own database connection. That is a product decision (D-10.1), not a measurement result:
  `pnpm profile --api ...` reproduces the numbers on any machine, and the roadmap names the design to use if
  the answer is yes.

## Reproduce

```powershell
pnpm build
pnpm profile                                          # the specification's example size, CLI stages only
pnpm profile --orders 100000 --customers 100000 --products 10000      # the scenario limits
# with the API running (pnpm api) against a database you do not mind filling:
pnpm profile --orders 100000 --customers 100000 --products 10000 --api http://127.0.0.1:3000 --api-pid <process id>
```

Output goes to `out\profile` (ignored by git); the limit run writes about 600 MB there.

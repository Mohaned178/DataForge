# ADR-0012: Test executions through the API: shared steps, stored rows and checked files, external pipelines

Status: Accepted (Milestone 7). Decisions 6 (the external actual state is submitted) and 8 (an
interrupted external execution is failed) were confirmed by the product owner on 2026-11-23 (D-7.1,
D-7.2).

## Context

Milestone 6 stored scenarios and runs behind the API. Milestone 7 runs the rest of the test there:
plan the faulty delivery of a stored run, deliver it to a target, validate the target's state, and
keep everything queryable (spec 6: Persistence Layer "test execution metadata", Backend API
"managing chaos configurations, starting test executions, retrieving reports"). Until now these steps
existed only inside the CLI commands `chaos plan`, `deliver` and `validate`, mixed with file and
console I/O. Milestone 4 also deferred testing a consumer DataForge does not start (D-4.3): the
user's own pipeline, on the user's own topic and consumer group.

## Decisions

1. **The steps live in a new package, `@dataforge/execution`, shared by the CLI and the API.** It
   holds the file formats of each step (`delivery-summary.json`, `target-run.json`,
   `validation-report.json`, `kafka-run.json`), `planExecution`, `deliverInProcess`,
   `deliveredStateFromConsumer`, `validateExecution`, `buildValidationReport` and the Kafka delivery
   (`deliverThroughKafka`, with the consumer process), moved from the CLI unchanged; the CLI keeps
   only argument parsing, file reading and writing, and printing. Its output is unchanged (every CLI
   test, golden hash and Kafka equivalence test passes before and after the move). Alternatives: the
   API running the CLI as a child process (the database would hold copies of files, and errors would
   be exit codes to parse), or a copy of the steps in the API (two implementations that drift). It
   cannot be `@dataforge/kafka`: it forks `@dataforge/consumer`, which depends on `@dataforge/kafka`.
   The ESLint determinism guard covers the package except `kafka-delivery.ts` and
   `consumer-process.ts`, the two modules that do I/O.

2. **Chaos profiles are named, with immutable versions, like scenarios.** `chaos_profile` and
   `chaos_profile_version` mirror `scenario` and `scenario_version` (ADR-0011, decision 4): the body
   is a profile file, validated by the chaos `chaosProfileSchema` (the loss rule and the late-needs-
   windowing rule included, with the same paths as the CLI); a version stores the resolved profile and
   its `chaosProfileHash`; an identical definition returns the existing version; a trigger refuses
   updates. An execution names a version, so its history stays readable when the profile changes.

3. **Tables** (migration `20261123140000_test_executions`):

   | Table | Key | Holds |
   | --- | --- | --- |
   | `test_execution` | `id` (UUIDv7) | Run, profile version, chaos seed, planner version, target (JSONB, defaults filled in), status, verdict, error, requested/started/delivered/finished times, attempt and finding counts, work directory. |
   | `delivery_attempt` | `(execution_id, delivery_sequence)`; unique `(execution_id, attempt_id)` | One line of `delivery-plan.jsonl` as columns (faults and `derivedFrom` as JSONB), plus its `delivery-log.jsonl` entry for Kafka (outcome, partition, offset, due/started/acked times, drift). |
   | `execution_file` | `(execution_id, name)` | The JSON files (`delivery-summary.json`, `actual-state.json`, `actual-windows.json`, `target-run.json`, `kafka-run.json`) as JSONB, with the SHA-256 and size recorded when each was made. |
   | `validation_report` | `execution_id` | `validation-report.json` without its findings, with the SHA-256 and size of the whole file. |
   | `validation_finding`, `window_finding` | `(execution_id, ordinal)` | One finding per row at its position in the report; the queried fields as columns, differences and causes as JSONB. |

   Attempts, files, reports and findings are immutable (triggers, as for canonical events); the
   execution row is not, because its status changes. Deleting an execution removes its rows.

4. **Rows and documents; every file rebuilt and checked before it is sent** (the rule of ADR-0011,
   decision 5). What is queried is in rows (attempts by event, aggregate, kind, fault and outcome;
   findings by category and entity), the rest in documents. `GET /executions/:id/files/<name>`
   rebuilds the file (`delivery-plan.jsonl` from the attempt rows, `chaos-profile.resolved.json`
   from the profile version, `delivery-log.jsonl` from the Kafka columns, `validation-report.json`
   from the report and finding rows, the JSON documents by canonical JSON) and sends it only when it
   matches the checksum recorded with it (`delivery-summary.json` records the plan and profile,
   `kafka-run.json` the delivery log). A mismatch is `500 Execution Integrity Error`. An execution
   also re-checks the run it consumes: the events rebuilt from their rows must hash to the manifest's
   checksum, and their replay must give the recorded expected state.

5. **Written at the end, in one transaction.** A reference-target execution stores attempts, files,
   report, findings and status `completed` together, so an execution is complete or has no results,
   and recovery is "run it again" (generation and planning are deterministic; a Kafka delivery gets a
   new topic). An external execution stores its plan and delivery when it starts waiting
   (`awaiting_actual_state`), and its report when the state arrives.

6. **An external pipeline submits its actual state** (`POST /executions/:id/actual-state` with
   `{actualState, actualWindows?}`, the Milestone 3 and 5 formats). The alternatives were DataForge
   reading a file the pipeline writes (it only works on the same machine, with a path convention) or
   fetching it from a URL the pipeline serves (an endpoint convention every pipeline must implement).
   A submission works for any pipeline on any machine and keeps the API the only interface; a pull
   adapter can be added later. It is validated with the paths of each problem (`400`, nothing
   changes); a windowed profile requires the windows and an unwindowed one refuses them; a second
   submission is `409`. The report is the one `dataforge validate --plan` gives for the same file
   (`target: null`: no delivery recorded what the pipeline received); `actual-state.json` is the
   canonical serialization of what was submitted.

7. **The user's topic, checked before the first record; completion by zero lag.** An external
   execution produces to an existing topic of the user's (DataForge does not create it: the pipeline
   is already subscribed to it), with the Milestone 4 executor. Before the first record it checks that
   the topic exists, that the consumer group has an active member subscribed to it (otherwise its lag
   would never reach zero), and that the group's lag is zero (records already waiting could not be
   told apart from the execution's). Completion is zero lag on the user's group after the last record,
   as in Milestone 4, so the pipeline must commit what it has handled. Each check fails the execution
   with what to do. Resetting the pipeline's state between executions is the user's part.

8. **Background executions, beside the runs; an interrupted external execution is failed.**
   `ExecutionRunner` processes one execution at a time, with the queue mechanics now shared with the
   run runner (`SerialQueue`). It claims an execution with a conditional update, refuses one requested
   for another planner version, and records a failure with its error. On start-up, queued executions
   are processed, reference executions left `running` go back to the queue, and external executions
   left `running` are `failed` with the reason: DataForge cannot reset the user's pipeline, and
   delivering again would show up as duplicates. A stop aborts the delivery in progress (an abort
   signal now reaches the executor and the lag wait) and leaves the execution `running` for the next
   start, so a stop is never recorded as a failure.

9. **The reference consumer is forked, as in the CLI.** A Kafka execution of a reference target
   starts the consumer process (Milestone 4) with its work directory under `EXECUTION_WORK_DIR`
   (consumer output and both Kafka client logs, kept for inspection like the topics). Running the
   target inside the API would be simpler, but the target would no longer know only Kafka, and the
   API and the CLI would not share one path.

10. **Status and verdict are two fields.** `queued`, `running`, `awaiting_actual_state`, `completed`,
    `failed` say whether the execution ran to the end; `PASS`/`FAIL` says whether the target was
    right. `failed` means the execution could not complete (Kafka unreachable, a missing topic, a
    stored run that no longer matches its checksums), never that the target was wrong.

11. **Configuration.** `KAFKA_BROKERS` (default `localhost:9092`; the API starts without Kafka, and a
    Kafka execution fails with the command to start it) and `EXECUTION_WORK_DIR` (an absolute path,
    default `<temp>/dataforge-executions`). JSON bodies up to 64 MB (Express's default is 100 kB; a
    submitted actual state of the specification-sized scenario is a few megabytes). The API hides
    KafkaJS's Node 24 timer warning, as the CLI and the consumer do.

## Consequences

- One run, profile, chaos seed and target give the same files from the CLI and from the API, in
  memory and through Kafka; the integration suite compares them byte for byte.
- An execution is only as reproducible as its planner: like runs and engines, an execution names
  the planner version it was requested for.
- An execution runs on the API's event loop: while it plans, delivers in memory and validates, the
  API answers nothing else (not yet measured at the specification's size; worker threads stay out
  until profiling, spec 5). A Kafka delivery is asynchronous.
- An external pipeline must commit offsets after it has handled a record, or zero lag does not mean
  it is done; this is documented with the external API.
- Work directories and Kafka topics accumulate; removing old ones is manual (`docker compose down`
  removes the topics).

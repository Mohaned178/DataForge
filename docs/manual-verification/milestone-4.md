# Manual Verification — Milestone 4: Kafka Delivery + Out-of-Process Target

Run every command from `F:\DataForge`. The commands work in Windows PowerShell 5.1 and
PowerShell 7. `--silent` hides pnpm's own `$ node ...` echo line. Each case builds on the earlier
ones, so run them in order. Docker Desktop must be running.

CLI exit codes: **0** success (for `validate`: the actual state is correct), **1** a check failed
(for `validate`: there are findings), **2** invalid input, **3** infrastructure unavailable (Kafka
not reachable, the consumer process failed, or the consumer group's lag did not reach zero).

Words used below:

- **transport**: how `dataforge deliver` gets messages to the target. `memory` (the default, as in
  Milestone 3) calls the target in the same process; `kafka` produces every delivered attempt to a
  real Kafka broker, and the target runs as a **separate consumer process** that reads them.
- **record**: one Kafka message. Key = the aggregate ID (for example `ord_000018`); value = the
  canonical event plus its event time as an ISO timestamp; headers = the attempt (`attemptId`,
  `attemptNumber`, `deliverySequence`, `scheduledDeliveryTimeMs`, `scheduledDeliveryTime`).
- **planned failure**: an attempt the plan marks `failed`. It is never sent; the delivery log records
  it, and a retry follows if the plan has one.
- **partition**: Kafka keeps order only within a partition, and every record of one key goes to the
  same partition. With the default single partition the consumer receives exactly the planned order.
- **consumer group lag**: how many records the consumer's group has not yet committed. The consumer
  commits only after its target handled a batch, so lag 0 means "everything was handled"; that is
  how `deliver` knows the consumer is done.
- **equivalence**: for the same run, plan and target, the Kafka delivery writes the same
  `actual-state.json` and `target-run.json` (same SHA-256) as the in-memory delivery, so `validate`
  gives the same findings.

Self-check: `scripts/verification/milestone-4.ps1` runs these same cases with the same expected values
and prints PASS/FAIL per case. It writes to `out\self-check`; the hand-run steps below use `out\mv`.
It needs Kafka running and stops and restarts it for MV-4.11.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verification\milestone-4.ps1
```

---

## MV-4.1 — Install, build and run the automated checks

- **Verifies:** the workspace, now with `@dataforge/kafka` and `@dataforge/consumer`, installs,
  type-checks, lints and passes every unit test, without Kafka.
- **Preconditions:** Node 24, pnpm 11.

```powershell
Set-Location F:\DataForge
pnpm install
pnpm check
pnpm build
```

- **Expected:** `pnpm -r typecheck` lists seven projects, now including `packages/kafka` and
  `apps/consumer`, each `Done`; `Test Suites: 24 passed, 24 total` and
  `Tests: 330 passed, 330 total`; nothing after `$ eslint .`; `Done` for all seven in the build.
- **How to read it:** `pnpm check` runs only the unit tests, which need no broker (the executor is
  tested with a fake clock and a fake sender). The tests that talk to Kafka are a separate suite,
  next case.
- **Failure:** any `error TS...`, an ESLint error, a failed test, or an `ERR_PNPM_...` message.

## MV-4.2 — Start Kafka and run the integration tests

- **Verifies:** Compose starts one healthy Kafka broker in KRaft mode from a pinned image, and the
  integration suite passes against it.
- **Preconditions:** MV-4.1; Docker Desktop running; nothing else listening on port 9092.

```powershell
docker compose up -d --wait
docker compose ps --format "{{.Service}} {{.Image}} {{.Status}}"
pnpm test:integration
```

- **Expected:**
  - `docker compose up` ends with `Container dataforge-kafka-1 Healthy` (the first time, after
    pulling `apache/kafka:4.3.2`);
  - `docker compose ps` prints `kafka apache/kafka:4.3.2 Up ... (healthy)`;
  - `pnpm test:integration` builds the workspace, then prints `Test Suites: 2 passed, 2 total` and
    `Tests: 25 passed, 25 total` (about 50 seconds here).
- **How to read it:** the integration suite sends real records through the broker: in-process
  (record round trip, duplicates, per-key order with three partitions, lag) and through the CLI with
  the consumer as a separate process (16 equivalence cases: seeds 42 and 7, profiles `none`,
  `spec-example`, `flaky-network`, `lossy`, both targets). The broker is a single node in KRaft mode
  (no ZooKeeper) with no volume: `docker compose down` deletes every topic.
- **Failure:** `docker compose` cannot pull or start the image, the status is not `(healthy)`, or a
  test fails.

## MV-4.3 — Zero faults through Kafka

- **Verifies:** a delivery through Kafka to a separate consumer process reaches the expected state
  for both targets, exactly like the in-memory delivery in MV-3.2.
- **Preconditions:** MV-4.2 (Kafka running). Starts from an empty `out\mv`.

```powershell
if (Test-Path out\mv) { Remove-Item out\mv -Recurse -Force }
pnpm --silent dataforge generate --scenario scenarios/ecommerce-small.json --seed 42 --out out\mv\run-a | Out-Null
foreach ($p in 'none', 'spec-example', 'duplicates-only', 'flaky-network', 'lossy') {
  pnpm --silent dataforge chaos plan --run out\mv\run-a --profile "chaos-profiles/$p.json" --chaos-seed 7 --out "out\mv\plan-$p" | Out-Null
}
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-none --target correct --out out\mv\k-none-correct --transport kafka
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-none --target naive --out out\mv\k-none-naive --transport kafka | Out-Null
Get-FileHash out\mv\k-none-correct\actual-state.json, out\mv\k-none-naive\actual-state.json | Format-Table Hash
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-none-correct\actual-state.json --plan out\mv\plan-none | Select-Object -Last 1
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-none-naive\actual-state.json --plan out\mv\plan-none | Select-Object -Last 1
Get-Content out\mv\k-none-correct\consumer.log | Select-String '^DataForge consumer|^  (joined|consumed) '
(Get-Content out\mv\k-none-correct\kafka-run.json -Raw | ConvertFrom-Json).consumer | Format-List pid, target, assignedPartitions, exitCode
```

- **Expected:**
  - the correct target's `deliver` prints, among the usual lines,
    `kafka localhost:9092 (cluster <id>), topic dataforge.<timestamp>-<6 hex> (1 partition)`,
    `consumer process <pid>, group dataforge-consumer.<same id>, joined after 0.3 s (partitions 0)`,
    `sent 472 records, 0 planned failures not sent; speed max, <about 0.5 to 1.5> s`,
    `completion consumer-group lag 0, 0.0 s after the last record` and
    `delivered 472 messages: 472 distinct events, 0 redeliveries; 0 failed attempts never reached the target`
    (the very first delivery on a fresh broker joins after about 5 s instead: the broker creates its
    offsets topic);
  - both hashes are `AF4A8046F579EB7123F45B68C594C548A7543FB522DC411EE0930F7E8455AA74`, the same as
    in MV-3.2;
  - both `validate` lines are `Result: PASS (the actual state matches the expected state and satisfies every invariant)`;
  - `consumer.log` shows `DataForge consumer: target correct (...)`,
    `joined partitions 0 after 0.1 s; consuming (Ctrl+C to finish and write the state)` and
    `consumed 472 records: 472 distinct events, 0 redeliveries`;
  - the consumer's `pid` is a number (different from the `deliver` process), `target : correct`,
    `assignedPartitions : {0}`, `exitCode : 0`.
- **How to read it:** `deliver` created a topic, started `dataforge-consumer` as its own Node.js
  process, sent every attempt to Kafka, waited until the consumer group's lag was zero, then told the
  consumer to finish; the consumer wrote `actual-state.json`. The two processes share nothing but
  Kafka (and a "ready / finish / finished" message over Node IPC). Topic and pid change with every
  run; the hash does not.
- **Failure:** a hash other than the expected state's, exit code 3, a `validate` finding, or a
  consumer `exitCode` other than 0.

## MV-4.4 — Equivalence: the specification's example through Kafka equals the offline run

- **Verifies:** for the spec's example faults, the Kafka delivery and the in-memory delivery give the
  same files and the same findings, for both targets.
- **Preconditions:** MV-4.3.

```powershell
foreach ($t in 'correct', 'naive') {
  pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-spec-example --target $t --out "out\mv\m-spec-$t" | Out-Null
  pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-spec-example --target $t --out "out\mv\k-spec-$t" --transport kafka | Out-Null
}
foreach ($f in 'm-spec-naive\actual-state.json', 'k-spec-naive\actual-state.json', 'm-spec-naive\target-run.json', 'k-spec-naive\target-run.json') { '{0}  {1}' -f (Get-FileHash "out\mv\$f").Hash, $f }
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\m-spec-naive\actual-state.json --plan out\mv\plan-spec-example --report out\mv\m-spec-naive-report.json | Out-Null
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-spec-naive\actual-state.json --plan out\mv\plan-spec-example --report out\mv\k-spec-naive-report.json --limit 0
$LASTEXITCODE
foreach ($f in 'm-spec-naive-report.json', 'k-spec-naive-report.json') { '{0}  {1}' -f (Get-FileHash "out\mv\$f").Hash, $f }
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-spec-correct\actual-state.json --plan out\mv\plan-spec-example | Select-Object -Last 1
```

- **Expected:**
  - the four hashes come in two equal pairs:
    `A47FBBB75451D59707B0E69CF2FEBDAF5D96BC845A94746285AE68DA46A81877` for both
    `actual-state.json` (the MV-3.8 value) and
    `62E37D930F2B321E8590593B137A4EFD550CA4C35A8CD51E64697D8D54299D86` for both `target-run.json`;
  - `validate` of the Kafka naive target prints `written by target naive from profile spec-example,
    chaos seed 7`, `findings 48` (`status-mismatch 8`, `field-mismatch 14`, `double-processing 8`,
    `invariant-violation 18`, the others 0), `explained 48 of 48 findings are linked to abnormal
    deliveries; 0 are not explained by any delivery fault`, first cause
    `evt_ord_000045_1 OrderCreated arrived after evt_ord_000045_2 [reorder] 7 findings`, and
    `Result: FAIL (48 findings)`; exit code `1`;
  - both reports hash to `51C6D6331A95CCF3CB0DDD1C94B90AD98E9CEC5C3E50D73A30A865F864945B44`
    (the MV-3.8 value);
  - the correct target through Kafka: `Result: PASS ...`.
- **How to read it:** this is the central claim of the milestone. With one partition Kafka hands the
  consumer the records exactly in plan order, so going through a real broker and a separate process
  changes nothing about the result: same state, same bookkeeping (`target-run.json` records no
  transport detail), same findings. Everything that depends on the transport (times, offsets, pids)
  lives in the other files of the directory.
- **Failure:** any pair of hashes differs, or the findings differ from MV-3.3.

## MV-4.5 — The records on Kafka: key, headers, value, and a duplicate

- **Verifies:** what is really on the topic: one record per delivered attempt, keyed by aggregate,
  the attempt in the headers; a duplicated event arrives twice with the same value and different
  `attemptId`s, and the naive target charges twice.
- **Preconditions:** MV-4.3.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-duplicates-only --target naive --out out\mv\k-dup-naive --transport kafka | Select-String 'kafka |sent|delivered'
$topic = (Get-Content out\mv\k-dup-naive\kafka-run.json -Raw | ConvertFrom-Json).kafka.topic
$records = docker compose exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:19092 --topic $topic --from-beginning --max-messages 527 --formatter-property print.key=true --formatter-property print.headers=true --formatter-property print.offset=true
$records.Count
($records[0] -split "`t") -join "`n"
$dup = $records | Where-Object { $_ -match 'evt_ord_000018_3"' }
$dup | ForEach-Object { ($_ -split "`t")[0..2] -join '  ' }
@($dup | ForEach-Object { ($_ -split "`t")[3] } | Sort-Object -Unique).Count
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-dup-naive\actual-state.json --plan out\mv\plan-duplicates-only --limit 200 | Select-String 'ord_000018 '
```

- **Expected:**
  - `deliver`: `sent 527 records, 0 planned failures not sent` and `delivered 527 messages: 472
    distinct events, 55 redeliveries`;
  - the console consumer also prints `Processed a total of 527 messages` (and a note about the
    KIP-848 rebalance protocol, which can be ignored); `$records.Count` is `527`;
  - the first record, split into its four parts:
    `Offset:0`,
    `attemptId:att_prd_000001_1_1,attemptNumber:1,deliverySequence:1,scheduledDeliveryTimeMs:0,scheduledDeliveryTime:2026-01-01T00:00:00.000Z`,
    `prd_000001`, and the value
    `{"event":{"aggregateId":"prd_000001","aggregateType":"Product",...},"eventTime":"2026-01-01T00:00:00.000Z","format":"dataforge.delivery-record","formatVersion":1}`;
  - the two records of `evt_ord_000018_3`:
    `Offset:123  attemptId:att_ord_000018_3_1,attemptNumber:1,deliverySequence:124,scheduledDeliveryTimeMs:60284611,scheduledDeliveryTime:2026-01-01T16:44:44.611Z  ord_000018`
    and
    `Offset:124  attemptId:att_ord_000018_3_2,attemptNumber:2,deliverySequence:125,scheduledDeliveryTimeMs:60310971,scheduledDeliveryTime:2026-01-01T16:45:10.971Z  ord_000018`;
  - the number of distinct values among them is `1`;
  - `validate` shows `order ord_000018 double-processing amountPaidMinor is 7000, expected 3500 (2x); paymentAttempts is 3, expected 2`,
    `amountPaidMinor 7000 exceeds totalMinor 3500 [order.paid-within-total]` and
    `paymentAttempts is 3 but the order has 2 payment records [order.payment-counters]`.
- **How to read it:** this is the real topic, read with Kafka's own console consumer inside the
  container (port 19092 is the broker's internal listener). The key is the aggregate, so all of an
  order's events share a partition. The value is the canonical event unchanged plus its ISO event
  time; the headers describe the attempt. The duplicate of `PaymentCompleted` for `ord_000018` has the
  same value and key, 26.36 s later in simulation time, with its own `attemptId`: nothing in the
  record says "duplicate", exactly as a real redelivery looks. The naive target counted it twice.
- **Failure:** a record count other than the number sent, a key that is not the aggregate ID,
  missing headers, or duplicates with the same `attemptId` or different values.

## MV-4.6 — The delivery log: planned failures are never sent

- **Verifies:** `delivery-log.jsonl` accounts for every planned attempt: sent ones with partition and
  offset, planned failures with neither; the consumer handled exactly the sent ones.
- **Preconditions:** MV-4.3.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-flaky-network --target correct --out out\mv\k-flaky-correct --transport kafka | Select-String 'sent|delivered'
Get-Content out\mv\k-flaky-correct\delivery-log.jsonl | ForEach-Object { $_ | ConvertFrom-Json } | Group-Object outcome | Format-Table Name, Count
Get-Content out\mv\k-flaky-correct\delivery-log.jsonl | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object eventId -eq 'evt_ord_000015_2' | Format-Table deliverySequence, attemptId, outcome, partition, offset
@(Get-Content out\mv\k-flaky-correct\processing-log.jsonl).Count
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-flaky-correct\actual-state.json --plan out\mv\plan-flaky-network | Select-Object -Last 1
```

- **Expected:**
  - `sent 509 records, 33 planned failures not sent; speed max, ...` and `delivered 509 messages:
    472 distinct events, 37 redeliveries; 33 failed attempts never reached the target` (the MV-3.6
    counts);
  - the outcome table: `sent 509`, `planned-failure 33`;
  - `evt_ord_000015_2`: delivery sequence 86 `att_ord_000015_2_1 planned-failure`, 87
    `att_ord_000015_2_2 planned-failure` (both without partition or offset), then 88
    `att_ord_000015_2_3 sent 0 83`, 89 `att_ord_000015_2_4 sent 0 84`, 90 `att_ord_000015_2_5 sent 0 85`;
  - the processing log has `509` entries;
  - `Result: PASS ...`.
- **How to read it:** the plan says the first two attempts of `evt_ord_000015_2` fail, the third (a
  retry) succeeds, and two duplicates follow. A failed attempt is one the target never receives, so
  it is never produced to Kafka: it appears only in the delivery log, at its place in the order.
  Every sent attempt has a partition and offset, and the consumer's processing log lists the same 509
  records in the same order.
- **Failure:** a planned failure with an offset, a count that does not add up, or a failing
  `validate`.

## MV-4.7 — Paced delivery: plan time compressed by --speed

- **Verifies:** with `--speed <factor>`, each attempt is sent when it is due (its plan time divided by
  the factor), and the drift is reported.
- **Preconditions:** MV-4.3.

```powershell
'took {0:N1} s' -f (Measure-Command { pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-spec-example --target correct --out out\mv\k-paced --transport kafka --speed 40000 | Select-String 'sent|sha256' | Out-Host }).TotalSeconds
(Get-Content out\mv\k-paced\kafka-run.json -Raw | ConvertFrom-Json).execution | Format-List speed, durationMs, maxDriftMs
Get-Content out\mv\k-paced\delivery-log.jsonl | Select-Object -Last 1
```

- **Expected:**
  - `sent 486 records, 0 planned failures not sent; speed 40000x, 4.3 s, largest drift <a few tens of> ms`
    (38 and 67 ms in two runs here) and the usual `actual-state.json` hash `af4a8046...`;
  - `took` about 6 s (the 4.3 s of paced sending plus start-up and finishing);
  - `speed : 40000`, `durationMs : 4312` or a little more, `maxDriftMs` the same as the drift above;
  - the last delivery-log entry has `"dueAtMs":4307`, `"scheduledDeliveryTimeMs":172303920` and a
    `startedAtMs` a few milliseconds after `4307`.
- **How to read it:** the plan's last attempt is at 172,303,920 ms of simulation time (about 47.9
  hours after the first); at 40,000x that is 4,307 ms of real time. Each attempt waits until it is
  due; when sending falls behind, the lateness is recorded as drift rather than hidden. The default,
  `--speed max`, sends without waiting: Milestone 4 needs the order, and windows that depend on
  timing come in Milestone 5.
- **Failure:** the delivery finishes in well under 4.3 seconds, `maxDriftMs` is empty or negative, or
  the hash differs.

## MV-4.8 — Three partitions: per-key order holds, the correct target still passes

- **Verifies:** with several partitions Kafka keeps the order of each key (aggregate) but interleaves
  keys; the correct target is unaffected.
- **Preconditions:** MV-4.6.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-flaky-network --target correct --out out\mv\k-p3-correct --transport kafka --partitions 3 | Select-String 'kafka |consumer |sha256'
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-p3-correct\actual-state.json --plan out\mv\plan-flaky-network | Select-Object -Last 1
$processed = @(Get-Content out\mv\k-p3-correct\processing-log.jsonl | ForEach-Object { $_ | ConvertFrom-Json })
$planned = @(Get-Content out\mv\plan-flaky-network\delivery-plan.jsonl | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object plannedOutcome -eq 'delivered')
$byKey = @{}; foreach ($r in $processed) { $byKey[$r.aggregateId] += @($r.attemptId) }
$keys = @($planned | Group-Object aggregateId)
"aggregates: $($keys.Count), received out of their planned order: " + @($keys | Where-Object { ($_.Group.attemptId -join ',') -ne ($byKey[$_.Name] -join ',') }).Count
"partitions used: " + @($processed | Group-Object partition).Count
$later = 0; for ($i = 1; $i -lt $processed.Count; $i++) { if ($processed[$i].deliverySequence -lt $processed[$i - 1].deliverySequence) { $later++ } }
"records handled after a record planned later: $later"
```

- **Expected:**
  - `topic dataforge.<id> (3 partitions)` and `joined after 0.3 s (partitions 0, 1, 2)`; the hash is
    again `af4a8046...`;
  - `Result: PASS ...`;
  - `aggregates: 157, received out of their planned order: 0`;
  - `partitions used: 3`;
  - `records handled after a record planned later:` a positive number that changes from run to run
    (83 here).
- **How to read it:** Kafka guarantees order only within a partition. Every aggregate still arrived
  exactly in its planned order (0 out of order), but records of different aggregates were handled in
  a different order than planned, because the consumer fetches the partitions in turns. The correct
  target does not care: it handles cross-aggregate dependencies itself. The naive target can end up
  with more findings than offline here (an order's update can now arrive before its customer from
  another partition), and their number varies; that is why one partition is the default for
  equivalence.
- **Failure:** any aggregate received out of its planned order, fewer than 3 partitions used, or a
  failing `validate`.

## MV-4.9 — Lost events through Kafka

- **Verifies:** under a profile that loses events, the Kafka delivery loses exactly what the plan
  loses, and every finding of the correct target points at a lost event, as offline in MV-3.7.
- **Preconditions:** MV-4.3.

```powershell
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-lossy --target correct --out out\mv\k-lossy-correct --transport kafka | Select-String 'sent|delivered|parked'
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-lossy --target correct --out out\mv\m-lossy-correct | Out-Null
foreach ($f in 'm-lossy-correct\actual-state.json', 'k-lossy-correct\actual-state.json') { '{0}  {1}' -f (Get-FileHash "out\mv\$f").Hash, $f }
pnpm --silent dataforge validate --run out\mv\run-a --actual out\mv\k-lossy-correct\actual-state.json --plan out\mv\plan-lossy --limit 0 | Select-String 'findings  |missing-entity|explained|Result'
```

- **Expected:**
  - `sent 471 records, 104 planned failures not sent` and `delivered 471 messages: 450 distinct
    events, 21 redeliveries; 104 failed attempts never reached the target`;
  - `35 events parked ...` and `parked 35 events never applied (what they wait for never arrived):
    evt_ord_000014_4, evt_ord_000015_3, ...`;
  - both hashes are `EFD6FFC682C311E7025708DE8BFCA8DAD81F96BF47854D8F839383B9DEBFE971`;
  - `findings 81`, `missing-entity 40`, `explained 81 of 81 findings are linked to abnormal
    deliveries; 0 are not explained by any delivery fault`, `Result: FAIL (81 findings)`.
- **How to read it:** the same result as MV-3.7. Lost events are attempts the plan never lets
  through, so they are never sent; the consumer cannot apply what it never received, and every
  finding points at a lost event.
- **Failure:** different hashes, an unexplained finding, or a different number of failed attempts.

## MV-4.10 — The specification's example size through Kafka

- **Verifies:** the spec's reference workload (1,000 customers, 5,000 orders, about 19,000 attempts)
  through Kafka, its duration, and equivalence at that size.
- **Preconditions:** MV-4.3.

```powershell
pnpm --silent dataforge generate --scenario scenarios/ecommerce-standard.json --seed 42 --out out\mv\run-standard | Out-Null
pnpm --silent dataforge chaos plan --run out\mv\run-standard --profile chaos-profiles/spec-example.json --chaos-seed 7 --out out\mv\plan-standard | Out-Null
pnpm --silent dataforge deliver --run out\mv\run-standard --plan out\mv\plan-standard --target naive --out out\mv\m-standard-naive | Out-Null
'took {0:N1} s' -f (Measure-Command { pnpm --silent dataforge deliver --run out\mv\run-standard --plan out\mv\plan-standard --target naive --out out\mv\k-standard-naive --transport kafka | Select-String 'sent|delivered' | Out-Host }).TotalSeconds
foreach ($f in 'm-standard-naive\actual-state.json', 'k-standard-naive\actual-state.json') { '{0}  {1}' -f (Get-FileHash "out\mv\$f").Hash, $f }
pnpm --silent dataforge validate --run out\mv\run-standard --actual out\mv\k-standard-naive\actual-state.json --plan out\mv\plan-standard --limit 0 | Select-String 'findings  |explained|Result'
```

- **Expected:**
  - `sent 19,050 records, 0 planned failures not sent; speed max, <about 16 to 20> s` and
    `delivered 19,050 messages: 18,479 distinct events, 571 redeliveries`;
  - `took` about 18 to 22 s here;
  - both hashes are `9821B28496BF22A87E2CC755882E2DD48DBE495FBF63DDE6C2F7A57B3B5CA254`;
  - `findings 1,897`, `explained 1,897 of 1,897 findings are linked to abnormal deliveries; 0 are not
    explained by any delivery fault`, `Result: FAIL (1,897 findings)` (the MV-3.12 values).
- **How to read it:** records are sent one at a time, each acknowledged before the next (about 1 ms
  each on a local broker), which is what guarantees the order; batching is left for Milestone 10.
- **Failure:** different hashes, or the delivery takes more than about a minute.

## MV-4.11 — Kafka unavailable

- **Verifies:** without a broker, `deliver --transport kafka` stops within seconds with exit code 3
  and says how to start Kafka, writes no actual state, and the integration suite refuses to run
  instead of passing.
- **Preconditions:** MV-4.3. This case stops Kafka and starts it again at the end.

```powershell
docker compose stop kafka
pnpm --silent dataforge deliver --run out\mv\run-a --plan out\mv\plan-none --target correct --out out\mv\k-down --transport kafka
$LASTEXITCODE
Test-Path out\mv\k-down\actual-state.json
pnpm test:integration 2>&1 | Select-String 'KAFKA UNAVAILABLE|not reachable|Start it with|Then rerun'
$LASTEXITCODE
docker compose up -d --wait
```

- **Expected:**
  - `Container dataforge-kafka-1 Stopped`;
  - `deliver` prints, after about 5 s,
    `Kafka is not reachable at localhost:9092: Connection error (ECONNREFUSED)` and
    `Start it with "docker compose up -d --wait" (see compose.yaml), or point --brokers or KAFKA_BROKERS at a running broker.`;
    exit code `3`; `Test-Path` prints `False`;
  - the integration suite prints `KAFKA UNAVAILABLE: the integration tests need a running Kafka
    broker and did not run.`, `Kafka is not reachable at localhost:9092: Connection error (ECONNREFUSED)`,
    `Start it with:   docker compose up -d --wait` and `Then rerun:      pnpm test:integration`;
    exit code `1`;
  - `docker compose up -d --wait` ends with `Container dataforge-kafka-1 Healthy`.
- **How to read it:** exit code 3 is new in this milestone: "infrastructure unavailable", distinct
  from 2 (your input is wrong) and 1 (a check failed). The integration suite fails as a whole instead
  of skipping, so a missing broker can never look like a passing test run. `pnpm check` still needs
  no broker.
- **Failure:** the command hangs, exits with another code, leaves an `actual-state.json`, or the
  integration suite passes.

## MV-4.12 — Invalid options are rejected before touching Kafka

- **Verifies:** transport and Kafka options are validated first (exit code 2, nothing created).
- **Preconditions:** MV-4.3.

```powershell
$d = 'deliver', '--run', 'out\mv\run-a', '--plan', 'out\mv\plan-none', '--target', 'naive', '--out', 'out\mv\never'
pnpm --silent dataforge @d --transport carrier-pigeon; $LASTEXITCODE
pnpm --silent dataforge @d --speed 10; $LASTEXITCODE
pnpm --silent dataforge @d --transport kafka --speed fast; $LASTEXITCODE
pnpm --silent dataforge @d --transport kafka --partitions 0; $LASTEXITCODE
pnpm --silent dataforge @d --transport kafka --brokers localhost; $LASTEXITCODE
$env:KAFKA_BROKERS = 'not a broker'; pnpm --silent dataforge @d --transport kafka; $LASTEXITCODE; Remove-Item Env:KAFKA_BROKERS
Test-Path out\mv\never
```

- **Expected:** each command prints one line and exit code `2`:
  `Unknown transport "carrier-pigeon". Transports: memory, kafka.`;
  `--speed applies only to --transport kafka.`;
  `--speed must be "max" or a positive number of simulated milliseconds per real millisecond (for example 3600), got "fast".`;
  `--partitions must be a whole number from 1 to 64, got "0".`;
  `Invalid Kafka broker list "localhost": "localhost" is not host:port. Use host:port, comma-separated (for example localhost:9092).`;
  the same for `"not a broker"`, ending with `(from KAFKA_BROKERS)`. `Test-Path` prints `False`.
- **How to read it:** options are checked before any connection or file is made, so a typo never
  creates a topic or a half-written output directory. The broker list comes from `--brokers`, else
  the `KAFKA_BROKERS` variable (or `.env`, see `.env.example`), else `localhost:9092`.
- **Failure:** any exit code other than 2, or `out\mv\never` exists.

## MV-4.13 — The Kafka client stays out of the pure packages

- **Verifies:** ESLint rejects a Kafka import in the deterministic packages, and holds
  `@dataforge/kafka` itself to the determinism rules everywhere except its two broker-facing modules.
- **Preconditions:** MV-4.1.

```powershell
Set-Content packages\targets\src\guard-probe.ts "import 'kafkajs';"
Set-Content packages\kafka\src\guard-probe.ts 'export const probe = (): number => Date.now();'
pnpm lint
$LASTEXITCODE
Remove-Item packages\targets\src\guard-probe.ts, packages\kafka\src\guard-probe.ts
pnpm lint
$LASTEXITCODE
```

- **Expected:** the first `pnpm lint` reports
  `packages\kafka\src\guard-probe.ts ... 'Date.now' is restricted from being used. Business time comes from the simulation clock, not the machine clock`
  and
  `packages\targets\src\guard-probe.ts ... 'kafkajs' import is restricted from being used by a pattern. The simulation core must stay framework- and infrastructure-independent`,
  `2 problems (2 errors, 0 warnings)`, and exits with `1`; after removing the probes, `pnpm lint`
  exits `0`.
- **How to read it:** only `@dataforge/kafka` may import the Kafka client, and inside it only the
  two modules that talk to the broker (`client.ts`, `consumer-runner.ts`) may do I/O or read the
  machine clock. The record contract, the executor (which receives its clock) and every new file
  there follow the same determinism rules as the core.
- **Failure:** the first lint passes, or a probe file is left behind.

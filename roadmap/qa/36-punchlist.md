# Chunk 36 — QA punch list (reviewed at roadmap/phase-2-spec @ cf43ef4)

Probes (none committed; scripts kept outside the repo):
- `caravan_test_qa36`: `test/retention.test.ts` as the owner and app roles.
- `caravan_dev_qa36`: `pnpm db:reset && pnpm db:seed`, then `pnpm e2e` (E2E_PORT 3965, E2E_WEB_PORT 4265).
- `caravan_load_qa36`: `pnpm load:queue` at small scale (40 trips, an 800-job burst, 2 processes × 2
  loops, `--profile`), with `--burst-parties 1` and then `24`. After that:
  - 6 000 synthetic caravans, each with 30 completed fights whose logs are 31–390 days old
    (180 840 logs, 112 MB). Inserted as the owner with the log guards off for the insert only.
  - The sweep timed and EXPLAINed over that data.
  - A race script: 3 concurrent `encounter_log_retention_sweep(500)` loops plus a per-caravan
    prune loop, as `caravan_app`, with the size budget lowered to 1 KB by the owner (since restored).
  - An erasure-race script with two connections. One compacts a caravan's logs in an open
    transaction (`encounter_log_prune`, the same `encounter_log_compact_rows` the sweep calls). The
    other runs `account_erasure_core` (the body of `account_erase`) on the same fights. Both
    orders were run, once for an erased defender and once for an erased party owner.
- A throwaway web test (deleted afterwards). It renders `WatchFight` under the app's
  `ErrorBoundary`, with `ReplayPlayer.tsx`'s import made to reject.
- `pnpm perf:resolver`, run 4 times alone on this 4-core machine (load average 2.6–3.8).

Baseline:
- `retention.test.ts` 8/8 pass.
- `pnpm build` passes. The `ReplayPlayer` chunk is 34.71 KB (12.37 KB gzip), as the build notes say.
- `pnpm e2e` 11/11 pass.
- `pnpm load:queue` passes every correctness check and fails its throughput target (exit 1), as the build notes report.

Checked and fine:
- **Compaction is atomic and exactly-once.** Each sweep call is one statement in one transaction:
  the summary insert, then the delete. A crash rolls back both. The summary's primary key plus
  `ON CONFLICT DO NOTHING` makes a second compaction a no-op. The delete guard refuses a log with no
  summary, even for the owner.
- **Concurrent sweeps do not corrupt anything.** 3 sweepers and a pruner ran for 15 s and compacted
  8 984 logs with 0 errors and 0 deadlocks. Summaries equal compacted logs: 8 984 summaries, and
  180 840 − 8 984 = 171 856 logs remaining. See N1 for the wasted work.
- **Neither role can tamper.** The app role gets 42501 on INSERT, UPDATE, DELETE and TRUNCATE of
  `encounter_log_summary`, on `encounter_log_compact_rows`, and on UPDATE of the retention row. The
  owner cannot rewrite, delete or truncate a summary. The app role can call `encounter_log_prune(any
  caravan)` and `encounter_log_retention_sweep(≤5000)`, but both apply only the definer's fixed rule
  on the database clock.
- **The summary keeps what the readers need.** The replay summary, the Party feed (ledger-driven),
  the inbox and telemetry do not read `encounter_log`. Outcome and tally are copied from the job's
  immutable result.
- **Compaction and erasure compose when they run one after the other**, in both orders and for both
  sides (the 3 tests pass). Concurrent runs do not compose: see S1.
- **`RECENT_OPPONENTS_SQL` keeps the pre-§36 ordering exactly** (`chosen_at DESC, trip_id,
  encounter_index DESC`), so the draw's replay input is unchanged.
- **The lock-contention finding is real.** At small scale, with 4 drain loops:

  | Burst parties | Advisory-lock wait per job | Throughput |
  |---|---|---|
  | 1 | 37.0 ms | 53 jobs/s |
  | 24 | 13.0 ms | 65 jobs/s |

  Worker CPU was 15–18 ms per job. For whether to fix it before the play test, see D1.

## Should-fix

S1. **Compaction racing an account erasure loses the other player's fight, or keeps the erased id.**
`encounter_log_compact_rows` (022 up:179-206) reads `encounter_log` from its statement snapshot,
with no row lock and no coordination with chunk 30. `account_erasure_core` (023 up:148-164) updates
`resolution_job` first. That update fires `encounter_log_summary_follow_erasure` (022 up:117-138),
and only then does it update `encounter_log`. Observed on `caravan_load_qa36`:
- **Defender erased while a compaction of their caravan is uncommitted.** The erasure blocks on the
  log row. Once the compaction commits, the erasure finishes with `fightsDefendedKept: 21,
  replaysDefendedAnonymized: 0`. Afterwards the log is null AND the summary is null. The trigger
  could not see the uncommitted summary, so the caravan cascade deleted the 21 summaries that had
  been kept for the party owner. The owner's replay route now answers 410 `replay_expired` for 21
  fights that chunk 30 promised to keep.
- **Party owner erased while a compaction of the defender's caravan is uncommitted.** The probed
  fight's summary keeps `party_owner_account_id` = the erased account's id (`summaryNamesErased: true`), although the
  audit counts say `replaysStruckAnonymized: 30`. Chunk 30's anonymization guarantee is broken for
  those rows.
- **Erasure first, compaction second.** The prune fails with 23503 (the summary's foreign key to the
  deleted caravan). In the sweep, that aborts the whole 500-row batch. In a completion transaction it
  fails the job (see D4).

These races happen in production whenever the hourly sweep, or any job completion on the same
caravan, overlaps an account deletion. Fix:
- Serialize the two paths. `account_erasure_core` takes `pg_advisory_xact_lock(<erasure ns>)`
  before it reads anything. `encounter_log_compact_rows` takes `pg_advisory_xact_lock_shared(<erasure
  ns>)` and then selects the rows `FOR UPDATE`, so it reads the post-erasure version.
- Alternatively, have the erasure lock the `encounter_log` rows `FOR UPDATE` before it updates
  `resolution_job`, so the trigger runs after any in-flight compaction has committed.

Tests: two connections, in both orders and for both sides. Hold one transaction open while the other
runs, then assert the summary exists, names the tombstone, and that the counts match.

S2. **The scheduled job never erases expired guests.** Chunk 30 handed this off
(PHASE-2.md:754-755; qa/30-punchlist.md:316): "chunk 36's scheduled sweep should call
`account_erase_expired_guests`". `LogRetentionLoop` (retentionWorker.ts:73-78) only calls
`encounter_log_retention_sweep`. Nothing in `apps/` calls the function outside
`account-lifecycle.test.ts:740`. Failure scenario: every guest who clears their cookies or abandons a
device keeps an account, a caravan, a standing party (still served to other players) and ledger rows
forever. The 180-day erasure that chunk 30's privacy copy promises never happens. Fix:
- Add a second step to the hourly run: `SELECT account_erase_expired_guests($1)` in a loop with a
  small limit (for example 50, since each call is one transaction holding every erased account's
  rows), until it returns less than the limit. Use a per-run cap, as the log sweep has.
- Log the count through `onRun`. Keep the step after the log sweep, and make it independent: an
  error in one must not skip the other.

Test: a guest with an expired device and session, backdated past 180 days, is gone after `runNow()`.
A guest with a live device is kept.

S3. **`pnpm perf:resolver` is a blocking CI step, and it flakes on this machine.** It is in `pnpm ci`
and in ci.yml:85-86. 4 runs alone, load average 2.6–3.8:
- **Run 1 FAILED.** `full-length full load best 117.1 ms` against the 100 ms bound
  (budget.test.ts:85-95).
- **The other runs passed with almost no margin.** The same fight read 99.9, 98.4 and 89.0 ms in
  the corpus test.
- **The same fight disagrees with itself within one run.** It read 63.4 ms in the direct test and
  99.9 ms in the corpus test.

So the noise (about ±30 %) is larger than the 13 % margin. The weak spots:
- The direct test takes best of 5 with no extension (budget.test.ts:86). The corpus takes best of up
  to 9 (budget.test.ts:52-53, 105-107).
- `process.cpuUsage()` is process-wide, so V8's concurrent GC and compiler threads count against the
  fight.
- GitHub's hosted runners are shared VMs with variable CPU models. A 2-vCPU private-repo runner on
  an older part can be uniformly slower than this host, which turns a flake into a permanent red.

A robust gate that still catches a real regression:
- **(a) Make the blocking check deterministic.** Have the resolver count its work as integers: path
  nodes expanded, distance checks, entity-ticks. Return the count in a stats field outside the log,
  so the replay and determinism are untouched. Pin the counts per corpus fight beside the golden
  logs, and fail when any fight's count rises more than about 10 % without an explicit re-pin. That
  catches an algorithmic regression, such as A* blowing up, on any machine, with zero noise.
- **(b) Keep a time check, but relative.** In the same process, time a fixed reference workload
  (the corpus's median fight, or a pinned integer loop) interleaved with the heavy fights. Assert
  `heaviest / reference ≤ R`, with R calibrated from the current numbers (about 12×). Machine speed
  and most contention cancel out.
- **(c) Make the absolute 100 ms bound a report.** Print it to the job summary and gate it only on a
  fixed or self-hosted perf runner, or nightly.
- **Remove the duplicate measurement now.** Drop the direct best-of-5 assertion for
  `fullLoadFullLength`, since the corpus already times that fight with up to 9 runs, or give it the
  same `CORPUS_RUNS_MAX` rule.

S4. **A failed replay-chunk load blanks the whole app, and Retry cannot recover it.**
`WatchFight.tsx:18` uses `lazy(() => import("./ReplayPlayer.tsx"))` inside a `<Suspense>`
(WatchFight.tsx:53-61). No error boundary sits around it, so a rejected import propagates to the
app-level `ErrorBoundary` (App.tsx:125). React caches a lazy component's rejection.

Observed with the import rejecting:
1. Opening a fight replaces the whole screen, trip results and tab bar included, with the
   render-error box. No dialog is left.
2. Retry restores the screen.
3. Opening any fight again fails immediately without retrying the import.

Failure scenario for the play test: a tester has the app open while a tuning build is deployed. The
old hashed `ReplayPlayer-*.js` is gone, so every "Watch the fight" tears down the app. Recovery takes
a full reload. The same happens offline, or on a flaky mobile connection on first open.

Fix:
- Put an `ErrorBoundary` inside the modal around the `Suspense`, with "Couldn't load the replay" and
  a Retry.
- Make the lazy factory retryable: keep the import promise in a module variable and clear it on
  rejection, so Retry calls `import()` again. Also re-create the `lazy()` on Retry, for example with a
  key-bumped wrapper.
- Optionally, on a chunk-load error, suggest a reload ("a new version is available").

Test: mock the module to reject once and then resolve. Opening shows the in-dialog error and leaves
the trail visible. Retry renders the player.

## Design-level

D1. **The lock-contention finding is real, but the proposed fix would not help real trips, and the
load test understates the owner's critical section.** Phase B runs with no settle hooks
(queue-load.ts:344 `setMode("none")`). The build notes' lever is "take the account lock only for
events that move a balance (`party_served_as_encounter` projects nothing)". But in a real trip, the
completion transaction's `afterCompleted` settle (`TRIP_SETTLE_HOOKS` → `settleInTx`) takes
`lockAccountsForAppend([defender, owner])` (trip/service.ts:305), credits the owner's loot share and
moves their Reputation.

So the popular owner's lock is held from worker.ts:162 through two prunes (`encounter_log_write`'s
own, and the new §36 one at worker.ts:171) and the whole settle, until COMMIT. That window is longer
than Phase B measures, and dropping the lock for `party_served_as_encounter` would not remove it.

Recommendation: **do not fix before the play test.** At a few hundred players, demand is about one
commit per second, against a measured single-party ceiling of about 50 jobs/s. Before launch:
- Run Phase B with the settle hooks, using real trip ids, so the measured section is the real one.
- Move the §36 prune out of the locked section (see D4).
- Consider crediting the absent owner asynchronously, as its own job keyed by the encounter, so the
  defender's completion never takes the owner's lock.

D2. **The load test's checks have gaps, and its exit status conflates correctness with the target.**
- The Phase A "settled" check (queue-load.ts:334) counts every `wagon_manifest` in the database with
  `encounters_resolved = 1 OR closed_at IS NOT NULL`. That is neither scoped to Phase A's trips nor
  to a settled outcome: a trip voided by a parked job also counts. Join on Phase A's job ids, and
  assert `trip_encounter` rows equal to TRIPS, each with the job's outcome kind.
- Nothing checks the property the account locks exist for. After 10 000 concurrent credits, every
  touched account's projected Coin should equal the fold of its ledger rows and stay at or below its
  cap, and each `coin_transferred_to_party_owner` should be clamped once. Add that check.
- Retention under load is not exercised. Every log is fresh, so the prune and sweep never compact.
  Lower the budget for one pass, or backdate, so compaction runs concurrently with completions.
- `process.exitCode = 1` comes from the throughput target (queue-load.ts:396) as well as from
  correctness checks. The script therefore always "fails" on a shared host, and the DoD's "load test
  passes" cannot be read off it. Exit non-zero only on correctness. Report the target as
  MET / NOT MET with the host's load average, and record the play-test cut in PHASE-2 §36 (no staging
  host exists for the DoD's "runs on staging").

D3. **Each hourly sweep re-scans every old-but-protected log, forever.** The first branch of
`encounter_log_retention_sweep` (022 up:244-253) walks `encounter_log_created_idx` from the oldest
row and runs the newest-N count subquery for each row older than 30 days. Most such rows belong to
caravans with fewer than 50 fights, players who played a little and left. They never qualify, so the
`LIMIT` never fills and the scan covers all of them on every run.

Measured over 180 000 protected rows:
- 1.09–1.15 s per call, compacting 0.
- EXPLAIN: `Rows Removed by Filter: 180000`, 741 576 buffers, the subplan executed 180 000 times.

The cost grows with the lifetime count of churned players' fights (up to 50 × caravans) and is paid
every hour by every server process (N1). It is fine at play-test scale, at about 10 k rows. Before
launch, choose the candidates per caravan instead: iterate caravans that have more than
`min_per_caravan` logs, from a maintained per-caravan count or a cursor over
`encounter_log_caravan_recent` with OFFSET `min_per_caravan`. Alternatively, keep a "scanned up to"
watermark: a protected row can only become compactable when its caravan writes a newer log, and that
write already runs the caravan's own prune.

D4. **Compaction runs unguarded inside the completion transaction, and inside the locked section.**
`pruneEncounterLogs` at worker.ts:171 has no savepoint, unlike `afterCompleted` at worker.ts:173-180.
Any error in it rolls back the fight's completion. S1's 23503 is one example; a lock timeout or
deadlock against a concurrent sweep is another. The job is then retried, and after `max_attempts` it
parks and the trip is voided. Storage housekeeping should never cost a player their fight. It also
holds the defender's and owner's account locks while it runs (D1).

Fix:
- Run the post-completion prune under a savepoint, report errors via `onHookError`, and leave
  anything missed to the hourly sweep.
- Better, move it after COMMIT, in its own short transaction. "An over-budget log never outlives its
  own completion transaction" is not worth a fight: the largest corpus log is 30 KB gzip against a
  100 KB budget.

D5. **The matchmaking EXPLAIN plans are snapshots, and nothing guards them in CI.** The checked-in
plans (`apps/server/db/explain/*.txt`) are regenerated by hand (`pnpm load:explain`). No test asserts
that `RECENT_OPPONENTS_SQL` reads `encounter_candidates_chosen_recent_idx` as an index-only scan.
Dropping or redefining the index, or editing the query, passes CI. `qa25-scale.test.ts:95-155`
already shows the pattern: EXPLAIN (FORMAT JSON) over about 10 k synthetic rows, then assert the index
name and no Seq Scan. Add the same for the recent-opponent query, with a veteran account of a few
hundred trips, and for POOL_SQL's linked-account filter.

Band-scan cost:
- **Play-test scale:** fine, at a few hundred players.
- **Launch:** the explain data spreads siege Reputation uniformly over 0..3999
  (matchmaking-explain.ts header). Real populations pile up near 0, because everyone starts there.
  So the ±600 slice at the bottom band will hold most accounts, not 15 k of 50 k, and the 82–110 ms
  scan, which also ships every row to Node, grows to match. Regenerate one plan with a skewed
  distribution, for example 70 % of accounts in 0..600. Then decide whether the pass-by-pass scan
  (±150 first) is needed before launch. If it changes the draw's input, it needs the replay-version
  care the build notes mention.

## Nits

N1. **Every server process runs its own hourly sweep.** Verified to be safe (see "checked and fine").
But the duplicates serialize. In the race probe, while one sweeper compacted 500 rows per call, the
other two waited 2.3–2.8 s per call on its uncommitted rows and then returned 0. Each extra process
also repeats D3's full scan. Wrap a run in `pg_try_advisory_lock(<retention ns>)` and skip the run if
another process holds it.

N2. **The reason is worded for retention only.** `COMPACTED_REASON` (routes/replay.ts:78) says
"(log retention)" even when `compacted.reason` is `size_budget`. A log over budget at write means the
resolver produced an abnormal log. Today the defender silently loses the replay of the fight they
just played. Word the reason per kind, and count `size_budget` compactions in telemetry or the server
log as an anomaly.

N3. **The tally-parity test does not test the web code.** `retention.test.ts` `webTally` is a copy of
`replayModel.ts:306-331`, not the web module, and it runs on one fight. A change to the web tally
would not fail it, although summary.ts:9-10 says "a server test pins the two equal". Options:
- Move the tally to one shared function (for example beside the resolver's replay reader) that both
  use.
- Or add a web test that runs `replayTally` over the recorded contract replay.

Also run the parity check over the whole golden corpus, not one fight.

N4. **The account export ignores compaction.** account/service.ts:192-201 LEFT JOINs only
`encounter_log`. For a compacted fight the export shows `replay_stored: false` with null metadata.
The kept summary (reason, compacted_at, tally, sizes, sha256), which is stored under the account's
ids, is omitted. Join `encounter_log_summary` as well.

N5. **Migration 022's down silently drops every summary** (022 down:56). That loses permanent data,
and so does 013's down for logs. 011 and 009 refuse to roll back while system accounts exist.
Consider the same refusal while `encounter_log_summary` is non-empty, so a `db:reset` of a played
database fails loudly instead.

N6. **`encounter_log_summary_follow_erasure` fires on every `resolution_job` update** (022 up:137-138):
lease, heartbeat, fail and complete, each paying an `account_erasure_active` probe. Add
`WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.input IS DISTINCT FROM NEW.input)` to the
trigger.

N7. **Client lazy loading is untested.**
- No test covers `WatchFight`'s Suspense fallback (`replay-loading`) or a failed chunk load (S4).
- Memory on repeated open and close was not measured: no test opens and closes the replay N times
  and checks that WebGL contexts or `IsoScene` instances do not accumulate. Teardown code exists
  (IsoCanvas.tsx:259-267, scene.ts:288-291).
- Add a Playwright loop to trip.spec's real-log section: open and close 10 times, then assert one
  canvas and a bounded `performance.memory` or context count.
- The atlas and memory-ceiling items are honestly deferred to chunk 26. Fine for the play test.

## Orchestrator decisions (2026-10-12)

- **S1:** serialize compaction and erasure. Both take the same transaction-scoped advisory lock keyed on the fight's job before touching its log or summary, and the compactor locks the logs it compacts (`FOR UPDATE SKIP LOCKED` in the sweep). A test runs the two in parallel connections, in both orders, and checks both outcomes: no fight loses its summary, and no summary keeps an erased id.
- **S2:** the hourly loop calls `account_erase_expired_guests` with a bounded limit per run, and a test covers it.
- **S3: adopt the proposal.**
  - The blocking check is pinned integer work counters per golden fight (for example ticks × units, path expansions), compared exactly, with a version bump required to change them.
  - Add a relative time check against a reference workload in the same process, with a generous ratio.
  - The absolute 100 ms bound becomes a report only.
  - Drop the duplicate best-of-5 measurement.
- **S4:** a failed lazy chunk shows an error inside the replay dialog with a Retry that really re-imports. Do not cache a rejected import, and never replace the app screen. Add a test.
- **D1: no change before the play test.** Record the finding and the correct target (the owner lock at settle) in §36 for launch.
- **D2:** fix the scoping and add Coin balance and cap checks after the burst. The throughput target becomes a reported number with a `--strict` flag for a dedicated host, so a shared host does not "fail".
- **D3, D5:** no change before the play test. Record them for launch.
- **D4:** wrap the post-completion prune in a savepoint, so a compaction error never fails a fight.
- **Nits:** N2, N4, N5 and N7 in scope. N1, N3 and N6 may stay open with a reason.

# Guardrail and technical readiness review, confirmation round (reviewed at e002854)

**Verdict: READY.** I found no new should-fix item. All seven round-4 fixes are closed. I reproduced
each original problem on this commit, and each is gone. This includes round 4's S1: a 1-unit caravan
before its second bank now gets a full authored menu, and "Return to town" frees a caravan only when
no menu can be filled. That return is never better than a bank. The six guardrails held under live
probes. The hosting runbook worked as written: from 3d13921 to e002854 with data in place, using the
documented drain, then a backup and restore, restarts, migrations down and up, and a cohort reset.
CI is still exactly `pnpm check`.

There is one thing to fix before tagging the play-test commit. **`pnpm check` is not reliably
green** (N1). One server test still pins pass 7's "first three roster units" for the suggested party.
Pass 8 changed the raise to round-robin, and the roster order is random UUID order, so the test fails
about 40 % of the time. I saw 2 of 3 full `test` steps fail on it, and 3 of 10 standalone runs (a second loop failed again within 5). The
product behaviour is correct, and the fix is one line of the test. I counted it as a nit under the
strict S bar, because it blocks no play test and breaches no guardrail. Even so, CI will be red
about every other run until it is fixed. The fuzz found one pre-existing 500 that round 4 missed
(N2, an unchecked strike-window number). It is harmless.

Severity: **S** should-fix before outside testers, **D** design-level (needs an orchestrator
decision), **N** nit.

## What I ran (all observed, this session)

- **Setup and ports.**
  - Databases: `caravan_test_c2`, `caravan_dev_c2`, and the rehearsal databases `caravan_pt_c2` and
    `caravan_pt_c2_restore`. The rehearsal databases are dropped.
  - Ports 3939 (server, smoke, both e2e runs, the rehearsal behind Caddy) and 4239 (vite preview, the
    drain, the restore check, the boot-refusal sweep).
  - Heavy runs were sequential. The play reviewer's server (pid 9758, its own worktree) was never
    touched. I stopped only my own processes, each by pid after checking its working directory.
  - The host was loaded by the parallel reviewer's browsers (load 14 on 4 cores).
- **A fresh clone, set up from AGENTS.md alone.**
  - I cloned e002854 into the scratchpad and wrote `.env` with the `_c2` names and ports.
  - `pnpm install`, then `pnpm db:migrate` → "Applied: 1_core_schema … 30_menu_version_stamp".
  - `pnpm db:seed:dev` → "Authored parties (set v7): 96 created", then the dev account with "the
    starting roster only". Then the Playwright install.
  - The sandbox has no `sudo -u postgres`. I created the databases with `CREATE DATABASE … OWNER
    caravan` over the local `caravan` superuser.
- **`pnpm check` (four runs).**
  - **Run 1** failed at `test`:
    - typecheck 24 s, lint 5 s ("66 violation lines flagged … 0 false positives"), test:boundary;
    - content 82, resolver 587, circle 118 and web 506 all passed;
    - server: 834 passed, 1 skipped, **1 failed**: `party.test.ts` "D5 … suggests the saved party
      plus free unlocked units" (N1).
  - **Run 2** (`--from test`): web failed once on a 5 s timeout in `FormationScreen.test.tsx`
    ("places by tap"). This was host load, and the test passed in runs 1 and 3.
  - **Run 3** (`--from test`): web 506 passed. The server failed again on the same `party.test.ts`
    case (N1).
  - **Run 4** (`--from determinism`) → **"all 7 steps passed in 8.7 min"**:
    - determinism 68 s (366 tests; "3 processes … × 3 runs agree with each other and with 72 golden
      logs"), perf:resolver 15 tests, build ("check-bundle: ok"), migrate;
    - smoke: "NODE_ENV=production refused to start with the repo-default database password" and
      "answered /health, /api/health and /";
    - e2e: 12 passed (3.7 m). e2e:hosting: 14 passed (3.1 m).
  - Every gate other than N1 passed. The step times add up to about 19 min, inside CI's 45.
- **The golden gate.**
  - `DETERMINISM_BASE_REF=3d13921 pnpm determinism` → "73 golden file(s) changed since 3d13921c7d"
    and "accepted — RESOLVER_VERSION 8 → 9, every changed golden carries v9".
  - Against 91612d0 (round 4) → "golden corpus unchanged". Pass 8 changed no resolver input.
- **CI equals `pnpm check`.** `.github/workflows/ci.yml` sets up the Postgres 16 service, pnpm, and
  Node from `.nvmrc`. It then runs `install --frozen-lockfile`, Playwright Chromium and exactly `pnpm
  check`. `timeout-minutes: 45`.

## Re-verification of round 4

| Item | Original problem | Reproduced now (e002854, built, real resolver) | Status |
|---|---|---|---|
| S1 stranded caravans | Three live one-raider parties held the bands 0–1 cap at 1; the authored-only rule then dropped them; a 1-unit caravan before 2 banks got 503 `pool_empty` and stayed `on_trip` | <ul><li>Three guests saved one-raider parties (200, `valid: true`) at siege 250–270. A fresh guest packed 1 at living 400 → search **201**, `raiderCap {"packedUnits":1,"cap":2,"relaxed":true,"excluded":88}`, `authoredOnlyTrip: true`, Prairie Wolf Pack / Bounty Board Riders / Salt Flat Drifters (authored, 2 raiders each). Return → 409 `menu_available`.</li><li>The return is refused on the resolved encounter (`not_current`), before the push decision (`decide_first`), after a push before any search, with a menu, and with a chosen menu (all `menu_available`).</li><li>Forced unfillable (the authored set deleted as the owner, then reseeded): a pushed encounter-2 search → **409 `pool_empty`**, `returnToTown: true`, player-facing copy with no "seed", repeatable with no wait. The server log has the operator's warn line. Return → **200**, `cause no_menu`, `credited 725` = the bank preview's `bankNow.total` 725, units untouched, cap use not refunded (2 → 2). The trip is voided, so it does not count toward the 2 banks. Return again → `trip_ended`.</li></ul> | **Closed**. The return is never better than banking (below). |
| D1 cap keyed on the caravan's band | Keyed on the centre, a band-2 caravan was capped at encounter 1 | A 7-unit guest (a refugee claimed) packing 1: at 400 → `caravanBand 1`, cap 2, relaxed, three 2-raider outfits. At **840** (centre 690) → `raider_cap` **null**, with 4-, 4- and 5-raider parties. At 860 → null. The stored record carries `caravanBand`. | **Closed** |
| D1 `SUGGESTED_PARTY_MAX` (now 3) | The raise served whole rosters that bands 0–1 never served | `GET /me/party` `suggested` for a fresh guest in each region: 3 units, round-robin over types (well_digger, dust_rider, well_digger; trapper, grizzly, trapper; prairie_wolf, homesteader, prairie_wolf; bounty_hunter ×2, gunslinger). Two adjacent starter edges. Dash types `nearest`, breakers / bursts `traps`. 0 locked units, siege `battering_wagon`. A saved party of 6 (from the old build) is not cut after the upgrade (`suggested: null`). | **Closed** (N1 is its stale test) |
| N1 PUBLIC CONNECT / EXECUTE | Any login on the cluster could connect and mint a session | <ul><li>A throwaway `c2g_stranger` login connecting to `caravan_dev_c2` → "FATAL: permission denied for database … User does not have CONNECT privilege".</li><li>Under `SET ROLE c2g_stranger`: "permission denied for function" on `session_issue` (with a literal account id), `resolution_job_park_other_version` and `encounter_log_prune`.</li><li>Functions executable by it: 0; by PUBLIC: 0. `datacl` `{caravan=CTc/caravan,caravan_app=c/caravan}` on the dev, rehearsal and restored databases.</li><li>The shared-instance login roles (members of `caravan` / `caravan_app`) connect and run normally.</li><li>The role is dropped.</li></ul> | **Closed** |
| N4 `menu_stale` | A menu chosen before a resolver bump resolved against an outdated scout | <ul><li>Simulated (a chosen menu's stamp set one version back as the owner): commit → **409 `menu_stale`**, no job queued; choose on that menu → 409 `menu_stale`; search → **201 at once** (seq 2), and the next search → `reroll_cooldown`. Fresh choice → commit 202, and the job's party hash equals the fresh chosen snapshot's (Bounty Board Riders).</li><li>Real, in the runbook upgrade 3d13921 → e002854: P's menu chosen on v8 (no stamp) → commit 409 `menu_stale`, then re-search 201 (seq 2), choose 200, commit 202, resolved. The fresh row carries `resolver_version 9`, `caravanBand 1`.</li></ul> | **Closed** |
| N3 CI timeout | 30 min against 19.9 min observed | `ci.yml:34` `timeout-minutes: 45`. AGENTS.md records the 15.3 → 17.6 → 19.9 min trend. | **Closed** |
| N5 runbook seed version | Step 5 expected "(set v5)" | Step 5 now names the `grep`. At 3d13921 it printed `AUTHORED_SET_VERSION = 5` and the seed "(set v5): 96 created". At e002854 it printed `= 7` and "(set v7): 0 created, 96 updated". | **Closed** |
| N2 (client fixer) guide copy | "From your next trip on…" | `strings.ts:15` `authoredUntil` ("until you have banked 2 trips"), used by `searchBody` (`:1427`) and `partyBody` (`:1527`) | **Closed** |

## Probes of what changed since round 4

- **The encounter-aware `pushAdvice` is pure and never reaches the resolver.**
  - `guide.ts` imports only `TUNABLES` and the `Manifest` type. `raise.ts` imports only
    `LIVING_UNIT_TYPES` and circle modules.
  - Neither holds I/O, a clock, randomness or float state. The FNV hash uses `Math.imul` / `>>> 0`.
    The Map iteration in `raiseOrder` is insertion order, so it is deterministic.
  - No file in `apps/server/src` or `packages/resolver/src` imports `pushAdvice`, `guidePick` or
    `guidedFormation`.
  - The server imports only `raiseUnits`, for the `suggested` read. Its output reaches a fight only
    after the owner saves it, and the save is validated against the web and the roster like any
    other.
  - The boundary check passed: "18 src file(s), zero dependencies".
- **`raiseUnits` / `raiseOrder`: no locked type, by construction and at the boundary.**
  - It skips `!unlocked` (`raise.ts:115`).
  - The server's roster is built from `unit_instance` with the caravan's unlocked set. The client's
    copy (`ShellGuide.tsx` `prefillParty`) gets the same flags from the server.
  - Any PUT is re-validated server-side, and a hand-made one naming a locked type is refused (party
    tests in `pnpm check`).
  - Live: 0 locked units in all four regions' suggestions.
  - A **packed** unit can appear, by design: `rules.unitsMayAlsoBePackedOnTrips: true`. A standing
    party is a template.
  - A unit **killed** in the current trip is still a roster instance until the trip ends, because
    loss applies at the bank or overrun. When it is then removed or de-merged,
    `standing_party_repaired` re-points or drops its slot, so the party never names a gone unit.
  - No erased or gone instance can be raised, because the roster is read from the live table.
- **Authored set v7 seeded over a v6 database with menus in flight.**
  - I built 46935a9 (set v6, migration 030, same resolver version and content hash), migrated a fresh
    `caravan_dev_c2` and seeded "(set v6): 96 created".
  - On the old server: two caravans chose and arranged (Alkali Freighters, Salt Flat Drifters), and
    one only searched (Prairie Wolf Pack, Timberline Gang, Alkali Freighters).
  - I stopped it gracefully. e002854's `migrate.js up` → "Nothing to apply", then `seed.js` → "(set
    v7): 0 created, 96 updated", and again → "96 already current". The new server started.
  - Both chosen menus committed → 202 and resolved. Each job's party hash equals the stored chosen
    snapshot's hash (`same: true`, stamp `[9, 876d50fb]`).
  - The searched-only menu read back byte-identical. I chose Prairie Wolf Pack, which v7 re-authored
    from `traps` to `nearest`. The job fought the **stored v6 snapshot** (stances `traps, traps`),
    while the live v7 party is `nearest, nearest`. The player fought what they scouted.
  - `authored_party` is all `set_version 7`. The 96 authored parties all resolve as valid, with no
    locked type, on both v7 databases (a script over `resolveStandingParty`).
- **`GET /me/economy?caravanId=` cannot read another account's caravan.**
  - Own caravan → 200, `earn.caravan {band 1, firstEncounter 600, shortestTrip 725}`.
  - Another account's caravan → **404** `not_found`, the same answer as a random UUID, so it is no
    existence oracle. The message echoes only the id the caller sent.
  - A non-UUID → 400 `invalid_caravan_id`. A repeated parameter → 400.
  - It reads `readOwnedCaravan(account, caravanId)` and the caravan-level living pool, which is the
    correct side of the split.
- **Per-viewer remembered commits.**
  - `committedFight.ts` stores `{manifestId, encounterIndex}` under `caravan.viewer.fight.committed`.
  - It is in try/catch, cleared by `resetViewerState()` on sign-out and on a forgotten session,
    dropped once read, and never sent to the server.
  - No token, Coin or opponent data is stored. The `api` client still keeps the bearer token in
    memory only.
- **Autosave keepalive.**
  - `pagehide` and a hidden `visibilitychange` flush only the pending debounce's draft, through the
    ordinary PUT with `keepalive: true` and the in-memory bearer token.
  - `settle()` (before a commit) clears the pending draft first. A late keepalive PUT can only hit a
    committed formation, which the server refuses; it cannot change a committed fight.
- **Inbox party-change coalescing and `windowOpen`.**
  - Coalescing is pure (`derive.ts` `partyChangedItems`). It groups events of one reason within 60 s,
    keys each group by its first seq, and makes the version the group's size, so a growing group
    re-surfaces as unread.
  - It reads at most 100 events and lists at most 10 notices.
  - `windowOpen` is `nowMs < windowEnd`.
  - Both are covered by their tests in `pnpm check`. Live, O's strike shows in O's inbox as
    `party_strike`.
- **Generated names.** The client no longer sends a guest name (`LoginScreen.tsx`), so the server
  generates it. 12 guests over HTTPS got 12 distinct names with distinct first parts (Painted Rock
  Trail Crew, Dusty Trail Crew, Red Mesa Wagons, …), and none equals an authored outfit's name.
  `firstPartTaken` binds only the server's own constant first part.
- **The Return to town route cannot be used to dodge a push or a loss.**
  - It needs: the open encounter, no job, no non-stale menu, and the server's own search (run in a
    savepoint, always rolled back) raising `PoolEmptyError` (`trip/service.ts:502-529`).
  - With 96 authored parties seeded, no player action empties the pool. I could not produce
    `pool_empty` without deleting the authored set as the owner.
  - When it does apply, it credits exactly what a bank at the last survived encounter would: 725 =
    725 above. It never refunds the cap, and it does not count as a bank for the authored-only rule.
  - So the most a "regretted push" can recover is the bank the player passed up, and only when the
    server truly cannot serve a fight.

## Whole-codebase guardrail sweep

- **Determinism.**
  - The 100× in-process harness, 3 processes, and the goldens, all byte-equal.
  - The gate against 3d13921 accepted the bump, and against round 4 the corpus is unchanged.
  - A grep of `packages/resolver/src` for `Math.sin|cos|tan|atan2|exp|pow|sqrt|random|log|hypot`,
    `Date.now`, `performance.now`, `new Date` and `**` found only comments.
  - The lint self-test passed.
- **No pay-to-win** (sandbox store, dev config).
  - Tier 3 ($25) → 201, and Coin is 40 000.
  - Recruiting `desert.sand_sharpshooter`, `desert.canteen_carrier`, `mountain.goat_herder`,
    `plains.homesteader`, `high_plains.homesteader`, `trap.bear_trap` or `siege.battering_wagon` →
    409 `not_unlocked`. `desert.dust_rider` → 201.
  - `unlocks/spend` → 409 `insufficient_points`.
  - The Coin reroll's pool is `["desert.dust_rider","desert.well_digger"]`. The caravan holds only
    those two types.
  - A grep of resolver, circle, matchmaking, party, trip, acquisition and jobs for purchase,
    entitlement and store state found only unlock-node "purchase order" (points), never billing.
- **The unlock web is the only gate.** The results are above, plus the raise probe.
- **Legibility.**
  - Candidates carry the full stored scout, and the trip preview itemizes unbanked Coin, the
    delivery bonus and every packed unit's HP.
  - A stale menu is never fought (N4). A menu in flight across an authored-set change is fought as
    scouted (above).
- **The account / caravan split.**
  - The new economy read uses the caravan-level living pool.
  - Authored-only counts the caravan's banked trips. The trip cap is per account (D's three trips).
  - Siege rating lands on the account (O).
  - No new read or write of ladder, Reputation or unlock state crosses the split in the diff since
    91612d0.
- **Bounded stakes.**
  - O's live party overran D on D's third trip (the first with live parties). D lost only what it
    had packed. O's 6 units were 6 before and 6 after. O was paid 300 (the party win, with D's
    unbanked 0).
  - The voided return applied nothing of the encounter.
  - `pnpm check`'s randomized stakes probe passed.
- **Ledger and menu immutability against `caravan_app`.** Each of these was refused:
  - UPDATE and DELETE of `ledger_event` ("append-only … refused (seq 1)"), TRUNCATE, DISABLE
    TRIGGER, `session_replication_role`, CREATE TEMP and CREATE FUNCTION;
  - UPDATE of `account.coin_balance` and of `pool_progress` Reputation and unlock points;
  - DELETE of `account`, of `trip_encounter` ("is history") and of `resolution_job` ("permanent");
    UPDATE of `resolution_job.status`;
  - INSERT into `account_admin`, `encounter_log` and `session`;
  - rewrites of `encounter_candidates` `resolver_version`, `content_hash` and `raider_cap` ("is a
    stored menu and is immutable"), of `refugee_menu` ("a drawn menu") and of ended `trip` rows ("has
    ended and is frozen");
  - DELETE of `refugee_menu` and of `encounter_candidates`;
  - execution of `account_erasure_core` and `encounter_log_compact_rows`.

  The app role can execute 13 SECURITY DEFINER functions plus the trigger function
  `ledger_event_project`, which cannot be called directly. `ALTER ROLE caravan_app SET …` still goes
  through as the role itself (round 2's accepted item). I reset it at once (no role settings), and
  production refuses to boot with one (observed).
- **Privacy, erasure and telemetry opt-out.**
  - D's live menu showed O's party as "Dry Gulch Fellowship", with owner keys `displayName,
    authored, flavor` only.
  - A scan of 13–14 GET bodies per player (`/me`, inbox, encounters, ledger, progression, export,
    trip, party, account, devices, onboarding, economy, candidates, the replay) found 0 hits for the
    other player's username, account id or caravan id.
  - O's erasure → 200 (`fightsStruckAnonymized 1`, `candidateMenusAnonymized 1`, …). O's token →
    401.
  - D's replay of the strike → 200, `renderable: true`, with no trace of O. O's username is left
    nowhere: ledger 0, menus 0, job inputs 0.
  - Telemetry opted in: `{"accepted":2,"dropped":0}`. Opted out: `{"accepted":0,"dropped":1,
    "optedOut":true}`, and 0 rows are left for the account's analytics id.
- **Fuzz.**
  - 9 620 requests over 74 routes in the dev config at the root, `?caravanId=`, `/trip/return` and
    `?ifNone=` forms included. Hostile ids, numbers, bodies, content types, and malformed and 2 MB
    JSON.
  - 4 810 more under `/api` through Caddy in the production config, with limits on (204 × 429).
  - **5xx: 17 × 500, all one cause (N2).** The other 11 were 502s: Caddy's "broken pipe" on the 2 MB
    bodies the server refuses before reading. That is the proxy's view of a 413, not a server fault.
  - The server logs have no other level-50 line.
- **Auth, cookie, CSRF and admin** (production config over HTTPS).
  - Cookie `Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure`.
  - A foreign Origin gets no `access-control-*` header, and its preflight → 404.
  - Resume with the cookie: `text/plain` → 415, form-encoded → 415, JSON → 200.
  - A write with only the cookie → 401, because writes take the bearer token only.
  - 11 wrong passwords → `401×10, 429`. The right one from that address → 429. Another username from
    the same address → 200.
  - The admin got 29 panels, `partyStrikes` among them, and `packFunnel` is `{…,"storeMode":"off",
    "counted":false}`. A player and an anonymous caller → 404.
  - `/me/store` `mode: "off"`, and a purchase → `store_unavailable`.
  - The page sends CSP, `X-Frame-Options: DENY`, HSTS, `Referrer-Policy: no-referrer` and `nosniff`.
    `*.js.map` → 404, and http → 308.
- **Logs.** 27 105 lines of server, drain and Caddy logs. 0 hits for either generated password, any
  test password, `caravan_device=`, `Bearer ` or a `password` field. Caddy's 11 `Authorization`
  hits are all `["REDACTED"]`.

## Should-fix

None.

## Design-level

None new. Pass 8's open telemetry items (BALANCE-LOG pass 8, "Open") are balance questions for the
dashboard, not guardrail findings.

## Nits

N1. **`pnpm check` fails about 40 % of runs: a server test still pins pass 7's raise order.**
- **Evidence.** `apps/server/test/party.test.ts:730` expects the suggested units to equal
  `unlockedUnits.slice(0, min(PARTY_SLOT_CAP, SUGGESTED_PARTY_MAX))`, the first three roster units.
  - Pass 8 made the raise round-robin over unit types (`packages/circle/src/raise.ts:90`
    `raiseOrder`, used by `raiseUnits` at `:115`).
  - The roster is ordered `ORDER BY created_at, id` (`apps/server/src/repo/unitInstances.ts:26`). A
    fresh roster is created in one transaction, so its order is random UUID order.
  - With 3 + 3 of two types, the first three roster units are the round-robin's {A₁, B₁, A₂} only
    when positions 2–3 hold one of each type: P = 12 / 20 = 60 %.
  - BALANCE-LOG pass 8's "Tests whose pins moved" updated `final-review-r4` and the web
    `guideModel`, but not this test.
- **Reproduction.** `pnpm --filter @caravan/server exec vitest run test/party.test.ts -t "suggests
  the saved party plus free unlocked units"`, 10 times: 3 failures; a second loop, stopping at the first failure, failed within 5 runs. One failing diff:

  ```
  -   "804c8249-5378-458e-83d3-cd88ba233f10",
  +   "d0e7d8f9-a52c-427a-8488-19c1617c4694",
  ```

  It also failed 2 of the 3 full `pnpm check` `test` steps.
- **Why only N.** The served behaviour is the decided one (observed live in all four regions). It
  breaches no guardrail and blocks no play test, because hosting does not run the tests. But CI is red
  about every other push until it is fixed, and a red gate hides real regressions.
- **Fix (minutes).** Expect `raiseOrder(roster).filter((u) => u.unlocked).slice(0, max)` (the
  `final-review-r4` test already does this), or compare against `suggestParty` / `raiseUnits` on the
  same roster. Then grep the tests for other `slice(0, … SUGGESTED_PARTY_MAX)` pins.

N2. **`GET /me/inbox/strikes/:window` answers 500 for a window number past PostgreSQL's timestamp
range.**
- **Evidence.**
  - `apps/server/src/inbox/service.ts:267` accepts any 1–15-digit window.
  - `listedStrikes` (`:229-230`) multiplies it by `INBOX_STRIKE_BATCH_WINDOW_MS` (3 600 000) and
    passes it to `to_timestamp`.
  - Above about 2.6 × 10⁹ windows, PostgreSQL raises "timestamp out of range: \"3.6e+15\"".
  - The code is from chunk 29 (692b93c). It is not new, and round 4's fuzz did not reach it.
- **Reproduction.** Any account: windows `0`, `999999999` and `2562047788` → 200 `{"strikes":[]}`.
  Windows `999999999999` and `999999999999999` → **500** `{"error":"internal"}`, with a level-50
  log line.
- **Impact.** No data or state is touched, and it is the caller's own empty inbox. The cost is one
  error line per request, under the auth rate limits.
- **Fix.** Refuse a window outside `[0, floor(nowMs / W) + 1]` with 400 `invalid_request` (or 404),
  and add the case to the inbox route tests.

## Accepted, not findings

- **Migration 030's down step refuses** once any tester has re-chosen after a stale menu, which is
  exactly the `menu_stale` path. The refusal reads "an encounter has a stale chosen menu and a fresh
  one". I observed it on the restored rehearsal database. Deleting that account made `down 2` → "Rolled
  back: 30_menu_version_stamp, 29_upgrade_safety", then `up` re-applied both (the per-stamp index and
  the park writer back). This is the documented design. The runbook never rolls back a play-test
  database, and it says never to run an older build on it.
- Round 2–4's accepted items still stand:
  - `caravan_app` can `ALTER ROLE` itself, which production refuses at boot.
  - The park writer parks newer versions too.
  - A SIGTERM right after a commit finishes the fight in progress. Observed: `completed|1`, then
    "shut down cleanly".
- A **Return to town** probe runs a full search in a savepoint. The route has no limit of its own, but
  a search with no stored menu is already immediate and unlimited, so it adds no new cost.

## docs/PLAYTEST-HOSTING.md followed literally (database `caravan_pt_c2`, port 3939)

Steps 1–9 ran on **3d13921** (a git clone checked out there, `RESOLVER_VERSION = 8`, set v5). Step 12
upgraded it in place to **e002854** (version 9, set v7), and steps 10 and 11 ran last. I used the
shared-instance mode with the roles `caravan_c2pt_owner` / `caravan_c2pt_app`, and `openssl rand
-hex 24` passwords.

| Step | Result |
|---|---|
| 0–1 | The variables as written (`PT_DOMAIN=localhost`, `PT_PORT=3939`). 3d13921: `pnpm install --frozen-lockfile`, `pnpm build` → "check-bundle: ok", "build ok". |
| 2 | The shared-instance SQL exactly as written: `CREATE ROLE … IN ROLE caravan`, `ALTER ROLE … SET role = caravan`, the app role `… INHERIT … IN ROLE caravan_app`, `CREATE DATABASE caravan_pt_c2 OWNER caravan`. All succeeded, through the local `caravan` superuser in place of `sudo -u postgres`. After step 4 on e002854, `datacl` has no PUBLIC entry, and both member logins connect. |
| 3 | The env file as written, `-rw-------`. |
| 4 | "Applied: 1_core_schema … 28_caravan_names". `status` `[x]` through 28. |
| 5 | The doc's grep printed `AUTHORED_SET_VERSION = 5`, and the seed printed "(set v5): 96 created" and "No login accounts were created". `--dev` → "seed --dev is refused when NODE_ENV=production". |
| 6 | "real resolver", "store: off (packs previewed, not sold)", "serving the client from …; API under /api; source maps not served", "Server listening at http://127.0.0.1:3939". systemd itself was not run (none here); SIGTERM stood in for `systemctl stop`. The boot refusals were all observed on e002854: default password, `CARAVAN_TEST_RESOLVER=double`, `CARAVAN_RATE_LIMITS=off`, `TRUST_PROXY=true`, `SERVE_WEB=1` with no client, `STORE_MODE=sandbox` and the same with `STORE_SANDBOX_IN_PRODUCTION=true`, and a role-level `statement_timeout = 1` ("refusing to start: the database role has role-level settings …"). |
| 7 | Caddy 2.8.4 with the doc's Caddyfile installed its local CA ("installed properly in NSS … / in linux trusts"). `/health` and `/api/health` → `{"ok":true}`. CSP, X-Frame-Options, HSTS, nosniff and Referrer-Policy present. `*.js.map` → 404, and http → 308. Then real play over `https://localhost/api`: an operator, an owner with a raised party, players A and B (banks, pushes, overruns), P (chose and arranged, not committed) and K (held encounter 1, pushed, arranged encounter 2). 9 fights on the old build. |
| 12 | <ul><li>**The version check** printed `-export const RESOLVER_VERSION = 8;` / `+… = 9;`.</li><li>K committed encounter 2, and I SIGKILLed the server right after the 202 (a crash). The job was `leased|1|server:vm:30633:resolver` with a live lease. Caddy → 502.</li><li>**The drain block as written**, with the old build on spare port 4239 (not `PT_PORT+1`, which belongs to the parallel reviewer). The count reached 0 in 5 s (17:03:50 → 17:03:55). Drain exit 0, "shut down cleanly", job `completed|2|server:vm:31611`.</li><li>A pre-upgrade dump, `-rw-------`.</li><li>`git checkout e002854`, install and build ("check-bundle: ok"). `migrate.js up` → "Applied: 29_upgrade_safety, 30_menu_version_stamp". The grep printed `= 7`, then "(set v7): 0 created, 96 updated".</li><li>The new build started. All six old sessions → 200.</li><li>K's drained fight ended its trip (`caravan_held → caravan_overrun`, in town), so K got the fight, not a void. P's v8 menu → `menu_stale`, then a fresh search and a resolved fight.</li><li>Replays: 8 × `200 v8 renderable=true` and 1 × `200 v9 renderable=true`.</li></ul> |
| 8–9 | "granted admin to 'c2gop'", and `list` shows `c2gop by reviewer_c2`. The dashboard (above). |
| Restarts (e002854, over HTTPS) | SIGKILL right after a commit: the job was `leased|1`, and after the restart and the 30 s lease it was `completed|2|server:vm:32445`, the trip `decide [caravan_held]`. SIGTERM 26 ms after a commit: "SIGTERM: shutting down …", the fight in progress finished (`completed|1`), then "shut down cleanly". |
| 10 | The dump (owner role, `umask 077`): 569 317 bytes, `-rw-------`. Restore into `caravan_pt_c2_restore` with `--no-owner --role=caravan` → exit 0. `migrate.js roles` → "Applied db/roles.sql". Both databases: 108 accounts, 4 655 events (`sum(seq)` 10 840 563), 13 jobs, 13 logs, 14 menus, 78 triggers, 30 migrations and the same `datacl`. On the restore, `caravan_app` has INSERT on `ledger_event` and no INSERT on `encounter_log`, no TRUNCATE, no TEMP, and PUBLIC executes 0 functions. The server ran against the restore on 4239: `/api/health` ok, login 200. |
| 11 | `standing_party_repaired` events: 0. Graceful stop, then `DELETE FROM account` → "DELETE 108", `migrate.js reset` → "Reset complete.", `seed.js` → "(set v7): 96 created". Restart: `/api/health` → `{"ok":true}`. A pre-reset device cookie and a bogus one → 401 `no_device`. Accounts: 96 system, 0 players. |

Migrations down and up on the restored database are recorded under "Accepted" above.

Clean-up:
- Every server I started and my Caddy are stopped. The play reviewer's server (pid 9758) and its
  files were untouched.
- `caddy untrust` → "uninstalled properly from NSS security databases" and "… from linux trusts".
  `ca-certificates.crt` has 0 "Caddy Local Authority" entries, and
  `/usr/local/share/ca-certificates` holds only the sandbox's proxy CAs.
- Dropped: `caravan_pt_c2`, `caravan_pt_c2_restore`, `caravan_c2pt_owner`, `caravan_c2pt_app` and
  `c2g_stranger`. The dumps, the env file and the password files are deleted.
- `caravan_app` carries no role setting.
- `caravan_test_c2` and `caravan_dev_c2` are kept (the dev one at set v7, migration 30).

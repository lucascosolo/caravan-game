# Final guardrail and technical readiness review, round 4 (reviewed at roadmap/phase-2-spec @ 91612d0)

**Verdict: NOT READY, by one should-fix item (S1): a caravan can be locked mid-trip with no way out.**
`pnpm check` passed from a fresh clone set up from AGENTS.md alone, on new database names. Every S and D
item from guardrail rounds 1–3 is still closed except round 2's D1, which round 3's play-test fix S2(b)
reopened in a wider form (D1 below). I reproduced each original problem; the others are gone. The six
guardrails held under the probes. The fuzz found no 5xx in 63 860 requests (dev config at the root,
production config under `/api` through Caddy). The hosting runbook worked as written from 3d13921 to
HEAD with data in place, using the documented drain. The blocker is the order of two rules in
`searchCandidates`. The bands 0–1 raider cap is computed over live **and** authored parties. The
authored-only rule (now "until 2 banks") then drops the live ones. So when three or more live
one-raider standing parties sit near the centre, a caravan that has banked fewer than 2 trips and
packed one unit gets an **empty** pool. Its search answers 503 `pool_empty` for good. Unpack, bank, a
new trip start and commit are all refused, so the caravan stays `on_trip` until those parties change.
Three free guest accounts can cause it on purpose, and a wiped tester rebuilding from one refugee is
exactly the caravan that meets it. The fix is a reorder of a few lines, plus a test. Once S1 is
closed I would call the build READY. D1 is a decision the orchestrator can take either way, and the
nits can wait.

Severity: **S** should-fix before outside testers, **D** design-level (needs an orchestrator decision),
**N** nit.

## What I ran (all observed, this session)

I used the databases `caravan_test_r4g` and `caravan_dev_r4g`, plus the rehearsal databases
`caravan_pt_r4g` and `caravan_pt_r4g_restore` (dropped afterwards). Every server and the e2e runs used
port 3943; the preview and the drain server used 4243. Heavy runs were sequential. The other agents'
servers (pids 6777, 30858, in their own worktrees) were never touched. I stopped only my own processes,
each by pid after checking its working directory.

- **Fresh clone, from AGENTS.md alone.**
  - I cloned the branch into the scratchpad. I wrote `.env` with the `_r4g` database names, plus
    `PORT` / `E2E_PORT` / `SMOKE_PORT` = 3943 and `E2E_WEB_PORT` = 4243.
  - `pnpm install`. Then `pnpm db:migrate`: "Applied: 1_core_schema … 29_upgrade_safety".
  - `pnpm db:seed:dev`: "Authored parties (set v6): 96 created", then the dev account with "the
    starting roster only".
  - Then the Playwright install.
  - The sandbox has no `sudo -u postgres`, so I created the databases with `CREATE DATABASE … OWNER
    caravan` over the existing `caravan` superuser login.
- **`pnpm check` → "all 11 steps passed in 19.9 min".**
  - typecheck 30 s, lint 6 s (the self-test: "66 violation lines flagged … 0 false positives"),
    test:boundary.
  - test 568 s: content 82, resolver 587, circle 113, web 490, server 822 (+1 skipped).
  - determinism 68 s (366 tests; "3 processes … × 3 runs agree with each other and with 72 golden
    logs"), perf:resolver 15 tests, build, migrate.
  - smoke: "NODE_ENV=production refused to start with the repo-default database password" and "built
    server (SERVE_WEB=1) answered /health, /api/health and /".
  - e2e: 12 passed (3.5 m). e2e:hosting: 14 passed (4.3 m).
- **The golden gate against 3d13921.** `DETERMINISM_BASE_REF=3d13921 pnpm determinism` → "73 golden
  file(s) changed since 3d13921c7d" and "accepted — RESOLVER_VERSION 8 → 9, every changed golden
  carries v9".
- **CI equals `pnpm check`.** `.github/workflows/ci.yml` has not changed since round 2. It sets up the
  Postgres 16 service, pnpm, and Node from `.nvmrc`, then runs `install --frozen-lockfile`, Playwright
  Chromium and exactly `pnpm check`. The job timeout is 30 min, against 19.9 min observed (N3).
- **Migrations down and up** on `caravan_dev_r4g`:
  - `db:rollback` → "Rolled back: 29_upgrade_safety". The writer and `walk_owner` were gone (0
    functions).
  - `down 2` → "Rolled back: 28_caravan_names, 27_menu_guards".
  - `db:migrate` → "Applied: 27_menu_guards, 28_caravan_names, 29_upgrade_safety". Both functions were
    back, `caravan_app` could execute the writer, and `account_erasure_rewrite` used `walk_owner`.
  - The documented `DELETE FROM account WHERE is_system OR username IS NULL` (105 rows), then
    `db:reset` → "Reset complete.", then `db:seed:dev` (v6, 96 created). `db:status`: 29 `[x]`.
- **The hosting runbook, followed literally from 3d13921, then upgraded to HEAD with the drain.** See
  the table at the end.

## Re-verification of guardrail rounds 1–3

| Item | Original problem | Reproduced now | Status |
|---|---|---|---|
| R1 S1 seed | `db:seed` created `dev` / `devpassword` with off-web, unledgered units | Production `seed.js`: "96 created" and "No login accounts were created". `seed.js --dev` under production: "seed --dev is refused when NODE_ENV=production". The repo-default password is refused (smoke, and the refusal sweep below). A sandbox-paid account's roster and refugee pool are only `desert.dust_rider` and `desert.well_digger`. | **Closed** |
| R1 S2 hosting | No way to serve the client and the API together; no runbook | `SERVE_WEB=1` under production, through Caddy: `/health` and `/api/health` → `{"ok":true}`, and http → 308. The headers include CSP, HSTS, `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. `*.js.map` → 404. A foreign Origin gets no `access-control-*` header, and its preflight → 404. The cookie is `Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure`. | **Closed** |
| R1 D1 store | The sandbox store was free Coin | Production: `store: off (packs previewed, not sold)`. `/me/store` returns `mode: "off"`, and a purchase → 409 `store_unavailable`. The dashboard's `packFunnel` is `{…,"storeMode":"off","counted":false}`. `STORE_MODE=sandbox` and `…=sandbox` + `STORE_SANDBOX_IN_PRODUCTION=true` are both refused at boot. | **Closed** |
| R1 D2 login lockout | 10 failures from 10 addresses locked the owner out | `TRUST_PROXY=1`. 11 failures from address A → `401×10 429`. A's correct password → 429, B's → 200, and the account's own device cookie → 200. The per-username backstop applies as decided: 100 failures from 10 addresses, and a fresh address then gets 429. | **Closed as decided** |
| R2 S1 relief re-draws | Free unlimited refugee re-draws below the floor | The owner role deleted 4 of 6 units (relief `{"active":true,"rosterFloor":3,"rosterSize":2}`). 40 refreshes → `{"409 free_refresh_not_due":30,"429 rate_limited":10}`. 0 free refreshes were accepted, and `refugee_menu` stayed at 1 row. | **Closed** |
| R2 S2 `raider_cap` guard | `caravan_app` could rewrite `encounter_candidates.raider_cap` | As `caravan_app`: `SET raider_cap = NULL`, `SET pool = '[]'` and the new `raider_cap.bandMax` rewrite → "is a stored menu and is immutable". | **Closed** |
| R2 D1 cap keyed on the search centre | A band-1 caravan packing one strong unit got only 2-raider parties | **Reopened by play-test r3 S2(b)** (`band.ts:499`). A caravan with **7** units (past `COLD_START_ROSTER_MAX` 6) packed 1, at living Reputation 400 → `raiderCap {"packedUnits":1,"cap":2,"relaxed":true,"excluded":92}`, three 2-raider outfits. At **840** (a band-2 caravan, ×2.0 encounter Coin): the same cap, centre 690, three 2-raider floor outfits. At 860: `raiderCap null`, with 4-, 5- and 5-raider parties. | **Regressed → D1** |
| R3 S1 old-version jobs | A v8 fight never resolved after the v9 upgrade | The runbook drain: K's v8 encounter-2 job was `leased|1|server:vm:26019` after a SIGKILL. The drain loop printed nothing, and the old build cleared it in 5 s (`completed|2|server:vm:27082`). The new build then started cleanly. The no-drain safety net is pinned by `trip-resolver.test.ts` in `pnpm check`. The park writer is executable by `caravan_app` (see N1 for PUBLIC). | **Closed** |
| R3 N1–N4 | Session race, the erasure name walk, the runbook notes, the sandbox in production | N1 and N3 are pinned by their tests in `pnpm check`. N2: erasing the party owner rewrote D's menu owner to "Departed outfit" (1), and the owner's name was left nowhere (ledger 0, job inputs 0, menus 0). D's struck replay → 200 `renderable: true`. N4: refused (above). | **Closed** |

## Probes of what changed since round 3

- **Authored-only until 2 banks: no farm found.**
  - A bank at encounter 0 is refused: `bank {encounterIndex: 0}` → 400. With `encounterIndex: 1`
    before the fight → 409 `not_survived` ("encounter 1 has not been survived on this trip").
  - One live guest played trip 1 (`authoredOnly true`, three authored owners), banked 725, then trip
    2 (`authoredOnlyTrip: true`), banked 725. Trip 3 had `authoredOnlyTrip: false`. A second guest's
    trip 3 menu was "Granite Company/L, Coyote Run/L, Stagecoach Rangers/L": live parties.
  - The count is `end_reason = 'banked'` only (`service.ts` `isAuthoredOnlyTrip`). As `caravan_app`,
    `UPDATE trip SET end_reason …` in either direction → "trip … has ended and is frozen".
  - Overrun-then-rebuild keeps a caravan authored-only, but an overrun loses every packed unit, and
    a trip ends only by a bank or an overrun. Staying authored-only past 2 banks therefore means never
    banking again, and so earning no Coin. The ladder pays per hold, the same against an authored or a
    live party.
  - Deleting and re-registering gives a new account with only the starting roster and 0 Coin.
- **The bands 0–1 packed-unit cap: a strong tanked player is not a farm, but the rule reopens round
  2's D1** (D1). An offline probe (`_r4tank.ts`, the server's own resolver path, not committed) ran 4
  regions × 8 seeds of one merged unit with 6 traps and a full fence. It used the tier-3 sturdiest
  type and the cap as served, with 16 layouts, pushing until the centre leaves band 1 or the caravan
  falls. Every party it met had 2 raiders.

  | packed | from rating | P(hold 1 / 2 / 3 / 6) | best bank point: gross / EV per trip |
  |---|---|---|---|
  | 1 × L3 | 400 | 88 / 72 / 44 / 22 % | k = 2: 1 192 / **+353** |
  | 1 × L4 | 400 | 94 / 63 / 47 / 19 % | k = 1: 680 / **+181** |
  | 1 × L5 | 400 | 100 / 75 / 63 / 41 % | k = 1: 725 / **+725** |
  | 1 × L5 | 600 | 100 / 72 / 59 / 41 % | k = 1: 725 / **+725** |

  Honest play is BALANCE-LOG pass 6: 8 × L1 at band 3 makes **+5 960** a trip, and 8 × L3 at band 4
  makes +5 783. Without repair a lone unit wears down, and it risks its whole value (22 787 Coin at
  L5). So the farm pays at most about 12 % of honest play.
- **The shared guide rule in `packages/circle` is pure and never feeds the resolver.**
  - `guide.ts` imports only `TUNABLES` and the `Manifest` type. `guideLayout.ts` imports only circle
    modules.
  - Neither file holds I/O, a clock, randomness or floats in state. One `Math.floor(side.length / 2)`
    is an integer index.
  - No file in `apps/server/src` or `packages/resolver/src` imports `guidePick`, `pushAdvice` or
    `guidedFormation`. The resolver boundary check passed: zero dependencies, internal imports only.
  - The guide is presentation, used by apps/web and `scripts/balance`.
- **Authored set v6 seeded over a v5 database with data in place** (the runbook upgrade):
  - The seed printed "Authored parties (set v6): 0 created, **96 updated**". A re-run printed "96
    already current". Every `authored_party` is now `set_version 6`. The ledger shows 1 088
    `unit_acquired` and 544 `unit_retired` events from the authored set.
  - Hardrock Hirelings now has stances `nearest ×4`, and Lumberjack Levy fields 6 raiders.
  - P's encounter-1 menu was chosen on v5/v8 and left uncommitted. It stayed byte-identical after
    the upgrade. Committed on v9, it resolved with the stored snapshot: its job party's `hash` and
    `composition` equal the menu's (2 raiders). The live authored roster had been replaced.
- **`coinEarned` / `coinTransferred` match the ledger.**
  - Owner O's standing party overran defender D at D's trip-3 encounter 2 (600 unbanked).
  - O's replay `settled`: `coinEarned 900`, `coinTransferred 600`,
    `coin [caravan_overrun 600, party_win 300]`.
  - The ledger under `progression:` / `transfer:<jobId>`: 900 earned, 600 transferred. O's inbox
    strike: `coinEarned 900, coinTransferred 600`.
  - D's banked encounters: `coinEarned 600` (400 × band 1's ×1.5, credited through the bank).
  - 5 replays checked, 0 mismatches.
- **`defender.username: null` everywhere strangers see.**
  - Both O and D had linked usernames.
  - O's inbox strike showed `"defender":{"username":null,"caravanName":"Dusty Supply","regionId":
    "desert","departed":false}`.
  - I scanned 21 GET bodies of both players: `/me`, the inbox, the feed, encounters, the ledger,
    progression, export, the trip, every replay and the candidate menus. There were 0 hits for the
    other player's username, account id or caravan id.
  - After O's erasure, D's replay of the strike shows owner `null`.
- **`resume?ifNone=null` is no new oracle.**
  - No cookie → 200 `{"session":null}` (the plain form: 401). A random cookie → the same, with the
    cookie cleared.
  - B's bearer token with no cookie → `{"session":null}`, and B's token still answers `/me`.
  - A's cookie with B's bearer → a session for **A**, `replacedPrevious: false`, and B is still 200.
  - An erased account's cookie → `{"session":null}`, and plain → 401.
  - `text/plain` → 415. The per-address limit holds: 620 calls → `{"200":600,"429":20}`.
  - So it answers only what the plain form already answers, and only to the holder of the cookie.
- **The upgrade-safety void path, migration 029.** It goes down and up (above). The drain rehearsal
  is in the table. `resolution_job_park_other_version` is SECURITY DEFINER with a pinned
  `search_path`. It parks a queued or expired-lease job of *any other* version, newer ones included,
  which the runbook already warns about.
- **The generated-name re-roll.**
  - `generatedCaravanName` steps through `seed~k` until a name is not reserved. It is deterministic
    and always ends: 1 024 combinations, and only a few are reserved.
  - The client's own generator (`LoginScreen.tsx:36`, 10 × 8 names) has **0 of 80** combinations in
    `RESERVED_CARAVAN_NAMES`, so "Start as guest" can never draw a 400 `reserved_caravan_name`.
  - Live guests got distinct generated names (Copper Convoy, Iron Rail Column, Sundown Movers, …).

## Whole-codebase guardrail sweep

- **Determinism.**
  - `pnpm check`'s determinism step: 72 fights × 100 in-process, then 3 processes, byte-equal to each
    other and to the goldens.
  - The gate against 3d13921 accepted the bump, and the lint self-test passed.
  - A grep of `packages/resolver/src` for `Math.sin|cos|tan|atan2|exp|pow|sqrt|random|log`,
    `Date.now`, `performance.now` and `new Date` found nothing.
- **No pay-to-win (sandbox store, dev config).**
  - I bought tier 3 for $0 → 201.
  - Recruiting `desert.sand_sharpshooter`, `desert.canteen_carrier`, `mountain.goat_herder` or
    `plains.homesteader` → 409 `not_unlocked`. `desert.dust_rider` → 201.
  - `unlocks/spend` with no points → 409 `insufficient_points`.
  - A reroll's pool is `["desert.dust_rider","desert.well_digger"]`.
  - A grep of the resolver, circle, `jobs/`, `trip/`, `matchmaking/`, `acquisition/`, `party/` and
    `economy/merge.ts` for purchase, entitlement, store and cosmetic state found only comments that
    say it is absent.
- **The unlock web is the only gate.** The recruit and reroll results are above.
- **Legibility.**
  - Candidates carry the full stored scout. The trip preview shows unbanked Coin and every packed
    unit's HP and level.
  - The one dent is the guide's copy, which promises live parties "from your next trip on" (N2).
  - A menu chosen before a resolver bump keeps its stored scout (N4).
- **The account / caravan split.** The authored-only rule counts the caravan's trips. The refugee
  and trip caps are per account. Held and overrun Reputation land on `pool_progress.caravan_id`, and
  the owner's rating on the account-level siege pool. Unchanged since round 3, and its tests pass.
- **Bounded stakes.**
  - In the O/D fight, D lost only what it had packed and its unbanked 600. O was paid 600 + 300,
    within its cap.
  - `pnpm check`'s randomized stakes probe passed ("preview == applied, Coin conserved … owners
    untouched").
- **Ledger and menu immutability against `caravan_app`.**
  - Refused:
    - UPDATE and DELETE of `ledger_event` ("append-only … refused (seq 1)"), and TRUNCATE;
    - DISABLE TRIGGER, `session_replication_role`, CREATE TEMP and CREATE FUNCTION;
    - UPDATE of `account.coin_balance` and of `pool_progress`;
    - DELETE of `account`, `trip_encounter` and `resolution_job`;
    - INSERT into `account_admin`, `account_erasure_active` and `session`;
    - any write to `encounter_log` or `encounter_log_summary`;
    - ALTER TYPE;
    - rewrites of `encounter_candidates`, `refugee_menu` and ended `trip` rows.
  - Every public function pins `search_path`. 13 SECURITY DEFINER functions are executable by the app
    role (round 3's 12 plus the park writer).
  - `ALTER ROLE caravan_app SET search_path …` still goes through as the app role itself. That is
    round 2's accepted item; I reset it at once (0 role settings), and production refuses it at boot.
    PUBLIC's EXECUTE on the SECURITY DEFINER functions is N1.
- **Privacy, erasure and telemetry opt-out.**
  - The privacy scan is above.
  - The party owner's erasure → 200 with counts (`fightsStruckAnonymized 1`,
    `candidateMenusAnonymized 2`, …). The old token → 401 and the old cookie's resume → 401.
  - A guest's erasure → 200. Its cookie then gets `{"session":null}` / 401, and its token → 401.
  - Telemetry opted in: `{"accepted":2,"dropped":0}`, 2 rows. Opted out:
    `{"accepted":0,"dropped":2,"optedOut":true}`, 0 rows.
- **Fuzz.**
  - 31 930 requests over 68 routes (`resume?ifNone=null` and the `?ifNone=` query forms included), in
    the dev config with limits on.
  - Another 31 930 under `/api` through Caddy, in the production config.
  - **0 responses ≥ 500, 0 level-50 log lines.** The only 5xx I met anywhere is S1's 503, which the
    fuzz does not reach.
- **Auth, cookie, CSRF and admin.**
  - Admin → 200 with 28 panels. A player and an anonymous caller → 404.
  - The cookie flags, the 415 on a `text/plain` resume and the absent CORS grant are in the table.
  - The production refusals, all observed: `STORE_MODE=sandbox`, and the same with
    `STORE_SANDBOX_IN_PRODUCTION=true` (only `1` counts); `CARAVAN_TEST_RESOLVER=double`;
    `CARAVAN_RATE_LIMITS=off`; `TRUST_PROXY=true`; `SERVE_WEB=1` with no client; the default
    password; and a role-level `statement_timeout = 1` ("refusing to start: the database role has
    role-level settings …").
- **Logs.** Across 107 938 lines of server, drain and Caddy logs: 0 hits for either generated database
  password, any test password, `caravan_device=`, an `authorization` header, `Bearer ` or a `password`
  field. None of the play-test players' issued tokens appear.

## Should-fix

S1. **[closed: fixr4g]** **A caravan on an authored-only trip that packs one unit can be served an empty pool, and is
then stuck on the trail.**

- **Cause.**
  - `searchCandidates` computes the cold-start raider cap over `counted`, which holds live **and**
    authored parties (`apps/server/src/matchmaking/service.ts:565`, `:573`).
  - The cap starts at the packed count and rises only while fewer than 3 of those parties fit
    (`band.ts:503`).
  - Then the authored-only rule removes the live parties (`service.ts:579-581`). If the cap stopped
    rising *because of live parties*, the authored parties under it can be zero.
  - With 1 packed unit: three live 1-raider parties within ±600 hold the cap at 1. No authored party
    has fewer than 2 raiders, so the pool is empty. `selectCandidates` draws 0 and the search throws
    `PoolEmptyError` (`service.ts:617`, 503).
  - The ingredients existed in round 3. This round widened both: authored-only now lasts until 2
    banks (an overrun no longer ends it), and in bands 0–1 the cap runs for any roster.
- **Pure reproduction** (`_empty.ts`, the server's own `coldStartRaiderCap` and `selectCandidates`):
  - three live 1-raider parties, packed 1 → cap 1, authored-only pool **0**, picks **0**;
  - packed 2 or 3, or live 2-raider parties → 3 picks.
- **Live reproduction** (built HEAD, dev config, real resolver):
  1. Three guests each `PUT /me/party` with one unit of their suggested party (200, `valid: true`).
  2. A fresh guest packs 1 unit and starts a trip (201).
  3. `POST …/encounters/1/search` → **503** `{"error":"pool_empty","message":"only 0 servable
     parties exist; 3 are needed — seed the authored parties (pnpm db:seed)"}`. Searching again → the
     same 503, with no cooldown, since no menu was stored.
  4. The trip: `phase "arranging"`, the caravan `on_trip`.
  5. Unpack → 409 `trip_open` ("a trip ends by banking or being overrun, never by unpacking").
     `trip/start` → 409 `trip_open`. Bank → refused, since nothing was survived. Commit → 409
     `no_draft`. `GET …/candidates` → `{"menu":null}`.

  The caravan stays stuck until fewer than three such parties stand within ±600 of its centre. Its
  trip-cap use is spent, and its packed unit is out of town.
- **Why it blocks.**
  - Three free guest accounts make it permanent on purpose: anyone can strand every new or rebuilding
    caravan that rides out with one unit.
  - It also happens with no ill intent. A wiped tester rebuilds one refugee claim at a time. Relief
    owes one menu at a time, so riding out with the 1 unit they have is the natural move. That caravan
    has fewer than 2 banks, so it is authored-only.
  - Standing parties shrink to one unit on their own, too, when party self-repair drops the slots of
    lost or merged units.
  - The tester sees an error with no remedy in the game or in the runbook. The operator is told to
    "seed the authored parties", which is already done.
  - This is the same failure class as round 3's S1: a caravan permanently stuck, an operational and
    data-integrity failure for that tester.
- **Fix (one session):**
  - In `searchCandidates`, apply the authored-only filter (and any other pool exclusion) **before**
    `coldStartRaiderCap`, so the cap relaxes over exactly the parties the draw can serve. Store the
    cap computed that way; the menu still replays from the row.
  - Defence in depth:
    - a search that cannot fill a menu for a trip with no committed encounter should let the trip be
      voided through the existing void path (it banks nothing, restores the units and refunds nothing),
      or let it unpack;
    - the 503 message should not tell a player to seed the database.
  - Tests:
    - three live 1-raider parties plus an authored-only caravan packing 1 → 3 authored 2-raider
      candidates (cap 2, relaxed);
    - the same with authored-only off → the live parties are served;
    - a pure test that `coldStartRaiderCap` is never given parties the pool will drop.

## Design-level

D1. **[closed: fixr4g]** **Round 2's D1 is reopened, wider: in bands 0–1 the cap keys on the search centre and the packed
count for any roster, and it hides whole raised parties from most low-band menus.**

- **Cause.** `band.ts:499`: `if (rosterSize > rosterMax && centreBand > bandMax) return null`, with
  `COLD_START_PACKED_CAP_MAX_BAND: 1` (`tunables.ts:619`). Round 2 closed D1 by keying the cap on the
  roster (pass 3, #23). The round-3 play-test decision S2(b) re-added a centre-band condition, so a
  caravan of any size now gets the cap whenever the centre is under 700. That covers encounter 1 for
  any caravan rated below 850, which includes **band-2 caravans paid ×2.0**.
- **Observed** (a 7-unit roster packing 1):
  - rating 400 → `cap 2, excluded 92`, three 2-raider outfits;
  - rating 840 → the same, at centre 690;
  - rating 860 → no cap, with 4-, 5- and 5-raider parties.
- **Measured: not a Coin farm.** The best bank point for one merged unit against capped menus is
  +181 to +725 a trip, against +5 960 for honest 8 × L1 (table above). A lone unit wears down, and an
  overrun destroys it.
- **What it does cost.**
  - **The passive layer at low bands.** The guide packs 5. In bands 0–1 every live party with 6 or 7
    raiders is left out of the pool whenever 3 parties at or under 5 stand within ±600. Authored
    outfits always do, since bands 0–1 field at most 4. That is every party the guide's "Raise my
    party from my roster" makes once a tester holds 6–7 units.
  - So while most testers sit in bands 0–1, which is most of the play test's first days, their raised
    parties are served only to caravans that pack 6 or more. Their inbox stays empty. The "reason to
    return" the inverted loop depends on is quiet exactly when it should be learnt.
  - Pass 6 measured what the cap removes from the defender's side. It did not measure the owner's
    serve rate.
- **Decide one:**
  - (a) **Keep it, and watch.** Add "strikes per live party per day, by party size, bands 0–1" next to
    the pool-health panel, and add the passive-starvation risk to BALANCE-LOG's open items.
  - (b) Run the band rule only while the caravan's **own** band is ≤ 1 (rating < 700), not the
    centre's. That restores round 2's D1 boundary for band-2 caravans.
  - (c) Let the band rule cap at `max(packed, GUIDE_PACK)`, so a 5-post circle still never meets 7
    raiders but a 1-unit pack does not narrow the menu below the guide's own size.

  I recommend (b) with (a)'s panel. It is one comparison in `coldStartRaiderCap`, and the stored
  `raider_cap` already records the band.

## Nits

N1. **[closed: fixr4g]** **PUBLIC can EXECUTE every SECURITY DEFINER function, so in the runbook's shared-instance mode any
other login on the cluster can mint a session for a known account id, or void every fight in
flight.**
- PostgreSQL grants EXECUTE on new functions to PUBLIC, and CONNECT on a new database to PUBLIC. Only
  `account_erasure_core` and `encounter_log_compact_rows` are revoked (migrations 023 and 025). A
  database ACL is `{=c/caravan,caravan=CTc/caravan}`.
- Observed with a throwaway role (`CREATE ROLE r4g_stranger LOGIN`, no grants), on `caravan_dev_r4g`:
  - it can connect and use schema public;
  - it can execute 13 SECURITY DEFINER functions, among them `session_issue`, `resolution_job_lease
    / complete / fail / park / park_other_version`, `account_erase` and `encounter_log_write`;
  - `SELECT … FROM session_issue('<dev's id>', NULL, 'stranger-minted-token-0123456789abcdef', now() +
    interval '1 hour')` succeeded. The server then answered `GET /me` with that bearer as `dev` (200);
  - `resolution_job_park_other_version('stranger', 0, …)` ran. It needs no knowledge at all, and with
    jobs queued it would park every one and void its trip.
  - I deleted the minted session and dropped the role.
- Scope: the attacker needs a login on the same Postgres cluster. The dedicated instance that step 2
  recommends has no such role, so this is not S. But step 2 documents the shared mode, and every
  reviewer has rehearsed in it.
- Fix:
  - in `db/roles.sql`, add `REVOKE CONNECT ON DATABASE <db> FROM PUBLIC`, with GRANTs to `caravan`
    and `caravan_app`;
  - add `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` and
    `ALTER DEFAULT PRIVILEGES FOR ROLE caravan REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, then GRANT
    EXECUTE on the 13 to `caravan_app` explicitly;
  - test, from a role with no grants: CONNECT is refused, and EXECUTE of each SECURITY DEFINER
    function is refused.

N2. **[open: the client fixer's branch]** **The guide still promises live parties "from your next trip on".**
- Since `AUTHORED_ONLY_UNTIL_BANKS` = 2, with overrun and voided trips not counted, three strings are
  wrong:
  - `apps/web/src/strings.ts:1409` (`searchBody`): "From your next trip on you also meet other
    players' standing parties";
  - `:1492` (`partyBody`);
  - `:1504` (`partyBodyNoFight`: "after it you also meet …").
- Observed: trip 2 was `authoredOnlyTrip: true`. A tester told otherwise reads their second trip
  wrongly.
- Fix: "Until you have banked two trips, every party is an authored outfit …". The candidate list
  could also show the rule when `authoredOnlyTrip` is set.

N3. **[closed: fixr4g]** **CI's time margin is shrinking.**
- `pnpm check` took 15.3 min (round 3), then 17.6 min (round 3's fix round), then 19.9 min now, on 4
  cores. `ci.yml` has `timeout-minutes: 30`.
- e2e:hosting alone grew to 4.3 min, and a slower runner would get close.
- Fix: raise the timeout to 45 min, or record the per-step times in the job summary and watch them.

N4. **[closed: fixr4g]** **A menu chosen before a resolver bump, and committed after it, resolves under the new rules
against the old stored scout.**
- Observed: P chose Salt Flat Drifters on v8 and committed on v9. The job ran v9 on the stored
  snapshot, which is correct and replayable, while the scout shown was derived under v8 content.
- Pass 5 did not change any stat a raider's scout shows, so nothing differed this time. A future bump
  that changes a raider stat would show the player outdated numbers. That is a legibility gap.
- Fix: in step 12, also drain "chosen, not committed" menus: they expire or are re-derived. Or, on
  commit, refuse a menu whose stored scout's content hash differs from the running content (409
  `menu_outdated`, search again). The second is cheap: the job input already carries `contentHash`.

N5. **[closed: fixr4g]** **The runbook's step 5 expects "(set v5)".** `docs/PLAYTEST-HOSTING.md:143`. The seed prints
"Authored parties (set v6)". Fix: say "(set vN)", or v6.

## Accepted, not findings

- `caravan_app` can `ALTER ROLE` itself, create large objects, and `UPDATE unit_instance.merge_level`
  and `caravan.name` (rounds 2–3, compromised-server class). Production refuses a role-level setting.
- `resolution_job_park_other_version` parks newer versions too. The runbook says never to run an
  older build against a database a newer one has run on.
- A SIGTERM right after a commit's 202 leaves the job `queued`, not resolved (observed:
  `queued|0|`). The next start resolved it in 1 s (`completed|1|…`). That is as documented ("takes no
  new fight") and safe within one version. Across a version bump the drain covers it.
- Party ratings only rise (round 2 D6). D1 and D3 of play-test round 3 are BALANCE-LOG telemetry
  questions.

## docs/PLAYTEST-HOSTING.md followed literally (database `caravan_pt_r4g`, port 3943)

Steps 1–9 ran on **3d13921** (a `git archive` export, `RESOLVER_VERSION = 8`). Step 12 then upgraded
it to HEAD (91612d0, version 9), and steps 10 and 11 ran last.

| Step | Result |
|---|---|
| 0. Variables | As written, with `PT_DOMAIN=localhost`, `PT_PORT=3943`, and the shared-instance roles `caravan_r4g_owner` / `caravan_r4g_app`. |
| 1. Build | 3d13921: `pnpm install --frozen-lockfile`, `pnpm build` → "check-bundle: ok …", "build ok". HEAD: the build from `pnpm check`. |
| 2. Roles and database | Shared-instance mode, exactly as the doc's SQL, with 48-hex `openssl rand` passwords. `CREATE DATABASE caravan_pt_r4g OWNER caravan`. All succeeded. I used the `caravan` superuser login in place of `sudo -u postgres` (sandbox). |
| 3. Env file | As written, mode `-rw-------`. |
| 4. Migrate | "Applied: 1_core_schema … 28_caravan_names". `status`: `[x]` through 28. |
| 5. Seed | "Authored parties (set v5): 96 created" and "No login accounts were created". `--dev` → "seed --dev is refused when NODE_ENV=production". |
| 6. Run | The log lines matched the doc: real resolver, `store: off (packs previewed, not sold)`, "serving the client from …; API under /api; source maps not served", "Server listening at http://127.0.0.1:3943". Every refusal in the doc's list was observed (sweep above). systemd itself was not run (none here). |
| 7. Caddy | Caddy with the doc's Caddyfile. It installed its local CA ("certificate installed properly in NSS security databases" / "… in linux trusts"). Every check in the doc passed. Then real trips over `https://localhost/api` (Node with the Caddy root): an operator, an owner, four players and two players left mid-state. 11 fights on the old build (14 resolved jobs by the end of the rehearsal), with banks, pushes and overruns, including live parties at trip 2 (Lost Spring Run, Wild Horse Train). |
| 8. Grant admin | "granted admin to 'r4gop'". `list` shows `r4gop  by reviewer_r4`. |
| 9. Dashboard | The admin got 28 panels, and `packFunnel` was `counted: false` with `storeMode: "off"`. A player and an anonymous caller → 404. |
| 12. Upgrade 3d13921 → HEAD, with the drain | <ul><li>**The version check** (`git diff 3d13921 HEAD -- packages/resolver/src/version.ts`) printed `-export const RESOLVER_VERSION = 8;` / `+… = 9;`. For HEAD~3..HEAD it printed nothing.</li><li>K held encounter 1 and pushed. K committed encounter 2, and the server was SIGKILLed right after the 202 (a crash, so there was no `systemctl stop`). The job was `leased|1|server:vm:26019:resolver|8`, and Caddy answered 502.</li><li>**The drain block as written**, with `PORT=4243` as the spare port. The old build listened, the count reached 0 in 5 s (10:52:47 → 10:52:52) and the drain exited 0 ("shut down cleanly"). The job was `completed|2|server:vm:27082:resolver`.</li><li>A pre-upgrade dump, `-rw-------`.</li><li>`migrate.js up` → "Applied: 29_upgrade_safety". `seed.js` → "(set v6): 0 created, 96 updated".</li><li>The new build started, and every resume → 200.</li><li>K's drained fight had ended its trip (`overrun`), so the player got the fight, not a void. P's pre-upgrade choice resolved on v9 from its stored snapshot.</li><li>Replays: 5 × `200 v8 renderable=true` and 1 × `200 v9 renderable=true`.</li></ul> |
| Restarts (HEAD, over HTTPS) | SIGKILL 153 ms after a commit: the job `queued|0|`, and after the restart `completed|1|server:vm:29975` within 1 s; the trip went on. SIGTERM 113 ms after a commit: "SIGTERM: shutting down …", then "shut down cleanly". The job `queued|0|`, then `completed|1|server:vm:30060` 1 s after the restart. |
| 10. Backups | The dump (as `PT_OWNER_ROLE`, `umask 077`) was 561 408 bytes, `-rw-------`. The restore into `caravan_pt_r4g_restore` with `--no-owner --role=caravan` exited 0. `migrate.js roles` → "Applied db/roles.sql". Both databases had 109 accounts, 4 684 events (the same `sum(seq)` 10 972 270), 14 jobs, 14 logs, 14 menus, 78 triggers and 29 migrations. On the restore, `caravan_app` has INSERT on `ledger_event`, and no INSERT on `encounter_log`, no TRUNCATE and no TEMP. |
| 11. Reset between cohorts | `standing_party_repaired` events: 0. I stopped the server (graceful). `DELETE FROM account` → "DELETE 109". `migrate.js reset` → "Reset complete.". `seed.js` → v6, 96 created. Restart: `/api/health` → `{"ok":true}`. A pre-reset device cookie and a bogus one on `/api/auth/resume` → 401 `no_device`. Accounts afterwards: 96 system, 0 players. |

Clean-up:
- Every server I started and Caddy are stopped. The other agents' servers were untouched.
- `caddy untrust` reported "uninstalled properly from NSS security databases" and "… from linux trusts".
  `/usr/local/share/ca-certificates` holds only the sandbox's proxy CAs, and `ca-certificates.crt` has 0
  "Caddy Local Authority" entries.
- Dropped: `caravan_pt_r4g`, `caravan_pt_r4g_restore`, `caravan_r4g_owner`, `caravan_r4g_app` and
  `r4g_stranger`. My dumps, the env file and the password files are deleted.
- `caravan_app` carries no role setting.
- `caravan_test_r4g` and `caravan_dev_r4g` are kept for the fix round.

## Orchestrator decisions (2026-10-20)

- **S1: never strand a caravan.**
  - Apply the authored-only filter before the raider cap is computed. The cap's minimal relaxation, which loosens it only enough to fill a menu, then works on the pool that can really be served.
  - If no menu can be filled at all, a trip with no committed encounter can be voided by the player. Make "Return to town" one tap, through the existing void path.
  - Replace the 503 copy that tells the player to seed the database with player-facing words.
  - Add a test with three one-raider live parties at the centre and a 1-unit caravan before 2 banks, which must still get a full authored menu.
- **D1: accept the recommendation, and protect the passive side.**
  - The bands 0–1 packed-unit cap is keyed on the caravan's own band (from its rating), not on the search centre.
  - "Raise my party" and the server's suggested party build a party of at most `SUGGESTED_PARTY_MAX` units (tunable, default 5, the guide's packed size), so a new player's standing party can be served to other new players. The player can still raise a bigger one by hand.
  - Add the dashboard panel: strikes per live party, by party size.
  - Re-run the balance gates. The guided targets must still hold.
- **N1: fix before any shared-instance play test.**
  - REVOKE CONNECT on the play-test database from PUBLIC, and REVOKE EXECUTE on every function in schema public from PUBLIC.
  - Grant explicitly to the owner and app roles in `db/roles.sql`. The runbook's shared-instance step does the same.
  - Add a test: a login with no grants can neither connect nor execute any definer function.
- **N2:** leave it to the client fixer, who is rewriting the authored-only copy now.
- **N3:** raise the CI job timeout to 45 minutes, and note the trend in AGENTS.md.
- **N4:** a commit whose chosen menu was stored under another resolver version or content hash is refused with 409 `menu_stale`. The client sends the player back to search, which is free. Add a test.
- **N5:** fix the runbook's expected seed version, and make the step read the version rather than hard-coding it.

## Fix round (branch `fixr4g`, 2026-10-20): S1, D1, N1, N3, N4 and N5 closed as decided; N2 left to the client fixer

Migration **030** (`030_menu_version_stamp`) carries N4.

- **S1, closed.**
  - `matchmaking/service.ts` `searchCandidates` applies the authored-only filter first (`servable`)
    and computes the raider cap over exactly those parties. The cap now relaxes over what the draw can
    serve.
  - A menu that cannot be filled is **409 `pool_empty`**, not 503. Its message is player-facing ("No
    raiding party can be served to your caravan for this encounter right now. Search again in a
    little while, or return to town …") and the body carries `returnToTown: true`. The operator's log
    gets a warn line: "pool_empty: only N servable parties for this search (if the authored parties are
    missing, run seed.js)".
  - **"Return to town"** is `POST /me/caravans/:id/trip/return {tripId, encounterIndex}`
    (`trip/service.ts` `returnToTown`). It is allowed only when:
    - the encounter is the open one, uncommitted, and has no current menu;
    - the server's own search, run in a savepoint and always rolled back, raises `PoolEmptyError`.
      Nothing is stored and no reroll wait starts.

    It then voids the trip through the existing void path (`voidTripTx`, `cause: "no_menu"`): it banks
    as of the last survived encounter, nothing of this encounter applies, and the cap use is not
    refunded. If a menu can be served, the answer is 409 `menu_available`, so a return is never a way
    out of a push. A pushed encounter 2 is covered the same way.
  - Client (the only `apps/web` edits besides N4's):
    - the Trail's unsearched screen shows the reason and a one-tap **Return to town**
      (`data-testid="return-to-town"`) on `pool_empty`;
    - `api.returnToTown`.
  - Tests:
    - `final-review-r4.test.ts`:
      - three live one-raider parties at the centre and a 1-unit caravan before 2 banks → a full
        authored menu (3 × 2-raider, cap 2 relaxed, `caravanBand: 1`);
      - with no authored set: 409 `pool_empty` with `returnToTown`, then a return → voided
        (`cause: "no_menu"`, 0 credited, cap not refunded), `in_town`, and re-packable;
      - with a menu available → `menu_available`, and the refused probe stored no menu.
    - web `ReturnToTown.test.tsx`.
  - **The S1 reproduction re-run live** (the fixr4g build, `caravan_dev_r4g`, real resolver):
    1. Three guests `PUT /me/party` with one raider each. A fresh guest packs 1 unit and starts a
       trip.
    2. Its search → **201**, `raiderCap {"packedUnits":1,"cap":2,"relaxed":true,"excluded":88}`, with
       Salt Flat Drifters, Prairie Wolf Pack and Bounty Board Riders, all authored, 2 raiders each. The
       same steps answered 503 `pool_empty` before the fix.
    3. Return to town → 409 `menu_available`.
    4. I then deleted the authored set as the owner role (`DELETE FROM account WHERE is_system` → 96)
       to force an unfillable menu. A fresh guest's search → 409 `pool_empty` with the player
       message, and **return → 200**. The trip is `{"caravan":"in_town","phase":"ended",
       "endReason":"voided"}`, `trip_voided` has `cause no_menu, credited 0, tripCapRefunded false`,
       and a re-pack → 201. The server log had the operator warn line and 0 level-50 lines. I reseeded
       afterwards (v6, 96 created).
- **D1, closed: the caravan-band key, `SUGGESTED_PARTY_MAX`, the panel.**
  - `band.ts` `coldStartRaiderCap(entries, centre, caravanRating, …)` keys the bands 0–1 rule on
    `bandOf(caravanRating)`. `raider_cap.caravanBand` is recorded, and older rows keep `centreBand`.
  - `TUNABLES.SUGGESTED_PARTY_MAX = 5`:
    - the server's `suggestParty` adds roster units only up to it, and never cuts a saved party;
    - the guide's `prefillParty` (`apps/web/src/onboarding/ShellGuide.tsx`, a two-line change, flagged
      because the onboarding fixer works nearby) does the same.
  - Dashboard panel `partyStrikes`: live parties now, and strikes fought in the window by party size,
    with the bands 0–1 share, overruns, and strikes per party per day. The admin screen renders it
    when present, and `telemetry-scale.test.ts` covers its two SQLs with checked-in plans.
  - **BALANCE-LOG pass 7**:
    - `first-trip.ts` is identical to pass 6: encounter 1 86 %, pushed encounter 2 90 %, delivered
      78 %;
    - `first-trip.ts --raised`, with the suggested party of 5 added: served fights 128, guided 91 %,
      best 95 %. The targets (60 / 70 %) hold;
    - `cold-start.ts` at ratings 400 / 700 / 840 is recorded.

    Open item: a raised Mountain or Badlands party of 5 is now served to fresh 5-post circles from
    their third trip on, and the guided layout holds it 2 of 8 times.
- **N1, closed.**
  - `db/roles.sql` revokes CONNECT on the database from PUBLIC and grants it to `caravan` and
    `caravan_app`.
  - It revokes EXECUTE on every function in schema public from PUBLIC, and grants it to
    `caravan_app`. The owner-only `account_erasure_core` and `encounter_log_compact_rows` are revoked
    from the app.
  - Default privileges keep both rules for later migrations.
  - The runbook's step 2 says so and gives the check.
  - Test: a fresh login with no grants cannot connect (42501). `has_function_privilege` is false for
    PUBLIC and for it on every function. Under `SET ROLE` it cannot call
    `resolution_job_park_other_version` (42501). The app keeps `session_issue`, the park writer,
    `account_erase` and the others.
  - Live on `caravan_dev_r4g`: `datacl` is `{caravan=CTc/caravan,caravan_app=c/caravan}`.
- **N3, closed.** `ci.yml` `timeout-minutes: 45`, and AGENTS.md records the 15.3 → 17.6 → 19.9 min
  trend.
- **N4, closed.**
  - Migration 030 adds `encounter_candidates.resolver_version` and `content_hash`. Both join the
    immutability guard (the catalogue-enumerating test covers them).
  - The one-chosen index becomes per stamp: `(trip_id, encounter_index, coalesce(resolver_version,
    0), coalesce(content_hash, ''))`.
  - `isStaleMenu` checks the stored stamps against this process's RESOLVER_VERSION and
    RESOLUTION_CONTENT_HASH; rows from before 030 count as stale.
  - Choosing from a stale menu, or committing a stale chosen one with no fight queued yet, is 409
    `menu_stale`. A search then replaces it at once, with no reroll wait and no `already_chosen`. The
    fresh choice commits against the fresh snapshot.
  - The latest-chosen readers (the resolution handler's snapshot check, analytics) read
    `ORDER BY search_seq DESC`.
  - Client: a `menu_stale` choose or commit returns the Trail to the search screen, with the notice
    "The game was updated after this menu was drawn …".
  - Down refuses while an encounter holds both a stale chosen menu and a fresh one.
  - Tests: `final-review-r4.test.ts` (commit → 409, nothing queued, immediate re-search, fresh choice
    → 202 against its party; choose on a stale menu → 409), and web `ReturnToTown.test.tsx`.
  - The runbook's step 12 explains it.
- **N5, closed.** Step 5 expects "(set vN)", and the step names the `grep` that reads N from
  `authored.ts`.
- **Migrations down and up** (`caravan_dev_r4g`): "Rolled back: 30_menu_version_stamp" (columns gone,
  009's index back), then "Applied: 30_menu_version_stamp" (the per-stamp index).

### Gates (observed)

- `pnpm check` on `caravan_test_r4g`, ports 3943/4243.
- The first run: content 82, resolver 587, circle 113, web 493, server 828 (+1 skipped), determinism,
  perf, build, migrate and smoke all passed.
- e2e failed once, on `onboarding.spec.ts` pinning the raised party at 7 ("Your standing party is up:
  5 units", D1 as decided). With the spec pinned to `SUGGESTED_PARTY_MAX`, `pnpm check -- --from e2e`
  → "all 2 steps passed": e2e 12 passed, e2e:hosting 14 passed.

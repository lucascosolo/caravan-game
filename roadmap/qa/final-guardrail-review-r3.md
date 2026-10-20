# Final guardrail and technical readiness review, round 3 (reviewed at roadmap/phase-2-spec @ 6efc311)

**Verdict: NOT READY, by one should-fix item that is an operations gap, not a guardrail breach.**
`pnpm check` passed from a fresh clone set up from AGENTS.md alone, on new database names. Every S and D
item from rounds 1 and 2 is still closed; I reproduced each original problem and it is gone. All six
guardrails held under the probes below. The fuzz found no 5xx in 8 928 requests. The changes since
round 2 work as described: session replacement, authored-only first trips, unique names, the `departed`
flag, `?ifNone=null`, the +8/−20 Reputation split, migrations 027 and 028, and the refugee limits. Old
v8 replays still render after the RESOLVER_VERSION 9 bump. The blocker came from the upgrade the brief
asked for, 3d13921 to HEAD with data in place. **A fight committed under resolver v8 and not finished
before the restart is never resolved by the v9 server** (S1). Its caravan stays "resolving" forever. No
player route gets it out, and the runbook gives the operator no remedy. It even says "a crash is safe
too … its trip continues". Every balance pass that bumps RESOLVER_VERSION during the play test will do
the same. S1 takes one session, and a runbook-only mitigation is enough to unblock (below). The four
nits can go either way. Once S1 is closed I would call it READY.

Severity: **S** should-fix before outside testers, **D** design-level (needs an orchestrator decision),
**N** nit.

## What I ran (all observed, this session)

Databases `caravan_test_r3g` and `caravan_dev_r3g`, plus the rehearsal databases `caravan_pt_r3g` and
`caravan_pt_r3g_restore` (dropped afterwards). Port 3949 for every server and Caddy's upstream, 4249
for the preview. Heavy runs were sequential. The play-test reviewer's server (pid 6191 on 3951, its own
worktree) answered `/health` before and after each of my stops. I stopped only my own processes, each by
pid after checking its working directory.

- **Fresh clone, from AGENTS.md alone.** I cloned the branch into the scratchpad and wrote `.env` with
  the `_r3g` database names and `PORT` / `E2E_PORT` / `SMOKE_PORT` = 3949, `E2E_WEB_PORT` = 4249. Then:
  - `pnpm install`;
  - `pnpm db:migrate`: "Applied: 1_core_schema … 28_caravan_names";
  - `pnpm db:seed:dev`: "Authored parties (set v5): 96 created", then the dev account with "the
    starting roster only";
  - the Playwright install.

  The `caravan` superuser role already existed on the shared cluster. The sandbox would not run
  `sudo -u postgres`, so I created the databases with `CREATE DATABASE … OWNER caravan` over the
  `caravan` login.
- **`pnpm check` → "all 11 steps passed in 15.3 min".**
  - Tests: content 82, resolver 587, circle 108, web 476, and server 814 (+1 skipped).
  - determinism 366, perf:resolver 15, build, migrate.
  - smoke: "NODE_ENV=production refused to start with the repo-default database password" and
    "built server (SERVE_WEB=1) answered /health, /api/health and /".
  - e2e: 12 passed (3.5 m), including `reloads.spec.ts`. e2e:hosting: 14 passed (3.4 m).
- **The golden gate against the previous commit.** `DETERMINISM_BASE_REF=3d13921 pnpm determinism` →
  "accepted — RESOLVER_VERSION 8 → 9, every changed golden carries v9". It also reported 366 tests and
  "3 processes … × 3 runs agree with each other and with 72 golden logs", exit 0.
- **CI equals `pnpm check`.** `.github/workflows/ci.yml` is unchanged since round 2. It sets up the
  Postgres 16 service, pnpm, and Node from `.nvmrc` (22), runs `install --frozen-lockfile` and
  Playwright Chromium, and then runs exactly `pnpm check`. `DETERMINISM_BASE_SHA` turns on the golden
  gate on pushes. On pull requests `scripts/determinism.mjs:68-72` falls back to `GITHUB_BASE_REF`. A
  null sha (branch creation) is skipped explicitly. The job timeout is 30 min, against 15.3 min
  observed.
- **The hosting runbook, followed literally from 3d13921, then upgraded to HEAD.** See the table at the
  end.
- **Restart mid-trip (same version).** On HEAD over HTTPS through Caddy, I committed encounter 1 and
  sent SIGKILL 57 ms after the 202. The job sat `leased|1|server:vm:14694`. After a restart it was
  `completed|2|server:vm:15327` within 24 s (once the lease expired), and the trip settled.
- **SIGTERM.** I committed a fresh caravan's encounter 1 and sent SIGTERM right after the 202. The log
  showed "SIGTERM: shutting down …" and then "shut down cleanly" 81 ms later. The process was gone after
  107 ms, and the job was `completed|1|server:vm:15464`, finished by the stopping process.
- **Migrations down and up** on `caravan_dev_r3g`:
  - `db:rollback` → "Rolled back: 28_caravan_names";
  - `down 2` → "Rolled back: 27_menu_guards, 26_playtest_fixes";
  - `db:migrate` → "Applied: 26_playtest_fixes, 27_menu_guards, 28_caravan_names";
  - afterwards the erasure body has both `names` and `raider_cap`, and there are 3
    `refugee_menu_guard*` triggers;
  - the documented `DELETE FROM account WHERE is_system OR username IS NULL` (122 rows), then
    `db:reset` → "Reset complete.", then `db:seed:dev` (96 created). `db:status` shows 28 `[x]`.

## Re-verification of rounds 1 and 2

| Item | Original problem | Reproduced now | Status |
|---|---|---|---|
| R1 S1 seed | `db:seed` created `dev` / `devpassword` with off-web, unledgered units | Production `seed.js`: "96 created" and "No login accounts were created". `seed.js --dev` under production: "seed --dev is refused …", exit 2. The repo-default password: "DATABASE_URL uses a default password from this repo …", exit 1. Authored rosters hold 544 unit rows and 544 `unit_acquired` events. Every non-system account without an unlock purchase holds only `desert.dust_rider` and `desert.well_digger`. | **Closed** |
| R1 S2 hosting | No way to serve the client and API together; no runbook | `SERVE_WEB=1` under production, through Caddy: `/health` and `/api/health` → `{"ok":true}`, http → 308. The headers are CSP, HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP and Permissions-Policy. `*.js.map` → 404. Dotfiles and encoded `..` paths → 404 or index.html, never a file. `/api/nope` → JSON 404. A foreign Origin gets no `access-control-*` header, and its preflight → 404. The guest cookie is `Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure`. | **Closed** |
| R1 D1 store | Sandbox store = free Coin | Production: `store: off (packs previewed, not sold)`. `/me/store` has `mode: "off"` and 3 offers, and a purchase → 409 `store_unavailable`. The dashboard's `packFunnel` is `{…,"storeMode":"off","counted":false}`. | **Closed** (see N4) |
| R1 D2 login lockout | 10 failures from 10 addresses locked the owner out | `TRUST_PROXY=1`, 11 failures from address A → `401×10 429`. A's correct password → 429, B's → 200, and A with the account's device cookie → 200. | **Closed as decided** |
| R2 S1 relief re-draws | Free unlimited refugee re-draws below the floor | Owner role deleted 4 of 6 units (relief `{"active":true,"rosterFloor":3,"rosterSize":2}`). 40 refreshes → `{"409 free_refresh_not_due":30,"429 rate_limited":10}`. Menus went 0 → 1 (only the relief menu the first GET drew). Another account was unaffected (409 `no_menu`, not 429). | **Closed** |
| R2 S2 `raider_cap` guard | `caravan_app` could rewrite `encounter_candidates.raider_cap` | As `caravan_app`: `SET raider_cap = NULL` and `SET raider_cap = '{}'`, `draw_rules`, `candidates` and DELETE are all refused ("is a stored menu and is immutable" / the delete guard). | **Closed** |
| R2 D1 raider cap keyed on roster | A band-1 caravan packing one unit got only 2-raider parties | A defender with a 6-unit roster packed 5. A 6-raider live party was left out of its band-0 menu, and the same owner's 3-raider party was served. The service and pure tests for the roster rule pass in `pnpm check`. | **Closed as decided** |
| R2 N5 `refugee_menu` guard | No guard at all | As `caravan_app`: UPDATE `offered_type_ids` → "is a drawn menu and is immutable". DELETE → "is history and may not be deleted while its caravan exists". TRUNCATE → permission denied. | **Closed** |
| PT-r2 S1 sign-outs | The 9th–11th reload signed the player out | `reloads.spec.ts` (50 reloads) passed in both e2e runs of `pnpm check`. Sequential cold resumes never return a dead token (see also N1). | **Closed** (race residue in N1) |
| PT-r2 S2 ranged first fights | Testers' raised ranged pairs beat the guided first fight | Trip 1: `authoredOnlyTrip: true` with three authored candidates at encounter 1, after a pack, unpack and re-pack. Trip 2: `authoredOnlyTrip: false`, and a live party was served and fought. | **Closed** |

## Probes of what changed since round 2

- **Session resume and replacement.** The probe script drove the built server over HTTP with real device
  cookies.
  - **No cross-account or cross-device eviction.**
    - A's cookie with B's token as `Authorization` → 200, `replacedPrevious: false`, and B's token still
      answers `/me` (200).
    - The same with B's token as `{ previousToken }` → the same result.
    - The same account on a second device, its token named by device 1's resume → `false`, and device
      2 still 200.
  - **No revoked token stays alive.**
    - Device 1 revokes device 2 (204). Device 2's token → 401, its cookie's resume → 401, and a resume
      naming its dead token → 401.
    - A linked logout (204): the old token → 401, and replaying the old cookie → 401.
    - Account deletion (200): the old cookie → 401 and the old token → 401.
  - **Two tabs racing on the same previous token:** both 200 / `replacedPrevious: true`, both new
    tokens answer 200, and the old one → 401.
  - **Junk `previousToken`** (a number, null, an object, 5 000 characters, an array) → 200, ignored.
  - **Concurrent cold resumes on a device that already has about 10 sessions in use** can each evict
    the other. That is N1.
- **Authored-only first trips: no re-trigger.**
  - `isAuthoredOnlyTrip` counts the caravan's earlier `trip` rows (`matchmaking/service.ts:645-654`).
  - An unpack happens before any trip row exists, so it changes nothing; I observed trip 1 still
    authored-only after a pack, unpack and re-pack.
  - A void keeps its trip row (`trip_guard_delete`). As `caravan_app`, DELETE of `trip` → "trip … is
    history and may not be deleted while its …". There is no caravan-delete route.
  - Erasing an account and starting a new guest gives a new account with only the starting roster and
    no Coin. It is a new player, so nothing carries over to farm.
  - Trip 2 served live parties again, as tested.
- **Unique caravan names and their erasure.**
  - Requesting a name already taken gives ordinals II…X.
  - The 11th request for the same name got the bare name again, a duplicate. A case-variant request
    after exhaustion also got a duplicate.
  - Erasure replaces the departed caravan's name in other players' menus. But it also replaces any
    *unit, ability or siege label* equal to that name: N2.
  - A caravan named `%`, `_`, `"`, `\` or "Battering Wagon" was created and erased cleanly. The `%`
    erasure scanned all 3 460 ledger rows in 161 ms.
- **The `departed` flag.** Owner O's party struck defender D. O's feed showed `{"username":null,
  "caravanName":"Painted Rock Party","regionId":"desert","departed":false}`. After D deleted their
  account it showed `{"username":null,"caravanName":null,"regionId":null,"departed":true}`. O's inbox
  carries `"departed":true` and not D's account id.
- **`formation?ifNone=null`.**
  - Packed with no draft: 200 `{"formation":null,"encounterIndex":n}` for n = 1, 2 and 99. Without the
    parameter it is still 404 `no_formation`.
  - With nothing packed, both forms → 404 `no_open_manifest`.
  - A foreign caravan → 404 `no_caravan`, and an anonymous caller → 401.
  - A repeated parameter (`?ifNone=null&ifNone=null`) falls back to the plain answer. The fuzz sent it
    with junk ids and junk numbers, with no 5xx.
- **`POST_ENGAGEMENT_BONUS` and RESOLVER_VERSION 9.**
  - The 72 goldens, the work counters and the gate are covered above.
  - **Old logs:** after the upgrade, all 8 v8 replays of the four rehearsal players → 200, `renderable:
    true`, `resolverVersion` 8. The reader (`packages/resolver/src/replay.ts:448`) accepts any version.
  - **Old jobs:** S1.
- **The +8 / −20 split.** Live `reputation_changed` payloads:
  - held at 373 against 223 → +5;
  - overrun at 400 against 250 → −27.

  That is +8 and −20 gap-scaled for encounter 1's 150-point offset, and the floor never clamped.
  `assertReputationTunablesCoherent` keeps the attacker's loss at 0.
- **Migrations 027 and 028.** Both go down and up (above). Their guards hold as `caravan_app` (above).
  The 028 erasure patch is in place after the re-up.
- **Refugee rate limits.** 30 a minute per account, shared by claim, refresh and reroll; the 31st call
  is 429 and another account is unaffected (R2 S1 above).

## Whole-codebase guardrail sweep

- **Determinism.** `pnpm check`'s determinism step: 72 fights × 100 in-process, then 3 processes,
  byte-equal to each other and to the goldens. The golden gate against 3d13921 accepted the bump. The
  lint self-test passed ("66 violation lines flagged … 0 false positives"), and so did the boundary
  check ("zero dependencies, all imports internal") and the bundle check (`battlefield.ts`, `fixed.ts`
  and `replay.ts` only). A grep of `packages/resolver/src` for `Math.sin|cos|atan2|exp|pow|sqrt|random`,
  `Date.now` and `performance.now` found nothing.
- **No pay-to-win (sandbox store on, dev config).** I bought tiers 1, 2 and 3 for $0 (balance 50 000 at
  cap). Then:
  - recruit of `desert.sand_sharpshooter`, `desert.canteen_carrier`, `mountain.goat_herder`,
    `plains.homesteader` and `badlands.gunslinger` → 409 `not_unlocked`, while `desert.dust_rider` →
    201;
  - `unlocks/spend` with and without a `coin` field → 409 `insufficient_points`;
  - the refugee pool is `["desert.dust_rider","desert.well_digger"]` for both the paid and the free
    account.

  A grep of the resolver, circle, `jobs/`, `trip/`, `matchmaking/`, `party/`, `acquisition/` and
  `economy/merge.ts` for purchase, entitlement, cosmetic and store state found only unlock-node
  "purchase order" (points, not Coin).
- **The unlock web as the only gate.** See the starter-types query in the table (R1 S1) and the recruit
  results above.
- **Legibility.**
  - Candidates carry `authoredOnlyTrip`, `raiderCap` and the full scout.
  - The trip preview shows `unbankedCoin` and every packed unit's HP and level before commit.
  - N2 is the one legibility dent: an erasure can rename unit labels in a stored menu's scout.
- **Account vs caravan split.** The authored-only rule counts the caravan's trips. Held and overrun
  Reputation land on the caravan's living pool (`pool_progress.caravan_id`), and the party rating on the
  owner's account-level siege pool. The refugee limit is keyed per account, which matches the
  account-level hourly cap.
- **Bounded stakes** (three live-party trips; the third ended in an overrun):
  - the defender kept 5 / 5 town units and its banked 725 Coin;
  - the attacking owner's 6 units and merge levels were unchanged, and its party stayed `valid: true`;
  - `pnpm check`'s randomized stakes probe passed ("preview == applied, Coin conserved … owners
    untouched").
- **Ledger and menu immutability as `caravan_app`.**
  - Refused:
    - UPDATE, DELETE and TRUNCATE of `ledger_event`;
    - UPDATE of `account.coin_balance` and of `pool_progress` reputation and ladder;
    - DELETE of `trip`, `trip_encounter` and `resolution_job`;
    - UPDATE of a completed job's input;
    - INSERT and DELETE on `encounter_log`;
    - INSERT into `account_admin` and `account_erasure_active`;
    - `caravan.region_id`;
    - DISABLE TRIGGER, `session_replication_role`, CREATE TEMP, CREATE FUNCTION, and a CREATE OR
      REPLACE of `account_erasure_display_name`.
  - Exactly 12 SECURITY DEFINER functions are executable by the app role, every public function pins
    `search_path`, and the app role has 0 role settings.
  - Went through (rolled back): `UPDATE unit_instance SET merge_level = 5` (693 rows) and `UPDATE
    caravan SET name` (124 rows). There is no route for either. They are projections the server must
    write, and the ledger parity tests would catch a drift. This is the same compromised-server class
    as round 2's accepted items, recorded below.
- **Privacy.** A scan of 96 GET bodies across four players, including the export, ledger, feed, inbox,
  replays, candidates and progression, found 0 hits for any other account's id, caravan id or username.
- **Erasure.** Delete → 200 with counts. Old cookie and old token → 401. A struck replay stays
  `renderable: true` after its party's owner is erased. The job input carries no display names (0
  occurrences before or after).
- **Telemetry opt-out.** Opted in: `{"accepted":2,"dropped":0}`, 2 rows. Opted out: `{"accepted":0,
  "dropped":2,"optedOut":true}`, and 0 rows remain.
- **Security.**
  - **Fuzz.** 4 464 requests over 62 routes at the root (66 listed; account delete, logout and the two device-revoking routes were skipped to keep the fuzz session alive) (dev config, limits on) and 4 464 under `/api`
    through Caddy (production config). Each covered junk ids, numbers, query strings and bodies, broken
    JSON and anonymous calls. 0 responses in the 5xx range and 0 level-50 log lines in either run.
  - **Logs.** In every server and Caddy log (about 18 600 lines) I found no bearer token, password
    field, device cookie, database password or test password.
  - **Admin.** A player and an anonymous caller → 404. The admin → 200 with 28 panels.
  - **Cookie and CSRF.** The cookie is HttpOnly, `SameSite=Strict` and Secure. The API takes bearer
    tokens only. A `text/plain` cross-site-style POST to `/auth/resume` → 415. There is no CORS grant.
  - **Production refusals, all observed:**
    - `CARAVAN_TEST_RESOLVER=double` → `TestResolverRefusedError`;
    - `CARAVAN_RATE_LIMITS=off` → refused;
    - `TRUST_PROXY=true` → refused;
    - `SERVE_WEB=1` with no client → refused;
    - a role-level `statement_timeout = 1` → "refusing to start: the database role has role-level
      settings (statement_timeout=1 (every database)) …", exit 1.

    `STORE_MODE=sandbox` is *not* refused: N4.

## Should-fix

S1. **[closed: fixr3g]** **A fight committed under the previous RESOLVER_VERSION is never resolved after an upgrade, and its
caravan is stuck for good.**

- **Cause.**
  - The lease takes only jobs "enqueued for exactly p_resolver_version, so a worker on another version
    never takes it" (`apps/server/migrations/002_ledger_and_jobs.up.sql:477-483`, the filter at
    `:502`; `apps/server/src/jobs/queue.ts:129-142`). That was designed for a rolling deploy, where old
    workers keep draining.
  - The play test runs one process (runbook step 6), so after `systemctl restart` no v8 worker is left.
    Nothing parks or re-enqueues an old-version job.
  - The runbook's upgrade step (`docs/PLAYTEST-HOSTING.md:319-329`) has no drain step. `:205-206`
    promises "A crash is safe too: a fight whose resolver died holding the job's lease is picked up
    again when the 30 s lease expires, and its trip continues". That is not true across a version bump.
- **Reproduction** (the brief's upgrade, observed):
  1. Host 3d13921 (v8) per the runbook, with players, parties and fights.
  2. Commit caravan K's encounter 1 over HTTPS and SIGKILL the server right after the 202. The job is
     `leased|1|…|8`.
  3. Step 12: `migrate.js up` → "Nothing to apply". `seed.js` → "96 already current". Start HEAD (v9).
  4. 73 s later the job is still `leased|1|server:vm:13454:resolver`, with its lease long expired.
- **What K sees:**
  - the trip → `phase: "resolving"`, caravan `on_trip`;
  - bank and push → 409 `not_survived`;
  - commit again → 200, the same job;
  - unpack → 409 `trip_open`; a search for encounter 2 → 409 `wrong_encounter`; trip/start → 409
    `trip_open`.

  Five of K's six units are inside that trip. The only way out I found was to start the *old* build
  against the database: it leased the job and completed it within 3 s (`completed|2|server:vm:15548`).
  After that the trip went on.
- **Why it blocks.**
  - Upgrades during the play test are a documented operation. Balance passes bump RESOLVER_VERSION:
    pass 5 just did, and BALANCE-LOG lists four open telemetry questions.
  - Any fight that is in flight, retrying (`next_attempt_at` backoff) or held by a crash at the restart
    strands that tester's caravan permanently, with no in-game or documented operator remedy.
  - That is a data-integrity and operations failure for the tester. It looks like a hung game, and it
    cannot be reported usefully.
  - A graceful SIGTERM narrows the window but does not close it: retries and crashes remain.
- **Fix (one session; pick one, or do both):**
  - (a) **Runbook only, enough to unblock.** In step 12, before `systemctl restart`, when the new
    commit changes `RESOLVER_VERSION`:
    1. Stop the old server with `systemctl stop` (graceful).
    2. Check `SELECT count(*) FROM resolution_job WHERE status IN ('queued','leased')`.
    3. If it is not 0, run the **old** build once more until it reaches 0. That is exactly what I did
       to recover K. Two things help: `ENV_FILE=… node <old>/apps/server/dist/index.js` with
       `HOST=127.0.0.1` and a spare `PORT`, and the in-process worker drains within seconds.

    Correct the "a crash is safe" sentence to say "within one resolver version".
  - (b) **Code.** At boot, the in-process worker parks every queued or leased `encounter_resolution` job
    whose `input.resolverVersion` is below `RESOLVER_VERSION`, with reason `resolver_upgraded`. It then
    runs `TRIP_SETTLE_HOOKS.afterParked`, so the trip is voided the way a parked job's trip already is:
    survived encounters credited, units restored, and the cap use not refunded.
    - Log the count.
    - Test: enqueue a job with `resolverVersion: RESOLVER_VERSION - 1`, boot the app with the worker,
      and assert that the trip is voided and the caravan is back in town.

    (b) also covers a crash that the runbook cannot.

## Design-level

None.

## Nits

N1. **[closed: fixr3g]** **Concurrent cold resumes on a busy device can still hand out a dead token.**

- `issueSession` (`apps/server/src/auth/sessions.ts:75-83`) inserts the new session. It then evicts the
  device's others down to cap − 1, excluding only its own id (`repo/sessions.ts:51`, `:68`). A
  *concurrently* issued session is not "in use", so it sorts last and is cut.
- The client never sends `previousToken` after a reload, because its token is in memory only (no
  occurrence in `apps/web/src`). So every reload adds a session, and a tester who reloads about 9 times
  in 5 minutes reaches the cap.
- Observed, 5 trials each:

  | sessions in use on the device | concurrent cold resumes | issued tokens already dead |
  |---|---|---|
  | 9 | 2 | 7 / 10 |
  | 10 | 2 | 9 / 10 |
  | 8 | 2 | 0 / 10 |
  | 5 | 2 | 0 / 10 |
  | 0 | 6 | 0 / 30 |

- The client recovers. `onUnauthorized` re-resumes up to 3 times a minute, then shows the
  `session_lost` retry card, never the start screen. So nothing is lost, but two tabs reloading together
  after an upgrade ("ask testers to reload") can flash a sign-out or show the retry card.
- Fix: run the insert and the eviction under `pg_advisory_xact_lock(hashtext(device_id))` in one
  transaction. Or exclude sessions created in the last few seconds from the eviction candidates. Add a
  test with 9 in-use sessions and 2 concurrent resumes.

N2. **[closed: fixr3g]** **Erasure's name walk rewrites any `displayName` equal to the erased caravan's name, not just the
owner's, and names can still collide.**

- `account_erasure_walk_names` (`apps/server/migrations/028_caravan_names.up.sql:30`) replaces every
  `displayName` key whose value is one of the account's names.
- Caravan names are free text (`services/onboarding.ts:38-45`). Uniqueness is checked only against
  other caravans (`services/caravanNames.ts:50-64`). So a caravan can be named after a unit, ability,
  siege or trap.
- **Observed.** I made guest V's caravan "Dust Rider" with a 3-unit party, and defender D's trip-2 menu
  served it and D fought it. After V deleted their account, D's stored menu read "Departed outfit:
  Departed outfit, Departed outfit, Well Digger". The departed party's two **Dust Rider unit labels**
  were renamed along with its owner name ("Dust Rider" labels in D's menus went 4 → 1). Any other
  candidate in the same menu with Dust Riders, such as an authored outfit, would be renamed too.
- **Ordinals run out.** Eleven requests for one name got base, II…X, and then the bare base again
  (`caravanNames.ts:64` returns the requested name). So two live caravans can share a name. Erasing one
  then renames the other's `displayName` in every menu that held both. A tester can also name a caravan
  "Departed outfit" and pass as departed.
- Scope is small. Only menus whose pool held the erased party are walked (step 5). The ledger payloads
  carry no display names (0 rows matched before and after). The job input carries none either, and
  replays stayed `renderable: true`.
- Fix (one session):
  - In the walk, replace `displayName` only inside an object that also carries `ownerAccountId` (or
    `authored: false`) equal to the erased account. That is the `owner` object, not unit or siege
    entries.
  - Reserve content display names, "Departed outfit", "Departed caravan" and the authored outfit names
    in `uniqueCaravanName`.
  - When the ordinals are exhausted, append a short hash instead of returning the duplicate.
  - Test: erase a caravan named after a unit type and assert that the unit labels survive.

N3. **[closed: fixr3g]** **The runbook's upgrade step says nothing about a resolver version change.** Covered by S1 (a). I
list it on its own because the doc fix is worth doing even if S1 is closed in code. Step 12 should say
which commits bump `RESOLVER_VERSION`; `git diff <old>..<new> -- packages/resolver/src/version.ts` is
enough. It should also say that old replays keep rendering (observed: 8 / 8 v8 replays `renderable:
true`).

N4. **[closed: fixr3g]** **`STORE_MODE=sandbox` starts under `NODE_ENV=production`.** `storeModeFromEnv`
(`apps/server/src/config.ts:152-157`) defaults to `off` in production but accepts an explicit `sandbox`.
Observed: with the play-test env plus `STORE_MODE=sandbox`, the server got past every check and failed
only on the port in use. The other dev-only switches (test resolver, rate limits off, `TRUST_PROXY=true`)
are refused. One stray line in the env file would hand testers 60 000 free Coin a week, which is round
1's D1. Fix: refuse `sandbox` under production unless an explicit `STORE_MODE_ALLOW_SANDBOX_IN_PRODUCTION=1`
is set, or refuse it outright. Add it to step 6's refusal list.

## Accepted, not findings

- The erased party's id stays in other players' records (QA-30 N8, accepted then).
- `caravan_app` can `UPDATE unit_instance.merge_level` and `caravan.name`, besides the round-2 items
  (`ALTER ROLE` on itself, large objects). Each is a compromised-server path: the server must write
  merge levels, and the ledger parity tests catch a drift.
- Party ratings only rise (round 2 D6, BALANCE-LOG open item 7).
- Encounter 1 is searched 150 below the caravan, so a hold there earns +5 and an overrun costs −27
  (observed). That is the pass-5 numbers under the existing offset, BALANCE-LOG's domain.

## docs/PLAYTEST-HOSTING.md followed literally (database `caravan_pt_r3g`, port 3949)

Steps 1–10 ran on **3d13921** (`PT_REPO` an export of that commit, `RESOLVER_VERSION = 8`). Step 12 then
upgraded it to HEAD (6efc311, version 9), and step 11 ran last.

| Step | Result |
|---|---|
| 0. Variables | As written, with `PT_DOMAIN=localhost`, `PT_PORT=3949`, and the shared-instance roles `caravan_r3g_owner` / `caravan_r3g_app`. |
| 1. Build | 3d13921: `pnpm install --frozen-lockfile`, `pnpm build` → "check-bundle: ok …", "build ok". HEAD: the build from `pnpm check`. |
| 2. Roles and database | Shared-instance mode: `CREATE ROLE … IN ROLE caravan`, `ALTER ROLE … SET role = caravan`, the app login `IN ROLE caravan_app`, and `CREATE DATABASE caravan_pt_r3g OWNER caravan`, with 48-hex `openssl rand` passwords. All succeeded. I used the `caravan` superuser login in place of `sudo -u postgres` (sandbox). |
| 3. Env file | As written, mode `-rw-------`. |
| 4. Migrate | "Applied: 1_core_schema … 28_caravan_names". `status`: `[x]` through 28. |
| 5. Seed | "Authored parties (set v5): 96 created" and "No login accounts were created". `--dev` was refused, exit 2. The repo-default password was refused, exit 1. |
| 6. Run | The four log lines matched the doc: real resolver, `store: off`, "serving the client from …; API under /api; source maps not served", "Server listening at http://127.0.0.1:3949". I observed every refusal in the doc's list (sweep above). systemd itself was not run (none here). |
| 7. Caddy | Caddy 2.8.4 with the doc's Caddyfile. It installed its local CA ("certificate installed properly in NSS security databases" / "… in linux trusts"). Every check in the doc passed. Then real trips over `https://localhost/api` for four players and an operator: 8 fights, banks and pushes, including live-party fights in trip 2. |
| 8. Grant admin | "granted admin to 'operator_r3g'". `list` shows `operator_r3g  by reviewer_r3`. |
| 9. Dashboard | Admin → 28 panels. `packFunnel` is `counted: false` with `storeMode: "off"`. A player and an anonymous caller → 404. |
| 10. Backups | The dump (as `PT_OWNER_ROLE`, `umask 077`) → 455 079 bytes, `-rw-------`. Restore into `caravan_pt_r3g_restore` with `--no-owner --role=caravan`, exit 0, then `migrate.js roles` → "Applied db/roles.sql". Both databases: 102 accounts, 3 401 events, 8 jobs, 8 logs, 78 triggers and 9 menus, with the same sum of `seq`. `caravan_app` has INSERT on `ledger_event`, none on `encounter_log`, no TRUNCATE and no TEMP. |
| 12. Upgrade 3d13921 → HEAD | Pre-upgrade dump taken. `migrate.js up` → "Nothing to apply.". `seed.js` → "96 already current". After the restart, all 8 v8 replays rendered (`renderable: true`, v8). **K's in-flight v8 fight never resolved: S1.** Recovered by running the 3d13921 build again until the job completed. |
| 11. Reset between cohorts | Run with a `standing_party_repaired` event in the database (1). Pre-reset dump taken. Server stopped. `DELETE FROM account` → "DELETE 111". `migrate.js reset` → "Reset complete.". `seed.js` → 96 created. Restart: `/api/health` → `{"ok":true}`. A pre-reset device cookie and a bogus one on `/api/auth/resume` → 401 `no_device`. Accounts afterwards: 96 system, 0 players. |

Clean-up:
- Every server I started and Caddy are stopped.
- `caddy untrust` reported "uninstalled properly from NSS security databases" and "… from linux trusts".
  `/usr/local/share/ca-certificates` holds only the sandbox's proxy CAs, and `ca-certificates.crt` has 0
  "Caddy Local Authority" entries.
- `caravan_pt_r3g`, `caravan_pt_r3g_restore`, `caravan_r3g_owner` and `caravan_r3g_app` are dropped, and
  my dumps, the env file and the secrets are deleted.
- `caravan_app` carries no role setting.
- `caravan_test_r3g` and `caravan_dev_r3g` are kept for the fix round.

## Orchestrator decisions (2026-10-20)

- **S1: both halves.**
  - **(a) Runbook.** Before restarting on a build with a new RESOLVER_VERSION, stop taking commits and drain. Run the old build until no job is queued or leased, and say how to check that.
  - **(b) Code, as the safety net when a drain was skipped or a crash interrupted it.** At boot, and in the worker's poll, any queued or leased job whose resolver version is not the running one is parked with an explicit reason. Its trip is voided through the existing void path: it banks as of the last survived encounter, and nothing from the unresolved fight is applied. The player sees the honest voided summary.
  - Re-resolving the fight with the new version is rejected: the formation was committed against the old rules, and a different outcome would contradict what was scouted.
  - Add a test that commits under a stamped old version, boots, and sees the trip voided and the caravan back in town.
- **N1: fix.** Serialize session issue per device with a row lock on the device.
- **N2: fix.**
  - Erasure rewrites only the owner object's name, never other `displayName` fields.
  - Content names and "Departed outfit" are reserved.
  - Beyond the ordinals, fall back to a short hash suffix.
- **N3: fix in the runbook.** Say which upgrades bump RESOLVER_VERSION (the release note or the commit carries `[resolver-bump]`), and that old replays keep rendering.
- **N4:** under `NODE_ENV=production`, refuse an explicit `STORE_MODE=sandbox` unless `STORE_SANDBOX_IN_PRODUCTION=1` is also set, and log a loud warning when it is. A play test must never hand out free Coin by accident.

## Fix round (branch `fixr3g`, 2026-10-20): every item closed as decided

Migration **029** (`029_upgrade_safety`) carries the S1 writer and the N2 rewrite.

- **S1, closed: both halves.**
  - **(b) Code.** `resolution_job_park_other_version(worker, version, reason)` (SECURITY DEFINER,
    pinned `search_path`, granted to `caravan_app` by `db/roles.sql`) parks every queued job, and
    every leased job whose lease has expired, of any other resolver version. The job guard only
    parks from `leased`, so it first takes a lease in the parking worker's name, a new attempt, as
    the guard requires. A live lease is left alone: a process still on that version may be
    finishing it, and the next poll parks it once it expires.
  - `EncounterWorkerLoop` (`jobs/inProcessWorker.ts`) calls `parkOtherVersions` (`jobs/worker.ts`)
    at the start of every pass, which means at boot and on every poll, and then runs the
    `afterParked` hook, so the trip is voided through the existing void path. Plain `drain` and
    `runOnce` do not, so a version-scoped worker on its own still never parks another version's
    job (QA-02 R2-S2's tests are unchanged).
  - The server logs `N job(s) of another resolver version parked and their trips voided (…step 12:
    drain before …)`.
  - The reason the player sees under "Why the server could not resolve it": "The game was updated
    while this fight was waiting to be resolved. A fight is never re-run under rules other than the
    ones it was arranged against, so the trip was called off (resolver v8 → v9)".
  - Test (`trip-resolver.test.ts`): three old-version fights — queued, leased with an expired lease,
    leased with a live lease. After boot the first two are parked and their trips voided: caravan
    `in_town`, one `trip_voided`, and 0 events under the job. The live one is untouched until its
    lease expires, then the next pass parks it. A current-version fight still completes on the same
    loop. `qa02-round2.test.ts` lists the new writer among the SECURITY DEFINER job functions.
  - **(a) Runbook.** Step 12 now says:
    - first check whether `RESOLVER_VERSION` changes
      (`git diff HEAD <new commit> -- packages/resolver/src/version.ts`, or `[resolver-bump]` in
      the commit or release note);
    - if it does: `systemctl stop`, run the **old** build on `PT_PORT+1` (loopback, not proxied, so
      no tester can commit), poll `SELECT count(*) FROM resolution_job WHERE status IN
      ('queued','leased')` until it is 0, stop it, then upgrade;
    - what the safety net does if a drain is skipped.

    Step 6's "a crash is safe too" now says "within one resolver version".
  - **The round-3 reproduction re-run, without a drain** (`caravan_pt_r3f`, shared-instance roles,
    production env):
    1. Host 3d13921 (v8). Caravan K holds encounter 1 (600 unbanked), pushes, and commits encounter
       2. SIGKILL right after the 202: `…:2|leased|1|server:vm:29627:resolver|8`.
    2. This branch's build: `migrate.js up` → "Applied: 29_upgrade_safety", then `seed.js` → "96
       already current". Start it.
    3. 18 s later (the old lease ran out): the job is `parked|2|server:vm:29755:resolver|8|The game
       was updated …`. The trip is `{"phase":"ended","endReason":"voided","caravanState":"in_town"}`
       and `trip_voided` has `credited: 725` (banked as of encounter 1). K still owns 6 units and can
       pack again (201) and unpack (200). Encounter 1's v8 replay → 200 `renderable: true`. The log
       line: "1 job(s) of another resolver version parked and their trips voided …".
  - **The runbook drain rehearsed literally** (`caravan_pt_r3f_drain`):
    1. On 3d13921, K's encounter-2 commit was SIGKILLed before any lease: `…:2|queued|0||8`.
    2. The version check printed `-export const RESOLVER_VERSION = 8;` / `+… = 9;`. For the same
       version (6efc311..HEAD) it printed nothing.
    3. The drain block ran as written, with `PT_PORT=4248` so the drain port is my 4249. The old
       build listened on 127.0.0.1:4249, the count reached 0 in 5 s (05:10:54 → 05:10:59), and
       "shut down cleanly" (exit 0). The job was `completed|1|server:vm:29989:resolver`.
    4. Then `migrate.js up` ("Applied: 29_upgrade_safety"), `seed.js`, and the new build started.
       K's trip was at `decide` (not voided), nothing was parked, and both v8 replays were
       renderable. A bank on the new build → 200 `{"encountersSurvived":2,"credited":1658}`.
- **N1, closed.**
  - `issueSession` (`auth/sessions.ts`) runs in one transaction, under
    `pg_advisory_xact_lock(LOCK_NS_SESSIONS = 30, hashtext(account))` and a row lock on the device it
    joins.
  - Serializing alone was not enough. The second resume's eviction still cut the first's session,
    issued but not yet used. So the eviction order (`repo/sessions.ts` `EVICTION_ORDER`) now ranks
    first a session issued in the last `SESSION_PENDING_PROTECT_SECONDS` (30) and not used yet,
    then sessions in use, then the rest. The cap is unchanged. An orphaned, never-used resume loses
    its protection after 30 s.
  - Test (`account-lifecycle.test.ts`): 8 trials of a device whose 10 sessions are all in use plus 2
    concurrent resumes. Both new tokens answer `/me`, and the device keeps 10 sessions. QA-30 S4's
    test now ages its eleven never-used resumes past the window, which is what an orphan is; a tab
    in use still survives them.
  - Live, the round-3 probe: 9 in use + 2 concurrent → **0/10** dead tokens (was 7/10); 10 + 2 →
    0/10 (was 9/10); 10 + 4 → 0/20; 0 + 6 → 0/30.
- **N2, closed.**
  - Migration 029's `account_erasure_walk_owner` replaces a `displayName` only inside an object whose
    `accountId` / `ownerAccountId` is the erased account (the candidate's `owner`).
    `account_erasure_rewrite` uses it. Unit, ability and siege labels, and another owner of the same
    name, are never touched.
  - `services/caravanNames.ts` `RESERVED_CARAVAN_NAMES` covers every unit, ability, trap, siege and
    fence label, every authored outfit name, "Departed outfit", "Departed caravan", "Unnamed
    outfit", "Unnamed drifter" and "Caravan", compared case-insensitively. A requested name on the
    list → 400 `reserved_caravan_name`, and a generated one re-rolls.
  - Past the ordinals II–X, a 4-hex hash suffix (8 hex after 16 salts) replaces the duplicate.
  - Tests (`caravans.test.ts`):
    - reserved names are refused, and no generated name is reserved;
    - 14 requests for one name give 14 distinct names (base, II–X, then hash suffixes);
    - the SQL walk replaces the owner object's name only.

    The existing account-erasure test (no table or replay still holds the erased caravan's name)
    passes on the new walk.
  - The r2 N4 test's "Juniper Teamsters" could also be *generated*: a 4 % flake, seen once in this
    round. It now uses a name the generator cannot produce.
  - Live: guests named "Dust Rider", "departed outfit", "Gunslinger's Dozen" or "Battering Wagon" →
    400 `reserved_caravan_name`. Twelve requests for one name → base, II…X, "… ad63" and "… bcb3",
    12 distinct.
- **N3, closed** in step 12, as above. It now also says that old replays keep rendering: a replay is
  the stored log, never re-simulated (observed: every v8 replay `renderable: true` after both
  upgrades). It also warns never to run an older build against a database a newer one has run on.
- **N4, closed.**
  - `storeModeFromEnv` refuses `STORE_MODE=sandbox` under production unless
    `STORE_SANDBOX_IN_PRODUCTION=1`. Only the exact value `1` counts: `true` is refused, as tested.
    With both set, `index.ts` logs a `WARNING: … every pack is sold for $0 …` line.
  - Step 6's refusal list names it, and so does AGENTS.md.
  - Test (`final-review.test.ts`).
  - Live with the play-test env: `STORE_MODE=sandbox` → "STORE_MODE=sandbox is refused when
    NODE_ENV=production: it sells packs for $0 (free Coin) …". Adding `STORE_SANDBOX_IN_PRODUCTION=1`
    → `store: sandbox` followed by the level-40 WARNING line.
- **Migrations down and up** (`caravan_dev_r3g`):
  - "Rolled back: 29_upgrade_safety": the writer is gone and the rewrite is back on `walk_names`;
  - "Applied: 29_upgrade_safety": `caravan_app` can execute the writer, and the rewrite uses
    `walk_owner`.

### Gates (observed)

- `pnpm check` on `caravan_test_r3g`, ports 3949/4249, after the fixes. The first run failed at
  `test` on the r2 N4 name flake above (1 failed, 818 passed). After that fix, `pnpm check -- --from
  test` → "all 8 steps passed in 16.4 min":
  - server 819 passed + 1 skipped;
  - determinism 366, perf 15;
  - smoke refused the repo-default password and answered `/health`, `/api/health` and `/`;
  - e2e 12 passed, e2e:hosting 14 passed.
- `git merge roadmap/phase-2-spec` → "Already up to date". Then the full `pnpm check` → "all 11 steps passed in 17.6 min":
  - content 82, resolver 587, circle 108, web 476, server 819 (+1 skipped);
  - determinism 366, perf 15, build, migrate, smoke;
  - e2e 12 passed (3.8 m), e2e:hosting 14 passed (3.7 m).
- The contract test re-records `apps/web/src/test/contract/*.json` with the current store week and
  timestamps on every run. That drift is not committed.

Clean-up:
- Every server I started is stopped.
- The play-test reviewer's server (3951) answered `/health` throughout.
- `caravan_pt_r3f`, `caravan_pt_r3f_drain` and the `caravan_r3f_owner` / `caravan_r3f_app` roles are
  dropped.
- `caravan_test_r3g` and `caravan_dev_r3g` are kept.

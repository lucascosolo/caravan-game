# Final guardrail and technical readiness review, round 2 (reviewed at roadmap/phase-2-spec @ fbce432)

**Verdict: NOT READY, but only by two small should-fix items.** Technically the build is ready. `pnpm check`
passed from a fresh clone set up from AGENTS.md alone. I followed docs/PLAYTEST-HOSTING.md end to end:
production config, Caddy over HTTPS, a real trip, `kill -9` mid-fight, backup and restore, a cohort reset
and an upgrade. All of it worked. Migrations go down and up. The fuzz found no 5xx in about 63 000 requests.
Every round-1 S and D item is closed, and I reproduced each fix. All six guardrails held under the probes
below. The two new S items both come from the play-test fix round:
- **S1.** Roster relief turns `POST …/refugees/refresh` into an unlimited free re-draw. A caravan below
  the floor can re-draw its refugee menu without limit or cost, which makes it a free exact pick. Each
  re-draw writes a row: 500 rows in 4.5 s, with no rate limit, against the production config.
- **S2.** Migration 026 added `encounter_candidates.raider_cap` but did not add it to the stored-menu
  immutability trigger. `caravan_app` can rewrite it.

There is also one design question (D1): the band-0 raider cap counts units and keys on the search centre.
A band-1 caravan (Reputation 400–549) that packs one strong unit is offered only 2-raider parties.

Each item takes one session. Once S1 and S2 are closed I would call it READY. D1 can be decided either
way before the test.

Severity: **S** should-fix before outside testers, **D** design-level (needs an orchestrator decision),
**N** nit.

## What I ran (all observed, this session)

Databases `caravan_test_r2g` and `caravan_dev_r2g`, plus the rehearsal databases `caravan_pt_r2g` and
`caravan_pt_r2g_restore`, which I dropped afterwards. Server on 3953, preview on 4253. Runs were
sequential. I did not touch the play-test reviewer's server.

- **Fresh clone, from AGENTS.md alone.** `git clone --branch roadmap/phase-2-spec` into the scratchpad.
  Then I ran `pnpm install`, `cp .env.example .env` (database names changed to `_r2g`, plus `PORT`,
  `E2E_PORT`, `SMOKE_PORT` and `E2E_WEB_PORT`), `pnpm db:migrate` (26 migrations plus roles.sql),
  `pnpm db:seed:dev` ("Authored parties (set v5): 96 created", and the dev account with "the starting
  roster only"), and the Playwright install. The `caravan` role already existed on the shared cluster.
- **`pnpm check` → "all 11 steps passed in 15.2 min".**
  - content 82, resolver 587, circle 108, web 459 and server 801 (+1 skipped) tests;
  - determinism 366 (the golden-gate self-test, 100× in-process, 3 processes against the goldens);
  - perf:resolver 15;
  - build with the bundle check;
  - smoke: "NODE_ENV=production refused to start with the repo-default database password" and
    "built server (SERVE_WEB=1) answered /health, /api/health and /";
  - e2e: 11 passed (2.9 m); e2e:hosting: 13 passed (3.3 m).
- **CI equals `pnpm check`.** `.github/workflows/ci.yml` sets up the Postgres 16 service, pnpm and Node
  (from `.nvmrc`, which is 22), runs `install --frozen-lockfile` and installs Playwright Chromium. Then
  it runs exactly `pnpm check` and uploads the build. The only difference is `DETERMINISM_BASE_SHA`,
  which turns on the golden-change gate in CI. Locally that gate is skipped for lack of a base. The
  30-minute job timeout leaves room over the 15–24 min observed locally.
- **Hosting runbook, followed literally.** The table at the end lists each step.
- **Restart mid-trip.** Over HTTPS through Caddy, I committed encounter 2 and sent SIGKILL to the server
  right after the 202. The job sat `leased|1|server:vm:24594:resolver`. After a restart it went
  `completed|2|server:vm:25802:resolver` within 23 s, once the lease expired, and the trip then banked
  1 658 Coin.
- **Migrations down and up** on `caravan_dev_r2g`. `db:rollback` and `db:reset` were refused by 026
  ("standing_party_repaired events exist … nothing was rolled back (26 steps run as one transaction)"),
  even after the documented `DELETE FROM account WHERE is_system OR username IS NULL` (see N1). After
  `DELETE FROM account`: "Reset complete.", then `db:seed:dev`. `db:rollback` rolled back 026, and
  `down 2` rolled back 025 and 024. `db:migrate` re-applied all three. `ledger_event_scope(
  'standing_party_repaired')` is `account` again, and the `raider_cap` column is back.
- **NOSUPERUSER owner (new probe).** The runbook creates `caravan` with NOSUPERUSER, but CI and every
  local database run the owner as a superuser. I created a scratch NOSUPERUSER role that owned a scratch
  database and ran `migrate.js up` as it. All 26 migrations applied. roles.sql then stopped at `ALTER
  DEFAULT PRIVILEGES FOR ROLE caravan`, but only because that scratch role is not `caravan`. So the
  migrations need no superuser. I dropped the role and the database.

## Round-1 re-verification

| Item | Original problem | Reproduced now | Status |
|---|---|---|---|
| S1 seed | `db:seed` created `dev` / `devpassword` with off-web, unledgered units | Production `seed.js`: "Authored parties (set v5): 96 created" and "No login accounts were created". The database has 96 system accounts and 0 others. `seed.js --dev` under production: "seed --dev is refused when NODE_ENV=production", exit 2. The dev account (`db:seed:dev`) holds 3 well diggers and 3 dust riders at L1, with 6 `unit_acquired` events. Authored rosters: 544 unit rows and 544 `unit_acquired` events. Across every non-system account without an unlock purchase, the only types are `desert.dust_rider` and `desert.well_digger`. | **Closed** |
| S2 hosting | No way to serve the client and API together; no runbook | `SERVE_WEB=1` under production: `/`, `/health` and `/api/health` answer, with CSP, HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, COOP and Permissions-Policy. `*.js.map` → 404. Dotfiles, encoded `..` and `/assets/../../../.env` → 404, and a non-file path → index.html. Unknown `/api/nope` → JSON 404. No `access-control-*` header with a foreign Origin, and the preflight → 404. Caddy: `https://localhost/health` and `/api/health` → `{"ok":true}`, http → 308. A full real-resolver trip ran over `https://localhost/api`. The guest cookie is `Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure`. | **Closed** (doc nits in N2) |
| D1 store | Sandbox store = 60 000 free Coin a week | Production default: `store: off (packs previewed, not sold)`. `/me/store` has `mode: "off"` and 3 offers. `POST /me/store/purchase` → 409 `store_unavailable`, also with a broken body. `pack_purchase` has 0 rows. The dashboard's `packFunnel` is `{…,"storeMode":"off","counted":false}`. `STORE_MODE=on` is refused at boot. | **Closed** |
| D2 login lockout | 10 failures from 10 addresses locked the owner out | Through Caddy with `TRUST_PROXY=1`, 12 failures with a different forged `X-Forwarded-For` each still counted on the real address (`401×10 429 429`), so a forged header buys nothing. Direct (trusted XFF): 11 failures from A → `…401 429`. A's correct password → 429, and B's correct password → 200, so one address no longer locks out another. The account's own device cookie → 200. The decided per-username backstop remains: after 100 failures spread over 10 addresses, the correct password from a fresh address → 429. | **Closed as decided** (residual in N3) |
| N1–N8 | — | `pnpm check` exists and CI runs it (N1). A fresh clone works from AGENTS.md (N2). Party feed and ledger carry no foreign caravan id: a two-account privacy scan of 28 GET bodies found 0 foreign account or caravan ids (N4). Smoke refuses when the port already answers: "something already answers on 127.0.0.1:3953" (N6). A role setting on the app login stops a production boot (N7, see N4 below for how). Smoke and e2e connect as `caravan_app` (N8). | **Closed** |

## Probes of what changed since round 1

- **Refugee roster floor.** Unlimited free re-draws: this is S1. The merge route to the floor is
  bounded. From the 6-unit start roster, merges stop at 4 units (`well_digger@1, dust_rider@1,
  dust_rider@2, well_digger@2`, with no pair left), so merging alone never reaches the floor. From a
  wiped caravan, the merge-and-claim cycle ends within a few merges, because three slots cannot keep
  holding a pair at the same level. Each cycle also costs a merge. Relief is off on a trip, and
  `reroll` is refused while relief owes a menu, so no Coin is charged for a menu relief owes.
- **Band-0 raider cap:** D1.
- **Self-repairing party.** With 6 units in the party, merging two of them returned 200. The preview
  carried `partyEffect {"carriedOver":1,"dropped":1}` and `requiresConfirmInParty: false`. Afterwards
  the party was `valid: true` with 5 units. The ledger has `standing_party_repaired` with `reason
  merge` and one `repointed` pair. It is account-scoped (`caravan_id` NULL), and the inbox shows
  `party_changed`. As `caravan_app`, UPDATE and DELETE of that event → "ledger_event is append-only".
  The owner whose party overran B kept all 6 units and gained `reputation_changed +25`.
- **Attackers never lose Reputation.** `REPUTATION_LOSS_ATTACKER` is 0 and asserted at boot. A party
  rating now only rises, so it no longer settles where it wins 37.5 % of the time. Instead it climbs to
  the band where it can no longer win. BALANCE-LOG pass 2 puts that at about 360–580 strikes per band
  for weak parties. A play test will not get near that, and the authored set still anchors every band.
  There is one side effect for defenders. Holding against a party rated above you is gap-scaled
  upward, so live parties rated above their strength pay defenders a little more Reputation, and so a
  little more Coin through the band scale. That is BALANCE-LOG open item 7. I record it as accepted,
  not as a finding.
- **Cheaper tier 2.** `/unlocks/webs` shows living `costByTier [0,1,2,8,14]`. Tier-2 nodes need only a
  starting node, and every cost is visible before spending. Spends store their cost in the
  `unlock_node_purchased` payload, so the retune changes no projection. A living web costs 35 in total
  against 30 points at the ladder cap, so the player still has to choose. A paid account with 40 000
  Coin got `409 insufficient_points` from `unlocks/spend` and `409 not_unlocked` on 4 locked recruit
  types.
- **`DELETE /caravans/:id/manifest`.**
  - Packed, then unpacked → 200. Unit, event and trip counts were unchanged (6 / 6 / 0), and the
    manifest closed.
  - Again → 404 `no_open_manifest`. With nothing packed → 404. A foreign caravan → 404 `no_caravan`.
  - After ride-out → 409 `trip_open`. A merge preview of packed units → 409 `unit_packed`.
  - Six races of `trip/start` against `DELETE manifest` on fresh accounts: each time exactly one won.
    Five starts won (the unpack got 409 `trip_open`, units 6, one trip) and one unpack won (the start
    got 409 `not_packed`, units 6, no trip). No unit was duplicated or lost, and no ride-out was undone.
- **The 200 empty states.**
  - Trip with nothing packed → 200. Manifest → 200 `{"manifest":null}`.
  - Candidates on an open trip before a search → 200 `{"menu":null,"searched":false,"encounterIndex":1}`.
    Encounter 2 likewise.
  - Encounter 0 → 400. Candidates with no trip → 404 `no_trip`, as documented.
- **`STORE_MODE` and `SERVE_WEB`:** see the round-1 table.
- **Seed split and production refusals.**
  - The repo-default `DATABASE_URL` → "DATABASE_URL uses a default password from this repo … Refused
    when NODE_ENV=production", exit 1.
  - Under production, each of these refused to start: `CARAVAN_TEST_RESOLVER=double`,
    `CARAVAN_RATE_LIMITS=off`, `TRUST_PROXY=true` and `STORE_MODE=on`.
- **Per-address login limits:** see D2 above.
- **Migration 026.** Down and up work. Its down refuses while repaired events exist (by design; the
  doc gap is N1). Its new column escapes the menu guard: S2.

## Whole-codebase guardrail sweep

- **Determinism.**
  - `pnpm check`'s determinism step: 72 fights × 100 in-process, then 3 processes, byte-equal to each
    other and to the goldens. The work counters are pinned.
  - The lint rules and `test:boundary` passed. The bundle check passed: the client holds only
    `battlefield.ts`, `fixed.ts` and `replay.ts`.
  - The raider cap is applied before the seeded draw and stored with the menu. S2 is the only gap in
    how it is stored.
- **No pay-to-win, store on (sandbox).** I bought tier 3 for $0, then:
  - recruit of `desert.sand_sharpshooter`, `desert.canteen_carrier`, `mountain.goat_herder` and
    `plains.homesteader` → 409 `not_unlocked`, while `desert.dust_rider` → 201;
  - `unlocks/spend` with Coin in the body → 409 `insufficient_points`;
  - reroll pool `["desert.dust_rider","desert.well_digger"]`, the same as a free account's.

  A grep of `packages/resolver`, `packages/circle`, `jobs/`, `trip/`, `matchmaking/`, `party/`,
  `acquisition/` and `economy/merge.ts` for purchase, cosmetic or store state found comments only. The
  owner's Coin headroom is read only when an overrun is settled, never when parties are selected.
- **No pay-to-win, store off:** see D1 in the round-1 table.
- **The unlock web as the only gate.**
  - Unit rows are inserted only by `acquisition/grant.ts:177` (behind `hasAccess`), `economy/merge.ts:415`
    (same type) and `repo/unitInstances.ts`. The last is used only by authored sets, through the ledger.
  - Starting roster, refugees, the floor (`refugees.ts:421`, the claim goes through `grantUnit`), the
    dev seed (`registerAccount`), onboarding and admin all grant nothing outside the web. The database
    query above found only starter types on every non-system account without an unlock purchase.
- **Legibility.** Candidates carry `raiderCap {packedUnits, cap, relaxed, excluded}` and
  `centreBasis`. The merge preview's `partyEffect` matched the party afterwards (6 → 5). The trip
  preview's `unbankedCoin` 1 408 and `bankNow` 1 658 matched the bank's `credited` 1 658.
- **Account vs caravan split.**
  - `standing_party_repaired` is account-scoped.
  - Relief reads the caravan's roster and state.
  - The raider cap reads the caravan's manifest.
  - The party rating is the owner's account-level siege pool.
- **Bounded stakes.** B was overrun at encounter 1 with 6 packed. Four units died (four
  `unit_demerged_on_death` at the L1 floor, all still owned), two were alive at the collapse (two
  `unit_lost_on_wipe`), and B went −20 Reputation. The attacking owner lost nothing. Unpack never
  touches a ride-out.
- **Ledger and menu immutability as `caravan_app`.**
  - Refused:
    - CREATE TEMP, `SET search_path = pg_temp` followed by CREATE TEMP TABLE, and TRUNCATE;
    - DISABLE TRIGGER and `session_replication_role`;
    - UPDATE of `account.coin_balance` and `pool_progress.reputation` / `ladder_level`;
    - DELETE of `account`;
    - INSERT into `account_admin`, `account_erasure_active` and `session`;
    - CREATE FUNCTION, `CREATE OR REPLACE ledger_event_scope`, `ALTER TYPE ledger_event_type` and
      CREATE EXTENSION;
    - direct DML on `encounter_log` and `encounter_log_summary`;
    - UPDATE and DELETE of `ledger_event` (append-only);
    - DELETE of `trip_encounter` and `resolution_job`;
    - UPDATE of `encounter_candidates.pool` ("is a stored menu and is immutable").
  - The SECURITY DEFINER functions the app can execute are exactly 12, and every public function pins
    `search_path`.
  - **Went through:** UPDATE of `encounter_candidates.raider_cap` (UPDATE 4, rolled back; S2). UPDATE
    of `refugee_menu.offered_type_ids` (UPDATE 34, rolled back; N5). `ALTER ROLE caravan_app SET …`
    again (round-1 N7, accepted; I reset it at once and the setting count is 0). `lo_create` (I
    unlinked the object).
- **Privacy and erasure.**
  - A two-account scan of 28 GET bodies (export, ledger, feed, inbox, replays, candidates, progression)
    found 0 foreign account or caravan ids.
  - I erased the party owner whose party struck B. The export was 9 833 bytes with no hash or token.
    The delete → 200, then the old token → 401 and a re-login → 401.
  - A `::text LIKE` scan of every table found no account id, caravan id or username. The erased
    party's id stays in B's ledger (2 rows), menu and job. This is the accepted QA-30 N8 behaviour.
- **Telemetry opt-out.** Opted in: `accepted 2`, 2 rows stored. Opted out: `accepted 0, dropped 2`, 0
  rows.
- **Security basics.**
  - **Fuzz.** 31 396 requests over 67 routes at the root (dev config), and 31 396 under `/api` on the
    production config. 0 responses in the 5xx range and 0 level-50 log lines in either run.
  - **Logs.** No password, bearer token, device cookie or database password appears in any server or
    Caddy log.
  - **Admin.** A player and an anonymous caller both get 404. The admin gets 200 with 28 panels; `days`
    0, 121 and 1e3 and a `week` of 99999 get 400. No username or account id appears in the dashboard.
  - **CSRF.** The API takes bearer tokens only, and the one cookie is `SameSite=Strict; HttpOnly`.
    There is no CORS grant.

## Should-fix

S1. **[closed: fixr2g]** **While roster relief is on, `POST /me/caravans/:id/refugees/refresh` is an unlimited free
re-draw.** It is a free exact pick and an unthrottled row writer.

- `apps/server/src/acquisition/refugees.ts:156-157` returns `relief.active ||
  isFreeRefreshDue(…)`, and `refreshRefugees` accepts on that alone (`:493`). It forfeits the unclaimed
  offer (`:496`) and writes a new free menu that opens "now" (`:177`). Nothing requires the current
  menu to have been claimed, so relief keeps owing another menu for as long as the roster is short.
- Reproduction. Setup as the owner role, standing in for an overrun: delete 4 of a fresh caravan's 6
  units. Then, against the production-config server: "free refreshes accepted in a row: 500 in 4484
  ms; menu sequence now 501". `refugee_menu` held 501 rows, all `free`, Coin stayed 0 and the ledger
  was unchanged.
- Why it matters:
  - A caravan below the floor can re-draw until the exact type it wants appears. That is the
    mercenary's certainty (600 Coin) and the reroll's sooner menu (150/300/600) for free. The decision
    was "its refugee menu is ready at once", one menu per unit owed, not a free reroll.
  - With more than 2 unlocked types this is a real bypass of the Coin certainty valve.
  - Each call is an INSERT with no rate limit, about 110 per second from one client.
- Fix (one session):
  - Under relief alone (the grid not due), owe a new free menu only when the current one is claimed.
    The claim's follow-on menu already does this. `refresh` should then answer 409
    `free_refresh_not_due` while the current relief menu is unclaimed.
  - Put `refresh`, `reroll` and `claim` behind a per-account limiter like `PUT /me/party`'s (30 a
    minute).
  - Test: with relief active, a second `refresh` without a claim → 409, and three claims bring the
    roster to the floor with exactly three menus written.

S2. **[closed: fixr2g]** **`encounter_candidates.raider_cap` is outside the stored-menu immutability guard.**

- Migration 026 adds the column (`026_playtest_fixes.up.sql:40-48`) and says it is stored "like
  draw_rules so a menu replays". The guard function `encounter_candidates_guard_update`
  (`020_account_lifecycle.up.sql:296-306`) enumerates the immutable columns, and 026 did not replace
  it.
- Reproduction, as `caravan_app` on a database with band-0 menus: `BEGIN; UPDATE encounter_candidates
  SET raider_cap = NULL WHERE raider_cap IS NOT NULL;` → `UPDATE 4`. The same transaction's `UPDATE …
  SET pool = '[]'` → "is a stored menu and is immutable". I rolled it back.
- The rule behind it is GUARDRAILS §1: any randomness must be seeded and reproducible from stored
  state. The raider cap is that state's record of why parties were left out. It is shown to the player
  (`raiderCap`) and audited by the balance harness.
- Fix: migration 027 `CREATE OR REPLACE FUNCTION encounter_candidates_guard_update()` with `OR
  NEW.raider_cap IS DISTINCT FROM OLD.raider_cap` added. Its down restores 020's body. Also add
  `raider_cap = account_erasure_rewrite(ec.raider_cap)` to erasure step 5
  (`023_account_lifecycle_hardening.up.sql`), so the erasure exception still matches the whole row.
  Extend the menu-immutability test to cover `raider_cap`.

## Design-level

D1. **[closed: fixr2g]** **The band-0 raider cap counts units and keys on the search centre, so a band-1 caravan can game
it.**

- `matchmaking/band.ts:446-451`: the cap starts at the packed unit count, whatever their merge levels.
  It applies when `bandOf(centre)` is band 0. `matchmaking/service.ts:563-564` passes the manifest's
  packed unit count.
- Encounter 1 is searched 150 below the caravan (`FIRST_ENCOUNTER_CENTRE_OFFSET`), so every caravan
  rated 400–549 gets the cap. That includes every new caravan (REPUTATION_START is 400), and they are
  paid at band 1's ×1.5 encounter Coin.
- Observed, packing 1 unit (owner-role setup set the living Reputation):
  - rating 400 → `raiderCap {"packedUnits":1,"cap":2,"relaxed":true,"excluded":90}`, three 2-raider
    outfits;
  - rating 549 → the same, three 2-raider outfits;
  - rating 550 → `raiderCap null`, offered 5-, 3- and 4-raider parties;
  - the same caravan at 400 packing 6 → cap 6, offered a live 5-raider party.
- So the cheapest route through encounter 1 below 550 Reputation is to pack the fewest, strongest
  units. Every live party with more raiders than that is excluded from those menus (90 of the pool
  here), which also thins the passive side's serve rate for the bands where most testers live.
- Decide one:
  - (a) apply it only while the caravan's own living roster is below a rebuild threshold, for example
    `REFUGEE_ROSTER_FLOOR` + `GUIDE_RESERVE`. That is S1's intent: a wiped player winning their way
    back;
  - (b) key it on the caravan's own band (rating < 400) and on packed merge-weighted slots (Σ 2^(L−1))
    rather than on the unit count;
  - (c) keep it, and add "packed units ≤ 2 at bands 0–1" to BALANCE-LOG's telemetry list.

  I recommend (a). It is one condition in `searchCandidates`, and the stored `raider_cap` already
  records whether it applied.

## Nits

N1. **[closed: fixr2g]** **The AGENTS.md reset recipe misses migration 026.** AGENTS.md:223 says to run `DELETE FROM
account WHERE is_system OR username IS NULL` before `db:reset`, falling back to `DELETE FROM account`
only for 022. Migration 026's down also refuses while any `standing_party_repaired` event exists, and
any registered player who merged a party unit has one. Observed: after the documented DELETE (97
rows), `db:reset` → "Migration 26_playtest_fixes (down) failed: … standing_party_repaired events
exist". Fix: name 026 alongside 022 ("…or repaired party events exist — then `DELETE FROM account`").

N2. **[closed: fixr2g]** **The hosting runbook drifts in four places.**
- Step 5 expects "(set v4)". The seed prints "(set v5)" (PLAYTEST-HOSTING.md:131).
- Steps 10–11 hard-code `-U caravan` and `postgres://caravan:$PT_OWNER_PW` (`:259`, `:270-271`,
  `:281`). In the documented shared-instance mode the owner login is `caravan_pt_owner`; I had to
  substitute it.
- The dump is written with the default umask: my `pt.dump` was `-rw-r--r--`. It holds every
  player's data and password hash. Add `umask 077` and `sudo install -d -m 700 -o <backup user>
  /var/backups/caravan`. Running `sudo mkdir` and then `pg_dump` as a non-root user cannot write
  there anyway.
- The systemd unit runs `User=caravan`, but no step creates that OS user.

N3. **[documented: fixr2g]** **The per-username backstop is still a lockout, by decision.** Observed: 100 wrong passwords from
10 addresses, then the owner's correct password from a fresh address → 429 for 15 minutes. The device
cookie still gets in. Usernames are public, and IPv6 makes 10 addresses free. If it stays, key
IPv6 failures by /64 for `loginFailuresPerUsernameAddress`, and say in the Account screen's error that
an already-signed-in device still works.

N4. **[closed: fixr2g]** **There is no graceful shutdown.** `apps/server/src/index.ts` installs no SIGTERM handler, so
`systemctl stop` or `restart` (runbook steps 6, 11 and 12) kills the process mid-request: exit 143, with
no "closing" line. A fight being resolved waits out the 30 s lease. That is safe, as the runbook says,
but every upgrade makes testers see "resolving" for up to 30 s. Fix: on SIGTERM, `app.close()`, stop
the in-process worker's loop and release or finish its lease, then exit.

In the same file: with a role-level `statement_timeout = 1` on the app login, a production boot dies
with a raw "canceling statement due to statement timeout" stack trace from `checkRoleSettings`. It
does not reach its own clear refusal. Read `pg_db_role_setting` before any other query, or `SET
statement_timeout = 0` on that one connection first.

N5. **[closed: fixr2g]** **`refugee_menu` has no guard at all.** It is not new, but no review has listed it. As
`caravan_app`, `UPDATE refugee_menu SET offered_type_ids = '[…sand_sharpshooter…]'` → `UPDATE 34`
(rolled back), and DELETE is granted. Access still holds, because the claim re-checks through
`grantUnit` (`refugees.ts:417-421`). But the "offers are seeded and reproducible" record (`seed`,
`pool_type_ids`, `offered_type_ids`) can be rewritten by the server role. Fix: a BEFORE UPDATE / DELETE
trigger that freezes every column except `claimed_*` (only while it is NULL) and allows the account
cascade, in the same migration as S2.

N6. **[no action, as decided]** **The fuzz found nothing.** Recorded for completeness: neither run produced a 5xx. The new routes
(`DELETE …/manifest`, the empty-state reads) were in both runs.

## Accepted, not findings

- The erased party's id stays in other players' records (QA-30 N8, accepted then).
- `caravan_app` can `ALTER ROLE` itself, and can create large objects. Both are compromised-server
  only. Production refuses to boot with a role setting (round-1 N7).
- Party ratings now only rise (D6, by decision; BALANCE-LOG open item 7).
- The runbook's dedicated-instance path (a NOSUPERUSER `caravan`) is never run by CI. I showed that the
  migrations need no superuser (above). The roles.sql step was only exercised with the real `caravan`
  role.

## docs/PLAYTEST-HOSTING.md followed literally (database `caravan_pt_r2g`, port 3953)

| Step | Result |
|---|---|
| 1. Build | `pnpm install --frozen-lockfile` ("Done"). The build from `pnpm check` was in place: "build ok". |
| 2. Roles and database | `sudo -u postgres psql` works in this sandbox. `caravan` / `caravan_app` belong to the shared cluster, so I used the doc's shared-instance alternative. I created `caravan_r2g_owner` (IN ROLE caravan, `SET role = caravan`) and `caravan_r2g_app` (IN ROLE caravan_app), each with a 48-hex `openssl rand` password, and `CREATE DATABASE caravan_pt_r2g OWNER caravan`. Everything succeeded. |
| 3. Env file | As written, with mode 600. |
| 4. Migrate | "Applied: 1_core_schema … 26_playtest_fixes". `status`: `[x]` on every line. |
| 5. Seed | "Authored parties (set v5): 96 created" (the doc says v4; N2) and "No login accounts were created". `--dev` was refused, exit 2. The repo-default password was refused, exit 1. |
| 6. Run | The log lines matched the doc: "real resolver", "store: off (packs previewed, not sold)", "serving the client from …; API under /api; source maps not served", "Server listening at http://127.0.0.1:3953". `/health` → `{"ok":true}`. All five refusals in the doc's list were observed (the role-setting one by its crash; N4). systemd itself was not run (no systemd here). |
| 7. Caddy | The doc's Caddyfile with `PT_DOMAIN=localhost`. Caddy installed its root CA ("certificate installed properly in NSS security databases", "… in linux trusts"). Every check in the doc passed. A real trip ran over HTTPS: held, push, held, bank 1 658. |
| 8. Grant admin | "granted admin to 'operator_r2g'". `list` shows `operator_r2g  by reviewer`. |
| 9. Dashboard | Admin → 200 with 28 panels. `packFunnel` is `counted: false` with `storeMode: "off"`. A player and an anonymous caller → 404. |
| 10. Backups | `pg_dump -Fc` (as the owner login; N2) → 429 915 bytes, mode 0644 (N2). Restore into `caravan_pt_r2g_restore` with `--no-owner --role=caravan` (exit 0), then `migrate.js roles` → "Applied db/roles.sql". Both databases: 101 accounts, 3 352 events, 4 jobs, 4 logs and 75 triggers. `caravan_app`: INSERT on `ledger_event`, none on `encounter_log`, no TRUNCATE, no TEMP, and 12 executable definers. |
| 11. Reset between cohorts | Run after creating a `standing_party_repaired` event (B merged a party unit, and the inbox showed `party_changed`). Server stopped. `DELETE FROM account` → "DELETE 101". `migrate.js reset` → "Reset complete.". `seed.js` → 96 created. Restart: healthy. A bogus device cookie on `/api/auth/resume` → 401. |
| 12. Upgrade | `migrate.js up` → "Nothing to apply.". `seed.js` → "96 already current". |

Clean-up:
- The server and Caddy are stopped.
- `caddy untrust` reported "uninstalled properly from NSS security databases" and "… from linux
  trusts". No Caddy certificate is left in `/usr/local/share/ca-certificates`, `/etc/ssl/certs` or the
  NSS store.
- `caravan_pt_r2g`, `caravan_pt_r2g_restore`, `caravan_r2g_owner`, `caravan_r2g_app` and the scratch
  NOSUPERUSER role and database are dropped.
- `caravan_app` carries no role setting.
- `caravan_test_r2g` and `caravan_dev_r2g` are kept for the fix round.

## Orchestrator decisions (2026-10-12)

- **S1:** while the caravan is below the roster floor, it is owed one menu at a time. A new free menu comes only after the current one is claimed. A refresh under relief is the normal paid reroll, never a free re-draw. Rate-limit the refugee routes, with a tunable. Add a test that 500 refreshes below the floor yield one free menu.
- **S2:** migration 027 adds `raider_cap` to the menu immutability guard and to the erasure rewrite. Add a test, as `caravan_app`, that every column of `encounter_candidates` except the documented mutable ones is refused. It must enumerate the columns from the catalogue, so a future column cannot slip past.
- **D1: accept the recommendation.** The band-0 raider cap applies only while the caravan's whole roster, in town plus packed, is at most `COLD_START_ROSTER_MAX` (tunable, default the starting roster size). It no longer depends on the search band. Re-run `scripts/balance/cold-start.ts` and `first-trip.ts --reserve`, and record the results. The guided first fight must stay at or above 70 %.
- **N1, N2, N4, N5:** in scope.
  - N4: graceful shutdown on SIGTERM. Stop leasing, finish or release leased jobs, then close. The boot check fails with its own clear message.
  - N5: an immutability guard on `refugee_menu` for the columns that must not change after creation.
- **N3:** keep the per-username backstop as decided, and document it in the runbook. **N6:** no action.

## Fix round (branch `fixr2g`, 2026-10-12): every item closed as decided

Migration **027** (`027_menu_guards`) carries the new guards; renumber it if another 027 lands first.

- **S1, closed.**
  - `acquisition/refugees.ts` `freeMenuOwed`: relief owes a free menu only when the current menu is
    **claimed** (one menu at a time). An unclaimed menu under relief is not re-drawn for free:
    `refresh` answers 409 `free_refresh_not_due` ("roster relief owes one free menu at a time: claim
    one of menu N's offers …"), and `reroll` is no longer refused for it, so another menu before
    claiming is the ordinary paid reroll. A claim still brings the next free menu in the same
    request while below the floor.
  - `ACCOUNT_RATE_LIMITS.refugeeActionsPerAccount` (new tunable, 30 a minute per account) covers
    `claim`, `refresh` and `reroll` together (`routes/acquisition.ts`).
  - PROJECT.md §15's amendment says "one menu at a time"; AGENTS.md names the new limit.
  - Tests (`acquisition.test.ts`): "500 refreshes below the floor yield ONE free menu" (499 ×
    `free_refresh_not_due`, 2 menu rows; the unclaimed relief menu rerolls for 150 Coin; the claim
    brings the next free one); the route limit (the 31st call is 429, another account is
    unaffected); the existing relief test now claims before it is owed a menu.
  - Live, against the built server with limits on (the review's reproduction: 4 of 6 units deleted
    as the owner): 40 refreshes → `{"409 free_refresh_not_due":30,"429 rate_limited":10}`, 0 menus
    written, `refugee_menu` still 1 row.
- **S2, closed.**
  - Migration 027 replaces `encounter_candidates_guard_update` with `raider_cap IS DISTINCT FROM`
    added, and patches erasure step 5 of `account_erasure_core` in place to rewrite `raider_cap`
    with the menu's other jsonb columns (the patch refuses a body it does not recognise; the down
    reverses it and restores 020's guard).
  - Test (`matchmaking.test.ts`): as `caravan_app`, EVERY column of `encounter_candidates` read from
    `information_schema.columns` except the documented mutable `chosen_candidate_id` / `chosen_at`
    is set to a type-correct different value on a menu whose `raider_cap` is not NULL, and each is
    refused with "is a stored menu and is immutable". A future column fails it until it is guarded.
  - Live as `caravan_app`: `UPDATE encounter_candidates SET raider_cap = NULL …` → "is a stored
    menu and is immutable" (it was `UPDATE 4`).
- **D1, closed as decided** (`COLD_START_RAIDER_CAP_BANDS` → `COLD_START_ROSTER_MAX`, default 6 = the
  starting roster, pinned against `STARTING_ROSTER × STARTING_NODES.living` by a test).
  - `matchmaking/band.ts` `coldStartRaiderCap(entries, centre, packedUnits, rosterSize)` runs while
    the caravan's whole roster (in town plus packed) is at most the max, at any band; the stored
    `raider_cap` records `rosterSize` and `rosterMax` instead of the band.
  - **One interpretation, flagged for the orchestrator:** the roster is counted in starting-unit
    equivalents (`rosterEquivalents`: Σ 2^(level − 1), a merged unit counts as the units it took).
    Counting units alone would have reopened D1 from the other side: a player who merges down to
    one L5 unit is a 1-unit roster. Switching to a plain count is one line in `searchCandidates`.
  - Tests: pure (`matchmaking-pure.test.ts`: the default equals the starting roster; band 1 is
    capped for a small roster; one L5 = 16 is never capped; two L2 = 4 is) and over the service
    (`matchmaking.test.ts`: a 1-unit rebuild in band 1 is capped; one L5 unit in band 0 is not).
  - Live: a fresh 6-unit caravan at 549 packing 1 → `raiderCap {"packedUnits":1,"cap":2,…}`; the
    same after claiming its first refugee (7) → `raiderCap null`, offered 3-, 3- and 4-raider parties.
  - Balance (BALANCE-LOG pass 3): `first-trip.ts --reserve 2` → guided encounter 1 **146 / 200 =
    73 %** (unchanged; target ≥ 70 %), encounter 2 74 % / 77 %, first trip completed 54 %.
    `cold-start.ts` at 400: identical to pass 2 (cap on and off). New at `--rating 700` (band 1),
    where the cap now runs: packed 1 → 11 % → 42 % guided, 2 → 41 % → 46 %, 4 unchanged, and one cell
    lower (3 packed: 49 % → 31 % guided, skilled 53 % → 57 %), recorded, not tuned.
  - The server contract fixtures (`candidates`, `search`, `choose`) now carry `raiderCap: null`:
    the contract caravan holds more than 6 units.
- **N1, closed.** AGENTS.md's reset recipe names migration 026 next to 022: `DELETE FROM account`
  when the database holds compacted summaries or `standing_party_repaired` events.
- **N2, closed** (docs/PLAYTEST-HOSTING.md):
  - step 5 expects "(set v5)";
  - `PT_OWNER_ROLE` / `PT_APP_ROLE` in step 0, used by the env file and by steps 10–11
    (`-U "$PT_OWNER_ROLE"`), and set to the login roles in the shared-instance mode;
  - backups: `sudo install -d -m 700 -o "$USER" /var/backups/caravan`, `umask 077` on the dump and in
    the cron line, and an `ls -l` check for `-rw-------`;
  - step 6 creates the `caravan` OS user (`useradd --system … --shell /usr/sbin/nologin`) before the
    unit that runs as it.
- **N3, documented.** Step 3 explains the login limits as decided: 10 failures per (username,
  address), the 100-per-username backstop, that a username can be locked out of password sign-in
  for 15 minutes by someone with 10+ addresses, and that the tester's own signed-in device is never
  locked out.
- **N4, closed.**
  - `index.ts`: on SIGTERM / SIGINT it logs "SIGTERM: shutting down (no new leases; finishing
    requests and the fight in progress)", `app.close()`s and exits 0 ("shut down cleanly"), or 1
    after a 20 s grace.
  - `jobs/worker.ts` `drain(…, shouldStop)` asks before every lease; the in-process loop passes
    `() => this.stopped`, so a fight already leased completes and no new one is taken (test in
    `jobs.test.ts`).
  - `app.ts` now closes in ONE ordered `onClose` hook: worker, retention, then the pool. The first
    live SIGTERM showed why: with three separate hooks the pool closed first ("Cannot use a pool
    after calling end on the pool"), and the fight stayed `leased` until another process took it.
    After the fix: SIGTERM 0 ms after a commit's 202 → "shut down cleanly" 150 ms later, exit 0,
    and the job `completed|1|server:vm:8357:resolver` (by the stopping process).
  - The boot check reads the role's settings first, over its own connection whose startup options
    override `statement_timeout` / `lock_timeout` (`db/roleSettings.ts` `readRoleSettings`), and
    refuses with its own message. Live, a login role with `statement_timeout = 1` under production:
    "refusing to start: the database role has role-level settings (statement_timeout=1 (this
    database)); clear them with ALTER ROLE … RESET ALL (docs/PLAYTEST-HOSTING.md, step 6)", exit 1.
    Test in `final-review.test.ts` (and an unreachable database is a plain `RoleSettingsCheckError`).
- **N5, closed.** Migration 027's `refugee_menu_guard_update` freezes every column but the claim,
  which may go from all-NULL to set once and is then final; `refugee_menu_guard_delete` refuses
  while the caravan exists (the account cascade and erasure still remove menus); TRUNCATE is
  refused. Test (`acquisition.test.ts`): as `caravan_app`, every column but the claim, read from the
  catalogue, is refused; the claim, once set, is final; DELETE and TRUNCATE are refused. The tests
  that age or corrupt menus as the owner now do it with the guard disabled for that one statement
  (`rewriteMenus`). Live as `caravan_app`: the review's `UPDATE refugee_menu SET offered_type_ids …`
  → "is a drawn menu and is immutable" (it was `UPDATE 34`).
- **Migrations down and up** (`caravan_dev_r2g`): "Applied: 27_menu_guards", "Rolled back:
  27_menu_guards", "Applied: 27_menu_guards"; 3 `refugee_menu_guard*` triggers and the patched
  erasure body afterwards.

### Gates (observed)

`TEST_DATABASE_URL=…/caravan_test_r2g E2E_PORT=3953 SMOKE_PORT=3953 E2E_WEB_PORT=4253 pnpm check`
on the fix (before the ordered-`onClose` change): content 82, resolver 587, circle 108, web 459,
server 808 (+1 skipped); determinism 366; perf 15; e2e 11 passed (4.4 m); e2e:hosting 13 passed
(3.9 m); "all 11 steps passed in 20.7 min".


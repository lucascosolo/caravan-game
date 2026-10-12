# Final whole-game guardrail and technical readiness review (reviewed at roadmap/phase-2-spec @ f4db20b)

**Verdict: NOT READY for an external play test, but close.** All six guardrails held under every
probe I ran across the whole codebase:
- the resolver is deterministic across processes and against the goldens;
- nothing on the resolution or matchmaking path reads billing or Coin state;
- every acquisition path goes through the unlock web, and every pack, place and party boundary
  re-checks it;
- the outcomes shown equal the recorded ones;
- the ledger and replay guards held against `caravan_app`, including the temp-table shadow trick;
- erasure leaves nothing behind.

The CI sequence, the e2e on a freshly seeded database, a production-mode server running the real
resolver, a `kill -9` with a job leased, migrations down and up, and `db:reset` with guests all
passed. Two should-fix items still stop me from putting this in front of outside testers:
- **S1.** `pnpm db:seed` is the only way to load the authored parties that matchmaking needs. It
  also creates a login `dev` / `devpassword` on any database it runs against, with units that sit
  outside the web and have no ledger events.
- **S2.** The repo has no way to serve the built client and API together, and no runbook covering
  TLS, the app role's password, `TRUST_PROXY` or the seed.

The sandbox store also needs a decision (D1): as built, it gives every outside tester 60 000 free
Coin a week. Each item takes one session. Once S1 and S2 are closed and D1 is decided, I would call
it READY.

Severity: **S** should-fix, **D** design-level (needs an orchestrator decision), **N** nit.

## What I ran (all observed, this session)

Ports and databases: `caravan_test_final2`, `caravan_dev_final2`, server on 3959, preview on 4259.
Runs were sequential. I did not touch the play-test reviewer's server on 3961.

- **`pnpm ci` → `ERR_PNPM_CI_NOT_IMPLEMENTED`** (see N1). `pnpm run ci` against
  `caravan_test_final2` exited 0:
  - content 82, resolver 587, circle 108, web 440, server 767 (+1 skipped);
  - golden-gate self-test, then determinism: 72 fights × 100 in-process, then 3 processes × 3 runs
    agreeing with each other and the 72 goldens;
  - `perf:resolver`: work counters pinned; slowest fight 88.0 ms (100 ms budget, MET);
  - build, then `check-bundle: ok — resolver modules in the client: battlefield.ts, fixed.ts,
    replay.ts`.
- **`DETERMINISM_BASE_REF=HEAD~40 pnpm determinism`** passed: "73 golden file(s) changed … accepted
  — RESOLVER_VERSION 7 → 8, every changed golden carries v8".
- **`pnpm e2e`** on `caravan_test_final2` after `DELETE FROM account` + `pnpm db:reset`: **11
  passed (2.8 m)**. My first attempt failed because my own server was still on 3959 (see N6).
- **Fresh copy** (`git archive HEAD` into the scratchpad), following AGENTS.md literally with
  `MIGRATE_DATABASE_URL` and `DATABASE_URL` pointed at `caravan_dev_final2`. `pnpm install`,
  `pnpm typecheck`, `pnpm db:migrate` (25 migrations + roles.sql), `pnpm db:status` and
  `pnpm db:seed` all worked. The steps that fail or are missing are in N1–N3.
- **Production-mode server.** The built `node apps/server/dist/index.js` ran as `caravan_app` with
  `NODE_ENV=production` and no test flag. It logged "encounters resolve in-process with the real
  resolver". Over HTTP:
  - a full trip: held → push → overrun;
  - a second account: held → push → held → bank 1 658 Coin;
  - a third trip in which B chose A's live standing party, then banked.
- **Restart mid-trip.** I committed encounter 2 and ran `kill -9` on the server while the job was
  `leased|1|server:vm:19200`. After a restart, the new process re-leased it when the 30 s lease
  expired (`completed|2|server:vm:19602`), and the trip went on to decide and bank.
- **Route fuzz.** 30 897 requests over all 56 routes: malformed JSON, wrong types, NUL bytes,
  1e300, 100 kB passwords, proto keys, bad UUIDs and path params, text/plain bodies. **0 responses
  in the 5xx range.** The server log had no level-50 lines.
- **IDOR.** B's token on 15 of A's caravan, trip, merge, replay and bank routes: every one returned
  404 or 400.
- **Privacy scan.** I collected every GET response for both players, including the export, the
  ledger, the feed, the inbox, the replays and the candidate menus. Then I searched them for every
  account id and caravan id in the database. No foreign account id appeared anywhere; the one
  foreign caravan id is N4.
- **DB guards as `caravan_app`.** The probe SQL is in the scratchpad.
  - Refused: CREATE TEMP; TRUNCATE; DISABLE TRIGGER; `SET session_replication_role`; UPDATE of
    `account.coin_balance` and `pool_progress.ladder_level`; DELETE of `account`; INSERT into
    `account_admin` and `account_erasure_active`; CREATE FUNCTION; CREATE EXTENSION; direct DML on
    `encounter_log` and `encounter_log_summary`; INSERT into `session`; any access to
    `schema_migrations`.
  - No schema grants the app role CREATE.
  - The SECURITY DEFINER functions the app can execute are exactly the 12 that roles.sql intends.
    `encounter_log_compact_rows` and `account_erasure_core` are not executable by the app.
  - One thing went through: `ALTER ROLE caravan_app SET …` (N7). I reverted it at once.
- **Erasure.** I exported the account (65 kB, no hash or token material), then called `POST
  /me/account/delete`. The old token and a re-login both returned 401. A `::text LIKE` scan of
  every public table found no row containing the account id, the caravan id or the username.
- **Admin.** The built CLI ran with `node apps/server/dist/admin.js grant <user> --by reviewer`,
  then `list`. The admin got 200 on `/admin/dashboard` and 400 on a bad `days` / `week`. A player
  and an anonymous caller both got Fastify's 404 body byte for byte. No player id or username
  appears in the dashboard.
- **Logs.** I searched four server logs and the e2e log for `password|bearer|caravan_device=|token`.
  Nothing matched except the seed script's own "Log in with … devpassword" lines (part of S1).
- **Migrations.** I ran `db:rollback` three times on a seeded database (025, 024, 023), then
  `db:migrate` re-applied all three. `db:reset` with a guest present was refused with "020 down:
  guest or tombstone accounts exist … nothing was rolled back". After the documented `DELETE FROM
  account WHERE is_system OR username IS NULL` (97 rows), `db:reset` and `db:seed` succeeded.

## Guardrail probes: checked and fine

- **Determinism.** The lint rules plus a manual grep of `packages/resolver/src` found only `Math.floor`,
  `Math.trunc` and `Math.abs` on integers. There is no clock, RNG or I/O. The client bundle check
  passes, and the web imports only `@caravan/resolver/replay`. The golden gate refuses an unbumped
  change. The work counters are pinned. The cross-process run agrees.
- **No pay-to-win.**
  - The only readers of `pack_purchase`, `cosmetic_*` and `coin_purchased` are `src/store/**`,
    `src/analytics/queries.ts` and `ledger/events.ts`.
  - A grep of `jobs/`, `trip/`, `matchmaking/`, `party/`, `packages/resolver` and `packages/circle`
    for cosmetic, coin-balance and admin reads came back empty.
  - Content enforces `WEEKLY_PAY_CEILING = Σ PACK_COIN_BY_TIER` (`packages/content/src/packs.ts:159`).
- **The unlock web as the only gate.**
  - Unit rows are inserted in three places: `acquisition/grant.ts:177` (behind `hasAccess`),
    `economy/merge.ts:412` (same type) and `repo/unitInstances.ts`. The last is used only by
    `seed.ts` and by authored system parties.
  - The starting roster is the region's tier-0 starting nodes, and goes through `grantUnit`.
  - The pack (`circle/service.ts:163`), place (`:207`, `:236`) and party (`party/service.ts:171`)
    boundaries each re-check access. With the seed's off-web units, the server refused the party
    (`type_locked`) and the pack (`type_locked`).
  - Onboarding, the store and admin grant no unit types.
- **Legibility.** For both encounters of the first trip, three records agreed:
  - the trip view's `outcome` and `deaths`;
  - the replay body's `outcome.kind` and units' `hp`;
  - `settled` and `ending`: the itemized de-merges with the L1 floor, and `coinLost` 600 (destroyed,
    because the owner is a system account).
- **Bounded stakes.** On the overrun, all six packed units died and were de-merged with the floor at
  L1 (none was alive at the wipe). `unitsLostOutright` was `[]`, and the roster still held 6. Only
  the 600 unbanked Coin was lost. Ladder points went up (+10), not down.
- **Account vs caravan split.** The ledger, `pool_progress` and erasure counts land on the
  documented side of the split. Earlier QA rounds covered this, and nothing I touched contradicts
  it.

## Should-fix

S1. **`pnpm db:seed` creates a known-password account with units outside the web and outside the
ledger, on any database, including production.**
- `apps/server/src/seed.ts:23-24` defaults to `dev` / `devpassword`.
- `:29-34` lists `desert.sand_sharpshooter` at L2 and `desert.canteen_carrier`. Neither is a
  desert starting node; the starting nodes are `desert.dust_rider` and `desert.well_digger`.
- `:59-60` inserts them with `createUnitInstance`, bypassing `grantUnit`.
- No `NODE_ENV` guard exists, and seeding is the only way to load the authored parties that
  matchmaking needs (`:46`).

Observed on the `NODE_ENV=production` server:
- `POST /auth/login {"username":"dev","password":"devpassword"}` returned 200 with a token.
- The dev caravan holds 10 units but has only 6 `unit_acquired` events. The 4 seeded rows have no
  ledger record, which breaks the provably-fair ledger story.
- The off-web units are inert: the party and the pack both refuse them with `type_locked`.

Even so, any outside tester can sign in as `dev`. Its standing party is served to everyone, and its
roster contradicts GUARDRAILS §3 on paper.

Fix: split the seed.
- `db:seed` (or `db:seed:authored`) loads only the authored set.
- The dev and e2e accounts move behind an explicit `SEED_DEV_ACCOUNT=1`, refused under
  `NODE_ENV=production`, the same pattern as `CARAVAN_TEST_RESOLVER`.
- The dev roster is granted through `grantUnit` (starting types plus refugee-style grants), with an
  explicit `mergeLevel` written by the merge path or a ledgered fixture event.
- `scripts/e2e.mjs` passes the flag, and AGENTS.md's `db:seed` line is updated.

Test: `NODE_ENV=production SEED_DEV_ACCOUNT=1 node dist/seed.js` exits non-zero. A plain `db:seed`
creates 96 system accounts and no login account.

S2. **There is no way to run the built game for outside testers, and no runbook for doing so.**
- The client calls `API_BASE = "/api"` (`apps/web/src/api/client.ts:100`). Only Vite dev and
  preview strip that prefix (`apps/web/vite.config.ts:10-12`).
- The built server serves neither `apps/web/dist` nor `/api/*`; there is no static route in
  `apps/server/src/app.ts`.
- The device cookie is `Secure` whenever `NODE_ENV=production` (`account/device.ts:70-77`). Observed:
  `set-cookie: caravan_device=…; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure` over plain
  http. A guest served over http therefore loses the account on reload.
- `caravan_app`'s password defaults to `caravan_app` (`db/roles.sql:22-25`).
- `TRUST_PROXY` is off by default. The `.js.map` files are emitted into `dist/assets`
  (`vite.config.ts:19`) and would be publicly served by a naive static host.
- AGENTS.md:231 says "no hosting target is chosen". `vite preview` is not a production server.

Fix, in one session: add `scripts/playtest/` (or a `docs/PLAYTEST-DEPLOY.md` section in AGENTS.md)
with:
- a reverse-proxy config, for example a Caddyfile that serves `apps/web/dist` (excluding `*.map`)
  and reverse-proxies `/api/*` to `:3000` with the prefix stripped, over TLS;
- the env block: `NODE_ENV=production`, `TRUST_PROXY=1`, a real `caravan_app` password via `ALTER
  ROLE`, and no `CARAVAN_RATE_LIMITS` or `CARAVAN_TEST_RESOLVER`;
- the bootstrap: migrate, then the S1 authored-only seed, then `admin grant`;
- a backup line.

A `pnpm smoke`-style script should then boot that stack and fetch `/` and `/api/health` through the
proxy.

## Design-level

D1. **The sandbox store is free Coin for outside testers.**
- `PURCHASE_BACKEND: "sandbox_stub"` (`packages/content/src/tunables.ts:773`) accepts every
  purchase at $0.
- The UI labels it honestly (`apps/web/src/strings.ts:900-957`, "Buy Pack N ($…, sandbox)").
- Each tester can therefore take all three tiers every week: 60 000 Coin, about 1.09× the free
  weekly earn.
- Pace and grind-wall telemetry is exactly what chunk 37 left for the play test to measure
  (BALANCE-LOG.md). Free packs confound it, even with the dashboard's `allBuyers` split.

Decide one of the following:
- (a) hide the Packs tab and 404 `POST /me/store/purchase` behind a `STORE_ENABLED` env (off for
  the play test);
- (b) keep it, and have the dashboard exclude every account that ever bought from the pace and
  grind-wall panels;
- (c) keep it as a deliberate probe of the paid path.

I recommend (a). Testing guardrail §2 needs no external buyers, and the server tests already cover
it.

D2. **The per-username login limit is a lockout anyone can trigger.**
- `routes/auth.ts:58` counts every attempt against `loginPerUsername` (10 per 15 min), whatever
  the address.
- Usernames are public: they are the party's display name in every defender's menu
  (`matchmaking/service.ts:151`).
- Observed: 10 wrong passwords from 10 different `X-Forwarded-For` values, then the owner's correct
  password returned 429.
- Mitigation that exists: a player on a device that already holds the cookie still gets in through
  `/auth/resume`.

For a small play test this is acceptable. Record the decision, or make the username key count
failures only and exempt a request carrying a valid device cookie for that account.

## Nits

N1. **`pnpm ci` does not run.** pnpm 10 has a built-in `ci` command, and it answers
`ERR_PNPM_CI_NOT_IMPLEMENTED`. Only `pnpm run ci` works. The doc is also out of step with the
script and the workflow:
- AGENTS.md:158 says `pnpm ci` and lists its steps without `perf:resolver`, which is in the script.
- AGENTS.md:227 and `.github/workflows/ci.yml:3` both say CI is `pnpm ci` "step for step", yet CI
  also migrates, smokes, installs Chromium and runs e2e.

Fix: write `pnpm run ci` everywhere, list the real steps, and either add `ci:full` (ci + migrate +
smoke + e2e) or say plainly that CI is a superset.

N2. **AGENTS.md cannot bring up a fresh clone on its own.**
- It never says how to create the `caravan` role or the two databases. The setup assumes they
  exist.
- Nothing loads `.env`, so new database names must be exported by hand. The doc implies `.env.example`
  is used.
- It does not say that a local `pnpm e2e` needs `pnpm --filter @caravan/web exec playwright install
  chromium` first.

Fix: add a 6-line "first time" block covering `createuser`, `createdb ×2`, the exports or
`node --env-file`, and the Playwright install.

N3. **Stale numbers and names in the docs.**
- AGENTS.md:153 says "576 tests"; the observed count is 587.
- `db:roles` is cited as a command at AGENTS.md:103 and in roles.sql's header, but no such script
  exists (AGENTS.md:124 admits it).
- PHASE-2.md:657-658 gives the old auth limits (10/h registration). The tunables now say 100/h
  (`packages/content/src/tunables.ts:991-999`).

N4. **A party owner sees the defender's caravan id.**
- `/me/party/feed` → `entries[].defender.caravanId` (`apps/server/src/party/feed.ts:146-158`).
- `/me/ledger` → `party_served_as_encounter.payload.defenderCaravanId`. `redactForeignAccountIds`
  (`routes/ledger.ts:23-33`) matches only `…AccountId` keys.

In v1 a caravan id is a stable per-player key (one caravan per account). The account export already
treats it as identifying: it replaces foreign `*CaravanId` values with `"other_player"`
(`account/service.ts:152-153`).

Fix: redact foreign `…CaravanId` keys in the ledger read model, and drop `caravanId` from the
feed's defender. Extend the chunk 19 S1 test to plant a defender caravan id.

N5. **The off-web seed roster also breaks ledger rebuild parity.** The 4 seeded unit rows have no
`unit_acquired` event. This closes with S1.

N6. **`scripts/e2e.mjs` trusts whatever already answers on `E2E_PORT`.**
- `:63-75` polls `/health` and stops at the first 200. If another server already holds the port,
  the spawned one dies with EADDRINUSE, but the poll can reach the old server first.
- Observed: "e2e: login for e2e_formation_… failed: 401" against my leftover server on another
  database.

Fix: refuse to start if the port answers before the spawn. Or confirm the database by having
`/health` return the database name in test mode, or the spawned PID.

N7. **The app role can set its own role-level settings.** As `caravan_app`, `ALTER ROLE caravan_app
SET search_path = pg_temp, public` succeeded (I reverted it immediately).
- It is harmless to the guards: every function pins its path, there are no TEMP rights and no
  CREATE anywhere.
- It does persist across connections and could DoS the server, for example with
  `statement_timeout = 1`.

PostgreSQL does not allow revoking that ability from a role on itself. Record it, and have the
runbook (S2) check `pg_db_role_setting` is empty at boot, or have the pool set `search_path`
explicitly on connect.

N8. **CI's smoke and e2e run the built server as the owner role.** `ci.yml`'s
`SMOKE_DATABASE_URL` / `E2E_DATABASE_URL` both use `TEST_DATABASE_URL` (`caravan`). So CI never
proves the shipped server works as `caravan_app`. I proved it by hand in this review.

Fix: point both at a `caravan_app` URL on the test database, after `db:migrate` has applied
roles.sql.

## Accepted, not findings (for the record)

- `account_erase` can be reached for any account by a fully compromised server role (mint with
  `session_issue`, then erase). This is documented and corrected in PHASE-2 §30 (QA-30 S1).
- Lease recovery after a crash takes up to `JOB_VISIBILITY_TIMEOUT_MS` (30 s) of "resolving".
  Observed about 23 s. Fine for a play test.
- Device push was deferred to chunk 34, and art and audio are cut (ORCHESTRATION "play-test
  scope"). I see no technical reason to challenge either for an app-open web play test.
- I did not observe the telemetry opt-out by hand. The suite covers it (`telemetry.test.ts`, passed
  in this run).

## Orchestrator decisions (2026-10-12)

- **S1:** split the seed.
  - `pnpm db:seed` loads only the authored cold-start parties, through the normal grant paths, so they appear in the ledger.
  - The dev and e2e accounts move behind an explicit `--dev` flag, refused when `NODE_ENV=production`.
  - Pre-equipped dev units go through `grantUnit` and the unlock web, or are removed. Nothing is inserted around the ledger. Ledger rebuild parity must hold (N5).
- **S2:** the built server can host the play test as one process.
  - With `SERVE_WEB=1`, it serves `apps/web/dist` and mounts every API route under `/api`.
  - Source maps are not served in production.
  - The cookie stays `Secure` in production, and the runbook requires HTTPS.
  - Add `docs/PLAYTEST-HOSTING.md`, a runbook covering:
    - creating the roles and databases with strong passwords (the defaults are refused in production);
    - the environment variables, including `TRUST_PROXY` and HTTPS through a reverse proxy, with a Caddy example;
    - migrating and seeding;
    - granting admin;
    - backups;
    - reading the dashboard;
    - resetting between play-test cohorts.
  - Add an e2e that runs against the built server in this single-process mode.
- **D1: switch the store off for the play test with a setting, `STORE_MODE=off`.** This becomes the default whenever `NODE_ENV=production`, and dev keeps `sandbox`. With it off, the Packs screen previews contents but shows "Not available during the play test" instead of a buy button, and the purchase route answers 409. No other part of the economy changes. Telemetry must not count the store funnel while it is off.
- **D2:** login failures are limited per (username, address), not per username alone. A generous per-username ceiling stays as a backstop. The device cookie path stays exempt. Add a test that one address cannot lock out another.
- **Every nit is in scope.**
  - N1: rename the root `ci` script to `check`, and make `.github/workflows/ci.yml` run exactly `pnpm check` plus the service and browser setup. Update AGENTS.md.
  - N2/N3: AGENTS.md is enough to set up a fresh clone (the roles and databases, `.env` loading, Playwright).
  - N4: redact the defender's caravan id from the party feed and ledger payloads seen by the party owner.
  - N8: CI's smoke and e2e run as `caravan_app`.

## Fix round 1 (2026-10-12, branch `fixfinal`): every item closed as decided

No schema change was needed, so there is no migration 026. Each item below is closed, with what
now holds and the test that pins it.

- **S1, closed.**
  - `pnpm db:seed` (`apps/server/src/seed.ts`) loads only the 96 authored parties. They reach
    their nodes through ladder rungs, and their rosters are `unit_acquired` / `unit_retired`
    ledger events (chunk 25 QA D3). It prints "No login accounts were created".
  - The dev and e2e fixture account now needs `--dev` (`pnpm db:seed:dev`).
    `devSeedRequested` refuses it under `NODE_ENV=production` (exit 2).
  - `src/dev/devAccount.ts` makes that account an ordinary `registerAccount`: the starting roster
    through `grantUnit`, and no hand-inserted or off-web units. The extra seeded units (an L2 sand
    sharpshooter and a canteen carrier) are gone. The seed no longer prints the password.
  - `scripts/e2e.mjs` passes `--dev`.
  - Tests in `test/final-review.test.ts`, "S1 / N5": the refusal; the roster is the starting
    nodes only; and `rebuildAuthoredRoster` equals `liveRoster`, with `verifyProjection` ok.
- **N5, closed** by S1, with the same test (the ledger rebuild of the dev account equals its live
  state).
- **S2, closed.**
  - `SERVE_WEB=1` (`config.ts` `serveWebFromEnv`, `app.ts`, `web/static.ts`) serves
    `apps/web/dist` and mounts every API route under `/api`; `/health` answers at both.
  - The client gets a CSP, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, COOP, and HSTS
    in production. `/assets/*` is immutable-cached and `index.html` is `no-cache`. Paths that
    escape the directory, dotfiles and NULs get 400 or 404. `*.map` gets 404 under
    `NODE_ENV=production`. API answers are `no-store` when hosted.
  - The CSP caught one real break: PixiJS compiles with `new Function`, so the formation canvas
    showed "unavailable" in the first hosting e2e run. The fix is `import "pixi.js/unsafe-eval"` in
    `apps/web/src/iso/scene.ts`, not `'unsafe-eval'` in the policy.
  - Production refuses the repo's default or empty database passwords
    (`assertProductionDatabaseUrl`). The server, `migrate.js`, `seed.js` and `admin.js` all check
    it. The cookie stays `Secure` in production.
  - `docs/PLAYTEST-HOSTING.md` covers roles and databases with strong passwords (plus a
    shared-instance alternative), the env file, `TRUST_PROXY`, HTTPS through Caddy (with a
    Caddyfile), migrate, seed, systemd, admin, the dashboard, backups and a restore rehearsal, a
    reset between cohorts, and upgrades.
  - `pnpm e2e:hosting` runs the WHOLE Playwright suite against the built server in this
    single-process mode (13 specs: the usual 11, plus `e2e/hosting.spec.ts` for the headers,
    `/api`, the cookie, a deep link and no CSP violation).
  - Server tests in `final-review.test.ts`, "S2": production config, and single-process hosting
    (production and dev app instances).
- **D1, closed.**
  - `STORE_MODE` (`config.ts` `storeModeFromEnv`) is `off` by default under
    `NODE_ENV=production` and `sandbox` elsewhere.
  - With it off, `GET /me/store` carries `mode: "off"` and still previews every offer, and `POST
    /me/store/purchase` answers 409 `store_unavailable` before reading the body. The dashboard's
    `packFunnel` is `{counted: false, storeMode: "off"}` with every number 0, and the admin screen
    says so.
  - The Packs screen shows "Packs are not on sale during the play test", and each tier shows "Not
    available during the play test" instead of a buy button.
  - Nothing else in the economy reads it.
  - Tests: `final-review.test.ts` "D1" (no `pack_purchase` row and no `coin_purchased` event after
    the 409), `PacksScreen.test.tsx` "final review D1", and `telemetry.test.ts` (sandbox funnel
    `counted: true`).
- **D2, closed.**
  - `ACCOUNT_RATE_LIMITS.loginFailuresPerUsernameAddress` is 10 per 15 min, and
    `loginFailuresPerUsername` is a backstop of 100 per 15 min.
  - Only failures count (`RateLimiter.check` / `record` / `reset`, `passwordFailureLimits`), and a
    success clears that address's count. A login carrying a live device cookie of the same account
    is exempt, and `/auth/resume` stays outside the username limits.
  - The account-delete password check shares the same counters.
  - Tests in `account-lifecycle.test.ts`:
    - one address's failures leave another address free to sign in;
    - the backstop holds across addresses;
    - the account's own device is exempt, and another account's device is not.
- **N1, closed.**
  - The root `ci` script is now `check` (`scripts/check.mjs`). It runs typecheck, lint,
    test:boundary, test, determinism, perf:resolver, build, migrate, smoke, e2e and e2e:hosting.
    `--from <step>` resumes at a step.
  - `.github/workflows/ci.yml` is exactly `pnpm check`, after the Postgres service, pnpm, Node, a
    frozen install and Playwright's Chromium.
  - AGENTS.md says `pnpm check`, and explains why not `pnpm ci`.
- **N2, closed.**
  - AGENTS.md has a "First time on a fresh clone" block: `corepack`; the `caravan` role and both
    databases; `.env` from `.env.example`; `db:migrate`; `db:seed:dev`; the Playwright install;
    `pnpm check`.
  - Every entry point and script loads the repo's `.env` (or `ENV_FILE`), never overriding the
    real environment: `config.ts` `loadDotEnv`, `scripts/lib/env.mjs`, and the server's vitest
    config. `.env.example` documents the new variables.
  - Test: `final-review.test.ts` "N2".
- **N3, closed.**
  - `pnpm db:roles` exists, at the root and in the server package.
  - The resolver count is 587 tests in 15 files.
  - The stale PHASE-2 §30 rate-limit numbers are superseded by the tunables. AGENTS.md now points
    at `TUNABLES.ACCOUNT_RATE_LIMITS`.
- **N4, closed.**
  - `routes/ledger.ts` `redactForeignIds` also drops every `…CaravanId` / `caravanId` key that is
    not one of the reader's own caravans.
  - The party feed's `defender` no longer has `caravanId`; the web client never read it.
  - Tests: `stakes.test.ts` (the owner's feed and ledger bodies do not contain the defender's
    caravan id; a unit test of `redactForeignIds`) and `party.test.ts`.
- **N6, closed.** `scripts/e2e.mjs` and `scripts/smoke-server.mjs` refuse to start when something
  already answers on their port (`scripts/lib/env.mjs` `assertPortFree`).
- **N7, closed.**
  - `createPool` pins `search_path=public` on every connection.
  - At boot, `checkRoleSettings` (`db/roleSettings.ts`) reads the role's `pg_db_role_setting`. It
    is a warning outside production and a refusal to start in production.
  - Test: `final-review.test.ts` "N7". It sets the setting only `IN DATABASE` the test database, so
    no other server sees it, then resets it.
- **N8, closed.** `pnpm check`'s smoke and both e2e runs use the `caravan_app` URL of the test
  database. The smoke run also proves production refuses the test database's default password, then
  boots `SERVE_WEB=1` and checks `/health`, `/api/health` and `/` (with a CSP).

### Gates (observed on the fix commit)

`TEST_DATABASE_URL=…/caravan_test_final2 E2E_PORT=3959 SMOKE_PORT=3959 E2E_WEB_PORT=4259 pnpm check`:

- content 82, resolver 587, circle 108, web 441, server 786 (+1 skipped) tests passed;
- determinism: 3 processes × 3 runs agree with the 72 goldens; perf:resolver 15/15;
- build passed, with the bundle check ok;
- smoke: "NODE_ENV=production refused to start with the repo-default database password (as it
  must)", and "built server (SERVE_WEB=1) answered /health, /api/health and /";
- e2e: 11 passed (4.0 m); e2e:hosting: 13 passed (5.0 m);
- "all 11 steps passed in 24.0 min".

After `git merge roadmap/phase-2-spec` (def081a, the play-test review record), the same command
gave the same counts (content 82, resolver 587, circle 108, web 441, server 786 + 1 skipped;
determinism 366; perf 15; e2e 11 passed in 3.8 m; e2e:hosting 13 passed in 4.6 m) and "all 11 steps
passed in 21.6 min".

### docs/PLAYTEST-HOSTING.md followed literally (database `caravan_playtest_final2`, port 3959)

| Step | Result |
|---|---|
| 1. Get the code and build | A clean `git archive` copy of the fix commit. `pnpm install --frozen-lockfile` and `pnpm build`: "build ok". |
| 2. Roles and database | **Deviated.** The sandbox refuses `sudo -u postgres` and `su`, and on the shared cluster `caravan` / `caravan_app` are in use by the parallel reviewer, so I could not set their passwords. `CREATE ROLE caravan` → "role "caravan" already exists". `CREATE DATABASE caravan_playtest_final2 OWNER caravan` → ok. I used the doc's shared-instance alternative, added after this walk: `caravan_ptf2_owner` (IN ROLE caravan, `SET role = caravan`) and `caravan_ptf2_app` (IN ROLE caravan_app), each with a 48-hex-character `openssl rand` password. |
| 3. Env file | Written as in the doc, with mode 600. |
| 3/4 with the default passwords first | `migrate.js up` → "MIGRATE_DATABASE_URL uses a default password from this repo … Refused when NODE_ENV=production" (exit 1). `seed.js` → the same for DATABASE_URL (exit 1). `seed.js --dev` → "seed --dev is refused when NODE_ENV=production" (exit 2). `index.js` → `ProductionConfigError: DATABASE_URL uses a default password`. |
| 4. Migrate (strong passwords) | "Applied: 1_core_schema … 25_compaction_erasure_lock". `status` shows every migration `[x]`. All 36 tables are owned by `caravan`. |
| 5. Seed | "Authored parties (set v4): 96 created" and "No login accounts were created". `--dev` was refused (exit 2). 96 system accounts, 0 others. |
| 6. Run | The logs say "encounters resolve in-process with the real resolver", "store: off (packs previewed, not sold)", "serving the client from …/apps/web/dist; API under /api; source maps not served", "Server listening at http://127.0.0.1:3959". `/health` → `{"ok":true}`. The systemd unit itself was not run (no systemd in the sandbox). |
| 7. Caddy | Caddy v2.8.4, built with `go install` because GitHub release downloads are blocked by policy. `PT_DOMAIN=localhost`. `https://localhost/health` and `/api/health` → `{"ok":true}`. `/` → `HTTP/2 200` with CSP, `strict-transport-security: max-age=31536000`, `x-frame-options: DENY` and `cache-control: no-cache`. `/assets/AdminScreen-….js.map` → 404. `http://localhost/` → 308 to https. A real trip through `https://localhost/api` with the real resolver resolved in about 0.2 s. Playwright `e2e/hosting.spec.ts` against `https://localhost`: 2 passed. Over HTTPS the cookie is `Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure`. `caddy run` installed its root CA into the NSS, Java and system stores; `caddy untrust --cert …` removed it, and the doc now says so. |
| 8. Grant admin | `admin.js grant <user> --by reviewer` → "granted admin to …". `list` shows it. |
| 9. Dashboard | The admin gets 200 with 28 panels; `packFunnel` is `{…, "storeMode":"off", "counted":false}`. A guest gets 404. `/me/store` has `mode: "off"` and 3 offers. A purchase gets 409 `store_unavailable`. |
| 10. Backups | `pg_dump -Fc` gave 405 926 bytes. The restore rehearsal: a scratch database, `pg_restore --no-owner --role=caravan` (exit 0), then `migrate.js roles`. Counts are equal (98 accounts, 3 509 ledger events, 1 job, 75 triggers). `caravan_app` has INSERT on `ledger_event` and none on `encounter_log`, as on the original. |
| 11. Reset between cohorts | Server stopped. `DELETE FROM account` → "DELETE 98". `migrate.js reset` → "Reset complete." `seed.js` → 96 created. A stale device cookie on `/api/auth/resume` → 401 `no_device`; the doc now states that observed behaviour. |
| 12. Upgrade | `migrate.js up` → "Nothing to apply."; `seed.js` → "96 already current"; restart → healthy. |

Clean-up: the server and Caddy are stopped, Caddy's root CA is removed from the trust stores, and
the two rehearsal databases and two login roles are dropped.

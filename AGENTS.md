# Caravan Vaults

Caravan Vaults is a build-then-async-resolve game in an Old West setting, and it runs
**the opposite way round from the genre it resembles**. In Clash of Clans you actively
attack and your base defends itself while you're away. Here it's inverted:

- **Active: defense.** You escort a caravan on a *trip* — a chain of individually
  matchmade, individually scoutable attacking parties. At each encounter you scout the
  party bearing down on you and arrange your **wagon circle** against it: fence
  segments, traps, posted units, stances. Then it resolves. Surviving lets you bank
  (deliver, keep everything) or push on with whatever's left. Nothing is repaired
  mid-trip.
- **Passive: offense.** You also keep a **standing raid party**, configured back in
  town, which is served as an encounter in *other* players' trips. You're never there
  for those fights; you check afterward where it struck. It is a template — it is never
  consumed and never loses units.
- **The home town is never attacked.** It holds your roster, merge board, and mine.

Battles resolve deterministically server-side with no live input; the log of a fight
*is* the replay. A fight looks like a Clash of Clans attack — units move freely and
attack on automatic cooldowns — it just runs to completion before anyone sees it.

`PROJECT.md` at the repo root is the full design document and the source of truth. Its
core loop was corrected after the first draft (see its revision note) — the original
had the polarity reversed. Decisions settled after it was written live in the roadmap:
the stack, the web-first target, one ability per unit type, and the isometric presentation.

## Read these before starting any work

1. **`/roadmap/GUARDRAILS.md`** — the cross-cutting rules that hold across every part
   of the codebase: determinism, no pay-to-win, the unlock web as the only access
   gate, legibility, and the account-vs-caravan data split. Read it **in full, every
   session, regardless of what you're working on.** It is short on purpose.
2. **`/roadmap/INDEX.md`** — the master roadmap: every implementation chunk, in
   dependency order, with its current status.
3. **`/roadmap/chunks/NN-*.md`** — the chunk you've been assigned. Each chunk file is
   self-contained: goal, the design constraints that apply to it, proposed defaults
   for any unspecified balance numbers, definition of done, and the review checks
   that matter most for it. You should not need to open `PROJECT.md` to build a chunk.

## How work moves through this repo

This repo uses **two rotating roles**:

- A **Maker** implements one chunk from `/roadmap/chunks/`, working to a
  working, testable state — not partial or broken intermediate commits.
- An **adversarial QA reviewer** audits completed chunks against
  `/roadmap/GUARDRAILS.md` and the chunk's own review checklist. The goal is to find
  what's wrong, not to confirm what's right. Findings come back as a scoped punch
  list, each item actionable in a single work session — not a general narrative.

A chunk moves `not started` → `in progress` → `built` → `QA'd` → `done`. Hand off to
QA after a chunk reaches `built`, before starting anything that depends on it. Update
the status column in `/roadmap/INDEX.md` when you change a chunk's state.

Your own assignment comes from the prompt that invoked you, not from this file. This
is shared orientation so you know the shape of the workflow either way.

## Working rules

- `PROJECT.md` is the source of truth. Do not invent mechanics or silently deviate.
- Where a **number** is unspecified, the chunk file proposes a default. Use it, mark
  it clearly as tunable in code, and keep moving — never block on balance data.
- All balance constants live in the tunables registry (see chunk 03). Do not hardcode
  balance numbers in game logic.
- The resolver is a pure, isolated package: no I/O, no clock, no randomness, no
  framework. Anything that compromises that is a bug regardless of how well it works.
- **No floats in the simulation.** Continuous movement means fixed-point integers
  everywhere in the resolver — positions, distances, damage, cooldowns. `sin`, `cos`,
  `atan2`, `exp`, and `pow` are banned there; compare squared distances instead of
  calling `sqrt`.
- The grid is a **placement lattice only** — it positions things and is shown in the
  UI only while something is being dragged onto it. It never constrains movement
  during a battle.
- Out of scope for v1 — do not build, do not scaffold speculatively: multi-caravan,
  prestige/reset systems, duplicate recycling, campaign mode.

## Stack

Settled: a **TypeScript monorepo**, web-first and mobile-shaped (touch-usable,
responsive, wrappable for app stores later without a rewrite).

- `packages/resolver` — the deterministic simulation. Pure, fixed-point, zero
  dependencies, no I/O. Kept extractable to Rust/WASM later if it ever needs to be.
- `packages/content` — unit/trap/siege/ability data and the tunables registry.
- `apps/server` — Node, Postgres, the event ledger and job queue.
- `apps/web` — the client. PixiJS for the camp and battle views, which are canvas
  rendering rather than DOM. `apps/web/src/iso` is the ONE isometric renderer (chunk 08):
  the wagon circle, the town (17) and the replay (22) all draw through it — never a second one.

The client **never runs the simulation** — it renders a stored log.

## Build / test / run

Requirements: Node 22, pnpm 10, Postgres 16 with two databases the `caravan` role owns
(`caravan` for dev, `caravan_test` for the test suite). The defaults in `.env.example`
match the local setup.

**Two DB roles, two URLs.** The schema's permanence guards are triggers and CHECKs that
the owner role could simply disable, so the server never runs as the owner:

- `MIGRATE_DATABASE_URL` — the owner role `caravan`. Used by `pnpm db:migrate` /
  `db:rollback` / `db:reset` / `db:roles` and by the test suite's schema reset. Falls
  back to `DATABASE_URL` when unset.
- `DATABASE_URL` — the DML-only login role `caravan_app` (SELECT/INSERT/UPDATE/DELETE on
  tables, USAGE on sequences; no ALTER, TRUNCATE, TRIGGER or CREATE). The running server
  and `pnpm db:seed` use it.
- `TEST_DATABASE_URL` — owner role on the test database; the suite resets its schema and
  re-applies `apps/server/db/roles.sql` on every run, then connects as `caravan_app` to
  prove the guards hold against the server's own role.

**Server tests must not depend on file order:** `apps/server/test/per-file-reset.ts` starts every file
with no accounts (so no jobs, parties, menus or ratings); create what a test needs itself and pin what a
seeded matchmaking draw reads (ratings, authored set, owner headroom). Check: `vitest run --sequence.shuffle.files --sequence.seed=N`.
The server suite's timeouts are 60 s per test and 60 s per hook (`apps/server/vitest.config.ts`): seeding
the authored set takes 8–11 s and timed out at the old 20 s on a busy host.

`encounter_log` (chunk 13 replays) is write-once even for the app role: no INSERT / UPDATE / DELETE
grant; rows go in only through `encounter_log_write()` (SECURITY DEFINER, fenced on the job's
live lease, checked against the job) and leave only through `encounter_log_prune()` (the
retention rule, migration 016). `caravan_app` is created and granted by `apps/server/db/roles.sql` (idempotent; a role is
cluster-level, so it is a script, not a migration). `pnpm db:migrate` and `pnpm db:reset`
apply it after migrating; `pnpm --filter @caravan/server exec tsx src/db/migrate.ts roles`
applies it alone (no `db:roles` script yet: `apps/server/package.json` belongs to chunk 02's
in-flight change). Default privileges on the
owner role mean tables added by later migrations are covered without extra GRANTs.

```
pnpm install                 # install the whole workspace
pnpm typecheck               # tsc --noEmit in every package
pnpm lint                    # resolver isolation rules + their self-test (packages/resolver)
pnpm test                    # vitest, against TEST_DATABASE_URL; resets that schema first

pnpm db:migrate              # apply pending SQL migrations to MIGRATE_DATABASE_URL, then db/roles.sql
pnpm db:rollback             # roll back the most recent migration
pnpm db:reset                # roll back everything, re-apply, then db/roles.sql
pnpm db:status               # show which migrations are applied
pnpm --filter @caravan/server exec tsx src/db/migrate.ts roles   # caravan_app role + grants only
pnpm db:seed                 # idempotent: the 96 authored cold-start parties (chunk 25; versioned, updates in place) + dev account dev / devpassword, region desert

pnpm dev                     # Fastify on http://127.0.0.1:3000 (PORT/HOST override), tsx watch; resolves committed encounters in-process with the real resolver
pnpm dev:web                 # Vite dev server on http://127.0.0.1:5173; /api/* proxied to the server on :3000 (CARAVAN_API_URL overrides)

pnpm --filter @caravan/web typecheck | test | build   # tsc; vitest + testing-library (jsdom); vite build → apps/web/dist
pnpm --filter @caravan/web e2e                        # Playwright smoke vs a running server (needs CARAVAN_API_URL + a seeded DB)
pnpm e2e                     # the same, self-contained: seeds E2E_DATABASE_URL (dev, a run-unique formation account packed and ridden out, a run-unique trip account in town), starts the BUILT server on :3917 with CARAVAN_TEST_RESOLVER=double, runs the e2e, stops it (run `pnpm build` first)

pnpm --filter @caravan/server exec tsx ../../scripts/balance/matchup-sweep.ts [--quick] [--jobs 2] [--json out.json]   # chunk 37 matchup sweep (authored parties × defending corpus × layouts; full ≈ 75 min at 2 jobs, --quick ≈ 17 min); first-trip.ts, probes.ts, measured-ev.ts, trip-ev.ts beside it; numbers in BALANCE-LOG.md; the CI slice is apps/server/test/balance-sweep.test.ts
pnpm determinism             # resolver determinism harness (chunk 13): the golden-gate self-test (scripts/golden-gate.test.mjs), then the 72-fight corpus 100× byte-identical in-process (one test per scenario per 25-run batch) and equal to the golden logs in packages/resolver/golden (UPDATE_GOLDEN=1 regenerates), then 3 separate Node processes (different corpus orders) compared by sha256 with each other and the goldens; with a base ref (DETERMINISM_BASE_REF locally) it refuses a changed/deleted golden unless RESOLVER_VERSION increased as an integer and every changed golden carries it (`[resolver-bump]` covers only new fixtures)
pnpm perf:resolver           # PHASE-2 §36: every golden-corpus fight (and the 180 s full-load fight) under 100 ms of CPU, timed ALONE (RESOLVER_BUDGET_STRICT=1); the parallel suite runs the same test with a 2x allowance. A CI step of its own, after determinism
pnpm load:queue -- --db <owner URL of a *load* database>     # PHASE-2 §36 job-queue load test (resets that DB; not in CI): real trips + a 10 000-encounter one-party burst; --burst-parties N spreads it, --profile times each SQL statement
pnpm load:explain -- --db <owner URL of a *load* database> --write   # PHASE-2 §36: seeds ~50k accounts / 156k menus and rewrites the matchmaking EXPLAIN plans in apps/server/db/explain/
pnpm --filter @caravan/resolver test   # the resolver alone: 576 tests in 15 files (288 of them the 100× harness in 25-run batches), no DB, no network, ~70 s on 4 cores
pnpm test:boundary           # resolver dependency-boundary check (zero deps, imports stay inside packages/resolver/src)
pnpm build                   # esbuild → apps/server/dist (index.js, db/migrate.js, seed.js); workspace packages inlined, npm deps external; then vite build → apps/web/dist
pnpm start                   # run the built server: node apps/server/dist/index.js
pnpm smoke                   # start the built server against SMOKE_DATABASE_URL, assert GET /health, stop
pnpm ci                      # the CI job, step for step: typecheck, lint, test:boundary, test, determinism, build
```

Migrations are plain SQL pairs in `apps/server/migrations/NNN_name.{up,down}.sql`, run by
`apps/server/src/db/migrate.ts`. Chunk 30 (account lifecycle, PHASE-2 §30 build notes): guest-first
`POST /auth/guest`, `POST /auth/resume` (the server's HttpOnly `caravan_device` cookie — the client
stores nothing), `GET /me/account`, `POST /me/account/link`, `GET|DELETE /me/devices[/:id]`,
`POST /me/devices/revoke-others`, `GET /me/export`, `POST /me/account/delete` (through the
`account_erase` SECURITY DEFINER function, which anonymizes shared records to a tombstone). Auth
routes are rate-limited (`TUNABLES.ACCOUNT_RATE_LIMITS`; counted IN MEMORY PER PROCESS, so N server
processes give N× the limits); `CARAVAN_RATE_LIMITS=off` (set by the server vitest env and `pnpm e2e`) is
refused in production. Behind a reverse proxy set `TRUST_PROXY` to the hop count or the proxy addresses /
CIDRs (off by default; `true` is refused), or every client shares the proxy's per-address limit. Every
function in schema public must pin `search_path = pg_catalog, public, pg_temp` (a test enumerates pg_proc). Server routes so far: `POST /auth/register`,
`POST /auth/login`, `POST /auth/logout`, `GET /me`, `GET /health` (bearer token auth), plus
the ledger, progression, circle, economy and unlock routes of chunks 02–07 and 16
(`GET /unlocks/webs`, `GET /me/unlocks`, `POST /me/unlocks/spend`), the party routes of
chunk 09, the matchmaking routes of chunk 14 (`POST /me/caravans/:id/encounters/:n/search`,
`GET …/candidates`, `POST …/choose`), the trip loop of chunk 15 (`GET /me/caravans/:id/trip`,
`POST …/trip/start`, `POST …/trip/encounters/:n/commit`, `GET …/trip/preview`, `POST …/trip/push`
and `…/trip/bank` with `{tripId, encounterIndex}`) and chunk 13's replay
(`GET /me/encounters/:jobId/replay`, for the caravan's player and the party's owner: 409
`not_resolved` while resolving, 409 `resolution_unavailable` once parked, 410 once pruned,
otherwise 200 with `renderable` — false, with a reason, for a log that fails its sha256 / reader
check or for a fight resolved without a tick log) and chunk 24's
first-session guide (`GET /me/onboarding`, `POST /me/onboarding/advance {step}`, `POST /me/onboarding/skip`;
account-level, forward-only, grants nothing; `pnpm db:seed` marks its pre-equipped accounts' guide done) and chunk 32's telemetry (`GET/PUT /me/analytics {optedOut}`, `POST /me/telemetry` screen flow + crash reports, and the admin-only `GET /admin/dashboard` — 404 for non-admins; grant with `pnpm --filter @caravan/server admin grant <username>`, which uses MIGRATE_DATABASE_URL). `pnpm db:seed` also creates the authored cold-start
parties (`src/matchmaking/authored.ts`, chunk 25: 12 per Reputation band, bands 0–7, owned
by `sys_outfit_*` system accounts that cannot log in or hold Coin), so a fresh database
serves three scoutable candidates at every band from the first search. Migrations 011 and 009
refuse to roll back while system accounts exist, and a multi-step `db:rollback N` or
`db:reset` runs every down step in ONE transaction, so a refusal rolls back nothing. Before
a `db:reset` (or a rollback past 011) of a seeded database, run
`DELETE FROM account WHERE is_system OR username IS NULL` as the owner role (migration 020 down refuses while guests or the erasure tombstone exist), then `pnpm db:reset && pnpm db:seed`
(the test suite empties `account` itself before its reset).

**Encounters resolve in the server process (chunk 13 QA S1).** `apps/server/src/index.ts` builds
the app with `encounterWorker: true`: `jobs/inProcessWorker.ts` drains the job queue in-process
with the REAL resolver (`DEFAULT_HANDLERS`), kicked by every `POST …/trip/encounters/:n/commit`
and polled every second (retries, expired leases, jobs committed through another process). Any
number of server processes may run it (the queue's lease and completion fence make concurrent
workers safe). Tests build apps without it and call `drain` themselves.

**`CARAVAN_TEST_RESOLVER=double` (dev / test only, chunk 23).** Swaps chunk 15's deterministic
test double (`apps/server/src/dev/tripDouble.ts`, via `src/dev/testResolver.ts`) in for the real
resolver in that in-process worker, for predictable e2e outcomes: every encounter is held, each
posted unit loses 150 HP, at encounter 1 the first laid trap fires and every placed fence segment
breaks. The double writes no tick log, so its fights' replays answer `renderable: false` with the
reason. The server REFUSES TO START with the flag set and `NODE_ENV=production`, and any value
other than `double` is refused. `pnpm e2e` sets it (with `NODE_ENV=test`); `pnpm smoke` and CI's
smoke run do not. Example: `CARAVAN_TEST_RESOLVER=double pnpm dev`.

**Web client** (`apps/web`, chunk 06 scaffold): Vite + React 18 + TypeScript strict. A
typed `fetch` wrapper (`src/api/client.ts`) carries the bearer token from in-memory session
state only — no localStorage, no cookies. A hand-rolled hash router (`src/shell/router.tsx`)
and an app shell with a thumb-sized bottom tab bar (Town / Trail / Party / Webs). Every
player-facing string lives in `src/strings.ts`; the theme is CSS variables in
`src/theme.css` with an Okabe–Ito (colourblind-safe) palette, and affinities / node states
are always carried by a shape or a word as well as a colour. The client renders server
state; it never runs the simulation and never decides affordability or eligibility itself.

### CI (chunk 21)

`.github/workflows/ci.yml` runs on every push and pull request: install with a frozen
lockfile, `typecheck`, `lint` (resolver isolation rules plus their self-test),
`test:boundary`, `test` against a Postgres 16 service container, `determinism`, `build`,
then migrates the test database and smoke-runs the built server. Since chunk 06 the
recursive `typecheck` / `test` / `build` steps include the web client, and a final step
installs Playwright's Chromium and runs `pnpm e2e` (built client against the built server
on the seeded test database). `pnpm ci` is the same
sequence locally. The resolver lint rules live in `packages/resolver/eslint.config.js`;
`packages/resolver/lint-fixtures/` must stay in sync with them (every line of
`violations.ts` from line 3 on must error; `allowed.ts` must be clean), which
`scripts/lint-selftest.mjs` enforces. There is no deploy step yet: no hosting target is
chosen. When one is, add a job that `needs: ci` and runs on pushes to `main` only.

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
  rendering rather than DOM.

The client **never runs the simulation** — it renders a stored log.

## Build / test / run

Requirements: Node 22, pnpm 10, Postgres 16 with two databases the `caravan` role owns
(`caravan` for dev, `caravan_test` for the test suite). Connection strings are read from
`DATABASE_URL` / `TEST_DATABASE_URL`; the defaults in `.env.example` match the local setup.

```
pnpm install                 # install the whole workspace
pnpm typecheck               # tsc --noEmit in every package
pnpm lint                    # resolver isolation rules + their self-test (packages/resolver)
pnpm test                    # vitest, against TEST_DATABASE_URL; resets that schema first

pnpm db:migrate              # apply pending SQL migrations to DATABASE_URL
pnpm db:rollback             # roll back the most recent migration
pnpm db:reset                # roll back everything, then re-apply
pnpm db:status               # show which migrations are applied
pnpm db:seed                 # idempotent dev account: dev / devpassword, region desert

pnpm dev                     # Fastify on http://127.0.0.1:3000 (PORT/HOST override), tsx watch

# resolver determinism harness — TBD (chunk 13; this one matters most)
```

Migrations are plain SQL pairs in `apps/server/migrations/NNN_name.{up,down}.sql`, run by
`apps/server/src/db/migrate.ts`. Server routes so far: `POST /auth/register`,
`POST /auth/login`, `POST /auth/logout`, `GET /me`, `GET /health` (bearer token auth).

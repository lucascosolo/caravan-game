# Caravan Vaults

Caravan Vaults is a build-then-async-resolve game in an Old West setting. Players
configure a defense (their camp — a wagon train circled for the night, with fences,
traps, and garrisoned units) and an offense (a raiding party with locked-in targeting
stances) as two separate puzzles, then send the party out on a *trip*: a chain of
individually matchmade, individually scoutable opponent camps. Outcomes resolve
deterministically on the server with no live input from either player — the log of a
fight *is* the replay both players watch afterward. A battle looks like a Clash of
Clans attack: units move freely and attack on automatic cooldowns. It just runs to
completion server-side before anyone sees it.

`PROJECT.md` at the repo root is the full design document and the source of truth.
A few decisions were settled after it was written and live in the roadmap instead:
the stack, the web-first target, and the addition of one ability per unit type.

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

*Nothing is implemented yet — chunk 01 sets this up and fills this in.*

```
# install       — TBD
# run (dev)     — TBD
# test          — TBD
# resolver determinism harness — TBD (chunk 13; this one matters most)
```

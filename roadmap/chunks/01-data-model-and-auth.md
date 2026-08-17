# Chunk 01 — Data model & auth scaffolding

**Depends on:** nothing. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Establish the persistent schema for Caravan Vaults and a minimal auth layer, with
the account-vs-caravan progress split correct from day one. Nothing else in the
project can be built safely until this is right — retrofitting the split after
multi-caravan ships would be a painful migration.

Deliverable: migrations + typed data access layer + a login that produces a session,
with a seed script that creates one account, one caravan, and a chosen region.

## Design constraints that apply here

**The split is load-bearing. Do not merge these.**

- **Account-level** (persists across future caravans):
  - trap Reputation, trap ladder level, trap unlock web state
  - siege Reputation, siege ladder level, siege unlock web state
  - Coin balance and Coin storage cap
  - auth identity, purchase records
- **Caravan-level** (region-specific, does not transfer):
  - living-unit Reputation, living-unit ladder level, living-unit unlock web state
  - the region choice
  - the camp/defense layout
  - owned living-unit instances and their merge levels

- **Region** is chosen once at account/caravan creation, from 3–4 biome-based
  regions. Not freely swappable. Region affects *only* which living units are
  available — there is no map, no travel, no geography anywhere in the schema.
- **Multi-caravan is post-v1 but the schema must already support it.** A caravan is
  its own row keyed by account id, never a set of columns inlined onto the account.
  v1 creates exactly one caravan per account; the schema must not assume that.
- **Reputation is a rating, never a currency.** It is volatile (raids can shift it)
  and is *never spent*. Do not model it as a spendable balance.
- **Ladder levels and granted unlock points are permanent and unrevocable.** No
  outcome, wipe, or loss event may ever reduce them. Model them so a decrement is
  impossible or at minimum loudly guarded.
- Two separate numbers per pool — Reputation and ladder — are distinct fields. Do
  not derive one from the other.
- A caravan is a **single entity serving both offense and defense roles**, not two
  records. It needs an explicit state field covering at minimum: `parked`
  (raidable) and `away` (on a trip, not targetable at all).

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `REGION_COUNT` | 4 | 3–4 per design; go with 4 biomes, Old West flavored (e.g. desert, high plains, mountain, badlands). Names are placeholder. |
| `COIN_STORAGE_CAP` | 50,000 | Per-account cap, §14. Pure placeholder until economy tuning. |
| `MAX_CARAVANS_PER_ACCOUNT` | 1 | v1 enforcement value only. Schema supports N. |

## Suggested shape (Maker's call, but justify a deviation)

No stack was specified in the design doc. Proposed default, chosen for the
determinism requirement: **TypeScript monorepo** — a pure, dependency-free
resolver package (no I/O, no clock, no RNG) that both server and tests import;
a Node server; Postgres via a migration tool; a web client. If you pick differently,
the non-negotiable is that the resolver is an isolated pure package.

Suggested tables: `account`, `caravan`, `pool_progress` (keyed by owner scope +
pool, so the split is enforced by a constraint rather than by convention),
`unit_instance` (caravan-scoped, carries merge level 1–5), `session`.

Consider making the split *structurally* impossible to violate: e.g. a check
constraint that `pool = 'living'` rows carry a caravan id and a null account id,
and `pool IN ('trap','siege')` rows carry an account id and a null caravan id.
That converts a whole class of QA finding into a database error.

## Definition of done

- [ ] Migrations run clean from empty, and roll back.
- [ ] Account, caravan, region choice, pool progress, unit instances, session all persist.
- [ ] The account/caravan split is enforced at the schema level, not just in app code.
- [ ] A second caravan can be inserted for an account without a schema change (even
      though app logic refuses it in v1).
- [ ] Ladder level and unlock points have no code path that decrements them.
- [ ] Caravan `parked`/`away` state exists and defaults to `parked`.
- [ ] Auth: register, log in, get a session, authorize a request. Nothing fancy.
- [ ] Seed script produces a playable-shaped account for later chunks to develop against.
- [ ] Tests cover the split constraints and the no-decrement guarantee.

## QA guardrail checks for this chunk

- **Data model violations of the account/caravan split:** grep every read and write
  of ladder, Reputation, and unlock-point state. Anything reading or writing
  living-unit progress at the account level, or trap/siege progress at the caravan
  level, is a bug. Try to write a violating row directly — the DB should refuse.
- **Permanence:** attempt to decrement a ladder level and a granted unlock point
  through every available API. Both must be impossible.
- **Reputation modeled as a rating:** confirm there is no "spend Reputation" path
  and no place it can go negative-by-spending.
- **Multi-caravan readiness:** insert a second caravan directly; confirm no unique
  constraint, no inlined column, and no query that silently assumes exactly one.
- **No purchase state reachable from progression:** the schema should not make it
  convenient for a resolver or matchmaker to join to billing.

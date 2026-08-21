# Caravan Vaults — MVP Scope & Core User Stories

**Derived from:** `PROJECT.md`, `roadmap/GUARDRAILS.md`, `roadmap/INDEX.md` and the
20 roadmap chunk files.
**Status:** locked for implementation seed.
**Purpose:** Define what MVP means for Caravan Vaults by establishing which 18 of 20
roadmap chunks are in scope, which 2 are deferred, and 3 core user stories that
downstream implementation tasks (`t_551e1d41`, `t_2e8bcff2`) build against.
**This document scopes PROJECT.md and GUARDRAILS.md — it does not replace them.**

---

## Summary: MVP = one complete core loop

> Create an account → pick a region → arrive in a starter town → pack a caravan
> → ride out → get matched against a scoutable party → scout it → arrange a
> wagon circle → watch it resolve → **bank or push** with previewed stakes →
> repeat or recover.

### IN scope — 18 of 20 roadmap chunks

Chunks 01–11, 13–19. All are required: removing any one either breaks the core
loop outright or violates a guardrail. The full rationale per chunk is in the
companion document at `t_f5e4384e`'s worktree; the short form is that every
included chunk has no gap-filling substitute.

The **highest-risk spine** is 10 (resolver core) → 11 (combat) → 13 (outcomes &
replay). Build and freeze in isolation before anything depends on it.

### OUT of first MVP — 2 chunks deferred

| Chunk | Why deferred |
|---|---|
| **12 — Unit abilities** | Riskiest resolver addition for least loop impact; ships as documented no-op on tick phase 7. Fast-follow. |
| **20 — Monetization packs** | Proves guardrail architecture (resolver/billing boundary) without payment integration. Fast-follow. |

### Explicitly out of v1

Multi-caravan, prestige/reset, duplicate recycling, campaign mode. Schema must
*accommodate* them; nothing else should.

---

## Core User Stories

### Story 1: Scout and Defend — the active game loop

**As a player mid-trip,** I want to scout the incoming attacking party, arrange
my wagon circle against it (fence gaps, traps, posted unit stances), watch the
fight resolve deterministically, and then choose to bank or push — so that I
experience the complete active core loop in one sitting.

**Acceptance criteria:**

1. **Full scouting.** Matchmaking returns exactly 3 candidates; each is fully
   inspectable before committing — every unit's stats (offense/defense split),
   stance, siege loadout, and entry edge(s). Re-roll is free and time-gated
   only.
2. **Wagon circle arrangement.** The player places fence segments (may
   deliberately leave gaps), lays traps (single-trigger), and posts units with
   stances (aggro radius + leash distance rendered as continuous circles). Caps
   (slot, budget) are enforced client-side and server-side.
3. **Carry-forward attrition.** Only what survived prior encounters (damaged
   HP, spent traps marked unavailable, destroyed fence segments) is available.
   No silent resupply or repair.
4. **Deterministic resolution.** Fight resolves exactly once, server-side, as a
   pure function. No live simulation in the UI, no re-simulation for replay.
5. **Three distinguishable end conditions.** Wipe (caravan holds), overrun
   (caravan loses), stalemate (attackers withdraw — favors caravan). Each
   renders distinctly in the replay log.
6. **Replay fidelity.** Re-re-solving the identical input 100 times produces
   byte-identical logs. The log is the replay — the resolver is never called
   twice.
7. **Bank-or-push preview.** Before the decision: itemized unbanked Coin at
   risk, exactly which alive units would be destroyed outright on overrun, and
   that the next encounter is harder. Accept or decline only after surviving
   the current encounter.
8. **Push escalates.** A pushed encounter is harder and the caravan carries its
   attrition forward. No mid-trip resupply.
9. **Bank succeeds.** Banking transitions the caravan to `in_town`, locks Coin
   permanently (a subsequent overrun cannot touch it), and fully restores
   state.

**Testable in isolation via:** synthetic formation → matchmaking stub returns
fixed party → arrange circle → commit resolver → assert outcome + replay log
consistency. No auth, no real matchmaking, no economy needed for the resolver
test path.

---

### Story 2: Stand and Collect — the passive side

**As a player,** I want to configure a standing raiding party once, leave it
standing without ongoing attention, and later check where it struck and how it
fared — so that I feel the King of Thieves tension of wondering what my build
ran into while I was away.

**Acceptance criteria:**

1. **Party builder.** The builder enforces `PARTY_SLOT_CAP`, `SIEGE_SLOT_CAP`,
   assigns one of exactly 3 stances per unit, and sets approach edge(s).
2. **Template, not expedition.** The same party served into dozens of
   resolutions leaves the owner's roster byte-identical afterward — no damage,
   no de-merge, no unit loss — including in fights the party loses.
3. **Concurrent resolution safe.** The party is snapshotted at the point it is
   served; editing the party after that does not alter an in-flight resolution
   or a stored replay.
4. **Unit sharing.** A unit may simultaneously sit in the standing party AND
   be packed on an active trip. The UI explains this coherently rather than
   blocking it.
5. **Results feed.** A feed lists every trip the party was served into, whether
   it broke the caravan, and links to that fight's replay.
6. **Symmetrical replay.** The party owner's replay is the identical artifact
   the caravan player saw — no divergence, no hidden information.
7. **Replay immutability.** Editing the party after it already fought does not
   alter that fight's stored replay.
8. **Scoutable by opponents.** The party is fully inspectable (every stat,
   stance, siege loadout, entry edge) by the caravan player who meets it —
   field-for-field identical to what the owner sees in their builder.

**Testable in isolation via:** stub matchmaking serves a configured party into
a synthetic trip → resolve → assert owner roster unchanged → assert results
feed updated → assert replay fidelity.

---

### Story 3: Grow and Recover — progression and loss

**As a player,** I want my ladder levels to rise from use (wins and losses
alike) and never fall, unlocking new unit types via webs, so that every fight
moves me forward permanently — and I want a real recovery path when I lose
units on a bad trip, so that a wipe is a setback, not a dead end.

**Acceptance criteria:**

1. **Ladder progress is use-driven.** Ladder progress credits only for pools
   actually used in a fight (no siege ladder gain from a fight with no siege).
   A loss credits positive ladder progress (strictly less than a win).
2. **Ladders never regress.** A full-trip wipe test asserts every ladder level
   and every already-granted unlock point is untouched afterward.
3. **Rung crossing grants once.** Crossing a rung grants unlock points exactly
   once. Two simultaneous stops crossing the same rung grant once, not twice.
4. **All three webs visible.** Living-unit (region-specific), trap, and siege
   unlock webs are fully visible at all times, including nodes not yet
   affordable — costs, prerequisites, and the full stat block of what the node
   grants.
5. **Server-side `hasAccess` is the single gate.** Spending points on an
   unreached node with unmet prerequisites is rejected server-side, not just
   hidden by the UI. A direct API request naming a type the player has not
   unlocked is rejected identically in every code path.
6. **Unlocking grants access, not an instance.** The player's instance
   inventory is unchanged immediately after unlocking a node.
7. **Merging is slot-efficiency, not power.** The merge-level stat curve
   (`MERGE_STAT_MULT_PER_LEVEL`) stays below 2.0× per level for both merge
   recipes (2→1 and 5→3). Cap at level 5.
8. **Recovery: refugee drip.** Offers exactly 3 types drawn only from the
   unlocked pool, on a free timer. Coin-cost reroll produces a new set of 3
   from the same pool (never wider/better). Server-side rejects a type the
   player hasn't unlocked.
9. **Recovery: mercenary recruit.** Lets the player pick any specific
   already-unlocked type, for Coin, with no cooldown. Same type recruited
   twice in a row succeeds without error.
10. **Per-death penalty.** A unit that dies mid-trip (trip ultimately banked or
    lost) loses exactly one merge level, floored at level 1. A unit alive at
    overrun is removed from the roster entirely — a different code path than
    de-merging.
11. **Blast radius bounded.** Only units packed for the trip are at risk.
    Town roster and banked Coin are untouched by any loss path. The attacking
    party's owner loses nothing — their party is a template.

**Testable in isolation via:** seed account with known ladder level + unlocks
→ run synthetic fights → assert ladder changes → assert unlocks grant only
access → simulate losses → assert de-merge vs permadeath code paths diverge
correctly → assert recovery paths use `hasAccess` gate.

---

## Build order for the 3 stories

| Story | First chunks | Can start when |
|---|---|---|
| 1 — Scout and Defend | 07, 10, 11, 13, 14, 15 | 01 (data model) done |
| 2 — Stand and Collect | 09, 13 | 01, 03 done |
| 3 — Grow and Recover | 01, 04, 05, 16, 18, 19 | 01, 02 done |

The dependencies overlap heavily — Story 1 requires the resolver spine (10/11/13)
and the trip loop (15); Story 2 requires the standing party builder (09) and
replay (13); Story 3 requires ladders (04), unlocks (05), economy (16), and
acquisition (18). Implementation order should follow the roadmap chunk order,
not the story order — each story's criteria serve as the acceptance gates for
the relevant chunks.

---

## Key risks (carried forward from the full scope analysis)

1. **Resolver determinism** — the project's highest-risk chunk. Build 10/11/13
   in isolation behind the determinism harness before any dependent chunk starts
   real work.
2. **Account/caravan data split (chunk 01)** — the one true one-way door.
   Schema-level enforcement (check constraints tying pool type to the correct
   scope), not app-code discipline alone.
3. **Server-side `hasAccess`** — the load-bearing P2W guarantee. One code path
   that checks client-side only is a finding. Test every acquisition code path
   with a direct API call bypassing the UI.
4. **Merge stat curve** — must stay below 2.0× per level for both recipes at
   every level. This single test keeps merging as pace-not-power. Check it the
   moment real numbers are set.
5. **Deferred abilities (chunk 12)** — fights may read flat until abilities
   land. This is expected, not a resolver bug. Document the tick-phase-7 no-op
   clearly so the fast-follow is additive, not re-architectural.
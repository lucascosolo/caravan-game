# Caravan Vaults — Design Document
*Status: Core design complete. Ready for implementation planning.*

## 1. Concept & Core Hooks

Build-then-async-resolve game. Players configure a defense (their camp) and an offense (a raiding party) as separate puzzles, then send the raiding party out; outcomes resolve deterministically, no live simulation, no real-time reaction required from either player.

Design is anchored on two player-tested hooks:
- **The King of Thieves hook:** designing a hard-to-beat defense, and the asynchronous tension of checking who raided you and how they did it.
- **The merge/loadout-game hook:** optimizing a loadout against enemy compositions, and collection growth over time — not the merge tap-mechanic itself as a standalone draw.

Hard design constraints carried through every system below:
- **No RNG on outcomes.** Combat resolution is fully deterministic — identical inputs always produce identical results.
- **No gacha, no chests.** Every unlock and every acquisition path gives the player a real, informed choice. Randomness (where it exists at all) only ever shapes which *options* are offered, never which outcome the player receives.
- **No mechanical power for sale.** Monetization affects pace and cosmetics only. Combat resolution logic is identical for paying and non-paying players.
- **Legibility.** A build should be inspectable by another player before they commit resources to fight it.

## 2. Core Loop Overview

The active player loop is a **trip**: a caravan sets out toward a destination, encountering a chain of individually matchmade, individually scoutable opponent camps along the way. This is not a map/travel layer — there is no geography, no route-picking on a spatial overworld. "Region" is a one-time account/caravan-level choice (see §4), unrelated to trip structure.

A trip:
1. Player locks in a raiding party (composition + per-unit stance) for the whole trip. No swapping mid-trip.
2. Matchmaking presents a scoutable candidate camp (see §17).
3. Player chooses an approach and starting positions against that specific camp, then resolves the fight (see §11).
4. On a clear: **bank** (end trip, keep everything earned) or **push** (matchmaking serves the next stop; party carries forward whatever damage/losses it has — no healing until the trip ends).
5. Trip ends on: voluntary bank, full party wipe, or a tick-cap stalemate (favors the defender).

One trip, regardless of how many stops it includes, consumes one use of an hourly trip cap (exact number TBD in balancing).

A successfully completed trip is thematically the "delivery" referenced in early notes — reaching the end and banking *is* the delivery.

## 3. Unit Pools

Three pools, each with its own visible, non-random unlock web:

- **Living units** — shared between offense and defense, but carry two distinct stat profiles (offense rating, defense rating) that are not equal, so the best raider isn't automatically the best guard. **Region-locked**: a desert unit is mechanically distinct from a mountain unit, not a reskin.
- **Traps** — defense-only, universal across regions.
- **Siege equipment** — offense-only, universal across regions. Functions mechanically as a **counter to fences and traps** — specific siege pieces reduce or bypass specific fence/trap categories, making siege loadout a real pre-trip decision informed by scouting.

## 4. Regions

3–4 biome-based regions, chosen once at account/caravan creation. Not freely swappable. No map or travel mechanic attached to region — it only affects which living units are available. Matchmaking is region-agnostic by design (cross-region matches are intentional build diversity, not something to prevent).

**Post-v1 (not in scope now):** a second caravan = a second region, run independently.

## 5. Progression: Reputation & Ladders

Two separate numbers per relevant pool — this split is load-bearing, do not merge them:

- **Reputation** — a single number that drives matchmaking. **Volatile/contestable**: successful raids can shift it (see §13). This is a rating, not a currency — it is never spent.
- **Ladders** — one per pool (living-unit, trap, siege). Levels rise **only through use** (deploying/fighting with objects from that pool); wins earn more ladder progress than losses, but **ladder levels are never lost**, regardless of raid outcomes. The first time a ladder crosses a new rung, the player receives a fixed, permanent grant of unlock points for that pool's web. Those points, once granted, can never be taken away.

## 6. Unlock Webs

One visible, non-random unlock web per pool, funded by the permanent points granted from ladder milestones (§5). Reaching a node grants **access** to recruit/deploy that unit, trap, or siege item — it does not itself grant an instance (see §15 for acquisition).

## 7. Merge System

Merging two owned copies of the same living-unit tier produces one stronger copy of the same unit — no branching, no specialization at merge time. Two recipes:
- 2 units → 1 of the next tier
- 5 units → 3 of the next tier (better per-unit rate: 1.67 units spent per level vs. 2.0 for the small recipe — rewards patient hoarding over merging the instant a pair is available)

Capped at **level 5**.

**Merging costs Coin** (see §14) — this is the primary power-pacing lever in the game. A merged unit is *not* stronger than its unmerged components combined; it is more **slot-efficient** (see deployment slot cap, §20), which is why buying Coin for faster merging is pace, not power (see §16).

## 8. Account vs. Caravan Data Model

- **Account-level** (persists across future caravans): trap Reputation/ladder/unlock web, siege Reputation/ladder/unlock web.
- **Caravan-level** (region-specific, does not transfer): living-unit Reputation/ladder/unlock web.

This split must be correct in the initial schema — retrofitting it after multi-caravan ships would require a painful migration.

## 9. Camp Defense Setup (what a defender configures)

Thematically: preparing camp for the night, Old West setting — a wagon train circling for defense against raiders. Configured asynchronously, persists until the player edits it (not re-configured every "night").

**The caravan is a single entity serving both roles, not two separate systems that happen to share units.** When parked, it presents the defensive posture below and is raidable. The moment a player sends it out on a trip (§12), it is **not present and not targetable** by matchmaking — there is genuinely nothing there to raid, not an undefended camp free for the taking. It becomes raidable again the instant the trip ends, whether by bank or wipe.

- **Fence perimeter** with per-segment HP. Fences are breakable, not permanent walls. Defenders may **deliberately leave gaps** — a resource-allocation puzzle (full-ring costs more unlock investment than most builds sustain early; gaps save budget but expose that approach angle). The layout is visible to scouting raiders — this is the intended read-the-camp skill expression.
- **Traps** — single-trigger, fire once on contact.
- **Garrisoned living units** — each has an **aggro radius** (how close an attacker must get to be noticed) and a **leash distance** (how far the defender will chase from its post before disengaging and returning). Garrison units are mobile within their leash, not static like fences/traps.
- Attackers may approach from any side, or split their party across multiple sides.

## 10. Raid Party Setup (what an attacker configures)

- Composition of living units + siege equipment.
- Starting position(s) along the chosen approach edge(s) — chosen fresh at each stop, based on that stop's scouted layout.
- Per-unit **targeting stance**, locked in before the fight and never changed live: nearest enemy, prioritize traps, or beeline for the caravan core.
- Composition and stances are locked for the **entire trip**, not reset per stop.

## 11. Raid Resolution Algorithm

Fully deterministic. Runs once, server-side, as an internal tick pass — never shown live to either player. The resulting tick log doubles as the replay both players can watch afterward; nothing is re-simulated for playback.

Each tick:
- Every surviving attacker unit paths one step toward its current stance target, respecting fence collisions (walking through a gap if aimed at one, chipping an intact segment's HP down if not — siege equipment accelerates or bypasses this against its countered fence/trap category).
- Any garrison unit with an attacker inside its aggro radius begins pursuing, capped by its leash distance from post; disengages and returns once the attacker leaves range or the leash limit is hit.
- Traps crossed this tick fire once (deterministic tie-break by unit order if multiple units cross simultaneously), applying damage/effect or being nullified by matching siege, then are spent.
- Engaged units (attacker vs. garrison) trade damage each tick via the offense/defense ratio formula: `damage = offense × offense / (offense + defense)`, modified by a type/affinity layer (2–4 damage categories tied to regional unit flavor and trap classes, to prevent pure stat-total optimization from being the whole story) until one side dies or the defender hits its leash limit.

**End conditions:**
- Full party wipe → raid fails this stop, loot scaled to depth reached.
- An attacker reaches the caravan core → full clear, full loot/Reputation for this stop.
- Tick cap reached with neither outcome → stalemate, favors the defender (safety valve against infinite kiting).

## 12. Trip Structure (the outer loop)

See §2 for the sequence. Key mechanical notes:
- Party composition/stances are fixed for the trip; only approach/positioning is chosen fresh per stop.
- Damage and unit deaths **carry forward** between stops within a trip — no healing until the trip ends (via bank or wipe).
- After every clear: **bank** (lock in gains, end trip) or **push** (next matched stop, with whatever's left of the party).
- Trip = one use of the hourly trip cap, regardless of stop count.
- **The caravan is untargetable for the full duration of the trip** — from the moment it starts until it's banked or wiped (§9). No separate travel timer; "in progress" is simply the state between those two points. This adds a minor secondary pull toward pushing further (it also extends how long the home camp stays safe), layered on top of — but not replacing — the loss risk that actually balances the bank/push decision.

## 13. Stakes & Loss Consequences

Two independent resources are at risk, operating at different scopes — this dual structure is deliberate, not redundant:

**Coin (trip-scoped, all-or-nothing):**
If a trip ends in a wipe, **all of that trip's unbanked Coin is lost**, and transfers to the specific defender whose camp landed the final blow (capped by that defender's Coin storage cap, so one kill can't overflow their economy). Banking before a wipe locks the Coin in permanently.

**Units (per-death, granular):**
- Any unit that **dies in any stop** of a trip — regardless of whether the trip is ultimately banked or wiped — **permanently loses one merge level**, floored at level 1 (a unit type can never be fully erased by this alone).
- Units **still alive at the moment a trip's final wipe occurs** are **lost completely** (permadeath), not just de-merged.

This is deliberately harsh but bounded and fair, because:
1. Loss is never RNG-driven — every push-or-bank decision is made with full information from a deterministic, scoutable system, so a wipe is a foreseeable consequence, not bad luck.
2. Blast radius is capped by the deployment slot limit (§20) — a catastrophic trip costs a slot's worth of units, never a whole collection.
3. Unlock rights (the web nodes) and ladder progress are permanent and untouched by any of this — a wiped-out unit type remains fully re-acquirable (§15), just costly to rebuild.
4. It creates real greed-vs-caution tension: units kept safely in the back (to avoid cheap per-death de-merge dings) are exactly the ones exposed to full loss if the whole trip collapses.

## 14. Economy: Coin

- **Earned** via successful raid stops, successful deliveries (completed/banked trips), and a slow passive trickle up to a storage cap (keeps something always at risk even for players who aren't actively pushing trips).
- **Lost** per §13.
- **Spent** on merges (§7) — the core power-pacing lever.
- **Purchasable** — see §16.
- Has a **per-account storage cap**, so accumulation (whether earned or bought) can't run unbounded.

## 15. Unit Acquisition

**Hard constraint on both paths below: neither can ever grant access to a unit type the player hasn't already unlocked.** The unlock web (§6) is the only gate for *which* units exist for a given player — Coin and refugees only ever affect how fast or reliably they get **instances** of types they've already earned deliberate, ladder-funded access to. Coin can never buy progression past the unlock web; it can only buy pace and certainty within it.

Two paths to get a base (level-1) copy of an already-unlocked unit type:

- **Refugee drip (free, passive):** periodically offers a choice of **3 unit types**, drawn from the player's unlocked pool. *Which 3 are offered* is randomized; **which one the player takes is always their choice** — randomness only shapes the menu, never the outcome. Refreshes on a free timer; a **Coin-cost reroll** is available to skip the wait and see a new set of 3 sooner.
- **Mercenary recruit (Coin-cost, guaranteed):** lets the player pick the **exact specific unit type** they want — but only from types already unlocked via the web. No randomness, and no way to reach ahead of unlock-web progress. This is the safety valve that makes the refugee drip's randomness acceptable rather than frustrating — as long as this path is always available for anything already unlocked, no player is ever blocked from getting what they need; they just pay Coin instead of waiting.

## 16. Monetization

- **Weekly rotating packs**, three fixed price tiers: **$5 / $10 / $25**.
- Each tier's **Coin amount is fixed and stays consistent week to week** (no variance, fully previewable).
- **All three tiers are purchasable in the same week** (stackable) — the effective weekly pay-to-accelerate cap is the **combined total of all three tiers' Coin amounts**, not any single tier's figure. This combined sum must be sized against a normal week's free-play Coin earn rate during balancing to keep the guardrail meaningful (playtesting-dependent, see §20).
- Packs bundle in **limited-release cosmetics** that rotate weekly, but contents are **always fixed and previewed before purchase** — no randomization, no mystery-box element, consistent with the legibility principle running through every other system.
- Nothing purchasable affects combat stats or power ceiling — only pace (Coin → faster merges) and cosmetics/rotation exclusivity.
- Resolution logic is identical for paying and non-paying players at every step.

## 17. Matchmaking

Not player-pairing in real time — it's **target selection**. The defender never needs to be online — though they do need to not currently be mid-trip themselves (§9, §12); the candidate pool naturally excludes any caravan that's currently away. This is expected to make the pool size fluctuate somewhat rather than something to correct for.

- Candidates are banded by the single, volatile **Reputation** number (§5), not by mirrored builds — two players at equal Reputation can have very different pool investments and regions, which is intentional diversity, not an imbalance to fix.
- Presents a short list of **3 candidates** per search.
- Re-roll (search again) is **free but time-gated**, not resource-gated — keeps search behavior identical for paying and non-paying players.
- A camp gets a **temporary shield/cooldown** after being successfully raided, preventing immediate re-farming before the defender has a chance to notice and rebuild.

## 18. Technical Architecture

- **Deterministic raid/defense resolver**: given an attacker loadout and a defender layout, compute the outcome as a pure function. No live/interactive combat for either player.
- **Job queue** for pending raids/trip stops, rather than an always-on tick engine — ticking happens once, instantly, server-side per resolution call, not continuously.
- **Event-sourced ledger** for trades, Reputation, Coin, and outcomes — supports the "provably fair" claim and clean replay generation.

## 19. Deferred / Post-v1.0 (explicitly out of scope for MVP)

- Multi-caravan (second caravan = second region, run independently).
- Call-of-Duty-style "reset with a permanent upgrade" prestige system for maxed units.
- Recycling excess/duplicate units for points toward new units.
- **Campaign mode:** a separate, Oregon-Trail-style permadeath run on a recurring cycle (e.g. monthly), using its own progressively-earned unit roster distinct from the core trip loop. Route encounters present risk/reward choices (cooperate for gain vs. fight for a different kind of gain), plus set-piece opportunities like robbing a train. Death ends the run; player waits for the next cycle. All encountered factions — rival wagon trains, outlaw gangs, corrupt railroad agents, Indigenous groups — should get the same structural choice rather than singling any one out for exclusion, since removing agency from only one real group is its own flattening. But for Indigenous encounters specifically, the two branches need to differ in *kind*, not just in loot numbers: this should track as an ongoing relationship with a specific, named group (never a monolithic "Natives" faction, and ideally multiple distinct groups across regions, each with real identity rather than one reskinned template) — sustained cooperation across repeated encounters unlocks safer paths, better trade terms, and unique positive content, reinforced by a portable trust token that signals good standing to further encounters with that group or its allies (needs a name with real cultural texture, not generic "trinkets," which carries its own loaded history). Choosing violence forecloses that relationship and its benefits for the rest of the run, and the writing/framing needs to carry real weight rather than reusing the same neutral "raid successful" tone used for bandits. This isn't something a mechanical formula solves on its own — it needs deliberate, careful writing when this content actually gets built, informed by real research rather than genre convention.

## 20. Open Numbers Needing Playtesting/Tuning

These are intentionally unresolved in this document — they're balancing constants, not design decisions, and shouldn't block implementation. The Maker agent should propose reasonable starting defaults for each and flag them clearly as tunable:

- Damage formula coefficients and the full type/affinity matrix.
- Garrison unit aggro radius and leash distance defaults (may vary by unit type).
- Deployment slot count (units per raid/defense formation).
- Fence segment HP values and their unlock-web cost.
- Trap damage/effect values and unlock-web costs.
- Siege equipment effect values and unlock-web costs.
- Ladder point curves per pool (how much use/wins it takes to hit each rung).
- Unlock web node counts and structure — how many living units (per region), traps, and siege pieces exist at MVP launch.
- Weekly pack Coin amounts per tier, and the resulting combined weekly cap.
- Coin storage cap value.
- Coin earn rates (per raid stop, per completed trip, passive trickle rate).
- Trips-per-hour cap value.
- Refugee drip refresh interval and mercenary recruit Coin cost.
- Tick cap / stalemate threshold for raid resolution.

**Theming (resolved):** Old West. Chosen partly because it's underused in this specific genre (mobile base-raiders default heavily to medieval/fantasy) and partly because it fits several mechanics unusually well — wagon-circling maps directly onto the breakable-fence-with-gaps mechanic, and notoriety/bounty maps directly onto the volatile Reputation number. If Indigenous characters or culture are ever part of unit/content design, that needs deliberate, specific research rather than genre-standard tropes — flagged here for whoever builds content, not resolved by this doc.

---

## 21. Implementation & QA Workflow (Claude Code Handoff Brief)

**Purpose:** Move from this design doc to a playable MVP using two rotating roles: a **Maker agent** (deep implementer, works in scoped chunks) and an **adversarial QA/marketing reviewer** (via Codex), engaged at defined checkpoints.

### Maker Agent — role and constraints
- This document is the source of truth. Do not invent new mechanics or silently deviate from anything in §1–19; where a *number* is unspecified (§20), propose a reasonable default and flag it explicitly as tunable rather than blocking on it.
- Work in scoped chunks, each ending in a working, testable state — not partial/broken intermediate commits.
- Suggested chunk breakdown, roughly in dependency order:
  1. Account/caravan data model (§8), including auth scaffolding.
  2. Unlock web data structures + UI for the three pools (§6).
  3. Living unit / trap / siege content data — placeholder balance numbers per §20, clearly commented as tunable.
  4. Camp/defense builder (fence + trap + garrison placement UI) (§9).
  5. Raid party builder (composition, stance assignment, approach selection) (§10).
  6. Deterministic tick resolver engine + replay log (§11) — this is the highest-risk chunk; should be built and tested in isolation before anything else depends on it.
  7. Matchmaking / candidate search (§17).
  8. Trip loop: chaining, bank/push decision, cross-stop attrition (§12).
  9. Economy: Coin earn/spend/lose/buy, storage cap (§14).
  10. Unit acquisition: refugee drip + mercenary recruit (§15).
  11. Monetization: pack purchase flow, likely stubbed/sandboxed for MVP (§16).
  12. Stakes/loss wiring: merge-level regression and full-loss logic on trip failure (§13) — depends on chunks 6, 8, and 9 being complete.
- After each chunk, hand off to the QA reviewer before starting the next dependent chunk.

### QA / Adversarial Reviewer (Codex) — role and checklist
Engage at the end of every chunk above, and again before declaring MVP-complete. Review adversarially — the goal is to find what's wrong, not to confirm what's right.

**Guardrail checks (run every time):**
- **Determinism:** given identical inputs, is the output always identical? Any hidden randomness anywhere in combat resolution, matchmaking outcome, or acquisition outcome (as opposed to menu generation)?
- **No pay-to-win:** does anything purchasable affect a stat, a power ceiling, or an outcome — versus only pace or cosmetics? Does resolution logic differ in any way for a paying vs. non-paying account? Specifically: can Coin, via mercenary recruit or any other path, ever grant a unit type the player hasn't reached through ladder/unlock-web progress — i.e., does spending Coin ever substitute for unlock-web progress rather than just accelerating instance acquisition within it?
- **Legibility:** can a player preview/scout everything they're supposed to be able to (camp layout before raiding, pack contents before buying, unlock costs before spending)? Is anything hidden that the design says should be visible?
- **Bounded stakes:** does the loss system (§13) ever exceed its intended scope — e.g., can a single trip touch units outside the deployment slot cap, or Coin beyond what that trip earned?

**Fun/playability/success checks:**
- Does the core loop still deliver the two founding hooks (§1) as implemented, or has something drifted the way the map/raiding concept drifted mid-session? Flag any implementation choice that quietly changes what the player is actually doing versus what's designed.
- Do the "generous acquisition" claims (§13, §15) hold up given the actual tuned numbers chosen in each chunk — i.e., is losing a unit type recoverable in practice, not just in theory?
- Are there any grind walls — points where free-path progress is slow enough that the paid path stops feeling optional? This is the specific failure mode called out in §16; check it explicitly, don't assume the guardrails prevent it by construction.

**Bug/edge-case checks:**
- Race conditions in the job queue (simultaneous trip resolutions, concurrent raids against the same camp).
- Tick-resolution edge cases: simultaneous trap triggers, garrison units at exact leash-limit boundaries, ties in the deterministic tie-break rules.
- Data model violations of the account/caravan split (§8) — anything reading or writing living-unit progress at the account level, or trap/siege progress at the caravan level, is a bug.

Report findings back to the Maker agent as a scoped punch list, not a general narrative — each item should be actionable within the next work session.

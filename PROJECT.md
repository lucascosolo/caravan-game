# Caravan Vaults — Design Document
*Status: Core design complete. Ready for implementation planning.*

> **Revision note.** §1, §2, §9, §10, §12, §13 and §17 were rewritten after the
> original draft to correct an inverted core loop. The original had the player
> actively raiding other players' parked camps, with their own camp defending
> passively — and described that camp as a circled wagon train, which is a formation a
> train adopts *out on the trail*, not at home. The polarity is now reversed to match:
> **the active experience is defense.** Mechanically almost everything survived the
> correction with the roles swapped; the deterministic resolver, the trip chain,
> bank-or-push, scouting, the unlock webs, merging, and the economy are unchanged in
> substance. Anything not listed above was not affected.

## 1. Concept & Core Hooks

Build-then-async-resolve game, with the genre's usual polarity reversed.

**The active player experience is defense.** A player escorts their caravan on a trip and, at each encounter along the way, arranges their wagon circle against a specific, scoutable attacking party. This is the analog of a Clash of Clans attack — the thing you actually sit down and play — except you are the one being attacked, and your skill expression is reading an incoming force and countering it.

**The passive side is offense.** Each player separately maintains a raiding party, configured at leisure and left standing. It is served as an encounter in other players' trips, and its owner checks later where it struck and how it fared. This is the analog of a base sitting there getting attacked while you're offline.

Outcomes resolve deterministically; no live simulation, no real-time reaction required from either player.

Design is anchored on two player-tested hooks:
- **The King of Thieves hook:** designing a hard-to-beat *raiding party*, and the asynchronous tension of checking where it struck and how it did — plus, on the active side, the tension of a trip you might not survive.
- **The merge/loadout-game hook:** optimizing a loadout against enemy compositions, and collection growth over time — not the merge tap-mechanic itself as a standalone draw.

Hard design constraints carried through every system below:
- **No RNG on outcomes.** Combat resolution is fully deterministic — identical inputs always produce identical results.
- **No gacha, no chests.** Every unlock and every acquisition path gives the player a real, informed choice. Randomness (where it exists at all) only ever shapes which *options* are offered, never which outcome the player receives.
- **No mechanical power for sale.** Monetization affects pace and cosmetics only. Combat resolution logic is identical for paying and non-paying players.
- **Legibility.** A build should be inspectable by another player before they commit resources to fight it.

## 2. Core Loop Overview

The active player loop is a **trip**: a caravan sets out toward a destination, encountering a chain of individually matchmade, individually scoutable **attacking parties** along the way. This is not a map/travel layer — there is no geography, no route-picking on a spatial overworld. "Region" is a one-time account/caravan-level choice (see §4), unrelated to trip structure.

A trip:
1. Player locks in what the caravan carries — its living units, traps, and fence materials — for the whole trip. No resupplying mid-trip; you fight the rest of the trail with what you packed.
2. Matchmaking presents a scoutable attacking party (see §17).
3. Player arranges the wagon circle against that specific party — fence placement, trap placement, garrison positions and stances — then resolves the fight (see §11).
4. On surviving: **bank** (end trip, deliver, keep everything earned) or **push** (matchmaking serves the next encounter; the caravan carries forward whatever damage/losses it has — no repair or healing until the trip ends).
5. Trip ends on: voluntary bank, the caravan being overrun, or a tick-cap stalemate (the attackers give up and withdraw — favors the caravan).

One trip, regardless of how many encounters it includes, consumes one use of an hourly trip cap (exact number TBD in balancing).

A successfully completed trip is the **delivery** — reaching the end and banking *is* the delivery. This is what the caravan is out there to do; every encounter is something standing between it and arriving.

## 3. Unit Pools

Three pools, each with its own visible, non-random unlock web:

- **Living units** — shared between offense and defense, but carry two distinct stat profiles (offense rating, defense rating) that are not equal, so the best raider isn't automatically the best guard. A unit's defense rating governs it when posted in the wagon circle; its offense rating governs it in a standing raiding party. **Region-locked**: a desert unit is mechanically distinct from a mountain unit, not a reskin.
- **Traps** — defense-only, universal across regions. Used by the caravan, so this pool belongs to the **active** side of the game.
- **Siege equipment** — offense-only, universal across regions. Used by standing raiding parties, so this pool belongs to the **passive** side. Functions mechanically as a **counter to fences and traps** — specific siege pieces reduce or bypass specific fence/trap categories. A party's owner picks its siege blind to any particular caravan, which is what makes the counter relationships a standing bet rather than a reaction.

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

## 9. The Wagon Circle (the active per-encounter puzzle)

Thematically: a wagon train circling for defense out on the trail, Old West setting. **This is the game's active skill expression** — the player arranges it fresh at each encounter, having scouted the specific party bearing down on them.

Two different lifetimes, and the split is the whole design:

- **Locked for the trip** — what the caravan is carrying: which living units, which traps, how much fence material. Packed before departure, never resupplied mid-trail.
- **Chosen fresh per encounter** — how it is all arranged: where the fence goes, where traps are laid, where units are posted and with what stance. This is the decision the player actually makes, against a known, scouted attacker.

**The caravan is a single entity serving both roles, not two separate systems that happen to share units** — the same units that fight for it here are the ones a player merges and manages back home.

- **Fence perimeter** with per-segment HP. Fences are breakable, not permanent walls. The player may **deliberately leave gaps** — a resource-allocation puzzle (a full ring costs more material than most loadouts can sustain; gaps save budget but expose that approach angle). Since the attacking party is scouted first, choosing *where* to leave the gap against *this* attacker is the core read.
- **Traps** — single-trigger, fire once on contact.
- **Posted living units** — each has an **aggro radius** (how close an attacker must get to be noticed) and a **leash distance** (how far it will chase from its post before disengaging and returning). Posted units are mobile within their leash, not static like fences/traps.
- Attackers may approach from any side, or split their party across multiple sides — so a circle is genuinely a circle, with no safe rear.

## 10. Raid Party Setup (the passive, asynchronous side)

A player's raiding party is configured at leisure back in town, persists until edited, and is served as an encounter in **other players' trips**. Its owner is never online for the fight — they check afterward where it struck and how it did. This is the structural analog of a base in a base-raider: a standing artifact other people run into.

- Composition of living units + siege equipment.
- Per-unit **targeting stance**, locked in and never changed live: nearest enemy, prioritize traps, or beeline for the caravan core.
- Approach edge(s) and starting positions, which the party commits to as part of its standing configuration.
- **The party is a template, not an expedition.** It is not consumed, and its units are never lost, however many trips it turns up in — exactly as a base's buildings are not destroyed when it is raided. Its owner risks nothing by leaving it standing, which is what makes the passive side low-friction. What it earns is Coin and Reputation when it succeeds.
- Because it is scouted by the player it attacks, it must be **fully inspectable** before that player commits to arranging their circle against it.

## 11. Raid Resolution Algorithm

Fully deterministic. Runs once, server-side, as an internal tick pass — never shown live to either player. The resulting tick log doubles as the replay both players can watch afterward; nothing is re-simulated for playback.

Each tick:
- Every surviving attacker unit paths one step toward its current stance target, respecting fence collisions (walking through a gap if aimed at one, chipping an intact segment's HP down if not — siege equipment accelerates or bypasses this against its countered fence/trap category).
- Any garrison unit with an attacker inside its aggro radius begins pursuing, capped by its leash distance from post; disengages and returns once the attacker leaves range or the leash limit is hit.
- Traps crossed this tick fire once (deterministic tie-break by unit order if multiple units cross simultaneously), applying damage/effect or being nullified by matching siege, then are spent.
- Engaged units (attacker vs. garrison) trade damage each tick via the offense/defense ratio formula: `damage = offense × offense / (offense + defense)`, modified by a type/affinity layer (2–4 damage categories tied to regional unit flavor and trap classes, to prevent pure stat-total optimization from being the whole story) until one side dies or the defender hits its leash limit.

**End conditions** (stated from the caravan's point of view, since that is the player who is present):
- The attacking party is wiped → **the caravan holds**. It may bank or push. The party's owner earns a reduced share scaled to the depth it reached before dying.
- An attacker reaches the caravan core → **the caravan is overrun**. The trip ends per §13, and the party's owner takes the full reward and Reputation.
- Tick cap reached with neither outcome → **stalemate; the attackers withdraw.** Favors the caravan, and is the safety valve against a party that cannot win but can stall. The caravan may bank or push, carrying its accumulated damage forward.

## 12. Trip Structure (the outer loop)

See §2 for the sequence. Key mechanical notes:
- What the caravan carries is fixed for the trip; only the arrangement of the circle is chosen fresh per encounter.
- Damage, destroyed fence segments, spent traps, and unit deaths **carry forward** between encounters within a trip — no repair, no resupply, no healing until the trip ends (via bank or being overrun).
- After surviving every encounter: **bank** (deliver, lock in gains, end trip) or **push** (next matched attacker, with whatever's left).
- Trip = one use of the hourly trip cap, regardless of encounter count.
- **Pushing is straightforwardly risky.** Each further encounter is another chance to lose the cargo and the caravan, against a party that arrives fresh while yours does not. There is no safety bonus for staying out — the escalating reward is the only reason to push, and mounting attrition is the only reason to stop. That opposition is what makes bank-or-push a real decision.
- Between trips the caravan is home in town and cannot be attacked at all (§9a). There is no asynchronous raid against a player's caravan; the asynchronous layer is entirely on the offense side (§10).

## 12a. Home Town (the hub)

The player's permanent settlement — an Old West town — distinct from the wagon circle in every way. **It is never raided.** It holds the full unit roster and the merge board, the mine that produces the passive Coin trickle (§14), unit acquisition (§15), and the unlock webs (§6).

- The **roster is much larger than what a caravan can carry**; choosing what to pack for a trip, under the deployment slot cap (§20), is a real loadout decision made here.
- Because banked Coin lives here and the town cannot be attacked, **banking genuinely means safe** (§13) — nothing can reach a delivered payload afterward.
- The town is **account-level** and persists across future caravans (§8); a second caravan in a second region would ride out from the same town.

## 13. Stakes & Loss Consequences

Two independent resources are at risk, operating at different scopes — this dual structure is deliberate, not redundant:

**Coin (trip-scoped, all-or-nothing):**
If a caravan is overrun, **all of that trip's unbanked Coin is lost**, and transfers to the owner of the raiding party that landed the final blow (capped by that owner's Coin storage cap, so one kill can't overflow their economy). Banking before that happens locks the Coin in permanently — it goes home to a town that cannot be attacked.

**Units (per-death, granular):**
- Any unit that **dies in any encounter** of a trip — regardless of whether the trip is ultimately banked or lost — **permanently loses one merge level**, floored at level 1 (a unit type can never be fully erased by this alone).
- Units **still alive at the moment the caravan is overrun** are **lost completely** (permadeath), not just de-merged.
- Units left behind in town are never at risk. Only what was packed for the trip can be lost, which is what bounds the blast radius to the deployment slot cap.
- The **attacking party's owner loses nothing** — their party is a standing template (§10), not an expedition. Asymmetric by design: the player who is present and playing is the one with something on the line.

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

Not player-pairing in real time — it's **encounter selection**. Matchmaking draws from the pool of **standing raiding parties** (§10) and serves them as the attackers a caravan meets on its trip. A party's owner never needs to be online, and never needs to be doing anything at all; their party stands whether they play or not, so the pool is always deep.

- Candidates are banded by the single, volatile **Reputation** number (§5), not by mirrored builds — two players at equal Reputation can have very different pool investments and regions, which is intentional diversity, not an imbalance to fix.
- Presents a short list of **3 candidates** per search, each fully scoutable before the player commits to arranging their circle against it.
- Re-roll (search again) is **free but time-gated**, not resource-gated — keeps search behavior identical for paying and non-paying players.
- A **recent-opponent exclusion** prevents the same party from being served repeatedly to the same player in a short window, so a trip feels like a varied trail rather than one gang over and over.
- Because a party is a standing template rather than a caravan that can be away, **nothing needs to be excluded from the pool for being busy**. This is simpler than the reverse arrangement would have been.

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

> **Superseded.** The chunk list below is the original sketch. The live roadmap is
> `/roadmap/INDEX.md`, with one self-contained brief per chunk in `/roadmap/chunks/`
> and the cross-cutting rules in `/roadmap/GUARDRAILS.md`. Work from those; this list
> is kept only to show where they came from. The guardrail and QA checklists further
> down this section are still current and are distilled into every chunk brief.

- Original suggested chunk breakdown, roughly in dependency order:
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
- Race conditions in the job queue (simultaneous trip resolutions; the same standing raiding party being served into several players' encounters at once; a party edited by its owner while it is mid-resolution in someone else's trip).
- Tick-resolution edge cases: simultaneous trap triggers, garrison units at exact leash-limit boundaries, ties in the deterministic tie-break rules.
- Data model violations of the account/caravan split (§8) — anything reading or writing living-unit progress at the account level, or trap/siege progress at the caravan level, is a bug.

Report findings back to the Maker agent as a scoped punch list, not a general narrative — each item should be actionable within the next work session.

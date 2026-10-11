# Chunk 12 — Unit abilities

**Depends on:** 11. **Status:** built (RESOLVER_VERSION 5; see Build notes at the end).
Read `/roadmap/GUARDRAILS.md` in full first.

> **Note on provenance:** abilities are an addition to PROJECT.md, agreed after the
> design doc was written — the reference feel is a Clash of Clans attack, where units
> fire abilities automatically on cooldown. Scope was deliberately fixed at **one
> ability per unit type, drawn from six archetypes**. Do not expand it. Everything
> else in PROJECT.md still governs, and abilities must obey every existing guardrail
> without exception.

## Goal

Tick phase 7: each unit fires its single ability automatically when its cooldown
expires and its targeting condition is satisfiable. Fully deterministic, fixed-point,
no player input.

## Design constraints that apply here

- **Exactly one ability per living-unit type.** No unit has two; no unit has none.
- **Abilities fire automatically on cooldown.** The player never triggers one — there
  is no live/interactive combat for either player, and nothing in the tick loop reads
  player input. Stances were locked before the trip; abilities are locked to the unit
  type.
- **Fully deterministic.** No proc chance, no random target, no variance in effect
  size, no critical version. An ability that fires at tick 412 in one run fires at
  tick 412 in every run. This is not negotiable — the design's entire fairness
  argument rests on being overrun as a foreseeable consequence rather than bad luck, and
  a random ability would make it luck.
- **Six archetypes, parameterized by data** (from chunk 03), not six-times-N bespoke
  implementations: burst damage in a radius, single-target heavy strike, heal/repair
  allies in a radius, temporary self buff, movement dash, structure-breaker (bonus vs.
  fences). Per-type variation comes from values and affinity, never from new code
  paths. The resolver has six cases; the roster has thirty-two units.
- **Abilities work on both sides.** The same unit type posted in a circle uses the same
  ability — but scored on its **defense** rating, consistent with the two-profile
  rule. An ability may be lopsidedly better on offense or on defense; that asymmetry
  is desirable and is part of why the best raider isn't automatically the best guard.
- **Abilities must not become a power ceiling that Coin can raise.** Merge level may
  scale an ability's *values* along the same sub-linear curve as stats — a merged
  unit is still not stronger than its unmerged components combined. It must never
  unlock a new ability, a second ability, or a qualitatively different effect at a
  higher merge level. That would make merging a power gain rather than a slot-
  efficiency gain, and Coin would be buying power.
- **Abilities must be legible before commitment** — effect, radius, and cooldown are
  visible in the standing party builder, the encounter formation UI, and the scout
  view. A player scouting the party about to hit them must be able to see exactly what
  its abilities do, since answering them is the whole active decision. Nothing about a
  fight should be a surprise the player could not have previewed.
- **No floats.** Radii compared as squared distances, durations in integer ticks,
  effect magnitudes in fixed-point.
- Siege equipment has **no** abilities — it remains purely a counter to fences and traps.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `ABILITY_COOLDOWN_RANGE` | 6–20 seconds by ability | Long relative to attack cooldowns so a firing is a visible beat. Converted to integer ticks at setup. |
| `ABILITY_FIRST_USE_DELAY` | equal to the full cooldown | Units don't open with their ability. |
| `ABILITY_TRIGGER_RULE` | fires on the first tick where cooldown is ready **and** the targeting condition is satisfiable; otherwise waits, cooldown already expired | No "wasted" casts into nothing, and no charge-up. Deterministic. |
| `ABILITY_TARGET_TIE_BREAK` | ascending unit id, after the archetype's own ordering rule | Total ordering, documented per archetype. |
| `ABILITY_RESOLUTION_ORDER` | all abilities due this tick resolve in ascending unit id order, against start-of-tick state | Consistent with the simultaneous-damage rule in chunk 11. Document whether a heal resolving before a damage in the same tick can save a unit — pick one and test it. |
| `ABILITY_MERGE_SCALING` | values scale on the same ×1.8/level curve as stats | Stays below the 2.0 that merging implies. Never a new or extra ability. |
| `BURST_RADIUS_DEFAULT` | 2.0 cells | Archetype 1. |
| `HEAVY_STRIKE_MULT` | ×3.0 of a normal hit, single target | Archetype 2. |
| `HEAL_RADIUS_DEFAULT` | 2.5 cells | Archetype 3. See the healer section below — this archetype has more constraints than the others. |
| `HEAL_AMOUNT` | 10% of the target's max HP per cast, all valid targets in radius | Percentage rather than flat, so it scales sanely across the roster. |
| `HEAL_CHARGES_PER_BATTLE` | 4, non-regenerating | **The load-bearing bound.** A healer's satchel empties and does not refill mid-battle. |
| `HEAL_COOLDOWN` | 14 seconds | Combined with 4 charges, a healer is spent roughly a minute into a 180-second fight. |
| `SELF_BUFF_DEFAULT` | +30% damage for 5 seconds | Archetype 4. Non-stacking with itself; document the refresh rule. |
| `DASH_DISTANCE_DEFAULT` | 3.0 cells along the current path | Archetype 5. Must not pass through an intact fence segment. |
| `STRUCTURE_BREAKER_MULT` | ×5.0 damage vs. fence segments only | Archetype 6. Does not stack multiplicatively with siege — pick additive and document it, or one guardrail check will find a unit one-shotting a top-tier fence. |

### The healer archetype — deliberate design intent

A healer is **wanted**. It makes the loop fairer: it gives a player a way to invest a
slot in resilience rather than raw damage, and it softens the harshest runs without
touching the unlock web or costing Coin. It is a skill-expression lever, not a
power one.

**But losses must still bite.** The explicit non-goal: *a caravan must never be able to
keep itself at full health.* If a healer lets a caravan reach encounter 4 in the shape
it left encounter 1, the carry-forward attrition that makes push-or-bank a real
decision is gone, and with it the tension the entire outer loop is built on. Healing
should make a trip **survivable-but-degraded**, never fresh.

Four rules enforce that, and they should be treated as design constraints rather than
balance numbers:

1. **Finite charges per battle, non-regenerating** (`HEAL_CHARGES_PER_BATTLE` = 4).
   This is the load-bearing bound and the reason it isn't simply "tune the number
   down." A charge budget fails safe: a longer, harder fight gets *less* healing per
   minute, not more, so a healer can never out-sustain an attritional grind. A flat
   per-cast nerf would not have that property.
2. **Charges do not refill between encounters.** They reset at the start of each
   fight, so healing is bounded per fight *and* cannot be banked across a trip.
3. **No overheal, no revival.** A heal may not exceed max HP and may not restore a
   dead unit. Death still triggers the per-death merge-level regression — healing only
   matters insofar as it prevents a death, never as an undo.
4. **End-of-encounter HP carries forward exactly, heals included.** PROJECT.md is
   explicit that there is no repair or healing until the trip ends; in-battle healing
   does not violate that, but nothing may top a caravan up between encounters.

**Tuning target:** across a typical encounter, a healer should offset roughly **25–35% of
incoming damage** — enough to change which units survive, nowhere near enough to
negate the fight. It also costs one of eight deployment slots, so it is already
competing against a damage unit; that opportunity cost is part of the balance and
should not be compensated for with generosity elsewhere.

**Known exploit vector — check this specifically.** A healer *posted in the wagon
circle* is more dangerous than one in a standing raid party, because a stalemate at
the tick cap **favors
the caravan**. A wagon circle built to survive rather than to kill could farm
stalemates, turning the safety valve into a free win every encounter. Finite charges
is the primary mitigation, but it must be verified rather than assumed: build a
maximally turtled circle with healers and confirm a strong standing party can still
break it.

## Definition of done

- [ ] Six archetypes implemented as six parameterized cases; a test asserts no
      per-unit-type branching exists in the resolver.
- [ ] Cooldowns tracked in integer ticks, first-use delay honored.
- [ ] Trigger rule implemented: fires when ready and satisfiable, waits otherwise.
- [ ] Resolution order documented and deterministic; the heal-vs-damage same-tick
      interaction is pinned by an explicit test.
- [ ] Abilities work for posted units, scored on defense rating.
- [ ] Merge scaling raises values only, never grants a new ability — tested at every level.
- [ ] Dash cannot cross an intact fence segment.
- [ ] Structure-breaker and siege interaction is additive and documented.
- [ ] Heals cannot exceed max HP or revive; post-battle HP carries to the next encounter.
- [ ] Heal charges are finite per battle, non-regenerating, and reset (not accumulate)
      at the start of each encounter.
- [ ] **An attrition test exists and is treated as a release gate:** a caravan carrying
      a healer that survives three consecutive encounters must reach the fourth
      measurably degraded — assert total caravan HP is below a stated fraction of full.
      If this test ever passes trivially, healing has broken the outer loop.
- [ ] A turtle test: a wagon circle built maximally around posted healers must still
      be breakable by a strong standing party within the tick cap.
- [ ] Still pure, still fixed-point, no floats. Isolation checks from chunk 10 pass.
- [ ] Determinism harness extended to ability-heavy fights — 100× byte-identical.
- [ ] Boundary tests: two abilities firing on the same tick; an ability firing on the
      same tick its caster dies; a heal and lethal damage on the same tick; a target
      at exactly the ability radius; an ability whose condition becomes satisfiable
      mid-tick.

## QA guardrail checks for this chunk

- **Determinism — the highest-risk surface abilities introduce:** any proc chance,
  random target, or variance? Does an ability ever fire at a different tick across two
  runs of the same input? Re-run the float and banned-function greps from chunk 10.
- **No pay-to-win:** does merge level ever grant a **new** ability, a second ability,
  or a qualitatively different effect — rather than scaling values sub-linearly? If it
  does, merging is a power gain and Coin buys power. Check every level for every archetype.
- **Legibility:** are ability effect, radius, and cooldown visible in the party
  standing party builder, the formation UI, **and the scout view**? The player
  arranging a circle must be able to see exactly what the incoming party's abilities
  do — that is the read the entire active loop rests on.
- **Scope creep:** has any unit acquired a second ability, or an archetype been
  special-cased for one unit? Both multiply the resolver's edge-case surface by the
  roster size, on the project's highest-risk code.
- **Attrition still bites — the single most important check on the healer:** run a
  healer-carrying caravan through three consecutive encounters and measure. If it
  reaches each one near full health, the carry-forward attrition that makes push-or-bank
  tense has been deleted, and the outer loop has quietly lost its stakes. Losses are
  supposed to hurt; a healer is meant to soften them, not erase them. Confirm charges
  are finite, non-regenerating within a battle, and not bankable across stops.
- **Defensive stalemate farming:** can a wagon circle built around posted healers survive to
  the tick cap against a competent attack? Stalemate favors the defender, so a camp
  that only needs to *not die* would convert the anti-kiting safety valve into a
  reliable win condition. Build the worst case deliberately.
- **Healing is not an undo:** confirm a heal cannot revive, cannot overheal, and never
  reverses the per-death merge-level regression once a unit has actually died.
- **Interaction stacking:** structure-breaker plus siege plus affinity — can any
  combination trivialize a top-tier fence? Compute the worst case rather than assuming.
- **Design fidelity:** siege still has no abilities and remains a counter to fences
  and traps only.

## Build notes (Maker, 2026-10-11) — RESOLVER_VERSION 4 → 5 `[resolver-bump]`

Code: `packages/resolver/src/abilities.ts` (phase 7; the header is the normative rule list),
`combat.ts` (damage pipeline steps 3b/3c, `engaged` / `breachableFence` moved here from
tick.ts), `state.ts` (`abilityFields`, `startHp`), `move.ts` (`advanceMeasured`), `posted.ts`
(`advanceWithinLeash` exported, returns `used`), `tick.ts` (dash sweep carried into phase 3,
keyframe `ab`), `log.ts` (`ability` events, interpolation contract), `input.ts` (two tunables,
ability field bounds). Content: `STRUCTURE_BREAKER_SEGMENT_CAP`; the six breaker descriptions
state the cap. Circle: `resolverTunables()` carries the two new keys (exports unchanged).

### Rules and tie-breaks

- **Six cases, data-driven.** `decide` and `applyNonHeal` each switch on the six archetypes
  and nothing else; no resolver file names a unit type, reads `typeId` outside the
  input/state plumbing, or reads `mergeLevel` in abilities.ts (a source-scanning test).
- **ABILITY_COOLDOWN**: `abilityCooldownTicks = msToTicks(cooldown)`; the ability may fire
  on any tick ≥ `abilityReadyTick`; after firing on t it is `t + cooldownTicks`.
- **ABILITY_FIRST_USE_DELAY**: initial `abilityReadyTick = floor(cooldownTicks ×
  abilityFirstUseDelayMult / 1024)` — a full cooldown at ×1.0 (a 9 s dash first readies on
  tick 180). The multiplier is input (`ABILITY_FIRST_USE_DELAY_MULT`, 0..×64).
- **ABILITY_TRIGGER_RULE**: fires on the first tick it is ready AND its condition holds;
  otherwise it waits, already ready, re-tested every tick. Conditions are evaluated in phase 7,
  so one made satisfiable by this tick's phases 3–6 fires this tick.
- **ABILITY_SKIPS_ZERO_HP**: a unit at 0 HP (dies in phase 8) is never a target and never
  makes a condition true. A caster at 0 HP still fires (SIMULTANEOUS_DAMAGE) — except a dash
  (DASH_NOT_DYING: its movement is over).
- **ABILITY_RESOLUTION_ORDER — decide, then apply, damage first.** Every living unit in
  ascending id decides against the state at the start of phase 7 (nothing mutates while
  deciding, so one firing cannot change another's targets — an ability made satisfiable only
  by another ability in the same phase waits a tick). Then (a) every non-heal firing in
  ascending caster id, then (b) every heal in ascending caster id. Log order follows.
- **HEAL_VS_DAMAGE_SAME_TICK (the decision):** a heal can NEVER save a unit from damage landing
  the same tick, whatever the ids. Phase 4/6 damage is in before phase 7 and ability damage is
  applied before any heal; a unit at 0 HP gets 0 and dies in phase 8. A heal applies to the HP
  left after all of the tick's damage. Pinned both ways round (attacker healer id 0 vs a post's
  strike; post healer vs an attacker's burst).
- **TARGET_ORDER** (per archetype, then ascending unit id): burst — all enemies in reach; heavy
  strike — nearest in attack reach (a breacher: only enemies that reach it, ATTACK_PRIORITY);
  heal — all wounded allies in reach (caster included); self buff / dash — the caster;
  structure breaker — the segment it is breaching.
- **REACH**: burst and heal radii are `distSq ≤ (radius + unitRadius)²`, inclusive (chunk 11).
- **Damage pipeline** (combat.ts DAMAGE_ROUNDING_ORDER): formula → affinity → merge → **3b**
  self buff while in force → **3c** ability multiplier (ability hits only) → siege (fence
  normal hits) → min 1, each floored. "×3.0 of a normal hit" is ×3.0 of the MERGED hit
  (QA-03 S1); no ability field scales with merge level.
- **burst_radius / heavy_strike**: `abilityHitDamage` = the unit-hit pipeline × damageMult.
- **heal_radius**: + floor(target maxHp × healFraction), capped at the target's
  **HEAL_CEILING = `startHp`, the HP it brought into this battle** (≤ maxHp, so no overheal).
  Condition: charges > 0 and a living ally with 0 < HP < startHp in reach. One charge per
  firing; charges come from the ability data, never regenerate, and reset per encounter by
  construction (fresh state per `resolve`). No revival: a dead unit is never a target and only
  phase 8 writes `alive`; the per-death merge regression (server side, on `diedTick`) is never
  touched.
- **self_buff**: condition — an enemy in attack reach (HP > 0) or a fence it is breaching.
  Hits on ticks t+1 … t+durationTicks carry ×(1 + damageBonus) (`buffEndTick − buffTicks <
  tick ≤ buffEndTick`), unit and fence hits alike. **SELF_BUFF_REFRESH**: a recast while in
  force replaces it — end = recast tick + duration; never stacks, never extends further.
- **dash**: condition — HP > 0, not rooted, has waypoints, not engaged (attackers) / pursuing
  and out of reach of its target (posts; hold and unreleased reserve posts never move), and a
  trial run of the step (restoring every movement field) covers > 0 (DASH_NEVER_EMPTY).
  Effect: `advance` by `distance` along the current route — the movement leg rule, consuming
  waypoints, stopping short of an intact breach segment; a post's dash uses LEASH_CLAMP. A slow
  does not shorten it. Never enters an intact fence or anchor cell (smoothed route + advance's
  blocked-cell refusal; tested over a whole sealed-ring fight per tick). **DASH_SPRINGS_TRAPS**:
  an attacker's dash polyline becomes the start of its next tick's sweep, so phase 4 of t+1
  tests the dash path (no tunnelling; the trap fires a tick after the dash). A dash ending on a
  core cell logs `core_reached` on the dash tick.
- **structure_breaker**: condition — an attacker breaching a segment it can hit now (intact,
  HP > 0, adjacent). Posts never hit fence, so a posted breaker never fires (lopsided by
  design). Damage = max(1, min(floor(merged × mult), floor(maxHp × segmentCap))), mult =
  fenceDamageMult + (siegeFenceDamageMult − 1.0) when the party's siege counters the segment's
  category, else fenceDamageMult. **SIEGE_ADDITIVE**: ×5 and ×4 → ×8, never ×20. Affinity never
  applies to a segment.
- **STRUCTURE_BREAKER_SEGMENT_CAP (new tunable, ×0.50 — see assumption 1):** one breaker hit
  takes at most half the segment's max HP, so no segment of any tier is one-shot.
- **Two profiles**: a post's ability hits use its defense rating (`rating`), like its hits.
- **Siege has no abilities**: a siege piece with an `ability` key is refused at the input.
- **Log**: `ability` events `{t, k, u, a, tg: [{kind: unit|fence, id, amount, hp}]}` plus
  `charges` (heal), `until` (buff), `x, y` (dash). `amount` = damage / HP restored / buff ticks
  / distance moved. Keyframes carry `ab` (ticks until ready). log.ts INTERPOLATION CONTRACT:
  a dash is a movement leg applied after the unit's own movement phase.
- **Input**: `abilityFirstUseDelayMult` (0..×64), `structureBreakerSegmentCap` (1..1024);
  ability fields bounded at both ends (radii/distance ≤ 64 cells, damage multipliers and the
  breaker mult ×1.0..×64, healFraction 0..1024, charges 0..1000, buff bonus 0..×64, duration
  1..60 000 ms).

### Worst cases computed (circle `test/abilities-qa.test.ts`, real content)

- **Structure breaker**: uncapped worst = level-5 Buffalo Bull (offense 120 → merged 292) ×8
  (5 + 4 − 1, stone siege) = **2336** vs Stacked Stone 1000 HP (multiplicative would be 5840);
  ×5 alone one-shots it from level 4 (1170). Capped: every breaker × level 1–5 × siege on/off ×
  every tier ≤ 50.0 % of the segment.
- **Reported, not changed (chunk 11 territory):** with stone siege, a level-5 Buffalo Bull's
  NORMAL hit is floor(292 × 4) = **1168 ≥ 1000** — it breaks a full Stacked Stone segment in
  one blow without its ability. For chunk 37 / the orchestrator.
- **Healer turtle** (all posts level 5: four content healers + four sturdiest defenders packed
  round the core, 20 Stacked Stone segments, six traps) vs 8 level-5 raiders with three siege:
  **held 0/8 approaches in `hold` and 0/8 in `guard`**. Sweep (3–8 raiders, levels 1–5, both
  stances): healers never held more than 4/8, and never turned more than one loss into a hold
  versus the same circle with tanks in the healer slots (they usually held the same or fewer).
  A single `core`-stance raider slips through a gap and reaches the core past guard posts:
  stalemate farming is not a reachable win condition while the ring must have gaps.
- **Healing offset** (healed ÷ damage taken by posts): 7.5–16 % against 8 raiders, up to
  29–32 % against 3–4 level-1 raiders — under the 25–35 % target in a full fight (the healers
  die early). A balance note, not a change.
- **Attrition gate**: four trips, each three survived encounters of 2 level-1 raiders, posts' HP
  carried forward exactly: arrive at encounter 4 with 82.6–89.9 % of full; asserted < 90 %, and
  no encounter ever ends with more total HP than it began.

### Measurements

- Full load (16 v 8 v 28, every unit with one of the six archetypes, 3600 ticks): best
  **69 ms** alone (77 ms under the parallel suite), asserted < 100 ms.
- Log: **124.7 KB** (was 115.5 KB): keyframes 95.5 KB (+6.5 KB for `ab`), `ability` 23 events
  4.3 KB. The lever is still the keyframe (QA-10 N4, chunk 13).

### Assumptions / decisions for QA

1. **STRUCTURE_BREAKER_SEGMENT_CAP is a new rule** (a tunable, ×0.50, stated in every breaker's
   description). The brief requires that no combination one-shots a top-tier fence; additive
   siege alone cannot satisfy that with content's numbers (2336 vs 1000). Alternatives the
   orchestrator may prefer: lower the breaker multipliers (≤ ×3.4 at level 5 without siege), or
   apply the bonus to the unmerged hit (contradicts QA-03 S1).
2. **HEAL_CEILING = start-of-battle HP.** Without it, a fresh satchel each fight healed damage
   carried in from earlier encounters (a healer circle came out of a weak encounter with MORE HP
   than it went in) — a between-encounter top-up, which healer rule 4 forbids. With it the
   attrition test is meaningful and HP is non-increasing across a trip.
3. HEAL_VS_DAMAGE_SAME_TICK: damage first (see above); a decided heal whose target died in step
   (a) still spends its charge (it fired against the start-of-phase state).
4. The healer heals itself (it is an ally in its own radius).
5. Self buff and heavy strike use the same reach as normal attacks; a self buff also boosts
   fence hits.
6. Test fixtures: chunk 10/11 tests that pin a rule tick-exactly use `quiet()` (first use ×64,
   past the cap) — 6 tests; every unit still has its ability. The qa11 literal inputs gained
   the two new tunable keys.

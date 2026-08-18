# Chunk 12 — Unit abilities

**Depends on:** 11. **Status:** not started.
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
  argument rests on a wipe being a foreseeable consequence rather than bad luck, and
  a random ability would make it luck.
- **Six archetypes, parameterized by data** (from chunk 03), not six-times-N bespoke
  implementations: burst damage in a radius, single-target heavy strike, heal/repair
  allies in a radius, temporary self buff, movement dash, structure-breaker (bonus vs.
  fences). Per-type variation comes from values and affinity, never from new code
  paths. The resolver has six cases; the roster has thirty-two units.
- **Abilities work on both sides.** The same unit type garrisoned uses the same
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
  visible in the raid party builder, the camp builder, and the scout view. A defender
  scouting a camp can see what the garrison's abilities do. Nothing about a fight
  should be a surprise the player could not have previewed.
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
| `HEAL_RADIUS_DEFAULT` | 2.5 cells, healing a flat amount by type | Archetype 3. May not heal above max HP. Note this interacts with the no-healing-between-stops rule — see below. |
| `SELF_BUFF_DEFAULT` | +30% damage for 5 seconds | Archetype 4. Non-stacking with itself; document the refresh rule. |
| `DASH_DISTANCE_DEFAULT` | 3.0 cells along the current path | Archetype 5. Must not pass through an intact fence segment. |
| `STRUCTURE_BREAKER_MULT` | ×5.0 damage vs. fence segments only | Archetype 6. Does not stack multiplicatively with siege — pick additive and document it, or one guardrail check will find a unit one-shotting a top-tier fence. |

**The heal archetype needs care.** PROJECT.md is explicit that there is **no healing
until the trip ends** — damage and unit deaths carry forward between stops. An
in-battle heal does not violate that (it's within a single fight), but two rules must
hold: a unit's HP at the *end* of a stop carries to the next stop as-is, heals
included; and no heal may exceed max HP or resurrect a dead unit. If in-battle healing
turns out to blur the cross-stop attrition that makes push-or-bank tense, flag it —
that tension is the outer loop's whole balance.

## Definition of done

- [ ] Six archetypes implemented as six parameterized cases; a test asserts no
      per-unit-type branching exists in the resolver.
- [ ] Cooldowns tracked in integer ticks, first-use delay honored.
- [ ] Trigger rule implemented: fires when ready and satisfiable, waits otherwise.
- [ ] Resolution order documented and deterministic; the heal-vs-damage same-tick
      interaction is pinned by an explicit test.
- [ ] Abilities work for garrison units, scored on defense rating.
- [ ] Merge scaling raises values only, never grants a new ability — tested at every level.
- [ ] Dash cannot cross an intact fence segment.
- [ ] Structure-breaker and siege interaction is additive and documented.
- [ ] Heals cannot exceed max HP or revive; post-battle HP carries to the next stop.
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
  builder, the camp builder, **and the scout view**? A raider committing a trip-locked
  party against a camp must be able to see what its garrison will do.
- **Scope creep:** has any unit acquired a second ability, or an archetype been
  special-cased for one unit? Both multiply the resolver's edge-case surface by the
  roster size, on the project's highest-risk code.
- **Bounded stakes / attrition:** does in-battle healing undercut the no-healing-
  between-stops rule? Confirm end-of-stop HP carries forward exactly, and judge
  whether heals have flattened the cross-stop attrition that makes push-or-bank a real
  decision.
- **Interaction stacking:** structure-breaker plus siege plus affinity — can any
  combination trivialize a top-tier fence? Compute the worst case rather than assuming.
- **Design fidelity:** siege still has no abilities and remains a counter to fences
  and traps only.

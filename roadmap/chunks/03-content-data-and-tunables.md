# Chunk 03 — Content data & tunables registry

**Depends on:** 01. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Define the three content pools as data — living units per region, traps, siege
equipment — plus the type/affinity matrix, and put **every balance number in the
project into one clearly-marked tunables registry**. Later chunks read constants
from here; none of them hardcodes a balance value.

## Design constraints that apply here

Three pools, each with its own visible, non-random unlock web:

- **Living units** — shared between offense and defense, but each carries **two
  distinct stat profiles (offense rating, defense rating) that are not equal**, so
  the best raider isn't automatically the best guard. This asymmetry is the point;
  do not let the data collapse into one stat with a modifier.
  **Region-locked**: a desert unit is mechanically distinct from a mountain unit,
  **not a reskin**. Different stats, different affinity type, different aggro/leash
  profile — not the same row with a new name and art.
- **Traps** — defense-only, universal across regions, carried by the caravan. Belongs
  to the **active** side. Single-trigger: they fire once on contact, are then spent,
  and do not re-arm for later encounters in the same trip.
- **Siege equipment** — offense-only, universal across regions. Functions
  mechanically as a **counter to fences and traps**: specific siege pieces reduce
  or bypass **specific** fence/trap categories. Siege belongs to the **passive** side:
  a standing party's owner picks it **blind to any particular caravan**, so it is a
  standing bet on what kinds of wagon circles the party will meet, not a reaction. The
  counter relationships must therefore be categorical and legible — a flat universal
  bonus would be strictly better than any counter and would collapse the choice.
- **Type/affinity layer**: 2–4 damage categories tied to regional unit flavor and
  trap classes, existing specifically **to prevent pure stat-total optimization
  from being the whole story**. If a player can win by summing one number, the
  affinity layer has failed.
- **Each living-unit type has exactly one ability, fired on an automatic cooldown**
  during battle. Abilities are fully deterministic — no proc chance, no random
  target, no variance. They are defined as **data** here; their resolution is
  chunk 12. Abilities are part of what makes a unit's offense and defense profiles
  differ: an ability may be useful in a standing raid party, useful posted in a wagon circle, or lopsidedly one.
- **Battles are continuous, not tile-locked.** Units move freely in fixed-point
  continuous space at a speed in cells/second, and attack on a per-unit cooldown
  rather than every tick. Stats must therefore be expressed in **rates and
  distances**, not per-tick amounts.
- Living units cap at **merge level 5**. Stats per merge level must be defined such
  that **a merged unit is not stronger than its unmerged components combined** —
  it is more *slot-efficient*. This is a hard monetization guardrail, not a balance
  preference: if merging is a net power gain, Coin buys power.
- Every number here is a **balance constant, not a design decision**. Propose a
  reasonable default, mark it tunable, and never block on playtest data.
- **Theming is Old West.** Wagon trains, fences, notoriety. If Indigenous characters
  or culture enter unit/content design, that needs deliberate, specific research
  rather than genre-standard tropes — do not improvise it in this chunk; flag it up.

## Tunables this chunk needs (defaults proposed — all tunable)

Content scale:

| Name | Default | Note |
|---|---|---|
| `LIVING_UNITS_PER_REGION` | 8 | MVP web size; 4 regions → 32 living unit types. |
| `TRAP_TYPES` | 6 | Universal. |
| `SIEGE_TYPES` | 5 | Universal; each counters a category. |
| `AFFINITY_CATEGORIES` | 3 | Within the 2–4 range. Suggest: Grit / Powder / Beast. |
| `MERGE_LEVEL_CAP` | 5 | Fixed by design, not tunable. |

Combat math:

| Name | Default | Note |
|---|---|---|
| `DAMAGE_FORMULA` | `offense × offense / (offense + defense)` | Fixed by design (§11). |
| `AFFINITY_ADVANTAGE_MULT` | 1.25 | Applied to damage on a favorable matchup. |
| `AFFINITY_DISADVANTAGE_MULT` | 0.80 | Unfavorable. Neutral = 1.00. |
| `MERGE_STAT_MULT_PER_LEVEL` | ×1.8 per level (L1=1.0, L2=1.8, L3=3.24, L4=5.83, L5=10.5) | **Must stay below the 2.0 that 2→1 merging implies**, so a merged unit is weaker than its components combined. Slot efficiency is the gain. |
| `BASE_OFFENSE_RANGE` | 40–120 across unit types | Placeholder spread. |
| `BASE_DEFENSE_RANGE` | 40–120, **independently rolled per type** | Must not correlate with offense. |

Unit behavior defaults (may vary by unit type — all in fixed-point, never floats):

| Name | Default | Note |
|---|---|---|
| `AGGRO_RADIUS_DEFAULT` | 4.0 cells | Per-type override expected. |
| `LEASH_DISTANCE_DEFAULT` | 6.0 cells from post | Per-type override expected. |
| `MOVE_SPEED_DEFAULT` | 1.5 cells/second | Per-type override; range roughly 0.8–3.0 across the roster. Stored as fixed-point, converted to per-tick displacement by the resolver. |
| `ATTACK_RANGE_DEFAULT` | 1.0 cells (melee); 4.0 cells for ranged types | Range is what makes a unit melee or ranged — there is no separate flag. |
| `ATTACK_COOLDOWN_DEFAULT` | 1.0 second | Range 0.4–2.5s across the roster. The damage formula fires once per cooldown expiry, not once per tick. |
| `UNIT_HP_RANGE` | 300–1,400 by type | Needed now that damage is cooldown-paced rather than per-tick. |

Ability data (one per living-unit type; resolution is chunk 12):

| Name | Default | Note |
|---|---|---|
| `ABILITIES_PER_UNIT_TYPE` | exactly 1 | Every living-unit type has one, no more. |
| `ABILITY_COOLDOWN_RANGE` | 6–20 seconds by ability | Long relative to attack cooldowns, so an ability firing is a visible beat in the fight. |
| `ABILITY_FIRST_USE_DELAY` | equal to the full cooldown | Units don't open with their ability. Tunable. |
| `ABILITY_TRIGGER` | fires the moment its cooldown is ready **and** its targeting condition is satisfiable | Fully deterministic — no chance, no player input. |
| `ABILITY_ARCHETYPES` | 6 shapes reused across the roster with per-type values: burst damage in a radius, single-target heavy strike, heal/repair allies in a radius, temporary self buff, movement dash, structure-breaker (bonus vs. fences) | Keeps the resolver's ability code to six deterministic cases rather than 32 bespoke ones. Per-type variation comes from values and affinity, not new code paths. |

Trap / siege / fence values:

| Name | Default | Note |
|---|---|---|
| `TRAP_DAMAGE_RANGE` | 60–250 flat, by type | Single-trigger. |
| `FENCE_SEGMENT_HP_DEFAULT` | 400 | See chunk 07. |
| `SIEGE_FENCE_DAMAGE_MULT` | ×4 vs. its countered fence category | The "accelerates" case. |
| `SIEGE_TRAP_NULLIFY` | full nullify vs. its countered trap category | The "bypasses" case. |

## Definition of done

- [ ] All content is **data**, loadable and diffable — not scattered literals.
- [ ] One tunables registry file; every constant above lives there with a comment
      marking it tunable and naming what would drive the change.
- [ ] A grep for magic numbers in game logic comes back clean.
- [ ] Living units have genuinely independent offense and defense ratings; a test
      asserts the two are not a fixed ratio across the roster.
- [ ] Regions produce mechanically distinct rosters; a test asserts no two regions
      share a unit stat block.
- [ ] Affinity matrix is complete, and the counter relationships between siege and
      fence/trap categories are explicit data, not code branches.
- [ ] Merge-level stat curve is verified **below** the components-combined line at
      every level, by test.
- [ ] Content validates on load: no dangling category references, no unit missing a
      required field.
- [ ] Every living-unit type has exactly one ability, drawn from the six archetypes,
      with all values authored as data.
- [ ] All rates and distances are stored as fixed-point, with the scaling factor
      documented once and used everywhere. A test asserts no float literal reaches
      the sim-facing content structures.
- [ ] Speeds are in cells/second and cooldowns in seconds — not in ticks. The
      resolver converts; the content data never encodes a tick rate.

## QA guardrail checks for this chunk

- **No pay-to-win, structurally:** does `MERGE_STAT_MULT_PER_LEVEL` ever make a
  merged unit stronger than the units spent to make it? Check every level, both
  recipes (2→1 and 5→3). If merging is a power gain, Coin buys power.
- **Determinism:** are any stats, ranges, or affinity values generated at load time
  rather than authored? Any "roll a spread" helper that runs at runtime is a bug.
  Are all values fixed-point, with no float literals anywhere in the content data?
  Does any ability have a proc chance, a random target, or a variance roll? It must not.
- **Ability scope creep:** is every ability one of the six archetypes with different
  values, or has a bespoke code path crept in per unit? The latter multiplies the
  resolver's edge-case surface by the size of the roster.
- **Design fidelity:** are region rosters mechanically distinct or reskins with
  different names? Are offense and defense ratings actually decoupled, or has one
  become a function of the other?
- **Legibility:** is every number a player is expected to reason about (unit stats,
  trap damage, siege counters, fence HP) exposed for display, not internal-only?
- **Affinity does real work:** can a player win consistently by maximizing raw stat
  total while ignoring affinity? If yes, the layer isn't doing its job — flag it.

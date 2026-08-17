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
- **Traps** — defense-only, universal across regions. Single-trigger: they fire once
  on contact and are then spent.
- **Siege equipment** — offense-only, universal across regions. Functions
  mechanically as a **counter to fences and traps**: specific siege pieces reduce
  or bypass **specific** fence/trap categories. This makes siege loadout a real
  pre-trip decision informed by scouting — so the counter relationships must be
  categorical and legible, not a flat universal bonus.
- **Type/affinity layer**: 2–4 damage categories tied to regional unit flavor and
  trap classes, existing specifically **to prevent pure stat-total optimization
  from being the whole story**. If a player can win by summing one number, the
  affinity layer has failed.
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

Unit behavior defaults (may vary by unit type):

| Name | Default | Note |
|---|---|---|
| `AGGRO_RADIUS_DEFAULT` | 4 tiles | Per-type override expected. |
| `LEASH_DISTANCE_DEFAULT` | 6 tiles from post | Per-type override expected. |
| `MOVE_SPEED_DEFAULT` | 1 tile/tick | Per-type override; keep integral for determinism. |

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

## QA guardrail checks for this chunk

- **No pay-to-win, structurally:** does `MERGE_STAT_MULT_PER_LEVEL` ever make a
  merged unit stronger than the units spent to make it? Check every level, both
  recipes (2→1 and 5→3). If merging is a power gain, Coin buys power.
- **Determinism:** are any stats, ranges, or affinity values generated at load time
  rather than authored? Any "roll a spread" helper that runs at runtime is a bug.
- **Design fidelity:** are region rosters mechanically distinct or reskins with
  different names? Are offense and defense ratings actually decoupled, or has one
  become a function of the other?
- **Legibility:** is every number a player is expected to reason about (unit stats,
  trap damage, siege counters, fence HP) exposed for display, not internal-only?
- **Affinity does real work:** can a player win consistently by maximizing raw stat
  total while ignoring affinity? If yes, the layer isn't doing its job — flag it.

# Chunk 11 — Resolver combat: damage, traps, garrison

**Depends on:** 10. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Fill in tick phases 4–6 and 8 of the resolver: trap triggers, garrison aggro/leash
pursuit, the cooldown-paced damage exchange with its affinity layer, and death
resolution. Abilities are chunk 12. Still pure, still isolated, still fixed-point,
still no I/O.

## Design constraints that apply here

- **Traps crossed this tick fire once** (deterministic tie-break by unit order if
  multiple units cross simultaneously), applying damage/effect **or being nullified
  by matching siege**, then are **spent**. Single-trigger — a spent trap does nothing
  for the rest of the fight. With continuous movement, "crossed this tick" means the
  unit's **swept path** between its previous and current position intersects the
  trap's trigger radius — not that its position happens to land inside it. A fast
  unit must not tunnel through a trap between ticks.
- **Any garrison unit with an attacker inside its aggro radius begins pursuing**,
  capped by its **leash distance from post**; it **disengages and returns once the
  attacker leaves range or the leash limit is hit.** Garrison units are mobile within
  their leash — and, like everything else, they move continuously, not cell by cell.
- **Engaged units (attacker vs. garrison) trade damage** via the formula:

  ```
  damage = offense × offense / (offense + defense)
  ```

  modified by a **type/affinity layer (2–4 damage categories tied to regional unit
  flavor and trap classes, to prevent pure stat-total optimization from being the
  whole story)** — until one side dies or the defender hits its leash limit.

- **Damage is paced by per-unit attack cooldowns, not dealt every tick.** A unit with
  a target inside its attack range fires when its cooldown expires; the formula above
  gives the damage of one such hit. This is what makes the fight read as a Clash of
  Clans attack rather than a per-tick attrition tick. Damage per second is therefore
  `formula_result / attack_cooldown` — keep that in view when tuning, since a unit's
  effective threat is the pair, not the formula alone.
- **"Engaged" means in range, not locked together.** With continuous movement and no
  unit-unit collision, a unit attacks whatever is within `attack_range` of it; it does
  not enter an exclusive duel. Ranged units attack while a melee unit closes.
- **Attacker units use their offense rating; garrison units use their defense
  rating.** These are deliberately unequal per unit type. When a garrison unit deals
  damage, the formula's `offense` term is the garrison unit's *defense* rating — it is
  defending. Be explicit about which number fills which slot in every direction, and
  write it down; getting this backwards is very easy and nearly invisible in tests.
- **Siege equipment is a counter to fences and traps**: specific pieces reduce or
  bypass specific fence/trap categories. Siege is not a general damage buff and does
  not fight garrison units.
- Everything remains **deterministic**: no randomness in damage, no variance rolls,
  no critical hits, no miss chance.
- **No floats.** Damage, cooldowns, and ranges are fixed-point integers. Range checks
  compare squared distances.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `DAMAGE_FORMULA` | `offense × offense / (offense + defense)` | Fixed by design. Computed in fixed-point with a documented rounding mode. |
| `ATTACK_COOLDOWN_DEFAULT` | 1.0s (range 0.4–2.5s by type) | From chunk 03. Converted to ticks once, at setup. |
| `ATTACK_RANGE_DEFAULT` | 1.0 cells melee, 4.0 ranged | From chunk 03. Compared as squared distance. |
| `ATTACK_TARGET_SELECTION` | nearest valid target within range; tie → ascending unit id | Independent of the stance, which drives *movement*; this drives *what gets hit right now*. |
| `ATTACK_WINDUP` | none in MVP | If added later it must be integer ticks. |
| `AFFINITY_ADVANTAGE_MULT` | 1.25 | From chunk 03. |
| `AFFINITY_DISADVANTAGE_MULT` | 0.80 | Neutral = 1.00. |
| `AFFINITY_APPLICATION` | multiply the damage result, then floor | Fix the rounding point; rounding order changes outcomes. |
| `SIMULTANEOUS_DAMAGE` | yes — all attacks due this tick are computed against start-of-tick HP, then deaths resolve | Means mutual kills are possible. Document it. |
| `TRAP_TIE_BREAK` | ascending unit id | The design's stated rule. |
| `TRAP_TRIGGER_TEST` | swept-segment intersection against the trigger radius | Prevents tunnelling at high move speeds. |
| `TRAP_TRIGGER_RADIUS` | 0.75 cells | |
| `TRAP_DAMAGE_RANGE` | 60–250 flat by type | From chunk 03. |
| `TRAP_EFFECTS` | damage; slow (−40% move speed for 3s); root (0 movement for 1.5s) | Durations in seconds, converted to ticks at setup. |
| `SIEGE_TRAP_NULLIFY` | full nullify vs. countered trap category; trap is **still spent** | Nullifying consumes the trap — it isn't preserved for the next attacker in the same fight. |
| `SIEGE_FENCE_DAMAGE_MULT` | ×4 vs. its countered fence category | |
| `AGGRO_RADIUS_DEFAULT` | 4.0 cells | Per-type override. Continuous. |
| `LEASH_DISTANCE_DEFAULT` | 6.0 cells from post | Per-type override. Continuous. |
| `LEASH_BOUNDARY_RULE` | leash is inclusive — a unit at **exactly** `LEASH_DISTANCE` from post is still engaged; beyond it, it disengages | Pick one and test the exact boundary. With fixed-point positions this boundary is now reachable exactly, so it *will* occur. |
| `LEASH_HYSTERESIS` | must return to within 80% of leash before re-acquiring | Prevents chattering at the boundary, which continuous movement makes likely. |
| `DISENGAGE_BEHAVIOR` | path back to post, ignoring aggro until the post is reached | Deterministic and non-oscillating. |
| `AGGRO_TIE_BREAK` | nearest attacker; tie → ascending attacker unit id | |

## Definition of done

- [ ] Trap triggers: swept-path detection, fire once, apply damage/effect, become
      spent, tie-break by unit id.
- [ ] Siege nullification of matching trap categories; siege multiplier on matching
      fence categories.
- [ ] Garrison aggro acquisition, continuous pursuit within leash, disengage-and-return
      with hysteresis.
- [ ] Attack cooldowns per unit; damage fires on expiry against targets in range.
- [ ] Damage formula in fixed-point, with the offense/defense slot assignment
      documented per direction.
- [ ] Affinity layer applied with a fixed rounding point.
- [ ] Death resolution with the simultaneity rule documented; mutual kills handled.
- [ ] Still pure: no I/O, no clock, no RNG, no floats. The isolation and no-float
      checks from chunk 10 still pass.
- [ ] Determinism harness extended to cover fights with traps, garrison, and affinity —
      100× byte-identical.
- [ ] **Boundary tests written deliberately**: unit at exactly `LEASH_DISTANCE`; unit
      at exactly `AGGRO_RADIUS`; target at exactly `ATTACK_RANGE`; a fast unit crossing
      a trap entirely between two ticks; two units crossing the same trap on the same
      tick; two garrison units acquiring the same attacker on the same tick;
      simultaneous mutual kill; damage reducing HP to exactly zero; a unit oscillating
      at the leash boundary.
- [ ] A test asserts affinity actually changes outcomes — that a stat-inferior party
      with a favorable matchup can beat a stat-superior one.

## QA guardrail checks for this chunk

- **Determinism:** 100× byte-identical logs, across processes. Any variance roll, any
  crit, any miss chance, any float? Re-run the float/banned-function grep from chunk 10.
- **Trap tunnelling:** set a unit's move speed high enough to cross a trap entirely
  within one tick and confirm it still triggers. A position-only containment test
  would miss it, and this is the failure mode continuous movement introduces.
- **Tick-resolution edge cases — run every one of these explicitly:**
  - simultaneous trap triggers (multiple units crossing on the same tick)
  - garrison units at the **exact** leash-limit boundary, and oscillating across it
  - ties in every deterministic tie-break rule
  - a target just outside leash but inside aggro
  - mutual simultaneous death
- **No pay-to-win:** resolution logic must be identical for paying and non-paying
  accounts. Confirm the resolver still cannot reach entitlement state.
- **Design fidelity:** is siege functioning as a **counter to fences and traps**, or
  has it drifted into a general damage buff? The latter would quietly change what the
  player is doing versus what's designed.
- **Affinity does real work:** can a player ignore the type layer and win on raw stat
  totals? If yes, flag it — the layer exists specifically to prevent that.
- **Offense/defense slots:** verify by hand-calculation that the garrison unit's
  *defense* rating drives its damage output, not its offense rating.
- **DPS sanity:** check a few units' `formula_result / attack_cooldown`. A unit with a
  huge hit and a long cooldown and one with a small hit and a short cooldown should be
  comparably threatening, or the cooldown stat isn't being tuned as a real lever.

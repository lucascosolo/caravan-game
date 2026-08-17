# Chunk 11 — Resolver combat: damage, traps, garrison

**Depends on:** 10. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Fill in tick phases 3–6 of the resolver: trap triggers, garrison aggro/leash
pursuit, the damage exchange with its affinity layer, and death resolution. Still
pure, still isolated, still no I/O.

## Design constraints that apply here

Quoted directly from the resolution algorithm:

- **Traps crossed this tick fire once** (deterministic tie-break by unit order if
  multiple units cross simultaneously), applying damage/effect **or being nullified
  by matching siege**, then are **spent**. Single-trigger — a spent trap does nothing
  for the rest of the fight.
- **Any garrison unit with an attacker inside its aggro radius begins pursuing**,
  capped by its **leash distance from post**; it **disengages and returns once the
  attacker leaves range or the leash limit is hit.** Garrison units are mobile
  within their leash, not static.
- **Engaged units (attacker vs. garrison) trade damage each tick** via the formula:

  ```
  damage = offense × offense / (offense + defense)
  ```

  modified by a **type/affinity layer (2–4 damage categories tied to regional unit
  flavor and trap classes, to prevent pure stat-total optimization from being the
  whole story)** — until one side dies or the defender hits its leash limit.

- **Attacker units use their offense rating; garrison units use their defense
  rating.** These are deliberately unequal per unit type. When a garrison unit deals
  damage, the formula's `offense` term is the garrison unit's *defense* rating —
  it is defending. Be explicit about which number fills which slot in every
  direction, and write it down; getting this backwards silently is very easy.
- **Siege equipment is a counter to fences and traps**: specific siege pieces reduce
  or bypass specific fence/trap categories. Siege is not a general damage buff and
  does not fight garrison units.
- Damage trades are **simultaneous within a tick** — both sides deal their damage
  before deaths are resolved, or the phase order must state clearly why not. Either
  choice is legal; an undocumented one is a determinism hazard.
- Everything remains **deterministic**: no randomness in damage, no variance rolls,
  no critical hits.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `DAMAGE_FORMULA` | `offense × offense / (offense + defense)` | Fixed by design. Compute in integers — use scaled fixed-point (e.g. ×1000) and floor, so results are identical on every platform. |
| `AFFINITY_ADVANTAGE_MULT` | 1.25 | From chunk 03. |
| `AFFINITY_DISADVANTAGE_MULT` | 0.80 | Neutral = 1.00. |
| `AFFINITY_APPLICATION` | multiply the damage result, then floor | Fix the rounding point; rounding order changes outcomes. |
| `SIMULTANEOUS_DAMAGE` | yes — both sides deal damage, then deaths resolve | Means mutual kills are possible. Document it. |
| `TRAP_TIE_BREAK` | ascending unit id | The design's stated rule. |
| `TRAP_DAMAGE_RANGE` | 60–250 flat by type | From chunk 03. |
| `TRAP_EFFECTS` | damage; slow (−1 tile/tick for 3 ticks); root (0 movement for 2 ticks) | Keep effects integral and tick-counted. |
| `SIEGE_TRAP_NULLIFY` | full nullify vs. countered trap category; trap is **still spent** | Nullifying consumes the trap — a defender's trap isn't preserved for the next attacker in the same fight. |
| `SIEGE_FENCE_DAMAGE_MULT` | ×4 vs. its countered fence category | |
| `AGGRO_RADIUS_DEFAULT` | 4 tiles | Per-type override. |
| `LEASH_DISTANCE_DEFAULT` | 6 tiles from post | Per-type override. |
| `LEASH_BOUNDARY_RULE` | leash is inclusive — a unit at **exactly** `LEASH_DISTANCE` from post is still engaged; at distance+1 it disengages | Pick one and test the exact boundary. This is a named QA edge case. |
| `DISENGAGE_BEHAVIOR` | path back to post, ignoring aggro until the post is reached | Prevents oscillation at the leash edge. Must be deterministic. |
| `AGGRO_TIE_BREAK` | nearest attacker; tie → ascending attacker unit id | |

## Definition of done

- [ ] Trap triggers: fire once, apply damage/effect, become spent, tie-break by unit id.
- [ ] Siege nullification of matching trap categories; siege multiplier on matching
      fence categories.
- [ ] Garrison aggro acquisition, pursuit within leash, disengage-and-return.
- [ ] Damage formula implemented in integer/fixed-point arithmetic, with the
      offense/defense slot assignment documented per direction.
- [ ] Affinity layer applied with a fixed rounding point.
- [ ] Death resolution with the simultaneity rule documented; mutual kills handled.
- [ ] Still pure: no I/O, no clock, no RNG. The isolation check from chunk 10 still passes.
- [ ] Determinism harness extended to cover fights with traps, garrison, and affinity —
      100× byte-identical.
- [ ] **Boundary tests written deliberately**: unit at exactly `LEASH_DISTANCE`; unit
      at exactly `AGGRO_RADIUS`; two units crossing the same trap on the same tick;
      two garrison units acquiring the same attacker on the same tick; simultaneous
      mutual kill; damage that reduces HP to exactly zero.
- [ ] A test asserts affinity actually changes outcomes — that a stat-inferior party
      with a favorable matchup can beat a stat-superior one. If it can't, the
      affinity layer isn't preventing pure stat-total optimization.

## QA guardrail checks for this chunk

- **Determinism:** 100× byte-identical logs, across processes. Any variance roll,
  any crit, any float that could round differently? Verify the fixed-point arithmetic
  produces identical results on two platforms if at all possible.
- **Tick-resolution edge cases — run every one of these explicitly:**
  - simultaneous trap triggers (multiple units crossing on the same tick)
  - garrison units at the **exact** leash-limit boundary
  - ties in every deterministic tie-break rule
  - a garrison unit whose aggro and leash boundaries interact (target just outside
    leash but inside aggro)
  - mutual simultaneous death
- **No pay-to-win:** resolution logic must be identical for paying and non-paying
  accounts. Confirm the resolver still cannot reach entitlement state.
- **Design fidelity:** is siege functioning as a **counter to fences and traps**, or
  has it drifted into a general damage buff? The latter would quietly change what
  the player is doing versus what's designed.
- **Affinity does real work:** can a player ignore the type layer and win on raw stat
  totals? If yes, flag it — the layer exists specifically to prevent that.
- **Offense/defense slots:** verify by hand-calculation that the garrison unit's
  *defense* rating drives its damage output, not its offense rating. A silent swap
  here would be invisible in tests but wrong in play.

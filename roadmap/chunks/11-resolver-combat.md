# Chunk 11 — Resolver combat: damage, traps, posted units

**Depends on:** 10. **Status:** built (RESOLVER_VERSION 3; see "Build notes" at the end).
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Fill in tick phases 4–6 and 8 of the resolver: trap triggers, posted-unit aggro/leash
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
- **Any posted unit with an attacker inside its aggro radius begins pursuing**,
  capped by its **leash distance from post**; it **disengages and returns once the
  attacker leaves range or the leash limit is hit.** Posted units are mobile within
  their leash — and, like everything else, they move continuously, not cell by cell.
- **Engaged units (attacker vs. posted unit) trade damage** via the formula:

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
- **Attacker units use their offense rating; posted units use their defense
  rating.** These are deliberately unequal per unit type. When a posted unit deals
  damage, the formula's `offense` term is the posted unit's *defense* rating — it is
  defending. Be explicit about which number fills which slot in every direction, and
  write it down; getting this backwards is very easy and nearly invisible in tests.
- **Siege equipment is a counter to fences and traps**: specific pieces reduce or
  bypass specific fence/trap categories. Siege is not a general damage buff and does
  not fight posted units.
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
- [ ] Posted-unit aggro acquisition, continuous pursuit within leash, disengage-and-return
      with hysteresis.
- [ ] Attack cooldowns per unit; damage fires on expiry against targets in range.
- [ ] Damage formula in fixed-point, with the offense/defense slot assignment
      documented per direction.
- [ ] Affinity layer applied with a fixed rounding point.
- [ ] Death resolution with the simultaneity rule documented; mutual kills handled.
- [ ] Still pure: no I/O, no clock, no RNG, no floats. The isolation and no-float
      checks from chunk 10 still pass.
- [ ] Determinism harness extended to cover fights with traps, posted units, and affinity —
      100× byte-identical.
- [ ] **Boundary tests written deliberately**: unit at exactly `LEASH_DISTANCE`; unit
      at exactly `AGGRO_RADIUS`; target at exactly `ATTACK_RANGE`; a fast unit crossing
      a trap entirely between two ticks; two units crossing the same trap on the same
      tick; two posted units acquiring the same attacker on the same tick;
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
  - posted units at the **exact** leash-limit boundary, and oscillating across it
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
- **Offense/defense slots:** verify by hand-calculation that the posted unit's
  *defense* rating drives its damage output, not its offense rating.
- **DPS sanity:** check a few units' `formula_result / attack_cooldown`. A unit with a
  huge hit and a long cooldown and one with a small hit and a short cooldown should be
  comparably threatening, or the cooldown stat isn't being tuned as a real lever.

## Note from chunk 07 QA (D1) — posted units carry a defensive stance

Each `Battlefield` post arrives with `stance: "guard" | "hold" | "reserve"` (chunk 07,
`DEFENSIVE_STANCES`). This chunk implements the behaviour; the semantics were fixed in
chunk 07 so the model and the resolver agree:

- `guard` — the aggro/leash pursuit described above, unchanged. The default.
- `hold` — fights only attackers within its attack range measured from its **post**; it
  never leaves the post (leash 0). No pursuit, no disengage-and-return — it simply does
  not move.
- `reserve` — ignores every attacker until one is **inside the ring**: any lattice cell
  with Chebyshev distance < `PERIMETER_RING_RADIUS` from the core centre (i.e. strictly
  inside the square the fence and the four wagon anchors sit on). From that tick on it
  behaves exactly as `guard`. It does not revert to ignoring once triggered.

Stance never changes mid-fight. Target selection (`ATTACK_TARGET_SELECTION`) is the same
for all three; the stance drives **movement and acquisition**, not what gets hit. Add the
tie-break and boundary tests for `hold` (target at exactly attack range) and `reserve`
(attacker on a ring cell vs. one cell inside) to the explicit edge-case list above.

Also from chunk 07 QA (D2): pathing is 4-connected (`TUNABLES.PATH_CONNECTIVITY` = 4, no
corner cutting) and the four ring corners are permanent blocked cells (`Battlefield.anchors`)
with no HP — they are never attacked, never breached, and never a target for
`structure_breaker` or siege.

## Build notes (Maker, 2026-10-11) — RESOLVER_VERSION 2 → 3

Built in the phase hooks chunk 10 left; nothing in the phase order moved. New files:
`packages/resolver/src/combat.ts` (formula, slots, affinity, merge, target selection),
`move.ts` (the leg stepping shared by attackers and posted units, effects, the sweep),
`traps.ts` (phase 4), `posted.ts` (phase 5). `hooks.ts` re-exports phases 4/5, implements
`siegeFenceMult`, keeps `abilityPhase` (chunk 12) and `endOfTick` (chunk 13) as seams.
Every rule below is named in a header comment where it lives.

**Rules and tie-breaks, written down:**

- **DAMAGE_SLOTS** — each unit brings ONE rating (`UnitState.rating`): an attacker its
  `offense`, a posted unit its `defense`. `hit = floor(o²/(o+d))` with o = the DEALER's
  rating and d = the RECEIVER's. So attacker→post is `offense²/(offense+defense)`,
  post→attacker is `defense²/(defense+offense)`, anything→fence is `offense` (d = 0).
  The other rating is 0 in state and never read.
- **DAMAGE_ROUNDING_ORDER** — formula (floor) → × affinity (floor) → × dealer's merge
  multiplier (floor) → × siege, fence hits only (floor) → **minimum 1**. Traps: flat
  `trap.damage` → × affinity (trap.affinity vs the unit's) → minimum 1; no merge, no siege.
- **AFFINITY** — the matrix and the three multipliers are INPUT (`ResolverTunables.
  affinityMatrix / affinityAdvantageMult / affinityDisadvantageMult / affinityNeutralMult`),
  built by circle's `resolverTunables()` from content's `AFFINITY_MATRIX`. Nine pairs tested.
- **MERGE (chunk 03 QA B1)** — `mergeStatMultByLevel[mergeLevel]` is input; applied to each
  hit's OUTPUT and, upstream, to max HP (already in the input's `maxHp`). Ratings are
  unmerged at every level; `toBattlefield` no longer scales `defense` (it did — fixed in
  this chunk; the circle test now pins the unscaled rating). Abilities untouched. Fence hits
  are hits, so they scale too (and the breach price follows).
- **REACH** — every unit-vs-unit and unit-vs-trap proximity test is squared centre distance
  ≤ (radius + unitRadius)²: attack range, aggro radius, trap trigger radius. The leash and
  the hysteresis radius are the unit's own centre vs its post (no radius). Chunk 10's
  "engaged" hold moved from attackRange to reach (one movement test updated).
- **ATTACK_COOLDOWN** — decrement first, then a ready unit (0) fires at a target in reach
  and resets to `cooldownTicks`; first hit on contact, then every cooldownTicks; a ready
  unit with nothing in reach stays ready; one hit per unit per tick.
- **ATTACK_TARGET_SELECTION** — nearest living enemy UNIT within reach, lowest id on an
  exact tie, for every stance on both sides and independent of the movement target (a
  `core` attacker fires at a guard it walks past; a pursuing guard hits whichever attacker
  is nearest). **ATTACK_PRIORITY**: an enemy in reach beats the fence a unit is breaching
  (a ranged breacher shoots the guard behind the fence first; the breach price does not
  model this — it is an estimate, as chunk 10 already says).
- **SIMULTANEOUS_DAMAGE** — hits land in id order during phase 6, but `alive` is read for
  targeting and a unit whose HP reached 0 earlier in the phase still fires; HP floors at 0;
  phase 8 kills every 0-HP unit in id order. Mutual kills happen and are tested. A unit a
  trap kills in phase 4 still acts in phases 5–7 of that tick.
- **UNIT_DEATH (phase 8)** — `unit_died`, `alive = false`, `diedTick` (in the summary),
  target/route/breach cleared; an attacker holding on it retargets in phase 1 of the next
  tick (chunk 10's rule), a guard pursuing it disengages `dead` in phase 5 of the next tick.
- **TRAP_TRIGGER_TEST** — each attacker's SWEEP polyline for the tick (start, every waypoint
  it landed on, end — corners included) is tested segment by segment against (trigger
  radius + unitRadius)² via the floored closest point (`segmentDistSq`: the projection is
  floored toward the segment start, < 1 unit off exact, documented as part of the rule).
  A unit that did not move is tested as a point. No tunnelling: tested at 64 cells/s.
- **TRAP_TIE_BREAK** — attackers in ascending id, then unspent traps in ascending index.
  Two units on one trap: the lower id springs it, the other is untouched. One unit on two
  traps: both fire, index order. **TRAP_FIRE**: spent the moment it is sprung; siege
  countering its category → `trap_nullified`, no damage, no effect, still spent.
- **TRAP_EFFECTS / EFFECT_STACKING** — durations `msToTicks`; an effect applied in phase 4 of
  tick t governs movement on ticks t+1..t+N (effects count down AFTER the movement they
  governed). Slow: budget = speedPerTick − floor(speedPerTick × magnitude); root: 0. A second
  effect of the same kind REFRESHES (max of remaining, max of magnitude), never adds.
  Every change of effective speed logs a `speed` event (in force from the next tick) — the
  replay contract in `log.ts` gained that clause; legs are never restarted by an effect.
- **POSTED STANCES** — `hold`: never moves, never acquires, hits in reach from its post.
  `reserve`: ignores every attacker — neither acquires NOR attacks, even in reach
  (`canAttack`) — until the lowest-id living attacker's CELL has Chebyshev distance
  < PERIMETER_RING_RADIUS from the core centre cell (a ring/gap cell does not count, one
  cell inside does), logged `released`, then guard forever. `guard`: the state machine below.
- **GUARD STATE MACHINE** (`postMode` idle / pursuing / returning), per tick, top to bottom:
  pursuing → returning on `dead` (target not alive), else `leash` (centre distance from the
  POST > leashSq — **inclusive leash**: exactly at the leash is still engaged), else `lost`
  (target beyond aggro reach measured from the UNIT). idle → pursuing by AGGRO_TIE_BREAK
  (nearest attacker within aggro reach, lowest id). returning → pursuing only once within
  LEASH_HYSTERESIS × leash of the post (inclusive), same rule; deaf to aggro until then.
  Every disengage, including `dead`, goes through returning. returning → idle on standing
  exactly on the post (`returned`). Acquisition is decided by aggro alone (a target beyond
  the leash but inside aggro is acquired and chased to the leash). Oscillation at the leash
  is therefore bounded to (1 − hysteresis) × leash of walking per half-cycle and is in the
  determinism corpus (`combat-leash-oscillation`).
- **POSTED MOVEMENT** — the same leg rule and `path`/`hold`/`speed` events as attackers
  (posts start `holding: true` so an idle post logs nothing). Routes: `findPath` with NO
  breach edges (a post never breaks the caravan's own fence) + string pulling, ending on the
  exact goal position (replacing the last cell-centre waypoint when that leg is LOS-clear,
  else appended); recomputed every `pathRecomputeInterval` ticks, on a mode/target change,
  and on the tick after a fence breaks (`pathDirty`; attackers keep chunk 10's
  `fenceBrokeSinceRecompute`). A pursuing post with no route stands, keeps pursuing, fires
  if the target comes into reach — no per-tick acquire/drop chatter (tested). A pursuing
  post whose target is in reach holds. Posts never spring traps (only attackers are tested).
- **SIEGE** — `fence.siegeCountered` / `trap.siegeCountered` are decided once at setup from
  the party's `siege[].counters`; `siegeFenceMult` returns `siegeFenceDamageMult` (×4) for a
  countered category, ×1 otherwise; unit hits never see siege. `SIEGE_TRAP_NULLIFY` is not
  carried as input (content marks it fixed by design); the rule is in `traps.ts`.
- **Input** — `ResolverTunables` gained `affinityAdvantageMult`, `affinityDisadvantageMult`,
  `affinityNeutralMult`, `affinityMatrix`, `mergeStatMultByLevel`, `trapTriggerRadius`,
  `siegeFenceDamageMult`, `leashHysteresisMult` (closed keys; `INPUT_BOUNDS.maxMult` ×64,
  `maxMergeLevels` 16; every unit's mergeLevel must index the table; the matrix must be
  complete with valid outcomes). Content gained `LEASH_HYSTERESIS_MULT` (×0.80).
  `normalizeInput` copies the matrix in a fixed key order.
- **Log** — new events `speed`, `trap_fired`, `trap_nullified`, `aggro`, `disengage` (why:
  leash | lost | dead), `returned`, `released`, `hit` (u, v, damage, hp after), `unit_died`;
  keyframes carry `cd`, `slow`, `root` per unit. `path.speed` is now the speed in force.
  Summaries: `UnitSummary.diedTick`, `TrapSummary.spentTick`.

**Measurements** (`test/budget.test.ts`, 16 attackers vs 8 posts vs 28 fences, 6 traps, 2
siege, 3600 ticks): resolve best-of-7 ≈ 70–80 ms (median 78–95 ms under the parallel
vitest load; the check asserts the best, the contention-free figure). Log 118 251 B
(115.5 KB, 543 events) — **keyframes are 89 KB of it** (36 × 24 units + 28 fences + 6
traps); all combat events together add ≈ 25 KB. The 100 KB target is chunk 13's call; the
lever is the keyframe (chunk 10 QA N4, already forwarded there), not the event stream.

**Tests**: resolver 119 passing in 9 files (`combat`, `traps`, `posted`, `budget` new;
`movement` updated for reach and for traps that now fire); every boundary case in the
brief is a named test. Determinism corpus: 10 scenarios (4 new: three stances + traps +
siege, leash oscillation, affinity mirror, full load), 100× in-process and 3 processes
agree. Circle 87, content 58 passing; `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary`
(15 src files) clean.

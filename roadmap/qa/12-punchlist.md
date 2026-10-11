# Chunk 12 — QA punch list (commit 2791822, merged at 1b27f4e; RESOLVER_VERSION 5)

Probes: scratchpad/qa12 (`./run.sh <probe>.ts`; corpus12.ts = 91 scenarios).

## Blocker
B1. **[closed]** A dash carries an attacker over a lethal trap and onto the core before the trap fires (abilities.ts:304-315, tick.ts:329). Fix: test an attacker's dash leg against traps inside phase 7 immediately after the dash, with phase 4's rules (swept polyline, TRAP_SKIPS_ZERO_HP, siege nullify, id/index order); record `core_reached` only after that and only if hp > 0. The tick-cap tick is covered too. Pin with p6b_dashcore.ts as a fixture.

## Decisions (orchestrator)
D1 + S1 + S2. **[closed]** **One fence-hit rule:** a fence segment takes at most `FENCE_HIT_SEGMENT_CAP` = 50% of its max HP **per unit per tick**, summed across normal hits, ability hits and buffed hits (the structure-breaker cap generalises to all fence damage). Every full segment of every tier therefore needs at least two blows from one unit. SIEGE_FENCE_DAMAGE_MULT stays ×4 (the brief's "accelerates" counter); the breach price follows the capped hits. Self buff keeps applying to fence hits under that cap. Rewrite every "never one-shot" claim (Build notes, abilities.ts header, six breaker descriptions) to state the per-tick rule exactly. Tests: every type × level × siege × tier with normal, buffed and same-tick normal+breaker hits never exceed 50% per tick.
D2. **[closed]** **Structure breaker usable:** archetype-specific first-use delay `STRUCTURE_BREAKER_FIRST_USE_MULT` = 0.25 of its cooldown (tunable); the per-tick cap keeps it safe. Re-measure breaker firings over the corpus and report.

## Should-fix
S3. **[closed]** Merge ceiling with abilities: apply the buff to the pre-floor product (one floor), and extend packages/content invariants to assert HP × effective DPS **including each type's ability contribution** (buff duty cycle; strike and burst share at first-use and cooldown) stays below 5/3 per level and both recipes. Report the new worst step.
S4. **[closed]** Log the leash-clamped pursuit step (e.g. `amount` on the leash `disengage`, or a `path`/`speed` event) so interpolation needs no input data; extend the log.ts contract; add the replica interpolator as a resolver test over the whole determinism corpus (0 divergences, 0 keyframe mismatches).
S5. **[closed]** Legibility (content + circle scout view; web display is relayed to the chunk 08 fixer): healer descriptions state "never above the HP it started this fight with"; every ability carries a first-use line ("first use after Xs"); ability reach shown as radius + unit radius; fixed-point percentages render exactly (10%, +35%) — expose display-ready numbers in the scout view (`healPercent`, `buffPercent`, `reachCells`, `firstUseSeconds`).

## Nits
N1. **[closed]** "Dying = 0 HP at the start of phase 7" for dash; a caster brought to 0 earlier in phase 7 does not dash (skip at apply time).
N2. **[closed]** Skip a self buff from a 0-HP caster and a heal whose every target died in step (a) (no charge spent); fix the "no cast is ever wasted" comment to match.
N3. **[closed]** Attrition gate: add a with-healer vs no-healer delta assertion, not only the 90% threshold.
N4. **[closed]** AGENTS.md resolver test count/time.

## Balance notes → chunk 37 **[recorded in PHASE-2.md §37, with the v6 changes]**
Win matrix with abilities: attacker 63.5% (was 63.7%); abilities flip 29/1024; range dominates (ranged 75.3% vs melee 58.1%); healers weakest (7.5–16% healing offset vs 25–35% target); core-stance runners reach the core ≈5 s in, before abilities fire — hold rate decided by approach coverage, not abilities.

## Closure (Maker, 2026-10-11) — RESOLVER_VERSION 5 → 6 `[resolver-bump]`

Probes rerun from scratchpad/qa12wt (imports repointed to the worktree; before = RESOLVER_VERSION 5).

- **B1** — `abilities.ts` dash case: after `dashStep` an attacker's dash polyline goes through
  `traps.ts springTraps` (the phase-4 loop, factored out: swept segments, ascending trap index,
  TRAP_SKIPS_ZERO_HP, siege nullify, spent on firing) inside phase 7; `core_reached` is logged
  only after that and only if HP > 0. `pendingSweep` is gone (state.ts, tick.ts). Fixtures
  `qa12-dash-over-trap-onto-core` and `qa12-dash-over-trap-tick-cap` (dash on tick 199 of a
  200-tick cap) are in the determinism corpus and pinned in `test/qa12.test.ts`, with the p6b
  sweep (×0 … ×1.5625 first use) as a test. p6b: 108 cases → **0**.
- **D1 + S1 + S2** — `FENCE_HIT_SEGMENT_CAP` (content, ×0.50; resolver input
  `fenceHitSegmentCap`, replacing `structureBreakerSegmentCap`, which is now refused as an unknown
  key). combat.ts DAMAGE_ROUNDING_ORDER step 6: `fenceHitCap` = max(1, floor(maxHp × cap)),
  `fenceHitRoom`, `landFenceHit`; per-unit `fenceHitTick` / `fenceHitIndex` / `fenceHitDealt`.
  Phase 6's `fenceHitDamage` is clipped to the room (also prices breaches); the breaker's condition
  needs room ≥ 1 and its damage is clipped to it. Siege stays ×4. Every "never one-shot" claim
  rewritten (abilities.ts header, Build notes, tunables.ts, six breaker descriptions: "with its
  normal hit it takes at most half a segment's max HP per tick"). Tests: circle
  `abilities-qa.test.ts` every type × level × siege × tier × {normal, buffed, normal + breaker}
  (1720 checks, worst exactly 50.0 %); resolver `qa12.test.ts` literal sweep (360 fights: ≤ 50 %
  per unit per tick, every broken segment took ≥ 2 ticks) and the whole determinism corpus.
  p5b (resolver-backed rerun `p5b_v6.ts`): **0** combos over 50 % per tick, 0 one-shots (the
  analytic p5b still prints its uncapped v5 arithmetic: 57 same-tick combos, 6 stone one-shots).
  p5c: Longhorn L2 + stone siege 524 + 500 same tick → 500 on t, 500 on t+1; Grizzly L3 716 → 500.
- **D2** — `STRUCTURE_BREAKER_FIRST_USE_MULT` ×0.25 (content; input
  `structureBreakerFirstUseMult`, 0..×64), applied per archetype in `state.ts abilityFields`.
  Breaker firings over corpus12 (91 → 93 scenarios with the two new fixtures; 43 with breakers, 61
  breaker units): **3 → 12**. p5_breaker: 4 of 16 → 16 of 16 runs fire. Every content breaker
  fires on a sealed brush and stone ring at level 1 (circle test).
- **S3** — `fixed.ts scaleInt2` (one floor, exact at the input bounds via the nested-floor
  identity; checked against BigInt) used by `dealtOutput` while buffed. Content
  `invariants.test.ts` asserts HP × effective DPS **with** each type's ability (buff duty cycle;
  strike/burst at first-use and cooldown intervals) < 5/3 per level and under both recipes, every
  type × role × opponent × affinity. Worst step **1.6856 → 1.6402** (a posted gunslinger vs an
  offense-120 raider at disadvantage, L3→L4); p4d OVER lines 6 → 0 under the one-floor model (p4e).
- **S4** — `disengage {why: "leash", amount}` when LEASH_CLAMP bound (posted.ts
  LEASH_CLAMP_LOGGED); log.ts contract extended. `test/replica.test.ts` replays every tick of the
  determinism corpus from the log alone: 0 divergences, 0 keyframe mismatches, every dash end
  exact. p9_replica without `clamp` (reading `amount`): 88 054 position divergences and 449
  keyframe mismatches over 91 scenarios (v5) → **0 divergences,
  0 keyframe mismatches** over 93 scenarios (24 clamped steps read from the log).
- **S5** — content `abilityDisplay(ability, attackRange)` / `abilityFirstUseMs` /
  `decimalString`; circle `ScoutUnit.abilityDisplay` (always set by `scoutUnit`; typed optional so
  the web's shape guard compiles until the chunk 08 fixer adds it). Fields: `archetype`,
  `cooldownSeconds`, `firstUseSeconds`, `reachCells` (radius + UNIT_RADIUS, or attack range +
  UNIT_RADIUS), `damageMultiplier`, `healPercent`, `healCeiling` ("start_of_fight_hp"),
  `charges`, `buffPercent`, `buffSeconds`, `dashCells`, `fenceHitCapPercent`. Percentages are
  whole percents ("10", "35"). Every description ends "First use after X s."; healers say "never
  above the HP it started this fight with". Content and circle tests pin both.
- **N1** — dash skipped at apply time if the caster is at 0 HP (ABILITY_SKIP_VOID); p8's
  "dash then died same tick (defender)" 2 → 0 (the 1 attacker case left is a dash whose own trap
  killed it — B1 working).
- **N2** — cooldown and charge are spent at apply time; a self buff from a 0-HP caster and a heal
  whose every target is at 0 HP are skipped; header comment rewritten. Tests in `qa12.test.ts` and
  `abilities.test.ts` (with controls).
- **N3** — `abilities-qa.test.ts`: the same healer circle with healing switched off
  (healFraction 0). With 82.6–89.9 %, without 60.3–70.4 %: asserted delta > 5 points and the healer
  caravan still loses ≥ 30 % of the unhealed loss (measured 34–45 %), plus the 90 % gate.
- **N4** — AGENTS.md: 190 tests in 13 files, ~40 s on 4 cores.

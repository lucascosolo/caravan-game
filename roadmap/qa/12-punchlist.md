# Chunk 12 — QA punch list (commit 2791822, merged at 1b27f4e; RESOLVER_VERSION 5)

Probes: scratchpad/qa12 (`./run.sh <probe>.ts`; corpus12.ts = 91 scenarios).

## Blocker
B1. A dash carries an attacker over a lethal trap and onto the core before the trap fires (abilities.ts:304-315, tick.ts:329). Fix: test an attacker's dash leg against traps inside phase 7 immediately after the dash, with phase 4's rules (swept polyline, TRAP_SKIPS_ZERO_HP, siege nullify, id/index order); record `core_reached` only after that and only if hp > 0. The tick-cap tick is covered too. Pin with p6b_dashcore.ts as a fixture.

## Decisions (orchestrator)
D1 + S1 + S2. **One fence-hit rule:** a fence segment takes at most `FENCE_HIT_SEGMENT_CAP` = 50% of its max HP **per unit per tick**, summed across normal hits, ability hits and buffed hits (the structure-breaker cap generalises to all fence damage). Every full segment of every tier therefore needs at least two blows from one unit. SIEGE_FENCE_DAMAGE_MULT stays ×4 (the brief's "accelerates" counter); the breach price follows the capped hits. Self buff keeps applying to fence hits under that cap. Rewrite every "never one-shot" claim (Build notes, abilities.ts header, six breaker descriptions) to state the per-tick rule exactly. Tests: every type × level × siege × tier with normal, buffed and same-tick normal+breaker hits never exceed 50% per tick.
D2. **Structure breaker usable:** archetype-specific first-use delay `STRUCTURE_BREAKER_FIRST_USE_MULT` = 0.25 of its cooldown (tunable); the per-tick cap keeps it safe. Re-measure breaker firings over the corpus and report.

## Should-fix
S3. Merge ceiling with abilities: apply the buff to the pre-floor product (one floor), and extend packages/content invariants to assert HP × effective DPS **including each type's ability contribution** (buff duty cycle; strike and burst share at first-use and cooldown) stays below 5/3 per level and both recipes. Report the new worst step.
S4. Log the leash-clamped pursuit step (e.g. `amount` on the leash `disengage`, or a `path`/`speed` event) so interpolation needs no input data; extend the log.ts contract; add the replica interpolator as a resolver test over the whole determinism corpus (0 divergences, 0 keyframe mismatches).
S5. Legibility (content + circle scout view; web display is relayed to the chunk 08 fixer): healer descriptions state "never above the HP it started this fight with"; every ability carries a first-use line ("first use after Xs"); ability reach shown as radius + unit radius; fixed-point percentages render exactly (10%, +35%) — expose display-ready numbers in the scout view (`healPercent`, `buffPercent`, `reachCells`, `firstUseSeconds`).

## Nits
N1. "Dying = 0 HP at the start of phase 7" for dash; a caster brought to 0 earlier in phase 7 does not dash (skip at apply time).
N2. Skip a self buff from a 0-HP caster and a heal whose every target died in step (a) (no charge spent); fix the "no cast is ever wasted" comment to match.
N3. Attrition gate: add a with-healer vs no-healer delta assertion, not only the 90% threshold.
N4. AGENTS.md resolver test count/time.

## Balance notes → chunk 37
Win matrix with abilities: attacker 63.5% (was 63.7%); abilities flip 29/1024; range dominates (ranged 75.3% vs melee 58.1%); healers weakest (7.5–16% healing offset vs 25–35% target); core-stance runners reach the core ≈5 s in, before abilities fire — hold rate decided by approach coverage, not abilities.

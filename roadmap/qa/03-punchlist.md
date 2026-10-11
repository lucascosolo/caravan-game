# Chunk 03 — QA punch list (commit a75b6b2)

Round 1 closed by the Maker (see ORCHESTRATION.md "chunk 03 QA round 1 closed"). Every item below is marked with its disposition.

## Blocker
B1. [closed] Merge curve ×1.6 on ratings is a net power gain under `damage = o²/(o+d)`: effective HP×DPS per level is 2.56–3.54 against a components bar of 2.0 (2→1) and 1.667 (5→3). Mirror duels: merged beats its own components in 21–26 of 32 matchups at every level.
**Orchestrator decision:** the merge multiplier applies **linearly to HP and to post-formula damage output** (never to the offense/defense ratings that enter the formula), at **×1.25 per level** (1280/1024; L1..L5 = 1.0, 1.25, 1.5625, 1.953, 2.441). Effective strength per level = 1.5625 < 1.667, so both recipes stay below components-combined. Ratings are unmerged in the formula. The registry must state *what* the multiplier applies to as data (`MERGE_MULT_APPLIES_TO: ["hp", "damage_output"]`), and `invariants.test.ts` must assert on effective strength at the roster's worst-case (o,d) pair, not on the raw table. Marked tunable; the ceiling that must never be crossed is k² < 5/3.

## Should-fix
S1. [closed] abilities.ts:9 says ability values merge-scale — a second multiplier. Decision: **no ability field scales with merge level**; the merged unit's larger base hit already carries it (heavy strike = ×3.0 of the merged hit; heal is % of target HP; radii, distances, durations, charges fixed). Remove the sentence and declare it in the registry.
S2. [closed] Exported data is not frozen. Deep-freeze every export (`CONTENT`, type arrays, `TUNABLES`, matrix, `REGIONS`) and test that assignment throws.
S3. [closed] validate.ts whitelists keys only on abilities. Whitelist keys on every shape (unit, trap, trap.effect, siege, siege.counters, fence) and test a smuggled `critChance` on each.
S4. [closed] Desert Canteen Carrier vs High Plains Prairie Doctor are a reskin (normalised stat distance 0.043); Mountain Apothecary / Badlands Snake-Oil Peddler marginal. Give the four healers distinct mechanical identities (range, speed, affinity, aggro/leash) and add a cross-region nearest-neighbour distance threshold test (≥ 0.10).
S5. [closed] traps.ts and the healers re-author registry defaults as literals (`fpMilli(400)`, `seconds(3)`, `ms(1500)`, heal fraction/radius/cooldown). Reference `TUNABLES.*` directly where the value is the default; list in the registry which keys are "reference defaults overridable per type".
S6. [closed] apps/server/src/jobs/tunables.ts carries `TODO(chunk-03)`. Decision: infra knobs stay server-side; replace the TODO with a one-line comment saying so. (Touch only that comment.)
S7. [closed] migration 001 line 232 `CHECK (merge_level BETWEEN 1 AND 5)` duplicates MERGE_LEVEL_MIN/MAX. Add a server test asserting the CHECK bounds equal the tunables.

## Nits
N1. [closed] abilities.ts:8 references `ABILITY_FIRST_USE_DELAY_RULE`; key is `ABILITY_FIRST_USE_DELAY_MULT`.
N2. [closed] fixedPoint.ts `fpMul`/`scaleInt` must `assertInteger` on every argument.
N3. [closed] Description strings hard-code numbers; generate them from values or test that each number in a description appears in the data.
N4. [closed] Add `FENCE_CATEGORY_COUNT`/`TRAP_CATEGORY_COUNT` to the registry; assert `SIEGE_TYPES` equals their sum.
N5. [closed] Disadvantage 819/1024 ≈ 0.7998: add a comment that adv×disadv ≠ 1 exactly and is intentional.
N6. [noted — no change; recorded under BALANCE-NOTES in ORCHESTRATION.md] Balance flag for chunk 37: Grizzly top attacker by 25%; five best attackers all Beast; Blasting Crew and Buffalo Hunter weak in both roles. Record in a BALANCE-NOTES section of ORCHESTRATION.md, no change now.

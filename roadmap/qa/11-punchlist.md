# Chunk 11 — QA punch list (commit 8da9b80, merge 941da83; RESOLVER_VERSION 3)

Probes: scratchpad/qa11 (`./run.sh pN_*.ts`; corpus.ts = 10 fixtures + random legal fights).

## Blocker
B1. A guard chatters every tick when its breach-free route to the target first leads out of aggro (posted.ts:164 drops as `lost`, :167 re-acquires at once inside the hysteresis radius). 782 aggro / 781 disengage events in a 1v1 (223 KB log); 5 of 211 random legal fights; worst 455 KB. Fix: (a) a route that cannot reach the target without leaving aggro reach or the leash counts as **no route** (the existing null-route rule: stand, keep the target, fire if it comes into reach); and (b) aggro hysteresis — after a `lost` disengage, the same target is re-acquired only within `LEASH_HYSTERESIS_MULT × aggro reach`. Add `chatter-guard.input.json` and `rand93.input.json` as determinism-corpus fixtures with an assertion on the number of `aggro` events (≤ 3 per post per target).

## Decisions (orchestrator)
D1. **Reserve posts fire back.** Per chunk 07 QA D1 ("stance drives movement and acquisition, not what gets hit"), phase 6 fires at anything in reach for every stance. `reserve` gates acquisition and movement only; it still does not move until released. Release stays "an attacker's cell strictly inside the ring" (a breacher on the ring cell releases one cell late, by design). Update the chunk 11 Build notes and the D1 note.
D2. **ATTACK_PRIORITY:** an attacker that is breaching a fence switches to a unit only if that unit can reach the attacker (the attacker is within that unit's attack reach) — i.e. it fights back against what is hurting it, and a harmless post can no longer shield a fence. Otherwise it keeps hitting the fence. Non-breaching attackers keep the current nearest-in-reach rule. Pin with `p3c_shield.ts` as a fixture (core arrival within one cooldown of the no-post baseline).

## Should-fix
S1. Input validation holes (input.ts:379-399; battlefield.ts post/trap shapes): posts' aggroRadius/leashDistance/attackRange ≥ 0; post attackCooldown ≥ 1 ms (same as party side); trap damage ≥ 1; slow magnitude in [0, 1024]; effect duration in [1, maxMillis]. One refusal test per field.

## Nits
N1. Leash overshoot up to 0.13 cells and one hit from beyond the leash: clamp the pursuit step at the leash (or check after moving).
N2. Skip units with hp === 0 in phase 4 so a trap is not spent on a corpse; document.
N3. Resolver refuses a trap or post on a core cell and a trap on an entry-band cell.
N4. Stale comments: battlefield.ts:452 ("scaled by merge level"), :443, log.ts:72-73 (`unreachable`, "no route" never emitted — either emit or remove).
N5. Log budget at full load is 118 KB (keyframes 89 KB): chunk 13 owns the format; B1's fix removes the larger growth.
N6. ORCHESTRATION entry lists 5 assumptions; add assumption 6 (merge on fence hits) there.

## Balance notes → chunk 37 BALANCE-NOTES (no change now)
- Win matrix (L1, open field, nearest attacker vs guard post): attacker wins 63.7%. Range dominates: ranged types top attackers and bottom guards. Grizzly top in both roles (QA-03 N6). Four healers weak until chunk 12 abilities exist.
- Affinity changes 7.1% of outcomes; every non-neutral pair changes some; stats decide 93%. Revisit ×1.25/×0.80 against the 40–120 offense spread in the balance pass.

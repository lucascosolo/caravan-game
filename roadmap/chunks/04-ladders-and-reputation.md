# Chunk 04 — Ladders & Reputation

**Depends on:** 01, 02. **Status:** built (2026-10-11; QA pending).
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Implement the two separate progression numbers per pool: the **volatile Reputation**
rating that drives matchmaking, and the **permanent, use-driven ladder** that grants
unlock points at milestones.

## Design constraints that apply here

**These two numbers are separate and the split is load-bearing. Do not merge them.**

- **Reputation** — a single number that drives matchmaking. **Volatile and
  contestable**: fight outcomes shift it, on both the active and passive sides. It is a **rating, not a currency —
  it is never spent.** There is one Reputation per relevant pool, following the same
  account/caravan split as everything else.
- **Ladders** — one per pool (living-unit, trap, siege). Levels rise **only through
  use** — deploying/fighting with objects from that pool. Wins earn more ladder
  progress than losses, but **losses still earn**. **Ladder levels are never lost,
  regardless of raid outcomes.**
- The first time a ladder crosses a new rung, the player receives a **fixed,
  permanent grant of unlock points** for that pool's web. **Those points, once
  granted, can never be taken away.** "First time" matters: crossing a rung again
  after nothing (levels can't drop) is not a case, but re-entrancy bugs are — grant
  exactly once per rung, ever.
- Because ladders rise through **use**, a player who deploys traps earns trap ladder;
  a player who never fields siege earns no siege ladder. Progress must be attributed
  to the pool actually used in that fight, not spread evenly.
- Scope split (from the schema in chunk 01): trap and siege Reputation/ladder are
  **account-level**; living-unit Reputation/ladder is **caravan-level**.
- All changes flow through the event ledger (chunk 02) as
  `reputation_changed`, `ladder_progress_gained`, `unlock_points_granted`.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `LADDER_RUNGS_PER_POOL` | 20 | MVP depth. |
| `LADDER_CURVE` | `points_to_rung(n) = 100 × n^1.5` | Rung 1 = 100, rung 10 ≈ 3,162, rung 20 ≈ 8,944. |
| `LADDER_GAIN_WIN` | 30 per survived encounter, per pool used | Scaled by pool participation. Traps and living units earn on the active side; siege earns when your standing party wins. |
| `LADDER_GAIN_LOSS` | 10 per lost encounter, per pool used | Losses still progress — never zero. |
| `LADDER_GAIN_STALEMATE` | 10 | Treated as a loss for the attacking party, a win for the caravan. |
| `LADDER_GAIN_DEFENSE_HELD` | 25 for trap + living pools when a wagon circle repels a party | The active side's main ladder path. |
| `UNLOCK_POINTS_PER_RUNG` | 1 for rungs 1–10, 2 for rungs 11–20 | Total 30 points per pool at cap. |
| `REPUTATION_START` | 1000 | Neutral starting rating. |
| `REPUTATION_WIN_ATTACKER` | +25 to the party's owner, scaled by the rating gap | Standard Elo-ish shape; keep the scaling function pure and deterministic. |
| `REPUTATION_LOSS_ATTACKER` | −15 | |
| `REPUTATION_CARAVAN_HELD` | +15 | |
| `REPUTATION_CARAVAN_OVERRUN` | −20 | |
| `REPUTATION_FLOOR` | 100 | Can't spiral to zero. |

Reputation adjustment must be a **pure deterministic function** of the two ratings
and the outcome — no randomness, no time decay that reads the clock at compute time.

## Definition of done

- [x] Reputation and ladder are separate fields per pool, never derived from each other.
- [x] Reputation has no spend path. A test asserts no API can debit it as a cost.
- [x] Ladder progress is attributed only to pools actually used in a fight.
- [x] Losses earn ladder progress; a test asserts the loss gain is > 0 and < the win gain.
- [x] Ladder levels cannot decrease — proven by test across every outcome type
      including full wipe.
- [x] Rung crossing grants unlock points exactly once, ever. A test replays the same
      progress event and asserts no double grant.
- [x] Granted unlock points cannot be revoked by any path.
- [x] Scope split honored: trap/siege at account level, living-unit at caravan level.
- [x] Reputation adjustment is a pure function; same inputs → same delta, every time.

## QA guardrail checks for this chunk

- **Permanence:** run a full-wipe trip and assert every ladder level and every
  granted unlock point survives untouched. This is the single most important check
  in this chunk — §13 promises unlock rights and ladder progress are permanent and
  untouched by any loss.
- **Determinism:** any randomness or clock read in Reputation adjustment or ladder
  gain? Replay the same fight outcome twice and byte-compare the resulting events.
- **Split correctness:** grep every read/write. Living-unit progress at account level,
  or trap/siege progress at caravan level, is a bug.
- **No pay-to-win:** can Coin or any purchase influence ladder gain, rung crossing,
  or points granted, by any path? It must not — the ladder is the only source of
  unlock points, and it rises only through use.
- **Double-grant under concurrency:** two stops resolving simultaneously that both
  cross the same rung must grant once, not twice.

## Build notes (Maker, 2026-10-11)

Implemented in `apps/server/src/progression/` (`ladder.ts`, `reputation.ts` pure;
`outcome.ts` the `deriveProgressionEvents` pure derivation plus the `applyEncounterOutcome`
DB wrapper; `view.ts` read models), routes `GET /me/progression`,
`GET /me/progression/events`, `GET /progression/rules`, migration
`003_unlock_grant_once` (unique index: one `unlock_points_granted` per pool/owner/rung),
tunables under "Chunk 04" in `packages/content/src/tunables.ts`. Tests:
`apps/server/test/progression-pure.test.ts`, `apps/server/test/progression.test.ts`.

Readings of the brief that QA should check:
- **Matchmaking ratings.** The caravan's rating is its `living` Reputation (caravan-level);
  the standing party's rating is its owner's `siege` Reputation (the account-level
  offense pool — a party is an account-level object, so its rating must be too). The
  gap used for scaling is between those two. Both always move on every encounter; `trap`
  Reputation moves only when traps were fielded; the owner's own living Reputation never
  moves for a passive result.
- **Ladder attribution.** Active side: `living` and `trap` when fielded. Passive side:
  `siege` when fielded. The party's living units are a template, not a deployment, so
  they earn no living ladder — keeps the active side the living pool's path.
- **Ladder points are cumulative** (`LADDER_POINTS_TO_RUNG` is the floor(100·n^1.5)
  table); no reset on crossing, so every delta is positive and the fold is monotone.
- **Gains.** Caravan: held = stalemate = `LADDER_GAIN_DEFENSE_HELD` (25), overrun =
  `LADDER_GAIN_LOSS` (10). Party: overrun = `LADDER_GAIN_WIN` (30), held = `LADDER_GAIN_LOSS`,
  stalemate = `LADDER_GAIN_STALEMATE` (10). Capped ladders write no event.
- **Gap scaling** is applied to all four Reputation deltas (not only the attacker's win),
  as a clamped linear ramp in fixed-point: ×(1 ± gap/400), clamped to [×0.25, ×2].
  Floor 100; a clamped loss records `floored: true` and the unclamped value.
- A self-encounter (same account both sides) is refused.

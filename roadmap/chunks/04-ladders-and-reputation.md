# Chunk 04 — Ladders & Reputation

**Depends on:** 01, 02. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Implement the two separate progression numbers per pool: the **volatile Reputation**
rating that drives matchmaking, and the **permanent, use-driven ladder** that grants
unlock points at milestones.

## Design constraints that apply here

**These two numbers are separate and the split is load-bearing. Do not merge them.**

- **Reputation** — a single number that drives matchmaking. **Volatile and
  contestable**: successful raids can shift it. It is a **rating, not a currency —
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
| `LADDER_GAIN_WIN` | 30 per cleared stop, per pool used | Scaled by pool participation. |
| `LADDER_GAIN_LOSS` | 10 per failed stop, per pool used | Losses still progress — never zero. |
| `LADDER_GAIN_STALEMATE` | 10 | Treated as a loss for the attacker. |
| `LADDER_GAIN_DEFENSE_HELD` | 25 for trap + living pools when a defense repels a raid | Defense is "use" too. |
| `UNLOCK_POINTS_PER_RUNG` | 1 for rungs 1–10, 2 for rungs 11–20 | Total 30 points per pool at cap. |
| `REPUTATION_START` | 1000 | Neutral starting rating. |
| `REPUTATION_WIN_ATTACKER` | +25, scaled by the gap to the defender's rating | Standard Elo-ish shape; keep the scaling function pure and deterministic. |
| `REPUTATION_LOSS_ATTACKER` | −15 | |
| `REPUTATION_DEFENDER_HELD` | +15 | |
| `REPUTATION_DEFENDER_LOST` | −20 | |
| `REPUTATION_FLOOR` | 100 | Can't spiral to zero. |

Reputation adjustment must be a **pure deterministic function** of the two ratings
and the outcome — no randomness, no time decay that reads the clock at compute time.

## Definition of done

- [ ] Reputation and ladder are separate fields per pool, never derived from each other.
- [ ] Reputation has no spend path. A test asserts no API can debit it as a cost.
- [ ] Ladder progress is attributed only to pools actually used in a fight.
- [ ] Losses earn ladder progress; a test asserts the loss gain is > 0 and < the win gain.
- [ ] Ladder levels cannot decrease — proven by test across every outcome type
      including full wipe.
- [ ] Rung crossing grants unlock points exactly once, ever. A test replays the same
      progress event and asserts no double grant.
- [ ] Granted unlock points cannot be revoked by any path.
- [ ] Scope split honored: trap/siege at account level, living-unit at caravan level.
- [ ] Reputation adjustment is a pure function; same inputs → same delta, every time.

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

# Chunk 13 — Matchmaking & scouting

**Depends on:** 04, 08. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Target selection: present a short list of candidate camps banded by Reputation, let
the player scout each one fully before committing, and manage rerolls and post-raid
shields.

## Design constraints that apply here

- **This is not player-pairing in real time — it's target selection.** The defender
  never needs to be online. Do not build presence, lobbies, or invitations.
- **The defender does need to not currently be mid-trip.** The candidate pool
  naturally excludes any caravan that's currently away. **A caravan on a trip is not
  present and not targetable — there is genuinely nothing there to raid, not an
  undefended camp free for the taking.** This is expected to make the pool size
  fluctuate somewhat; **that is not something to correct for** — do not backfill with
  bots, ghosts, or stale snapshots of away caravans.
- Candidates are banded by the **single, volatile Reputation number**, **not by
  mirrored builds**. Two players at equal Reputation can have very different pool
  investments and regions — **this is intentional diversity, not an imbalance to
  fix.** Do not add build-similarity or region matching.
- **Matchmaking is region-agnostic by design** — cross-region matches are intentional
  build diversity.
- **Presents a short list of 3 candidates per search.**
- **Re-roll (search again) is free but time-gated, not resource-gated** — this keeps
  search behavior identical for paying and non-paying players. **There must be no
  Coin reroll for matchmaking.** (The refugee drip has a Coin reroll; matchmaking
  explicitly does not. Do not copy the pattern across.)
- **A camp gets a temporary shield/cooldown after being successfully raided**,
  preventing immediate re-farming before the defender has a chance to notice and rebuild.
- **Every candidate is individually scoutable** before the player commits. Scouting
  shows the camp exactly as the defender built it: fence segments and their HP, gaps,
  trap positions and types, garrison units and their stats, aggro and leash. **This
  is the intended read-the-camp skill expression** — hiding any of it to create
  surprise is a design violation, not a difficulty knob.
- Matchmaking selection must be **deterministic given the same pool and seed state**,
  or if a random element shapes *which* candidates are offered, it must be seeded and
  reproducible. Randomness may shape the menu; it must never shape an outcome.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `CANDIDATES_PER_SEARCH` | 3 | Fixed by design. |
| `REPUTATION_BAND_WIDTH` | ±150, widening by ±100 per failed search pass up to ±600 | Handles thin pools without abandoning banding. |
| `REROLL_COOLDOWN_SECONDS` | 180 | Free but time-gated. **Never purchasable.** |
| `RAID_SHIELD_DURATION_HOURS` | 4 | Applied after a camp is successfully raided (full clear). |
| `SHIELD_ON_PARTIAL` | none | Only a successful raid shields. Tunable. |
| `SELF_EXCLUDE` | always | A player never matches their own caravan. |
| `RECENT_OPPONENT_EXCLUSION` | last 5 opponents excluded for this account | Anti-repetition; tunable. |
| `EMPTY_POOL_BEHAVIOR` | widen band, then tell the player to try again shortly | **Never fabricate a target.** No bots, no ghost camps, no snapshots of away caravans. |
| `CANDIDATE_SELECTION_SEED` | derived deterministically from (account id, search sequence number) | Reproducible menu generation. |

## Definition of done

- [ ] Reputation-banded candidate search returning exactly 3 candidates.
- [ ] Away caravans (`away` state) are excluded from the pool, verified by test.
- [ ] Self and recent opponents excluded.
- [ ] Region is **not** a filter; a test asserts cross-region candidates appear.
- [ ] Build similarity is **not** a filter.
- [ ] Reroll is free, time-gated, with the cooldown visible. No Coin path exists.
- [ ] Post-raid shield applied on a successful raid and honored by the pool query.
- [ ] Full scout view per candidate: fence segments + HP + gaps, traps + types,
      garrison units + stats + aggro/leash, core position. Identical to what the
      defender's builder shows.
- [ ] Candidate menu generation is seeded and reproducible from stored state.
- [ ] Thin/empty pool degrades honestly — widen, then say so. No fabricated targets.
- [ ] Layout is snapshotted when the player commits to a stop, so a mid-flight edit
      by the defender can't change the fight (ties into chunk 02).

## QA guardrail checks for this chunk

- **Determinism:** any hidden randomness in **matchmaking outcome** as opposed to
  menu generation? The menu may be shaped by seeded randomness; which camp you get
  when you pick one must be fixed. Re-running a search with the same seed must
  produce the same 3.
- **No pay-to-win:** is reroll free and time-gated everywhere, with no Coin or
  purchase path — including any "skip the wait" surface? Search behavior must be
  identical for paying and non-paying players. Check whether a paying account gets
  better candidates by any path.
- **Legibility:** can the player scout **everything** before committing? Compare the
  scout payload field-by-field against the camp builder's model. Anything present in
  the layout but absent from the scout view is a legibility bug.
- **Untargetable while away:** drive a trip and confirm the caravan vanishes from
  every candidate pool for the whole duration, and returns the instant the trip ends
  by bank *or* wipe. Confirm nothing substitutes a stale snapshot for it.
- **Design fidelity:** has banding drifted toward mirrored builds or same-region
  matching? Both are explicitly not wanted — cross-region and cross-build variety is
  intentional diversity, not an imbalance to fix.
- **Re-farming:** can a raider circumvent the shield by rerolling, by a second
  account, or by racing a concurrent raid? (Concurrency handling lives in chunk 02 —
  exercise it here.)

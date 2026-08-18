# Chunk 14 — Matchmaking & scouting

**Depends on:** 04, 09. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

Encounter selection: draw from the pool of **standing raiding parties** and serve them
as the attackers a caravan meets on its trip. Present 3 candidates, let the player
scout each in full before committing, and manage rerolls and repetition.

## Orientation

**This is not player-pairing, and it is not target selection in the usual sense.** The
player being served is the *defender* — the caravan. What matchmaking picks is who is
about to attack them. A party's owner is never online for it, and never needs to be
doing anything at all: their party stands whether they play or not.

Because a standing party is a template rather than a caravan that can be busy,
**nothing needs excluding from the pool for being away**. The pool is always deep.
This is simpler than the inverse arrangement would have been — do not port over
availability logic that no longer has a reason to exist.

## Design constraints that apply here

- Candidates are banded by the single, volatile **Reputation** number, **not by
  mirrored builds** — two players at equal Reputation can have very different pool
  investments and regions, which is **intentional diversity, not an imbalance to fix.**
- **Matchmaking is region-agnostic by design** — cross-region encounters are intentional
  build diversity.
- **Presents a short list of 3 candidates per search.**
- **Re-roll (search again) is free but time-gated, not resource-gated** — this keeps
  search behavior identical for paying and non-paying players. **There must be no Coin
  reroll here.** (The refugee drip has one; matchmaking explicitly does not. Do not
  copy the pattern across.)
- **A recent-opponent exclusion** prevents the same party being served repeatedly to
  the same player in a short window, so a trip feels like a varied trail rather than
  one gang over and over.
- **Every candidate is scoutable in full** before the player commits to arranging their
  circle: every unit and its stats, its ability, its stance, its siege loadout, and
  which edges it will enter from. **This is the game's central skill expression** —
  reading the incoming force and countering it. Hiding any of it to create surprise is
  a design violation, not a difficulty knob.
- Selection must be **deterministic given the same pool and seed state.** If randomness
  shapes *which* candidates are offered, it must be seeded and reproducible. Randomness
  may shape the menu; it must never shape an outcome.
- **The party is snapshotted when the player commits to an encounter**, so its owner
  editing it mid-flight cannot change the fight (ties into chunk 02).
- A player never meets their own standing party.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `CANDIDATES_PER_SEARCH` | 3 | Fixed by design. |
| `REPUTATION_BAND_WIDTH` | ±150, widening by ±100 per failed pass up to ±600 | Handles thin pools without abandoning banding. |
| `REROLL_COOLDOWN_SECONDS` | 180 | Free but time-gated. **Never purchasable.** |
| `SELF_EXCLUDE` | always | A player never meets their own party. |
| `RECENT_OPPONENT_EXCLUSION` | last 5 parties excluded for this account | Variety on the trail. |
| `DIFFICULTY_ESCALATION` | band centre rises ~5% of band width per encounter within a trip | Later encounters are harder, which is what makes pushing risky rather than merely longer. Central to the bank/push balance — tune with care. |
| `EMPTY_POOL_BEHAVIOR` | widen band, then serve an authored fallback party | Unlike a caravan pool, a party pool should rarely thin out. An authored fallback avoids a dead end for very early or very high Reputation, and must be clearly the same kind of object, not a special case in the resolver. |
| `CANDIDATE_SELECTION_SEED` | derived deterministically from (caravan id, trip id, encounter index) | Reproducible menu generation. |

## Definition of done

- [ ] Reputation-banded search over standing parties, returning exactly 3 candidates.
- [ ] Self and recent opponents excluded.
- [ ] Region is **not** a filter; a test asserts cross-region candidates appear.
- [ ] Build similarity is **not** a filter.
- [ ] Reroll is free, time-gated, cooldown visible. No Coin path exists.
- [ ] Full scout view per candidate: every unit, stats, ability, stance, siege, entry
      edges. Identical to what the party's own builder previews.
- [ ] Candidate menu generation is seeded and reproducible from stored state.
- [ ] Difficulty escalates across encounters within a trip.
- [ ] Party is snapshotted at commit, so a mid-flight edit by its owner can't change
      the fight.
- [ ] Thin pool degrades honestly — widen, then authored fallback. No fabricated
      inconsistency, no resolver special-casing.
- [ ] No availability/exclusion logic based on whether a party's owner is online or busy.

## QA guardrail checks for this chunk

- **Legibility — the single most important check:** can the player scout **everything**
  before committing? Compare the scout payload field by field against the standing
  party model. Anything in the model but missing from the scout view is a legibility
  bug, and here it directly breaks the game's active loop, which is entirely about
  reading the attacker and answering it.
- **Determinism:** hidden randomness in the **encounter outcome** as opposed to **menu
  generation**? The 3 candidates may be shaped by seeded randomness; which party you
  face once you pick must be fixed. Re-running a search with the same seed must give
  the same 3.
- **No pay-to-win:** is reroll free and time-gated everywhere, with no Coin or purchase
  path including any "skip the wait" surface? Can a paying account be served easier
  encounters, or a paying party owner get served into more trips? Both would sell
  outcomes.
- **Which way round:** has any logic survived that excludes parties because their owner
  is busy, away, or offline? A standing party is always available by definition;
  such logic is leftover from the inverted model and should be deleted, not maintained.
- **Design fidelity:** has banding drifted toward mirrored builds or same-region
  matching? Both are explicitly unwanted — cross-region, cross-build variety is
  intentional diversity.
- **Difficulty escalation is legible:** can the player tell that pushing means harder
  encounters, before choosing to push? If not, bank-or-push is being made on
  incomplete information, which the design forbids.
- **Snapshot integrity:** edit a party while it is mid-resolution in someone's trip and
  confirm the fight and its replay are unaffected.

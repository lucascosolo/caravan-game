# Chunk 14 — Matchmaking & scouting

**Depends on:** 04, 09. **Status:** built (server search / scout / choose, trip + candidate persistence, authored cold-start seam, tests — 2026-10-11).
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

## Notes from chunk 04 QA

- **Decided in chunk 04 QA (D1): which Reputation is each side's rating.** The caravan
  being served is banded by its **living** Reputation (caravan-level). A standing party
  is banded by its owner's **siege** Reputation — the account-level "offense Reputation,
  stored on the siege pool". Trap Reputation has no reader and does not move; do not band
  on it. `GET /progression/rules` → `reputation.matchmakingRating` publishes this and the
  resolver-side writer is `apps/server/src/progression/outcome.ts`.
- **Sandbagging (D2) — carry these into this chunk's checklist** (from PHASE-2 §31
  "Integrity and anti-abuse"; the chunk 04 punch list cites it as §28):
  - [ ] A **floor on Coin earned per encounter** against parties whose Reputation is far
        below the caravan's, so farming trivially beatable parties pays less than playing.
        Visible in the tunables registry, identical for every account.
  - [ ] The **recent-opponent exclusion** (`RECENT_OPPONENT_EXCLUSION`) is enforced
        server-side and tested, not only in the candidate menu's presentation.
  - Chunk 04 blunts the rating side only: a loss is scaled by at least ×0.5
    (`REPUTATION_GAP_MULT_MIN_LOSS`) and a win by at least ×0.25, so tanking a rating takes
    roughly twice as many losses as climbing back takes wins. Nothing structural changed.

## Build notes (2026-10-11)

**Where it lives.** `apps/server/src/matchmaking/{band,service,trips,exclusions,authored}.ts`,
`routes/matchmaking.ts` (`POST /me/caravans/:id/encounters/:n/search`, `GET …/candidates`,
`POST …/choose`), migration `009_matchmaking` (`account.is_system`, `trip`,
`encounter_candidates`), the chunk 14 tunables block in `packages/content/src/tunables.ts`,
and the `party` input on `enqueueEncounterResolution`. Tests: `test/matchmaking-pure.test.ts`
(16) and `test/matchmaking.test.ts` (17).

**The snapshot contract (chunk 09 QA blocker, settled here — chunk 15 builds on it):**
1. `snapshotStandingParty` runs **exactly once per candidate, at menu generation**
   (`searchCandidates`); the `StandingPartySnapshot` is stored on the candidate inside the
   `encounter_candidates` row.
2. The scout view is `scoutParty(partyFromJson(snapshot.composition))` over that stored
   snapshot — never a live resolve. A test proves it is byte-identical to the owner's own
   `GET /me/party` preview at search time.
3. `chooseCandidate` marks the menu row chosen. It does **not** re-resolve the live party:
   the stored snapshot is the party that will be fought.
4. `enqueueChosenEncounter(client, caravan, n, formation)` — the seam chunk 15 calls after
   `commitFormation` — passes the chosen snapshot as `party` to `enqueueEncounterResolution`,
   which stores it as-is (the live-snapshot path survives only for callers that omit
   `party`, i.e. the chunk 02 tests). Tests prove `job.input.party` is byte-identical to the
   scouted snapshot and that `scoutParty` over it equals what the defender saw.
5. `StandingPartyInvalidError` can therefore only surface at generation: the party is
   skipped, its id recorded in `skipped_party_ids`, and the draw re-runs without it (so the
   stored inputs still replay to the stored menu).
6. The snapshot is a copy: the owner editing, de-merging or losing units between search and
   resolution changes nothing. Tested both ways (edit-then-choose, lose-unit-then-choose).
   This supersedes the brief's "refuse and re-scout if the party became invalid between
   scouting and choosing": refusing would punish the defender for the owner's roster
   changes and would make the arrangement they built against a scouted party worthless.

**Decisions and assumptions (confirm in QA):**
- **Ratings (chunk 04 QA D1):** caravan = its living Reputation (`pool_progress` on the
  caravan); party = its owner's siege Reputation (account). The pool query joins only
  `standing_party`, `account` (username, `is_system`) and the siege row. Region, build and
  any notion of the owner being online/busy are not read (a source scan asserts it).
- **Band centre** = caravan living Reputation + `floor(SPAN × DIFFICULTY_ESCALATION_BP ×
  (n − 1) / 10000)`, SPAN = 2 × `REPUTATION_BAND_WIDTH` = 300, so **+15 per encounter**
  ("~5% of band width" read as 5% of the full span; ±7 if read as the half-width — a
  one-number change). The menu reports `escalation.applied/perEncounter/nextEncounter` so
  the player sees that pushing means a harder party before deciding.
- **Widening:** half-widths 150, 250, 350, 450, 550, 600; a pass fails when live + allowed
  authored in band < 3. `EMPTY_POOL_BEHAVIOR`: after ±600, authored parties outside the
  band nearest the centre fill the menu; live parties outside never do. If even that cannot
  reach 3 the search is `503 pool_empty` (only possible before `pnpm db:seed`).
- **Authored share cap:** in a band with L live parties at most `floor(L × 0.3 / 0.7)`
  authored join the draw (seeded choice of which), never fewer than needed to reach 3. So
  with ≥ 7 live parties in band, 3 authored join a 10+ pool (≤ 30%); with 0–2 live, authored
  fill the rest. "Weighted down" is implemented as a pool cap rather than a per-encounter
  served-ratio ledger; chunk 25 may replace it with a measured ratio.
- **Seed** = `fnv1a32(caravanId:tripId:encounterIndex:searchSeq)`, drawn with xorshift32
  (chunk 18's helpers, now exported). Each row stores seed, centre, the eligible pool (after
  exclusions), the excluded and skipped party ids and the candidates; `replaySearch(row)`
  recomputes the picks and a test asserts they match.
- **Exclusions:** self (always); linked accounts through `LinkedAccountsResolver`
  (`exclusions.ts`, v1 returns none — PHASE-2 §31 fills it; injectable, tested with a stub);
  the last `RECENT_OPPONENT_EXCLUSION` (5) parties the **account** committed to (chosen
  rows across all its caravans and trips, newest first). Parties with no units are not
  served (every fresh account's party is empty; there would be nothing to fight).
- **Reroll:** the first search of an encounter is immediate; each later one is free and
  waits `REROLL_COOLDOWN_SECONDS` (180) after the previous, measured by the caller-supplied
  `nowMs` (routes pass `Date.now()`; the service never reads the clock). `409
  reroll_cooldown` carries `availableAtMs`, `retryAfterSeconds`, `Retry-After` and
  `gate: "time"`. Once a candidate is chosen, searching again is `409 already_chosen`.
  No Coin, cost, price, purchase or entitlement word appears on the matchmaking path (scan).
- **Choose:** only the CURRENT menu is choosable; an id from a rerolled-away menu is `409
  stale_candidate`, an unknown id `404`. Idempotent for the same candidate; a different one
  after choosing is `409 already_chosen`. The chosen row is frozen by trigger; one chosen
  row per encounter by partial unique index; the CHECK refuses an id that was not offered.
- **Trip seam:** `trips.ts` `createTrip(client, caravanId)` (needs the open manifest; one
  open trip per caravan) and `endTrip`. Chunk 15 owns the trip cap, `caravan.state`,
  closing the manifest, `trip_started` and the bank/push loop; tests here call these two
  directly. Encounter index n is valid only while n = `manifest.encounters_resolved + 1`.
- **Sandbagging earn floor (chunk 04 QA D2):** `sandbagEarnMultiplier(gap)` with
  `SANDBAG_EARN_GAP_START` 300 and `SANDBAG_EARN_MULT_MIN` 0.25 is published on every
  candidate (`reputation.sandbagEarnMultiplier`, fixed-point) so the player sees before
  committing that a far-weaker party pays less. **Chunk 19 applies it** to Coin earned; it
  reads ratings only.
- **Authored cold-start (PHASE-2 §25 seam):** `seedAuthoredParties` (called by `pnpm
  db:seed`) creates 12 system accounts (`sys_outfit_01..12`, `is_system`, unusable random
  passwords) — 3 per band for bands 0–3 (REPUTATION_START is in band 3), across all four
  regions, all three stances, 1/2/4-edge splits, sizes 3–8, merge levels 1–4, on each
  region's two free starting types and the starting siege piece only (the web is the only
  access gate; authored content gets no bypass — chunk 25 can purchase nodes for them).
  Their parties are ordinary rows through `saveParty`; the snapshot carries nothing that
  marks them authored (asserted). Chunk 19 must read `is_system` to destroy rather than
  bank Coin lost to one and to skip their Reputation.
- **No ledger event is added here.** Searching and choosing are recorded in
  `encounter_candidates`; the `formation_committed` event (chunk 02) already carries the
  party version at enqueue. Chunk 15 appends `trip_started`.
- **Routes are under `/me/caravans/:id/…`** as the assignment specified, alongside chunk
  07's `/caravans/:id/…`; a later pass may unify the prefix.

**Deferred / for QA:** the UI (chunk 08 renders this menu); `linkedAccounts` is a stub;
the authored set is 12 parties, not 12 per band; the share cap is a pool cap, not a served
ratio; migration 009's `is_system` column means `pnpm db:migrate` must re-apply roles.sql
(it does) so the app role keeps column-level UPDATE on `account`.

## QA round 1 (2026-10-11) — decisions and the fixer's changes

Punch list: `roadmap/qa/14-punchlist.md`. B1, B2, S4, S5, N1, N2 are closed by the chunk 25
Maker (authored.ts, the authored allowance, login, migration 009's `is_system` bits, the
seed). The rest, below, by a chunk 14 fixer.

**Decisions (orchestrator):**
- **D1 — escalation stays 500 bp of the full span, +15 per encounter.** "~5% of band width"
  is read as 5% of the 300 span (`BAND_SPAN`), not of the ±150 half-width.
  `DIFFICULTY_ESCALATION_BP` is the single lever; chunk 32 (balance) tunes it, nothing else
  about escalation changes shape.
- **D2 — the sandbagging earn floor stays, measured beyond the band (S3).** The floor reads
  `gapBeyondBand(caravanLiving − ownerSiege, band_width_used)`: a party the search had to
  widen to is paid in full; only the authored-outside-band fallback can still be floored,
  and the candidate shows it before commit. Chunk 19 applies it through ONE exported
  function, `applyEarnFloor` (named in its checklist; "From chunk 14" block in its file).
- **D3 — `owner.authored: true` stays published.** Legibility beats disguise: the player is
  told when a candidate is authored; the resolver and the draw cannot tell (same row type,
  same snapshot shape). PHASE-2 §25's QA check now reads "indistinguishable to the resolver
  and matchmaking, visibly labelled to the player".

**Closed by the fixer:**
- **S1** `enqueueEncounterResolution` requires `party` (the chosen snapshot); the live
  re-resolve fallback is gone. Omitting it throws before any write; a snapshot of another
  owner is refused. The chunk 02 tests that bypass matchmaking take their own
  `snapshotStandingParty` inside the enqueuing transaction.
- **S2** the pool query is bounded in SQL to `pp.reputation BETWEEN centre ∓
  REPUTATION_BAND_WIDTH_MAX OR a.is_system` over the new `pool_progress (pool, reputation)`
  index (migration 009); the stored pool is that subset. Replay stays exact because nothing
  outside it can be drawn (live parties outside the widest band never are; authored ones
  are all loaded). A test asserts the far party is neither stored nor scanned and the index
  exists.
- **S3** `gapBeyondBand` in `band.ts` (the only band.ts change); `candidateFromSnapshot`
  takes `band_width_used`; every candidate now carries `reputation.gapBeyondBand` and its
  `sandbagEarnMultiplier` is computed from that. Tests: pure sweep over every width; a
  pocket the search widens to ±550 pays `FIXED_ONE` where the raw gap (550) would have been
  floored; the fresh-player n = 6 path pays `FIXED_ONE` on every candidate; a 9000-rated
  caravan with an empty pocket gets the authored fallback, floored and labelled.
- **S6** "From chunk 14" blocks appended to the chunk 15 file (createTrip / endTrip /
  enqueueChosenEncounter / `encounter_candidates` seam; a new trip resets the reroll gate)
  and the chunk 19 file (destroy Coin lost to `is_system` owners, skip their Reputation,
  `applyEarnFloor`, the tests it owes).
- **N3** `snapshots.ts` header now says skip-at-generation (recorded in
  `skipped_party_ids`), never re-scout, and that the enqueue never snapshots a live party.
- **N4** the client view (`CandidateMenuView`, `ChoiceView.chosen`) is built from
  `CandidateView` — `owner` is `{displayName, authored}` — and no longer carries
  `skippedPartyIds`; both stay on the stored row and in `chosenCandidate()` for chunk 15.
  Not changed: the published `snapshot` still carries `ownerAccountId` (the snapshot is
  published whole so the client can later verify the job input against it); flagged for the
  coordinator if that id should go too.
- **N5** the menu carries `authoredShare: {authored, of, shareBp, maxShareBp}`;
  `usedAuthoredFallback` is `authoredOutsideBand` in the view (band.ts's
  `SelectionResult.usedAuthoredFallback` is untouched — chunk 25 is rewriting that draw).

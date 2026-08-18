# Chunk 16 — Economy: Coin (and the merge system)

**Depends on:** 02, 03. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Coin: earning, spending, the storage cap, the passive trickle — and the merge system
that Coin exists to pace. Losing Coin is chunk 19; buying it is chunk 20.

## Design constraints that apply here

**Coin:**
- **Earned** via surviving encounters, completed deliveries (banked trips), successful
  fights by your standing raid party, and a **slow passive trickle up to a storage cap** — the trickle exists
  specifically to keep **something always at risk even for players who aren't
  actively pushing trips**.
- **Spent** on merges — **this is the core power-pacing lever.**
- Has a **per-account storage cap**, so accumulation (whether earned or bought)
  **can't run unbounded.**
- Coin is **account-level**, not caravan-level (per the data split).
- All Coin movement flows through the event ledger. Balance is a projection.
- The passive trickle must be computed **lazily from elapsed time on read**, not by a
  background tick — there is no always-on engine in this architecture. It must be
  deterministic: same elapsed time → same amount, no drift from how often it's read.

**Merging:**
- Merging two owned copies of the same living-unit tier produces one stronger copy of
  the same unit — **no branching, no specialization at merge time.**
- Two recipes: **2 units → 1 of the next tier**, and **5 units → 3 of the next tier**
  (better per-unit rate: 1.67 units spent per level vs. 2.0 — this **rewards patient
  hoarding over merging the instant a pair is available**, and that asymmetry is
  deliberate).
- **Capped at level 5.**
- **Merging costs Coin.**
- **A merged unit is *not* stronger than its unmerged components combined; it is more
  slot-efficient.** This is precisely why buying Coin for faster merging is **pace,
  not power**. If this ever stops being true, the entire monetization guardrail fails.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `COIN_STORAGE_CAP` | 50,000 | Per account. Hard ceiling on accumulation. |
| `COIN_PER_ENCOUNTER_BASE` | 400 at encounter 1, ×1.25 per subsequent encounter | Ties to chunk 15's escalation. |
| `COIN_PER_BANKED_TRIP` | 500 flat completion bonus | The delivery reward. |
| `COIN_PER_PARTY_WIN` | 300 when your standing party overruns a caravan | The passive side's earn path. Deliberately below the active path — playing should pay better than not playing. |
| `COIN_TRICKLE_RATE` | 200/hour, ceasing at the storage cap | Keeps something always at risk. Computed lazily on read. |
| `MERGE_COST_BY_TARGET_LEVEL` | L2: 250, L3: 900, L4: 3,000, L5: 9,500 | Steeply escalating — this is *the* pacing lever. Cost is per resulting unit. |
| `MERGE_RECIPE_SMALL` | 2 → 1 | 2.0 units per level. |
| `MERGE_RECIPE_LARGE` | 5 → 3 | 1.67 units per level. Better rate; rewards hoarding. |
| `MERGE_LEVEL_CAP` | 5 | Fixed by design. |
| `MERGE_STAT_MULT_PER_LEVEL` | ×1.8 per level | From chunk 03. **Must stay below 2.0** so a merged unit is weaker than its components combined. Applies to ability values too (chunk 12) — merging never grants a new or extra ability, only larger numbers on the same one. |
| `MERGE_SLOT_COST` | 1 slot at any level | The entire benefit of merging. A level-5 unit occupies one slot where its 16 level-1 components would have needed 16. |
| `COIN_OVERFLOW_BEHAVIOR` | earnings above the cap are discarded, with a clear warning surfaced before the trip | Do not silently void a player's earnings. |

## Definition of done

- [ ] Coin earn on surviving an encounter, on a banked trip, when your standing party
      wins, and via the lazy passive trickle.
- [ ] Storage cap enforced on every credit path, including the trickle and (later)
      purchases and defender transfers.
- [ ] Trickle is deterministic and read-frequency-independent: reading the balance
      10 times in an hour yields the same total as reading it once.
- [ ] Merge: both recipes, Coin cost charged, level cap enforced, no branching or
      specialization possible.
- [ ] **A test asserts, at every level and for both recipes, that the merged unit's
      stats are strictly less than the sum of the components consumed.** This is the
      single most important test in this chunk.
- [ ] Merged units cost one slot regardless of level; slot efficiency demonstrable.
- [ ] All movement written to the ledger; balance rebuilt from the ledger matches live.
- [ ] Coin is account-level. Merges affect caravan-level unit instances.
- [ ] Overflow is warned about, not silently discarded.
- [ ] Merge cost and resulting stats are shown before the player commits.

## QA guardrail checks for this chunk

- **No pay-to-win — the load-bearing check:** verify by calculation at every merge
  level that a merged unit is **not stronger than its unmerged components combined**.
  If it is, Coin buys power and the entire monetization design is broken. Check both
  recipes; check the 5→3 path especially, since three outputs from five inputs is
  easy to get wrong.
- **No pay-to-win, second pass:** does anything about Coin affect a **stat, a power
  ceiling, or an outcome** — versus only pace? Does the merge cap differ for anyone?
- **Bounded accumulation:** can Coin exceed the storage cap by any path — trickle
  race, concurrent credits, purchase plus earning in the same instant?
- **Determinism:** is the trickle computation deterministic and independent of read
  timing? Any drift, any double-credit across concurrent reads?
- **Legibility:** are merge costs, resulting stats, and the slot benefit all visible
  before committing? Is the overflow warning shown before a trip that would exceed
  the cap?
- **Grind wall check (explicitly, don't assume the guardrails prevent it):** with
  these earn rates and merge costs, how long does a free player take to reach level 5
  on one unit? Is that duration one where the paid path stops feeling optional? This
  is the specific failure mode the design calls out — check it, don't infer it.
- **Generous acquisition holds up:** given these numbers, is rebuilding a lost unit
  type actually recoverable in practice, not just in theory?
- **Split correctness:** Coin at account level; unit instances at caravan level.

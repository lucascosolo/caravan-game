# Chunk 16 — Economy: Coin (and the merge system)

**Depends on:** 02, 03. **Status:** built (2026-10-11); QA round 1 punch list closed
2026-10-11 (`roadmap/qa/16-punchlist.md`), awaiting re-review.
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
| `TRICKLE_MATERIALIZE_MIN_COINS` | 10 | QA S4. A read shows the pending trickle always but writes a ledger row only once this many coins (or `_MIN_MS`) have accrued. Pending coins carry; nothing is dropped. |
| `TRICKLE_MATERIALIZE_MIN_MS` | 15 min | QA S4. The time threshold for the same. With 18 s/coin the coin threshold is reached first; this one matters if the rate is retuned. |
| `MERGE_COST_BY_TARGET_LEVEL` | L2: 250, L3: 900, L4: 3,000, L5: 9,500 | Steeply escalating — this is *the* pacing lever. Cost is per resulting unit. |
| `MERGE_RECIPE_SMALL` | 2 → 1 | 2.0 units per level. |
| `MERGE_RECIPE_LARGE` | 5 → 3 | 1.67 units per level. Better rate; rewards hoarding. |
| `MERGE_LEVEL_CAP` | 5 | Fixed by design. |
| `MERGE_STAT_MULT_PER_LEVEL` | ×1.25 per level (was ×1.8 in this brief; chunk 03 QA settled ×1.25) | From chunk 03: applies to max HP and post-formula damage OUTPUT only, never to the ratings or ability fields. Bound is k² < 5/3 for the 5→3 recipe. Merging never grants a new or extra ability. |
| `MERGE_SLOT_COST` | 1 slot at any level | The entire benefit of merging. A level-5 unit occupies one slot where its 16 level-1 components would have needed 16. |
| `COIN_OVERFLOW_BEHAVIOR` | earnings above the cap are discarded, with a clear warning surfaced before the trip | Do not silently void a player's earnings. |

## Definition of done

- [x] Coin earn on surviving an encounter, on a banked trip, when your standing party
      wins, and via the lazy passive trickle.
- [x] Storage cap enforced on every credit path, including the trickle and (later)
      purchases and defender transfers.
- [x] Trickle is deterministic and read-frequency-independent: reading the balance
      10 times in an hour yields the same total as reading it once.
- [x] Merge: both recipes, Coin cost charged, level cap enforced, no branching or
      specialization possible.
- [x] **A test asserts, at every level and for both recipes, that the merged unit's
      stats are strictly less than the sum of the components consumed.** This is the
      single most important test in this chunk.
- [x] Merged units cost one slot regardless of level; slot efficiency demonstrable.
- [x] All movement written to the ledger; balance rebuilt from the ledger matches live.
- [x] Coin is account-level. Merges affect caravan-level unit instances.
- [x] Overflow is warned about, not silently discarded.
- [x] Merge cost and resulting stats are shown before the player commits.

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

## Built (2026-10-11)

Files: `apps/server/src/economy/{coin,trickle,merge,index}.ts`, `apps/server/src/routes/economy.ts`
(`GET /me/economy`, `POST /me/caravans/:id/merge/preview`, `POST /me/caravans/:id/merge`),
tests `apps/server/test/economy-guards.test.ts` (pure) and `apps/server/test/economy.test.ts`
(DB). Tunables added to `@caravan/content`: `COIN_PER_ENCOUNTER_BASE`,
`COIN_ENCOUNTER_ESCALATION_MULT`, `COIN_PER_BANKED_TRIP`, `COIN_PER_PARTY_WIN`,
`COIN_TRICKLE_RATE_PER_HOUR`, `COIN_TRICKLE_MS_PER_COIN`, `MERGE_COST_BY_TARGET_LEVEL`,
`MERGE_SLOT_COST`, `COIN_OVERFLOW_BEHAVIOR`. No migration: the trickle's accrual point is
read from the last `coin_earned{reason:"trickle"}` event's `accruedThroughMs` (else account
creation), so the ledger alone reproduces it.

Earn paths are service functions for chunks 15/19/13 to call inside their own transaction:
`creditBankedTrip` (one `coin_earned` per survived encounter + the delivery bonus — the
per-encounter Coin is unbanked trip state until then, so there is deliberately no
"credit one encounter into the account now" path), `creditPartyWin`, and the generic
batch-clamped `appendCoinCredits`. See ORCHESTRATION.md for assumptions and the grind-wall
numbers.

## QA round 1 closed (2026-10-11)

Punch list: `roadmap/qa/16-punchlist.md` (S1–S6, N1–N6 all `[closed]`). What changed:

- **Debits have one path:** `spendCoin(client, accountId, amount, reason, nowMs, { causationId,
  extra?, alongside? })` in `economy/coin.ts` — flushes the pending trickle (forced), refuses
  409 `insufficient_coin`, then appends `coin_spent` plus any `alongside` events (the merge's
  `unit_merged`) in one batch under one causation id. `coinDebitDraft` is imported nowhere
  else; a source-scan test enforces it. Chunks 18/20 debit through this and nothing else.
- **Trickle: shown always, written at thresholds, never at the cap.** The balance the player
  sees (`GET /me/economy` `balance`, `MergePreview.balance`) is ledger + pending. A trickle
  row is written once `TRICKLE_MATERIALIZE_MIN_COINS` / `_MIN_MS` is reached or a debit
  flushes it. At the cap nothing is written. The accrual point is
  max(last valid trickle `accruedThroughMs`, last `coin_spent` `occurred_at`), so idling at
  the cap banks no backlog; a spend drops at most a sub-coin remainder (< 18 s).
  `peekTrickle` is the read-only form for previews.
- **Merges are town-only** (409 `caravan_on_trip` unless `in_town`, FOR SHARE in the commit
  transaction), **validated before any query** (uuid path param → 400 `invalid_caravan_id`;
  ids lowercased, distinct, a recipe for the count), and **idempotent on retry**: the same
  caravan + inputs after a commit returns 200 `{ replayed: true, merged, events, ... }` with
  the stored `unit_merged` payload. A race on the same inputs is 1 winner + N replays.
- **Earn schedule clamps at `COIN_STORAGE_CAP`** per encounter (reached around encounter 23)
  and asserts safe integers; `prospectiveEarn` is a safe integer ≤ 10 × cap.

### Conventions (QA N6)

- **A caravan that is not the caller's is a 404**, indistinguishable from one that does not
  exist. The response never confirms a foreign caravan id. Unit instances not on the named
  caravan are likewise 404 (`not_found`), whoever owns them.
- The overflow forecast is **as of now**: `room` is the room right now; UI text says so.
- Merge and Coin error codes: 400 `invalid_caravan_id` / `invalid_instance_ids` /
  `duplicate_instances` / `no_such_recipe` / `mixed_unit_types` / `mixed_merge_levels` /
  `invalid_prospective_earn`; 404 `not_found`; 409 `caravan_on_trip` / `merge_cap` /
  `insufficient_coin` / `merge_inputs_changed`.

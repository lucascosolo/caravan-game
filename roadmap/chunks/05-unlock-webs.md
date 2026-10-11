# Chunk 05 — Unlock webs (data + spend logic)

**Depends on:** 03, 04. **Status:** built.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Define the three unlock webs as data and implement spending granted unlock points to
reach nodes. This is **the only access gate in the game** — get the enforcement right.

## Design constraints that apply here

- **One visible, non-random unlock web per pool** (living-unit, trap, siege), funded
  by the permanent points granted from ladder milestones. The whole web is visible
  from the start, including nodes not yet affordable — nothing is hidden, nothing is
  discovered, nothing is randomized.
- **Reaching a node grants *access* to recruit/deploy that unit, trap, or siege item
  — it does not itself grant an instance.** Getting instances is chunk 18's job.
  Keep the two concepts strictly separate in code and in naming; conflating them is
  how the access gate quietly leaks.
- **The unlock web is the only gate for which units exist for a given player.**
  Coin and refugees only ever affect how fast or reliably they get *instances* of
  types they've already earned deliberate, ladder-funded access to. **Coin can never
  buy progression past the unlock web.**
- Unlock points come **only** from ladder rung crossings (chunk 04). There is no
  other funding source. No Coin conversion, no purchase, no gift.
- **Once granted, points can never be taken away**, and once a node is reached, that
  access is permanent — a wiped-out unit type remains fully re-acquirable, just
  costly to rebuild.
- Scope split: trap and siege webs are **account-level**; the living-unit web is
  **caravan-level** and region-specific — a caravan's web contains only its region's
  living units.
- Unlock costs are visible before spending (legibility).

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `LIVING_WEB_NODES` | 8 per region (one per unit type) | Matches chunk 03's roster. |
| `TRAP_WEB_NODES` | 6 + 4 fence-tier nodes = 10 | Fence segment tiers are unlock-web purchases too (§20 lists fence unlock-web cost). |
| `SIEGE_WEB_NODES` | 5 | |
| `NODE_COST_CURVE` | tier 1 = 1 point, tier 2 = 2, tier 3 = 4, tier 4 = 6 | Against `UNLOCK_POINTS_PER_RUNG` totalling 30 per pool, a player reaches most but not all of a web by ladder cap — meaningful choice, not a checklist. |
| `WEB_SHAPE` | DAG with 2–3 roots per pool, prerequisites required | "Web", not a line: multiple viable paths, so two players at equal ladder can have different rosters. |
| `STARTING_NODES` | 2 living, 1 trap, 1 siege unlocked free at creation | So a new account can actually play. |

## Definition of done

- [ ] Three webs defined as data (nodes, prerequisites, costs, pool, region where applicable).
- [ ] Full web is readable by the client at any time, including unaffordable nodes,
      with exact costs.
- [ ] Spending points: validates prerequisites, validates sufficient granted points,
      is idempotent, writes `unlock_node_purchased` to the ledger.
- [ ] **Reaching a node grants access only.** A test asserts the player's instance
      inventory is unchanged after unlocking.
- [ ] An `hasAccess(player, typeId)` predicate exists and is the single source of
      truth every other system calls.
- [ ] No code path funds unlock points from Coin, purchases, or anything but ladder rungs.
- [ ] Access, once granted, is never revoked — proven by test through a full wipe.
- [ ] Living web is caravan+region scoped; trap/siege webs are account scoped.
- [ ] Web is a DAG with genuine branching — a test asserts more than one distinct
      maximal reachable set exists at a mid-game point budget.

## QA guardrail checks for this chunk

- **The unlock web is the only access gate:** this is the chunk where that promise
  lives or dies. Confirm `hasAccess` is enforced **server-side** and that no other
  system can mint access. Confirm no Coin path, no purchase path, and no refugee
  path can produce a node the player hasn't reached.
- **No pay-to-win:** can spending Coin ever substitute for unlock-web progress rather
  than just accelerating instance acquisition within it? Trace every caller.
- **Legibility:** can the player see the whole web and every node's cost before
  spending? Is anything hidden that the design says should be visible?
- **Determinism / no randomness:** the web is fixed data. Confirm nothing about node
  availability, cost, or layout is generated or randomized per player.
- **Permanence:** wipe a trip, lose everything, and confirm every reached node is
  still reached and every unspent point is still there.
- **Split correctness:** living web at caravan level; trap/siege webs at account level.

## Build notes (Maker, chunk 05)

Where it lives: `packages/content/src/unlockWebs.ts` (the three webs as data, pure
evaluation, validation at import), the chunk 05 block of `packages/content/src/tunables.ts`,
`apps/server/src/unlocks/{access,spend,view}.ts`, `apps/server/src/routes/unlocks.ts`,
migration `005_unlock_node_once`. `apps/server/src/circle/access.ts` now re-exports the real
`hasAccess` (as `isUnlocked`) and `accessCheckFor(db, owner)` — the chunk 07 stub is gone.

Decisions and assumptions, in the order they came up:

- **A node's id is the type id it unlocks.** One node per unit / trap / fence tier / siege
  piece, validated both ways on load (a type with no node would be unreachable forever).
  `webForTypeId` resolves a living type to its own region's web only, so a desert caravan
  asking about `mountain.grizzly` gets "not in your web", never "not yet".
- **Starting nodes are tier 0, cost 0, reached by data.** No event is written at creation;
  `reachedSet(web, purchased)` = tier-0 nodes ∪ purchases. The brief's 2 living / 1 trap / 1
  siege, plus **fence tier 1** (`fence.brush_pile`) in the trap web: chunk 07's assumption,
  confirmed here — a caravan with no fence tier has no circle. `TUNABLES.STARTING_NODES`
  carries the four counts and validation checks the data against them.
- **Prerequisites are all-of**, listed on the node; roots have none. Every web has 2–3 roots
  (2 free + 1 paid). Living webs share one topology across regions (two tier-2 branches off
  the two starters, rejoining at a tier-3 node; a tier-3 specialist behind the paid root; the
  tier-4 capstone behind that) so the learning curve is the same whichever region a player
  picks.
- **Cost = `UNLOCK_NODE_COST_BY_TIER[tier]`** = 0/1/2/4/6, the brief's curve. With the brief's
  node counts the paid totals are living 19, trap 24, siege 11 — all **below** the 30 points
  a capped ladder grants, so a capped ladder reaches a whole web. The "most but not all"
  intent needs a steeper curve or more nodes; the registry comment says so. **Flagged for QA
  / balance, deliberately not changed** (the curve is a specified number, not an unspecified one).
- **Spend = one `unlock_node_purchased` event** (`{pool, nodeId, cost, tier}`), causation id
  `unlock:<pool>:<scope id>:<node id>`, appended under the account's append lock after the
  read-check (node in web → not reached → prerequisites reached → cost ≤ available). Chunk
  02's projection trigger moves `unlock_points_spent`; the `spent ≤ granted` CHECK and the
  new once-per-node unique index are the storage backstops. Resending a spend for a reached
  node (starting or purchased) is a 200 with `created: false` and appends nothing; a fresh
  spend is a 201.
- **Error codes**: `node_not_in_web` (400: unknown type, another region's unit, a type named
  under the wrong pool), `caravan_required` / `wrong_scope` / `bad_pool` / `bad_node` /
  `bad_caravan` (400), `no_caravan` (404, someone else's caravan — never a hint it exists),
  `prerequisites_unmet` / `insufficient_points` (409).
- **Reads**: `GET /unlocks/webs` (public, every web and cost, identical for everyone) and
  `GET /me/unlocks` (trap, siege, then each caravan's living web; every node with `cost`,
  `reached`, `prerequisitesMet`, `affordable`, `missing`; the pool's granted/spent/available).
- **Access is read from the ledger directly** (`purchasedNodeIds` → `reachedSet`), no cache,
  no projection table: the ledger is append-only, so the reached set can only grow.
  `accessCheckFor(db, owner)` binds one snapshot per validation pass, taken inside the
  transaction that uses it (chunk 07's three call sites now `await` it).
- **Nothing here grants points.** A source test asserts `unlock_points_granted` is written
  only by `progression/outcome.ts` and `unlock_node_purchased` only by `unlocks/spend.ts`,
  and that the unlocks module never mentions Coin, ladders, grants, instances or purchases.

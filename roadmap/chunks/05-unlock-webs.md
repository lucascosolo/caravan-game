# Chunk 05 — Unlock webs (data + spend logic)

**Depends on:** 03, 04. **Status:** not started.
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
  — it does not itself grant an instance.** Getting instances is chunk 16's job.
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

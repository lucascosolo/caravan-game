# Chunk 05 — QA punch list (merge e34a23b / 65c5f72)

No blockers.

Round 1 closed by the Maker (see ORCHESTRATION.md "chunk 05 QA round 1 closed"); every
item below is `[closed]`, with its regression in `apps/server/test/unlocks.test.ts`
(the `QA-05 …` describes) or `packages/content/test/unlock-webs.test.ts` as noted.

## Decision (orchestrator)
D1. [closed] **Per-pool cost curve adopted** so a capped ladder (30 points) reaches ~77–79% of each web's paid total: `UNLOCK_NODE_COST_BY_TIER` becomes `Record<UnlockPool, number[]>` = living `[0,1,4,8,14]` (paid total 39), trap `[0,1,3,7,10]` (39), siege `[0,1,8,15,21]` (38). Tier 0 untouched; first paid node still 1 point; every root-to-node path ≤ 30 so every node stays reachable at cap. Update `validateUnlockWebs`, `publicUnlockWebs().costByTier`, and the content test. Record in the chunk file.

## Should-fix
S1. [closed] Lax UUID regex in unlocks/spend.ts:75 and routes/circle.ts:37 → 500 on 36-char junk. One shared `isUuid` (canonical 8-4-4-4-12 hex) in a small server util; 400 `bad_caravan` / 404 as each route's convention says.
S2. [closed] `hasAccess` trusts caller-supplied `regionId`. Take `(accountId, caravanId)` and read region + ownership from the caravan row in the same query; test that a mismatched triple is refused.
S3. [closed] Storage backstop: CHECK for `unlock_node_purchased` `cost > 0` and non-empty string `nodeId` (migration 005 or a new 006); test as app role.

## Nits
N1. [closed] `GET /me/unlocks` reads points and purchases outside one transaction; wrap in a read transaction.
N2. [closed] `maximalReachableSets` uses `localeCompare`; use code-point compare.
N3. [closed] Note in the 005 comment that the index does not imply web validity.
N4. [closed] Add tests: two different nodes racing with points for one; two caravans of one account with the coalesce index; malformed uuid.

## Closure notes (Maker, round 1)

- **D1** `TUNABLES.UNLOCK_NODE_COST_BY_TIER` is `{ living, trap, siege }`, each a tier-indexed
  curve; `nodeCost(web, node)` reads the web's pool's curve (signature change — the only
  callers were content, `unlocks/spend.ts`, `unlocks/view.ts` and the tests). New pure
  helpers: `costCurveFor(pool)`, `pointsPerPoolAtLadderCap()`, `closureCost(web, nodeId)`
  (a node's cost plus every transitive prerequisite's, each counted once).
  `validateUnlockWebs` now checks each pool's curve (tier 0 = 0, strictly increasing
  integers) AND that every node's closure cost ≤ the capped ladder's points, so "most but
  not all" can never silently become "some nodes, never". `publicUnlockWebs().costByTier`
  is the per-pool record. Content test asserts the exact curves, first paid tier = 1, paid
  totals 39/39/38 (cap reaches 76.9% / 76.9% / 78.9%), every node reachable at cap, more
  than one maximal set at cap, and that validation rejects a web whose chain outruns the cap.
- **S1** `apps/server/src/util/uuid.ts` → `isUuid`. Used by `parseSpendRequest` (400
  `bad_caravan`), `routes/circle.ts` `ownCaravan` (404 `no_caravan`, the one regex line plus
  its import) and `unlocks/access.ts` (a non-uuid owner id resolves to no owner). Tests: 12
  malformed spend bodies are all 400 with the right code; the three 36-character
  non-uuids on the circle route are 404.
- **S2** `AccessOwner` is `{ accountId, caravanId, regionId? }`; `readOwnerSnapshot` reads
  `caravan.region_id` under `WHERE id = $1 AND account_id = $2` and the three purchase
  lists in ONE query. No row (another account's caravan, no such caravan, non-uuid) or a
  caller `regionId` that disagrees with the row → `null` → `hasAccess` false,
  `unlockedTypeIds` empty, `accessCheckFor` always false: a mismatched triple gets
  nothing, not even starters. `regionId` is kept optional so chunk 07's `ownerOf(caravan)`
  triple (always consistent) compiles unchanged; it is never the authority.
- **S3** Migration `006_unlock_node_purchase_shape`: CHECK `cost` is a JSON number > 0
  (via CASE so a non-number is a check violation, never a cast error) and `nodeId` is a
  non-empty JSON string. Tested as the app role through `appendEvents`: cost 0 / −1 / "1",
  missing / empty / numeric / null `nodeId` all 23514, and a well-formed purchase from the
  same role still lands. Migration 005's comment (N3) now says what the index does not
  guarantee (web membership, prerequisites, tier/cost agreement — the spend service's job);
  a regression test documents that a crafted out-of-region purchase charges points and
  grants nothing.
- **N1** `unlockWebsSnapshot(pool, accountId)` runs `unlockWebsForAccount` inside
  `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`; the route uses it (a source assertion
  keeps it that way).
- **N2** `compareCodePoints` (exported) replaces `localeCompare`; test asserts order and
  that `"a" > "B"` by code point.
- **N4** Tests: two different nodes racing on one point (one 201, one 200 replay, two 409
  `insufficient_points`, spent = 1, one ledger row); a spend racing a grant (spent ≤
  granted); two caravans of one account (per-caravan living web and once-per-node index,
  shared account trap web, view lists both); malformed uuids (S1). The reviewer's remaining
  probes are regressions too: replay body identical except `created`; `accessCheckFor` is a
  snapshot per call; `affordable` false with points but missing prerequisites; the public
  web carries no account data.

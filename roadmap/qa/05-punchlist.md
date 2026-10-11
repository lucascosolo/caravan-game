# Chunk 05 — QA punch list (merge e34a23b / 65c5f72)

No blockers.

## Decision (orchestrator)
D1. **Per-pool cost curve adopted** so a capped ladder (30 points) reaches ~77–79% of each web's paid total: `UNLOCK_NODE_COST_BY_TIER` becomes `Record<UnlockPool, number[]>` = living `[0,1,4,8,14]` (paid total 39), trap `[0,1,3,7,10]` (39), siege `[0,1,8,15,21]` (38). Tier 0 untouched; first paid node still 1 point; every root-to-node path ≤ 30 so every node stays reachable at cap. Update `validateUnlockWebs`, `publicUnlockWebs().costByTier`, and the content test. Record in the chunk file.

## Should-fix
S1. Lax UUID regex in unlocks/spend.ts:75 and routes/circle.ts:37 → 500 on 36-char junk. One shared `isUuid` (canonical 8-4-4-4-12 hex) in a small server util; 400 `bad_caravan` / 404 as each route's convention says.
S2. `hasAccess` trusts caller-supplied `regionId`. Take `(accountId, caravanId)` and read region + ownership from the caravan row in the same query; test that a mismatched triple is refused.
S3. Storage backstop: CHECK for `unlock_node_purchased` `cost > 0` and non-empty string `nodeId` (migration 005 or a new 006); test as app role.

## Nits
N1. `GET /me/unlocks` reads points and purchases outside one transaction; wrap in a read transaction.
N2. `maximalReachableSets` uses `localeCompare`; use code-point compare.
N3. Note in the 005 comment that the index does not imply web validity.
N4. Add tests: two different nodes racing with points for one; two caravans of one account with the coalesce index; malformed uuid.

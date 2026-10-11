/**
 * hasAccess — THE single source of truth for "does this type exist for this player"
 * (GUARDRAILS §3). Every other system (the wagon circle's pack and placement checks now;
 * acquisition in chunk 18; the standing party in chunk 09) asks this module and nothing
 * else decides access.
 *
 * Reached nodes are read from the ledger (`unlock_node_purchased` events) plus the web's
 * free starting nodes. There is no cache and no projection table: the ledger is append-only,
 * so what was reached can only grow — access, once granted, is never revoked.
 *
 * Scope (GUARDRAILS §5): the living web is read on the CARAVAN (events carry its caravan
 * id, and the web is the caravan's region's); the trap and siege webs are read on the
 * ACCOUNT (events carry no caravan id). An owner is the (account, caravan) pair; the
 * caravan's REGION and its OWNERSHIP are read from the caravan row itself, in the same
 * query as the purchases (QA-05 S2) — nothing the caller says about the region is trusted.
 * A caravan that is not the account's, or a caller-supplied region that disagrees with
 * the row, resolves to no owner at all, and no owner has access to anything.
 */
import { isRegionId, reachedSet, unlockWebFor, webForTypeId, type RegionId, type UnlockPool, type UnlockWeb } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import { isUuid } from "../util/uuid.js";

export interface AccessOwner {
  readonly accountId: string;
  readonly caravanId: string;
  /**
   * Optional and never the authority: the caravan row's region decides. If a caller passes
   * a region that disagrees with the row, the owner is refused outright (QA-05 S2).
   */
  readonly regionId?: RegionId;
}

/** `(typeId) => boolean`, bound to one owner's reached set. The circle package's AccessCheck. */
export type AccessPredicate = (typeId: string) => boolean;

/** Where a pool's web is read for an owner: the caravan row for living, the account for the rest. */
export function scopeOf(pool: UnlockPool, owner: { accountId: string; caravanId?: string | null }): { accountId: string; caravanId: string | null } {
  if (pool === "living") {
    if (!owner.caravanId) throw new TypeError("the living web is caravan-scoped; an owner with no caravan has no living web");
    return { accountId: owner.accountId, caravanId: owner.caravanId };
  }
  return { accountId: owner.accountId, caravanId: null };
}

/**
 * Node ids this scope has PURCHASED (not the free starting nodes), in purchase order.
 * Reads the ledger directly: no other table claims to know. The spend and view services
 * call this with a caravan they have already resolved as the caller's.
 */
export async function purchasedNodeIds(db: Queryable, pool: UnlockPool, owner: { accountId: string; caravanId?: string | null }): Promise<string[]> {
  const scope = scopeOf(pool, owner);
  const res = await db.query<{ node_id: string }>(
    `SELECT payload->>'nodeId' AS node_id
     FROM ledger_event
     WHERE event_type = 'unlock_node_purchased'
       AND payload->>'pool' = $1
       AND account_id = $2
       AND coalesce(caravan_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY seq`,
    [pool, scope.accountId, scope.caravanId],
  );
  return res.rows.map((r) => r.node_id);
}

/** One consistent read of everything access depends on: the caravan's region and the three purchase lists. */
export interface OwnerSnapshot {
  readonly accountId: string;
  readonly caravanId: string;
  readonly regionId: RegionId;
  readonly purchased: Readonly<Record<UnlockPool, readonly string[]>>;
}

/**
 * Resolve an owner against the caravan row and read its purchases in ONE query, so the
 * region, the ownership and the reached sets are a single snapshot. `null` when the pair
 * is not an owner: the ids are not uuids, the caravan does not exist, it belongs to another
 * account, or the caller's region disagrees with the row.
 */
export async function readOwnerSnapshot(db: Queryable, owner: AccessOwner): Promise<OwnerSnapshot | null> {
  if (!isUuid(owner.caravanId) || !isUuid(owner.accountId)) return null;
  const purchases = (poolSql: string, caravanSql: string) =>
    `(SELECT coalesce(array_agg(e.payload->>'nodeId' ORDER BY e.seq), '{}'::text[])
        FROM ledger_event e
       WHERE e.event_type = 'unlock_node_purchased'
         AND e.account_id = c.account_id
         AND e.payload->>'pool' = '${poolSql}'
         AND ${caravanSql})`;
  const res = await db.query<{ region_id: string; living: string[]; trap: string[]; siege: string[] }>(
    `SELECT c.region_id,
            ${purchases("living", "e.caravan_id = c.id")} AS living,
            ${purchases("trap", "e.caravan_id IS NULL")} AS trap,
            ${purchases("siege", "e.caravan_id IS NULL")} AS siege
       FROM caravan c
      WHERE c.id = $1 AND c.account_id = $2`,
    [owner.caravanId, owner.accountId],
  );
  const row = res.rows[0];
  if (!row || !isRegionId(row.region_id)) return null;
  if (owner.regionId !== undefined && owner.regionId !== row.region_id) return null;
  return { accountId: owner.accountId, caravanId: owner.caravanId, regionId: row.region_id, purchased: { living: row.living, trap: row.trap, siege: row.siege } };
}

/** Every node reached in one pool's web for this owner: starting nodes plus purchases. Empty for a refused owner. */
export async function reachedNodeIds(db: Queryable, pool: UnlockPool, owner: AccessOwner): Promise<ReadonlySet<string>> {
  const snap = await readOwnerSnapshot(db, owner);
  if (!snap) return new Set();
  return reachedSet(unlockWebFor(pool, snap.regionId), snap.purchased[pool]);
}

/** The web that governs a type for a caravan in `regionId`, or undefined if no web of theirs contains it. */
export function webForOwnerType(owner: { regionId: RegionId }, typeId: string): { web: UnlockWeb; pool: UnlockPool } | undefined {
  const hit = webForTypeId(typeId);
  if (!hit) return undefined;
  // A living type in another region's web is not in THIS caravan's web at all.
  if (hit.web.pool === "living" && hit.web.regionId !== owner.regionId) return undefined;
  return { web: hit.web, pool: hit.web.pool };
}

function reachedFromSnapshot(snap: OwnerSnapshot): ReadonlySet<string> {
  const out = new Set<string>();
  for (const pool of ["living", "trap", "siege"] as const) for (const id of reachedSet(unlockWebFor(pool, snap.regionId), snap.purchased[pool])) out.add(id);
  return out;
}

/**
 * The predicate. A type nobody's web contains, a living type from another region, a node
 * not yet reached, and an owner pair that does not resolve are all simply `false` — there
 * is no "almost".
 */
export async function hasAccess(db: Queryable, owner: AccessOwner, typeId: string): Promise<boolean> {
  const snap = await readOwnerSnapshot(db, owner);
  if (!snap) return false;
  const governed = webForOwnerType(snap, typeId);
  if (!governed) return false;
  return reachedSet(governed.web, snap.purchased[governed.pool]).has(typeId);
}

/** Every type id this owner has access to, across all three webs. Empty for a refused owner. */
export async function unlockedTypeIds(db: Queryable, owner: AccessOwner): Promise<ReadonlySet<string>> {
  const snap = await readOwnerSnapshot(db, owner);
  return snap ? reachedFromSnapshot(snap) : new Set();
}

/**
 * Bind an owner once (one read of the caravan row and the three webs) and get a
 * synchronous predicate for a validation pass. The set is a snapshot at the moment of the
 * read; take it inside the transaction that uses it.
 */
export async function accessCheckFor(db: Queryable, owner: AccessOwner): Promise<AccessPredicate> {
  const set = await unlockedTypeIds(db, owner);
  return (typeId) => set.has(typeId);
}

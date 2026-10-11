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
 * ACCOUNT (events carry no caravan id). An owner is always the full triple so the split is
 * decided here, once.
 */
import { reachedSet, unlockWebFor, webForTypeId, type RegionId, type UnlockPool, type UnlockWeb } from "@caravan/content";
import type { Queryable } from "../db/pool.js";

export interface AccessOwner {
  readonly accountId: string;
  readonly caravanId: string;
  readonly regionId: RegionId;
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
 * Reads the ledger directly: no other table claims to know.
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

/** Every node reached in one pool's web for this owner: starting nodes plus purchases. */
export async function reachedNodeIds(db: Queryable, pool: UnlockPool, owner: AccessOwner): Promise<ReadonlySet<string>> {
  const web = unlockWebFor(pool, owner.regionId);
  return reachedSet(web, await purchasedNodeIds(db, pool, owner));
}

/** The web that governs a type for this owner, or undefined if no web of theirs contains it. */
export function webForOwnerType(owner: AccessOwner, typeId: string): { web: UnlockWeb; pool: UnlockPool } | undefined {
  const hit = webForTypeId(typeId);
  if (!hit) return undefined;
  // A living type in another region's web is not in THIS caravan's web at all.
  if (hit.web.pool === "living" && hit.web.regionId !== owner.regionId) return undefined;
  return { web: hit.web, pool: hit.web.pool };
}

/**
 * The predicate. A type nobody's web contains, a living type from another region, and a
 * node not yet reached are all simply `false` — there is no "almost".
 */
export async function hasAccess(db: Queryable, owner: AccessOwner, typeId: string): Promise<boolean> {
  const governed = webForOwnerType(owner, typeId);
  if (!governed) return false;
  const reached = await reachedNodeIds(db, governed.pool, owner);
  return reached.has(typeId);
}

/** Every type id this owner has access to, across all three webs. */
export async function unlockedTypeIds(db: Queryable, owner: AccessOwner): Promise<ReadonlySet<string>> {
  const [living, trap, siege] = await Promise.all([reachedNodeIds(db, "living", owner), reachedNodeIds(db, "trap", owner), reachedNodeIds(db, "siege", owner)]);
  return new Set<string>([...living, ...trap, ...siege]);
}

/**
 * Bind an owner once (one read of the three webs) and get a synchronous predicate for a
 * validation pass. The set is a snapshot at the moment of the read; take it inside the
 * transaction that uses it.
 */
export async function accessCheckFor(db: Queryable, owner: AccessOwner): Promise<AccessPredicate> {
  const set = await unlockedTypeIds(db, owner);
  return (typeId) => set.has(typeId);
}

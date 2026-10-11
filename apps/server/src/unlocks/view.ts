/**
 * Read models for the unlock webs (GUARDRAILS §4 — legibility): the whole web, every node's
 * exact cost, and whether the player can reach it right now. Nothing is hidden; a node the
 * player cannot afford or cannot reach yet is in the list with the reason.
 */
import { TUNABLES, UNLOCK_WEBS, evaluateWeb, isStartingNode, nodeCost, pointsPerPoolAtLadderCap, type UnlockNodeView, type UnlockPool, type UnlockWeb } from "@caravan/content";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import type { PoolProgressRow } from "../db/types.js";
import { listCaravansForAccount } from "../repo/caravans.js";
import { listPoolProgressForAccount } from "../repo/poolProgress.js";
import { purchasedNodeIds } from "./access.js";
import { pointsOf, type UnlockPoints } from "./spend.js";

export interface UnlockWebView {
  readonly id: string;
  readonly pool: UnlockPool;
  readonly scope: "account" | "caravan";
  readonly regionId: string | null;
  readonly accountId: string;
  readonly caravanId: string | null;
  readonly points: UnlockPoints;
  readonly nodes: readonly UnlockNodeView[];
}

/** The authored webs, every region, with costs — public data, the same for every player. */
export function publicUnlockWebs() {
  return {
    /** Per pool (QA-05 D1): `{ living, trap, siege }`, each indexed by tier. */
    costByTier: TUNABLES.UNLOCK_NODE_COST_BY_TIER,
    tiers: TUNABLES.UNLOCK_WEB_TIERS,
    startingNodes: TUNABLES.STARTING_NODES,
    pointsPerPoolAtLadderCap: pointsPerPoolAtLadderCap(),
    webs: UNLOCK_WEBS.map((w) => ({
      id: w.id,
      pool: w.pool,
      scope: w.pool === "living" ? "caravan" : "account",
      regionId: w.regionId,
      nodes: w.nodes.map((n) => ({ id: n.id, tier: n.tier, cost: nodeCost(w, n), requires: n.requires, starting: isStartingNode(n) })),
    })),
  };
}

async function viewFor(db: Queryable, web: UnlockWeb, progress: PoolProgressRow, accountId: string, caravanId: string | null): Promise<UnlockWebView> {
  const points = pointsOf(progress);
  const purchased = await purchasedNodeIds(db, web.pool, { accountId, caravanId });
  return {
    id: web.id,
    pool: web.pool,
    scope: web.pool === "living" ? "caravan" : "account",
    regionId: web.regionId,
    accountId,
    caravanId,
    points,
    nodes: evaluateWeb(web, purchased, points.available),
  };
}

/**
 * The player's own webs: trap and siege on the account, and the living web of each caravan
 * (its region's). Listed in that order, caravans by creation.
 *
 * Points and purchases are several statements; the caller runs this inside ONE read-only
 * transaction (`unlockWebsSnapshot`) so a spend landing mid-read cannot show points that
 * disagree with the reached set (QA-05 N1).
 */
export async function unlockWebsForAccount(db: Queryable, accountId: string): Promise<UnlockWebView[]> {
  const progress = await listPoolProgressForAccount(db, accountId);
  const caravans = await listCaravansForAccount(db, accountId);
  const out: UnlockWebView[] = [];
  for (const pool of ["trap", "siege"] as const) {
    const row = progress.find((p) => p.pool === pool && p.account_id === accountId);
    if (!row) throw new Error(`account ${accountId} has no ${pool} pool_progress row`);
    out.push(await viewFor(db, UNLOCK_WEBS.find((w) => w.pool === pool)!, row, accountId, null));
  }
  for (const caravan of caravans) {
    const row = progress.find((p) => p.pool === "living" && p.caravan_id === caravan.id);
    if (!row) throw new Error(`caravan ${caravan.id} has no living pool_progress row`);
    out.push(await viewFor(db, UNLOCK_WEBS.find((w) => w.pool === "living" && w.regionId === caravan.region_id)!, row, accountId, caravan.id));
  }
  return out;
}

/**
 * `unlockWebsForAccount` as one consistent snapshot: a READ ONLY, REPEATABLE READ
 * transaction, so every statement sees the same committed state and nothing here can write.
 */
export async function unlockWebsSnapshot(pool: pg.Pool, accountId: string): Promise<UnlockWebView[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const webs = await unlockWebsForAccount(client, accountId);
    await client.query("COMMIT");
    return webs;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

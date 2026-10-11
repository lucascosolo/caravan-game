/**
 * Read models for the unlock webs (GUARDRAILS §4 — legibility): the whole web, every node's
 * exact cost, and whether the player can reach it right now. Nothing is hidden; a node the
 * player cannot afford or cannot reach yet is in the list with the reason.
 */
import { TUNABLES, UNLOCK_WEBS, evaluateWeb, isStartingNode, nodeCost, type UnlockNodeView, type UnlockPool, type UnlockWeb } from "@caravan/content";
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
    costByTier: TUNABLES.UNLOCK_NODE_COST_BY_TIER,
    tiers: TUNABLES.UNLOCK_WEB_TIERS,
    startingNodes: TUNABLES.STARTING_NODES,
    pointsPerPoolAtLadderCap: TUNABLES.UNLOCK_POINTS_BY_RUNG.reduce((a, b) => a + b, 0),
    webs: UNLOCK_WEBS.map((w) => ({
      id: w.id,
      pool: w.pool,
      scope: w.pool === "living" ? "caravan" : "account",
      regionId: w.regionId,
      nodes: w.nodes.map((n) => ({ id: n.id, tier: n.tier, cost: nodeCost(n), requires: n.requires, starting: isStartingNode(n) })),
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

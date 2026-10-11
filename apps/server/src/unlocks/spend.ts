/**
 * Spending granted unlock points to reach a node. The only way a node is ever reached
 * after creation, and the only writer of `unlock_node_purchased`.
 *
 * Reaching a node grants ACCESS. It creates no instance, touches no roster, no Coin, no
 * ladder: the one event it appends is folded by chunk 02's projection into
 * pool_progress.unlock_points_spent and nothing else. Points are never granted here —
 * chunk 04's rung crossings are the only source — and never refunded.
 *
 * Validation is server-side and complete (GUARDRAILS §3): the node must be in THIS owner's
 * web for the named pool (so a unit from another region, a trap named under the siege
 * pool, or a type nobody has is refused by name), every prerequisite must be reached,
 * the cost must fit the points available, and the scope must match the pool (a caravan for
 * living, none for trap/siege). All of it runs under the account's append lock, so two
 * concurrent spends for one owner serialize; the storage-level once-per-node index
 * (migration 005) is the backstop.
 *
 * Idempotent under retries: the causation id is `unlock:<pool>:<scope id>:<node id>`, and a
 * request for a node already reached returns the reached state with `created: false` and
 * appends nothing — the same answer however many times the client resends.
 */
import { checkSpend, evaluateWeb, findUnlockNode, isUnlockPool, nodeCost, unlockWebFor, type UnlockNodeView, type UnlockPool, type UnlockWeb } from "@caravan/content";
import type pg from "pg";
import type { PoolProgressRow } from "../db/types.js";
import { appendEvents, lockAccountForAppend } from "../ledger/ledger.js";
import { findCaravanById } from "../repo/caravans.js";
import { getAccountPoolProgress, getCaravanPoolProgress } from "../repo/poolProgress.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { isUuid } from "../util/uuid.js";
import { purchasedNodeIds, scopeOf } from "./access.js";

export interface SpendRequest {
  readonly pool: UnlockPool;
  readonly nodeId: string;
  /** Required for the living pool (the caravan whose web it is); must be absent for trap/siege. */
  readonly caravanId?: string | null;
}

export interface UnlockPoints {
  readonly granted: number;
  readonly spent: number;
  readonly available: number;
}

export interface SpendResult {
  /** True when this call appended the purchase; false when the node was already reached. */
  readonly created: boolean;
  readonly webId: string;
  readonly pool: UnlockPool;
  readonly scope: "account" | "caravan";
  readonly accountId: string;
  readonly caravanId: string | null;
  readonly node: UnlockNodeView;
  readonly points: UnlockPoints;
  /** Every node of the web after the spend, so the client can redraw without a second read. */
  readonly nodes: readonly UnlockNodeView[];
}

export const notFound = (code: string, message: string) => new AppError(404, code, message);

export function unlockCausationId(pool: UnlockPool, scopeId: string, nodeId: string): string {
  return `unlock:${pool}:${scopeId}:${nodeId}`;
}

export function pointsOf(row: PoolProgressRow): UnlockPoints {
  return { granted: row.unlock_points_granted, spent: row.unlock_points_spent, available: row.unlock_points_granted - row.unlock_points_spent };
}

/** Parse an HTTP body into a SpendRequest, refusing anything malformed before it reaches the service. */
export function parseSpendRequest(body: unknown): SpendRequest {
  if (body === null || typeof body !== "object") throw badRequest("bad_body", "expected a JSON object");
  const b = body as Record<string, unknown>;
  if (!isUnlockPool(b["pool"])) throw badRequest("bad_pool", "pool must be one of living, trap, siege");
  if (typeof b["nodeId"] !== "string" || b["nodeId"].length === 0 || b["nodeId"].length > 100) throw badRequest("bad_node", "nodeId must be a type id");
  const caravanId = b["caravanId"];
  // Canonical uuid only (QA-05 S1): anything else is a 400 here, never a cast error in the database.
  if (caravanId !== undefined && caravanId !== null && !isUuid(caravanId)) throw badRequest("bad_caravan", "caravanId must be a uuid");
  return { pool: b["pool"], nodeId: b["nodeId"], caravanId: (caravanId as string | null | undefined) ?? null };
}

interface ResolvedScope {
  web: UnlockWeb;
  scope: "account" | "caravan";
  scopeId: string;
  caravanId: string | null;
  readProgress: () => Promise<PoolProgressRow>;
}

async function resolveScope(client: pg.PoolClient, accountId: string, req: SpendRequest): Promise<ResolvedScope> {
  if (req.pool === "living") {
    if (!req.caravanId) throw badRequest("caravan_required", "the living web is caravan-scoped: name the caravan");
    const caravan = await findCaravanById(client, req.caravanId);
    // Not the caller's caravan: a 404, never a hint that it exists (same rule as the circle routes).
    if (!caravan || caravan.account_id !== accountId) throw notFound("no_caravan", "caravan not found");
    return {
      web: unlockWebFor("living", caravan.region_id),
      scope: "caravan",
      scopeId: caravan.id,
      caravanId: caravan.id,
      readProgress: async () => {
        const row = await getCaravanPoolProgress(client, caravan.id);
        if (!row) throw new Error(`caravan ${caravan.id} has no living pool_progress row`);
        return row;
      },
    };
  }
  if (req.caravanId) throw badRequest("wrong_scope", `the ${req.pool} web is account-level: do not name a caravan`);
  const pool = req.pool;
  return {
    web: unlockWebFor(pool),
    scope: "account",
    scopeId: accountId,
    caravanId: null,
    readProgress: async () => {
      const row = await getAccountPoolProgress(client, accountId, pool);
      if (!row) throw new Error(`account ${accountId} has no ${pool} pool_progress row`);
      return row;
    },
  };
}

/**
 * Reach a node for the caller. Runs inside the caller's transaction; takes the account
 * append lock before reading anything so the read-check-append sequence is serialized
 * against every other writer for this account (chunk 04's grants included).
 */
export async function spendUnlockPoints(client: pg.PoolClient, accountId: string, req: SpendRequest): Promise<SpendResult> {
  if (!isUnlockPool(req.pool)) throw badRequest("bad_pool", "pool must be one of living, trap, siege");
  await lockAccountForAppend(client, accountId);
  const resolved = await resolveScope(client, accountId, req);
  const { web } = resolved;

  const node = findUnlockNode(web, req.nodeId);
  if (!node) throw badRequest("node_not_in_web", `'${req.nodeId}' is not a node of the ${web.id} web`);

  const purchased = await purchasedNodeIds(client, req.pool, { accountId, caravanId: resolved.caravanId });
  const progress = await resolved.readProgress();
  const points = pointsOf(progress);
  const check = checkSpend(web, purchased, points.available, node.id);

  const result = (created: boolean, pts: UnlockPoints, nowPurchased: readonly string[]): SpendResult => {
    const nodes = evaluateWeb(web, nowPurchased, pts.available);
    return {
      created,
      webId: web.id,
      pool: req.pool,
      scope: resolved.scope,
      accountId,
      caravanId: resolved.caravanId,
      node: nodes.find((n) => n.id === node.id)!,
      points: pts,
      nodes,
    };
  };

  if (!check.ok) {
    switch (check.reason) {
      case "already_reached":
        // Idempotent: a starting node or an earlier purchase. Nothing to append.
        return result(false, points, purchased);
      case "prerequisites_unmet":
        throw conflict("prerequisites_unmet", `'${node.id}' requires ${check.missing!.map((m) => `'${m}'`).join(", ")} first`);
      case "insufficient_points":
        throw conflict("insufficient_points", `'${node.id}' costs ${check.cost} unlock points; ${points.available} available`);
      case "unknown_node":
        throw badRequest("node_not_in_web", `'${req.nodeId}' is not a node of the ${web.id} web`);
    }
  }

  const cost = nodeCost(web, node);
  const scope = scopeOf(req.pool, { accountId, caravanId: resolved.caravanId });
  await appendEvents(client, unlockCausationId(req.pool, resolved.scopeId, node.id), [
    {
      type: "unlock_node_purchased",
      accountId,
      caravanId: scope.caravanId,
      payload: { pool: req.pool, nodeId: node.id, cost, tier: node.tier },
    },
  ]);
  // Re-read: the projection trigger moved unlock_points_spent; the CHECK spent <= granted is the floor.
  const after = pointsOf(await resolved.readProgress());
  return result(true, after, [...purchased, node.id]);
}

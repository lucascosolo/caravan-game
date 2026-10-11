/**
 * Mercenary recruit (chunk 18): the Coin, guaranteed, exact-pick path to a level-1 unit.
 *
 * Pick a type, pay MERCENARY_COST_BASE through `spendCoin` (the only debit path), get one
 * level-1 instance of exactly that type. No randomness anywhere. ALWAYS available for every
 * unlocked type: no cooldown, no daily limit, no per-type restriction, no scaling in MVP —
 * this is the safety valve that makes the refugee drip's randomness acceptable. The only
 * refusals are the unlock web (`not_unlocked`: the type is not in this caravan's reached
 * set — a locked node, another region's unit, a type nobody has), Coin
 * (`insufficient_coin`) and the storage guard (`inventory_full`), and none of them is a
 * rate limit.
 *
 * Coin buys pace and certainty, never access (GUARDRAILS §3): the price list shows locked
 * types too, so the player can see what the web still holds, but they are not for sale at
 * any price — `grantUnit` re-checks `hasAccess` at the boundary on every purchase.
 *
 * Idempotency: a client may send a `requestId` (uuid); the causation id is then
 * `recruit:<caravan>:<request id>` and a retry returns the stored outcome without a
 * second charge. Without one, every call is a new purchase (buying the same type twice in
 * a row is legitimate — there is no cooldown), under a fresh causation id.
 */
import { randomUUID } from "node:crypto";
import { TUNABLES, unitsForRegion } from "@caravan/content";
import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import type { UnitInstanceRow } from "../db/types.js";
import { spendCoin } from "../economy/coin.js";
import { peekTrickle } from "../economy/trickle.js";
import type { LedgerEventRow } from "../ledger/events.js";
import { listEventsByCausation, lockAccountForAppend } from "../ledger/ledger.js";
import { conflict } from "../services/errors.js";
import { reachedNodeIds } from "../unlocks/access.js";
import {
  grantUnit,
  normalizeCaravanId,
  normalizeRequestId,
  normalizeUnitTypeId,
  readInventory,
  readOwnedCaravan,
  summarizeUnit,
  type InventoryStatus,
  type UnitAcquiredPayload,
  type UnitTypeSummary,
} from "./grant.js";

/** The cost of one level-1 mercenary of any unlocked type. MERCENARY_COST_SCALING is "none": flat. */
export function mercenaryCost(): number {
  return TUNABLES.MERCENARY_COST_BASE;
}

export interface RecruitOffer extends UnitTypeSummary {
  cost: number;
  affordable: boolean;
}

export interface RecruitView {
  caravanId: string;
  costBase: number;
  scaling: string;
  /** Every type this caravan can recruit right now, each at `cost`. Always the whole unlocked pool. */
  recruitable: RecruitOffer[];
  /** Types in this region's web the caravan has NOT reached. Shown, never sold: reach them in the web. */
  locked: UnitTypeSummary[];
  /** Ledger balance plus the pending trickle — what a purchase right now is checked against. */
  balance: number;
  pendingTrickle: number;
  inventory: InventoryStatus;
  availability: { cooldown: null; dailyLimit: null };
}

/** GET: the price list. Read-only. */
export async function viewRecruit(db: pg.Pool, input: { accountId: string; caravanId: string; nowMs?: number }): Promise<RecruitView> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const nowMs = input.nowMs ?? Date.now();
  const owner = await readOwnedCaravan(db, input.accountId, caravanId, false);
  const reached = await reachedNodeIds(db, "living", owner);
  const trickle = await peekTrickle(db, input.accountId, nowMs);
  const cost = mercenaryCost();
  const region = [...unitsForRegion(owner.regionId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    caravanId,
    costBase: TUNABLES.MERCENARY_COST_BASE,
    scaling: TUNABLES.MERCENARY_COST_SCALING,
    recruitable: region.filter((u) => reached.has(u.id)).map((u) => ({ ...summarizeUnit(u), cost, affordable: trickle.balance >= cost })),
    locked: region.filter((u) => !reached.has(u.id)).map(summarizeUnit),
    balance: trickle.balance,
    pendingTrickle: trickle.pending,
    inventory: await readInventory(db, caravanId),
    availability: { cooldown: null, dailyLimit: null },
  };
}

export interface RecruitResult {
  /** True when `requestId` named a purchase that had already committed: the stored outcome, no charge. */
  replayed: boolean;
  acquired: UnitAcquiredPayload;
  /** The instance, or null on a replay whose instance has since been merged away or lost. */
  instance: UnitInstanceRow | null;
  coinCost: number;
  events: LedgerEventRow[];
  balanceAfter: number;
  inventory: InventoryStatus;
}

export function recruitCausationId(caravanId: string, requestId: string): string {
  return `recruit:${caravanId}:${requestId}`;
}

export async function recruitMercenary(
  pool: pg.Pool,
  input: { accountId: string; caravanId: string; unitTypeId: unknown; requestId?: unknown; nowMs?: number },
): Promise<RecruitResult> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const unitTypeId = normalizeUnitTypeId(input.unitTypeId);
  const requestId = normalizeRequestId(input.requestId);
  const nowMs = input.nowMs ?? Date.now();
  const cost = mercenaryCost();
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, true);
    if (requestId !== undefined) {
      const causationId = recruitCausationId(caravanId, requestId);
      const events = await listEventsByCausation(client, causationId);
      const hit = events.find((e) => e.event_type === "unit_acquired");
      if (hit) {
        const acquired = hit.payload as UnitAcquiredPayload;
        if (acquired.unitTypeId !== unitTypeId) {
          throw conflict("request_id_reused", `requestId ${requestId} already bought a '${acquired.unitTypeId}'; use a new requestId for a new purchase`);
        }
        const trickle = await peekTrickle(client, input.accountId, nowMs);
        const res = await client.query<UnitInstanceRow>("SELECT * FROM unit_instance WHERE id = $1 AND caravan_id = $2", [acquired.instanceId, caravanId]);
        return {
          replayed: true,
          acquired,
          instance: res.rows[0] ?? null,
          coinCost: acquired.coinCost,
          events,
          balanceAfter: trickle.balance,
          inventory: await readInventory(client, caravanId),
        };
      }
    }
    const causationId = recruitCausationId(caravanId, requestId ?? randomUUID());
    // Access and the storage guard first (nothing is charged for a refused grant), then the debit
    // and the `unit_acquired` event in one batch: no instance without its event, no charge
    // without its instance.
    const grant = await grantUnit(client, owner, unitTypeId, "mercenary", cost, requestId !== undefined ? { requestId } : {});
    const spend = await spendCoin(client, input.accountId, cost, "mercenary_recruit", nowMs, {
      causationId,
      extra: { caravanId, unitTypeId: grant.unit.id, instanceId: grant.instance.id },
      alongside: [grant.draft],
    });
    return {
      replayed: false,
      acquired: grant.payload,
      instance: grant.instance,
      coinCost: cost,
      events: spend.events,
      balanceAfter: spend.balanceAfter,
      inventory: await readInventory(client, caravanId),
    };
  });
}

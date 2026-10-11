/**
 * Chunk 24 QA D1 — the starting roster (PHASE-2 §24 "pre-filled from the starting roster").
 *
 * EVERY caravan is granted TUNABLES.STARTING_ROSTER at creation, in the creation
 * transaction, by `createCaravanForAccount` (so registration, a guest account's caravan and
 * a future second caravan all get it the same way — it is a rule of the game, not a
 * tutorial gift; no route grants it). Each instance goes through `grantUnit`, the one
 * acquisition boundary: the access check (`hasAccess`) runs before the INSERT, the instance
 * is level 1, and one `unit_acquired` event (source "starting_roster", coinCost 0) is
 * appended per instance under one causation id. The types are the region's STARTING living
 * nodes only (tier 0, reached free by every caravan), so the grant cannot widen access
 * (GUARDRAILS §3), and it moves no Coin and grants no unlock point.
 *
 * Existing caravans are NOT backfilled: a caravan created before this rule has already
 * played (or been seeded) under the old one, and a retroactive grant would be a gift to
 * some accounts and not others mid-flight (e.g. a caravan out on a trip).
 */
import { TUNABLES, startingNodeIds, unlockWebFor, type RegionId } from "@caravan/content";
import type pg from "pg";
import { appendEvents, lockAccountForAppend } from "../ledger/ledger.js";
import type { LedgerEventDraft } from "../ledger/events.js";
import { grantUnit } from "./grant.js";

/** The causation id of a caravan's starting-roster grant: one per caravan, ever. */
export function startingRosterCause(caravanId: string): string {
  return `starting_roster:${caravanId}`;
}

/** The type ids a caravan of `regionId` is granted at creation, in order (pure; one entry per instance). */
export function startingRosterTypes(regionId: RegionId): string[] {
  const copies = TUNABLES.STARTING_ROSTER.copiesPerStarterType;
  if (!Number.isSafeInteger(copies) || copies < 0) throw new RangeError("STARTING_ROSTER.copiesPerStarterType must be a non-negative integer");
  const starters = [...startingNodeIds(unlockWebFor("living", regionId))].sort();
  const out: string[] = [];
  for (const typeId of starters) for (let i = 0; i < copies; i++) out.push(typeId);
  return out;
}

/** Grant the starting roster to a caravan created in this transaction. Returns the new instance ids. */
export async function grantStartingRoster(
  client: pg.PoolClient,
  owner: { accountId: string; caravanId: string; regionId: RegionId },
): Promise<string[]> {
  const types = startingRosterTypes(owner.regionId);
  if (types.length === 0) return [];
  await lockAccountForAppend(client, owner.accountId);
  const drafts: LedgerEventDraft[] = [];
  const ids: string[] = [];
  for (const typeId of types) {
    const g = await grantUnit(client, owner, typeId, "starting_roster", 0);
    drafts.push(g.draft);
    ids.push(g.instance.id);
  }
  await appendEvents(client, startingRosterCause(owner.caravanId), drafts);
  return ids;
}

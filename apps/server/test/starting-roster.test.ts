/**
 * Chunk 24 QA D1 — the starting roster (PHASE-2 §24). EVERY player caravan is granted
 * TUNABLES.STARTING_ROSTER at creation, in the creation path (`createCaravanForAccount`, not a
 * route), through the ordinary acquisition grant: one level-1 instance per entry, one
 * `unit_acquired` event each (source "starting_roster", coinCost 0) under one causation id.
 * It is the same for every caravan of a region, it moves no Coin, grants no unlock point and
 * reaches no node: every type in it is one of the region's tier-0 starting nodes, which every
 * caravan has from creation (GUARDRAILS §3).
 */
import { REGION_IDS, TUNABLES, startingNodeIds, unlockWebFor, type RegionId } from "@caravan/content";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startingRosterCause, startingRosterTypes } from "../src/acquisition/startingRoster.js";
import { withTransaction } from "../src/db/pool.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { createAccount } from "../src/repo/accounts.js";
import { listUnitInstancesForCaravan } from "../src/repo/unitInstances.js";
import { createCaravanForAccount } from "../src/services/caravans.js";
import { registerAccount } from "../src/services/onboarding.js";
import { reachedNodeIds } from "../src/unlocks/access.js";
import { testPool, truncateAll, unique } from "./helpers.js";

const pool: pg.Pool = testPool();

beforeAll(async () => {
  await truncateAll(pool);
});
afterAll(async () => {
  await pool.end();
});

async function events(accountId: string): Promise<{ event_type: string; caravan_id: string | null; causation_id: string; payload: Record<string, unknown> }[]> {
  return (await pool.query("SELECT event_type, caravan_id, causation_id, payload FROM ledger_event WHERE account_id = $1 ORDER BY seq", [accountId])).rows;
}

async function register(region: RegionId) {
  const { account, caravan } = await registerAccount(pool, { username: unique("start"), password: "password123", regionId: region });
  return { accountId: account.id, caravanId: caravan.id };
}

describe("the starting roster (chunk 24 QA D1)", () => {
  it("the tunable: a non-negative integer copy count over the region's tier-0 living nodes, all level 1", () => {
    const copies = TUNABLES.STARTING_ROSTER.copiesPerStarterType;
    expect(Number.isSafeInteger(copies) && copies >= 0).toBe(true);
    for (const region of REGION_IDS) {
      const starters = new Set(startingNodeIds(unlockWebFor("living", region)));
      const types = startingRosterTypes(region);
      expect(types.length).toBe(starters.size * copies);
      for (const t of types) expect(starters.has(t), t).toBe(true);
    }
  });

  it("every new caravan gets exactly it, at level 1, in the ledger as unit_acquired (source starting_roster, coinCost 0) — and nothing else", async () => {
    for (const region of REGION_IDS) {
      const p = await register(region);
      const units = await listUnitInstancesForCaravan(pool, p.caravanId);
      expect(units.map((u) => u.unit_type_id).sort(), region).toEqual(startingRosterTypes(region));
      expect(units.every((u) => u.merge_level === 1)).toBe(true);
      const evs = await events(p.accountId);
      // The registration's whole ledger story is the grant: no Coin, no unlock point, no purchase.
      expect(evs.map((e) => e.event_type)).toEqual(units.map(() => "unit_acquired"));
      expect(evs.every((e) => e.causation_id === startingRosterCause(p.caravanId) && e.caravan_id === p.caravanId)).toBe(true);
      expect(evs.map((e) => e.payload["instanceId"]).sort()).toEqual(units.map((u) => u.id).sort());
      for (const e of evs) expect(e.payload).toMatchObject({ source: "starting_roster", coinCost: 0, mergeLevel: 1 });
      const acct = await pool.query<{ coin_balance: string }>("SELECT coin_balance FROM account WHERE id = $1", [p.accountId]);
      expect(Number(acct.rows[0]!.coin_balance)).toBe(0);
      const points = await pool.query<{ n: string }>("SELECT COALESCE(sum(unlock_points_granted + unlock_points_spent), 0)::text AS n FROM pool_progress WHERE account_id = $1 OR caravan_id = $2", [p.accountId, p.caravanId]);
      expect(points.rows[0]!.n).toBe("0");
      // No access beyond the starters: the reached living set is exactly the tier-0 nodes.
      const reached = await reachedNodeIds(pool, "living", { accountId: p.accountId, caravanId: p.caravanId });
      expect([...reached].sort()).toEqual([...startingNodeIds(unlockWebFor("living", region))].sort());
      expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
    }
  });

  it("is identical for every caravan of a region", async () => {
    const rosters = [];
    for (let i = 0; i < 3; i++) {
      const p = await register("badlands");
      rosters.push((await listUnitInstancesForCaravan(pool, p.caravanId)).map((u) => [u.unit_type_id, u.merge_level]).sort());
    }
    expect(rosters[1]).toEqual(rosters[0]);
    expect(rosters[2]).toEqual(rosters[0]);
  });

  it("is granted by the caravan-creation path itself, not by a route (so a guest or second caravan gets it the same way)", async () => {
    const account = await createAccount(pool, { username: unique("direct"), passwordHash: "x" });
    const caravan = await withTransaction(pool, (c) => createCaravanForAccount(c, { accountId: account.id, regionId: "mountain" }));
    expect((await listUnitInstancesForCaravan(pool, caravan.id)).map((u) => u.unit_type_id).sort()).toEqual(startingRosterTypes("mountain"));
  });

  it("a system (authored) caravan gets none: its roster is its authored spec", async () => {
    const account = await createAccount(pool, { username: unique("sysx"), passwordHash: "x" });
    await pool.query("UPDATE account SET is_system = true WHERE id = $1", [account.id]);
    const caravan = await withTransaction(pool, (c) => createCaravanForAccount(c, { accountId: account.id, regionId: "desert" }));
    expect(await listUnitInstancesForCaravan(pool, caravan.id)).toEqual([]);
    expect(await events(account.id)).toEqual([]);
  });
});

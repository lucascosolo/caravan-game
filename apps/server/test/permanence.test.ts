/**
 * Ladder levels and granted unlock points are permanent and unrevocable; Reputation is
 * a rating with no spend path. Proven at the DB layer and at the repo layer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as poolProgressRepo from "../src/repo/poolProgress.js";
import { grantUnlockPoints, raiseLadderLevel } from "../src/repo/poolProgress.js";
import { registerAccount } from "../src/services/onboarding.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let accountId: string;
let caravanId: string;
let trapId: string;
let livingId: string;

beforeAll(async () => {
  await truncateAll(pool);
  const { account, caravan } = await registerAccount(pool, {
    username: unique("perm"),
    password: "password123",
    regionId: "mountain",
  });
  accountId = account.id;
  caravanId = caravan.id;
  trapId = (await poolProgressRepo.getAccountPoolProgress(pool, accountId, "trap"))!.id;
  livingId = (await poolProgressRepo.getCaravanPoolProgress(pool, caravanId))!.id;
});
afterAll(() => pool.end());

describe("ladder level and unlock points can only rise", () => {
  it("increments through the repo", async () => {
    const a = await raiseLadderLevel(pool, trapId);
    expect(a.ladder_level).toBe(1);
    const b = await grantUnlockPoints(pool, trapId, 2);
    expect(b.unlock_points_granted).toBe(2);
    const c = await raiseLadderLevel(pool, livingId);
    expect(c.ladder_level).toBe(1);
  });

  it.each([trapId, livingId].map((_, i) => i))("DB refuses a ladder decrement (row %i)", async (i) => {
    const id = i === 0 ? trapId : livingId;
    const err = await expectDbError(pool, "UPDATE pool_progress SET ladder_level = ladder_level - 1 WHERE id = $1", [id]);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("ladder_level is permanent");
  });

  it("DB refuses setting ladder level to zero after it rose", async () => {
    const err = await expectDbError(pool, "UPDATE pool_progress SET ladder_level = 0 WHERE id = $1", [trapId]);
    expect(err?.code).toBe("23514");
  });

  it("DB refuses revoking granted unlock points", async () => {
    const err = await expectDbError(
      pool,
      "UPDATE pool_progress SET unlock_points_granted = unlock_points_granted - 1 WHERE id = $1",
      [trapId],
    );
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("unlock_points_granted is permanent");
  });

  it("DB refuses spending more unlock points than were granted, or negative spend", async () => {
    const over = await expectDbError(pool, "UPDATE pool_progress SET unlock_points_spent = 3 WHERE id = $1", [trapId]);
    expect(over?.code).toBe("23514");
    const neg = await expectDbError(pool, "UPDATE pool_progress SET unlock_points_spent = -1 WHERE id = $1", [trapId]);
    expect(neg?.code).toBe("23514");
  });

  it("DB refuses deleting a progress row while its owner exists (no delete-and-reset back door)", async () => {
    const acct = await expectDbError(pool, "DELETE FROM pool_progress WHERE id = $1", [trapId]);
    expect(acct?.code).toBe("23514");
    const crv = await expectDbError(pool, "DELETE FROM pool_progress WHERE id = $1", [livingId]);
    expect(crv?.code).toBe("23514");
    const still = await pool.query("SELECT ladder_level FROM pool_progress WHERE id = ANY($1)", [[trapId, livingId]]);
    expect(still.rowCount).toBe(2);
  });

  it("repo refuses a non-positive grant", async () => {
    await expect(grantUnlockPoints(pool, trapId, 0)).rejects.toThrow(RangeError);
    await expect(grantUnlockPoints(pool, trapId, -5)).rejects.toThrow(RangeError);
    await expect(grantUnlockPoints(pool, trapId, 1.5)).rejects.toThrow(RangeError);
  });

  it("the repo module exposes no decrement, revoke, reset or spend-reputation function", () => {
    const names = Object.keys(poolProgressRepo);
    expect(names.filter((n) => /(decrement|revoke|reset|lower|reduce|spendrep|debit|charge)/i.test(n))).toEqual([]);
  });

  it("rows cascade away only with their owner", async () => {
    const { account, caravan } = await registerAccount(pool, {
      username: unique("cascade"),
      password: "password123",
      regionId: "badlands",
    });
    await pool.query("DELETE FROM account WHERE id = $1", [account.id]);
    const rows = await pool.query("SELECT 1 FROM pool_progress WHERE account_id = $1 OR caravan_id = $2", [
      account.id,
      caravan.id,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("reputation is a rating", () => {
  it("has no spend column and cannot go below zero", async () => {
    const cols = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'pool_progress' AND column_name LIKE '%reputation%'",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["reputation"]);
    const err = await expectDbError(pool, "UPDATE pool_progress SET reputation = -1 WHERE id = $1", [trapId]);
    expect(err?.code).toBe("23514");
  });
});

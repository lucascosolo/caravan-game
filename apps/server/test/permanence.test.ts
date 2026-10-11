/**
 * Ladder levels and granted unlock points are permanent and unrevocable; Reputation is
 * a rating with no spend path. Proven at the DB layer and at the repo layer.
 *
 * Progress only ever rises THROUGH THE LEDGER (chunk 04 QA S6): there is no repo-level
 * writer of ladder_level / ladder_points / unlock_points_granted; the rows below are moved
 * by appending `ladder_progress_gained` / `unlock_points_granted` events and letting the
 * projection trigger fold them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/pool.js";
import type { LedgerEventDraft } from "../src/ledger/events.js";
import { appendEvents } from "../src/ledger/ledger.js";
import * as poolProgressRepo from "../src/repo/poolProgress.js";
import { registerAccount } from "../src/services/onboarding.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let accountId: string;
let caravanId: string;
let trapId: string;
let livingId: string;
let causationN = 0;

const append = (drafts: LedgerEventDraft[]) =>
  withTransaction(pool, (c) => appendEvents(c, `test:perm:${++causationN}`, drafts));

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
  it("rise through the ledger, and only through the ledger", async () => {
    await append([
      { type: "ladder_progress_gained", accountId, payload: { pool: "trap", pointsDelta: 100, levelsGained: 1 } },
      { type: "unlock_points_granted", accountId, payload: { pool: "trap", points: 2, rung: 1 } },
      { type: "ladder_progress_gained", accountId, caravanId, payload: { pool: "living", pointsDelta: 100, levelsGained: 1 } },
    ]);
    const trap = (await poolProgressRepo.getAccountPoolProgress(pool, accountId, "trap"))!;
    expect(trap.ladder_level).toBe(1);
    expect(trap.ladder_points).toBe(100);
    expect(trap.unlock_points_granted).toBe(2);
    expect((await poolProgressRepo.getCaravanPoolProgress(pool, caravanId))!.ladder_level).toBe(1);
    // the repo exposes no direct writer of these columns (chunk 04 QA S6)
    const names = Object.keys(poolProgressRepo);
    expect(names.filter((n) => /(raise|grant|ladder|unlock)/i.test(n))).toEqual([]);
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

  it("DB refuses a ladder_points decrease (the ladder is cumulative)", async () => {
    const err = await expectDbError(pool, "UPDATE pool_progress SET ladder_points = ladder_points - 1 WHERE id = $1", [trapId]);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("ladder_points is cumulative");
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

  it("the ledger refuses a non-positive, fractional or rung-less grant (chunk 04 QA S1)", async () => {
    const grant = (payload: object) =>
      append([{ type: "unlock_points_granted", accountId, payload: payload as LedgerEventDraft["payload"] }]);
    await expect(grant({ pool: "trap", points: 0, rung: 2 })).rejects.toMatchObject({ code: "23514" });
    await expect(grant({ pool: "trap", points: -5, rung: 2 })).rejects.toMatchObject({ code: "23514" });
    await expect(grant({ pool: "trap", points: 1.5, rung: 2 })).rejects.toThrow(/integers/); // validateDraft, before the DB
    await expect(grant({ pool: "trap", points: 1 })).rejects.toMatchObject({ code: "23514" });
    expect((await poolProgressRepo.getAccountPoolProgress(pool, accountId, "trap"))!.unlock_points_granted).toBe(2);
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

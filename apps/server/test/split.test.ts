/**
 * GUARDRAILS §5: the account-vs-caravan split is enforced by the schema, not by convention.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAccount } from "../src/services/onboarding.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let accountId: string;
let caravanId: string;

beforeAll(async () => {
  await truncateAll(pool);
  const { account, caravan } = await registerAccount(pool, {
    username: unique("split"),
    password: "password123",
    regionId: "desert",
  });
  accountId = account.id;
  caravanId = caravan.id;
});
afterAll(() => pool.end());

describe("pool_progress scope constraint", () => {
  it("registration lands each pool on the correct side of the split", async () => {
    const res = await pool.query<{ pool: string; account_id: string | null; caravan_id: string | null }>(
      `SELECT pool, account_id, caravan_id FROM pool_progress
       WHERE account_id = $1 OR caravan_id = $2 ORDER BY pool::text`,
      [accountId, caravanId],
    );
    expect(res.rows).toEqual([
      { pool: "living", account_id: null, caravan_id: caravanId },
      { pool: "siege", account_id: accountId, caravan_id: null },
      { pool: "trap", account_id: accountId, caravan_id: null },
    ]);
  });

  it("refuses living-unit progress at account level", async () => {
    const err = await expectDbError(
      pool,
      "INSERT INTO pool_progress (pool, account_id, reputation) VALUES ('living', $1, 1000)",
      [accountId],
    );
    expect(err?.code).toBe("23514"); // check_violation
    expect(err?.message).toContain("pool_progress_scope_matches_pool");
  });

  it.each(["trap", "siege"])("refuses %s progress at caravan level", async (p) => {
    const err = await expectDbError(
      pool,
      "INSERT INTO pool_progress (pool, caravan_id, reputation) VALUES ($1, $2, 1000)",
      [p, caravanId],
    );
    expect(err?.code).toBe("23514");
  });

  it("refuses a row that names both scopes, or neither", async () => {
    const both = await expectDbError(
      pool,
      "INSERT INTO pool_progress (pool, account_id, caravan_id, reputation) VALUES ('trap', $1, $2, 1000)",
      [accountId, caravanId],
    );
    expect(both?.code).toBe("23514");
    const neither = await expectDbError(pool, "INSERT INTO pool_progress (pool, reputation) VALUES ('trap', 1000)");
    expect(neither?.code).toBe("23514");
  });

  it("refuses moving a row across the split after the fact", async () => {
    const err = await expectDbError(
      pool,
      "UPDATE pool_progress SET account_id = NULL, caravan_id = $2 WHERE account_id = $1 AND pool = 'trap'",
      [accountId, caravanId],
    );
    expect(err?.code).toBe("23514");
  });

  it("allows at most one row per (owner, pool)", async () => {
    const dupAccount = await expectDbError(
      pool,
      "INSERT INTO pool_progress (pool, account_id, reputation) VALUES ('trap', $1, 1000)",
      [accountId],
    );
    expect(dupAccount?.code).toBe("23505");
    const dupCaravan = await expectDbError(
      pool,
      "INSERT INTO pool_progress (pool, caravan_id, reputation) VALUES ('living', $1, 1000)",
      [caravanId],
    );
    expect(dupCaravan?.code).toBe("23505");
  });
});

describe("account-level hub rows", () => {
  it("home town and standing party are keyed by account, not caravan", async () => {
    const town = await pool.query("SELECT 1 FROM home_town WHERE account_id = $1", [accountId]);
    const party = await pool.query("SELECT 1 FROM standing_party WHERE account_id = $1", [accountId]);
    expect(town.rowCount).toBe(1);
    expect(party.rowCount).toBe(1);
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('home_town', 'standing_party') AND column_name LIKE '%caravan%'`,
    );
    expect(cols.rows).toEqual([]);
  });

  it("the account table inlines no caravan or living-unit fields", async () => {
    const cols = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'account'",
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const bad of ["region", "caravan", "living", "ladder", "reputation", "unlock"]) {
      expect(names.some((n) => n.includes(bad)), `account column containing '${bad}'`).toBe(false);
    }
  });
});

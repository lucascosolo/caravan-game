/**
 * Multi-caravan readiness (GUARDRAILS §5): the schema supports N caravans per account;
 * only v1 app logic refuses the second. Plus caravan state and region immutability.
 */
import { TUNABLES } from "@caravan/content";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startingRosterTypes } from "../src/acquisition/startingRoster.js";
import { withTransaction } from "../src/db/pool.js";
import { listCaravansForAccount, setCaravanState } from "../src/repo/caravans.js";
import { createUnitInstance, listUnitInstancesForCaravan } from "../src/repo/unitInstances.js";
import { createCaravanForAccount } from "../src/services/caravans.js";
import { AppError } from "../src/services/errors.js";
import { registerAccount } from "../src/services/onboarding.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let accountId: string;
let caravanId: string;

beforeAll(async () => {
  await truncateAll(pool);
  const { account, caravan } = await registerAccount(pool, {
    username: unique("crv"),
    password: "password123",
    regionId: "high_plains",
  });
  accountId = account.id;
  caravanId = caravan.id;
});
afterAll(() => pool.end());

describe("caravan", () => {
  it("defaults to in_town and can move to on_trip and back", async () => {
    const [c] = await listCaravansForAccount(pool, accountId);
    expect(c?.state).toBe("in_town");
    expect((await setCaravanState(pool, caravanId, "on_trip")).state).toBe("on_trip");
    expect((await setCaravanState(pool, caravanId, "in_town")).state).toBe("in_town");
    const bad = await expectDbError(pool, "UPDATE caravan SET state = 'under_siege' WHERE id = $1", [caravanId]);
    expect(bad?.code).toBe("22P02"); // invalid enum input
  });

  it("region is chosen once: the DB refuses a change", async () => {
    const err = await expectDbError(pool, "UPDATE caravan SET region_id = 'desert' WHERE id = $1", [caravanId]);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("not swappable");
    const unknown = await expectDbError(
      pool,
      "INSERT INTO caravan (account_id, region_id, name) VALUES ($1, 'atlantis', 'x')",
      [accountId],
    );
    expect(unknown?.code).toBe("23503"); // fk to region
  });

  it("a second caravan can be inserted directly with no schema change", async () => {
    // Inside a transaction that is rolled back: a caravan cannot be deleted while its
    // account exists (it owns ladder progress), so this is the only way to undo it.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const second = await client.query<{ id: string }>(
        "INSERT INTO caravan (account_id, region_id, name) VALUES ($1, 'badlands', 'Second') RETURNING id",
        [accountId],
      );
      const secondId = second.rows[0]!.id;
      // Its own caravan-level living progress, independent of the first caravan's.
      await client.query("INSERT INTO pool_progress (pool, caravan_id, reputation) VALUES ('living', $1, 1000)", [secondId]);
      const list = await listCaravansForAccount(client, accountId);
      expect(list.map((c) => c.id)).toEqual([caravanId, secondId]);
      const living = await client.query(
        "SELECT caravan_id FROM pool_progress WHERE pool = 'living' AND caravan_id = ANY($1)",
        [[caravanId, secondId]],
      );
      expect(living.rowCount).toBe(2);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect((await listCaravansForAccount(pool, accountId)).length).toBe(1);
  });

  it("v1 app logic refuses a second caravan (tunable MAX_CARAVANS_PER_ACCOUNT)", async () => {
    expect(TUNABLES.MAX_CARAVANS_PER_ACCOUNT).toBe(1);
    await expect(
      withTransaction(pool, (client) => createCaravanForAccount(client, { accountId, regionId: "desert" })),
    ).rejects.toMatchObject({ statusCode: 409, code: "caravan_limit" } satisfies Partial<AppError>);
    expect((await listCaravansForAccount(pool, accountId)).length).toBe(1);
  });

  it("the service rejects an unknown region", async () => {
    const { account } = await registerAccount(pool, { username: unique("r"), password: "password123", regionId: "desert" });
    await expect(
      withTransaction(pool, (client) => createCaravanForAccount(client, { accountId: account.id, regionId: "narnia" })),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_region" });
    await expect(
      registerAccount(pool, { username: unique("r"), password: "password123", regionId: "narnia" }),
    ).rejects.toMatchObject({ code: "invalid_region" });
  });
});

describe("unit instances", () => {
  it("are caravan-scoped with merge level 1..5", async () => {
    const u = await createUnitInstance(pool, { caravanId, unitTypeId: "placeholder.high_plains.scout" });
    expect(u.merge_level).toBe(1);
    const m5 = await createUnitInstance(pool, { caravanId, unitTypeId: "placeholder.high_plains.scout", mergeLevel: 5 });
    expect(m5.merge_level).toBe(5);
    await expect(createUnitInstance(pool, { caravanId, unitTypeId: "x", mergeLevel: 6 })).rejects.toThrow(RangeError);
    await expect(createUnitInstance(pool, { caravanId, unitTypeId: "x", mergeLevel: 0 })).rejects.toThrow(RangeError);
    const dbErr = await expectDbError(pool, "UPDATE unit_instance SET merge_level = 6 WHERE id = $1", [m5.id]);
    expect(dbErr?.code).toBe("23514");
    const floor = await expectDbError(pool, "UPDATE unit_instance SET merge_level = 0 WHERE id = $1", [u.id]);
    expect(floor?.code).toBe("23514");
    // Two, besides the starting roster every caravan is created with (chunk 24 QA D1).
    expect((await listUnitInstancesForCaravan(pool, caravanId)).length).toBe(2 + startingRosterTypes("high_plains").length);
    expect(TUNABLES.MERGE_LEVEL_MAX).toBe(5);
  });

  it("have no account-level column", async () => {
    const cols = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'unit_instance'",
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain("account_id");
  });
});

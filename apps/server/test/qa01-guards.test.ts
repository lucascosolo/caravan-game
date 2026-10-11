/**
 * Chunk 01 QA round 1: the schema's permanence guards hold against every route a caller
 * might take around them (TRUNCATE, caravan delete, spent-points decrease, empty type id,
 * and the server's own DB role trying to switch the guards off), plus the auth nits.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { APP_DB_ROLE, CARAVAN_NAME_MAX, PASSWORD_MAX, SESSIONS_PER_ACCOUNT_MAX } from "../src/config.js";
import { loadMigrations } from "../src/db/migrate.js";
import { countSessionsForAccount } from "../src/repo/sessions.js";
import { registerAccount } from "../src/services/onboarding.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const owner = testPool();
const appDb = appRolePool();
let app: FastifyInstance;
let accountId: string;
let caravanId: string;
let livingId: string;

beforeAll(async () => {
  await truncateAll(owner);
  app = await buildApp({ db: appDb });
  const reg = await registerAccount(owner, { username: unique("qa"), password: "password123", regionId: "desert" });
  accountId = reg.account.id;
  caravanId = reg.caravan.id;
  livingId = (await owner.query<{ id: string }>("SELECT id FROM pool_progress WHERE caravan_id = $1", [caravanId])).rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await appDb.end();
  await owner.end();
});

describe("item 1: TRUNCATE cannot bypass the row-level guards", () => {
  it.each(["pool_progress", "caravan CASCADE"])("refuses TRUNCATE %s even for the owner role", async (table) => {
    const err = await expectDbError(owner, `TRUNCATE ${table}`);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("TRUNCATE is refused");
    expect((await owner.query("SELECT 1 FROM pool_progress WHERE id = $1", [livingId])).rowCount).toBe(1);
  });

  it("refuses TRUNCATE account CASCADE (it would reach the guarded tables)", async () => {
    const err = await expectDbError(owner, "TRUNCATE account CASCADE");
    expect(err?.code).toBe("23514");
    expect((await owner.query("SELECT 1 FROM account WHERE id = $1", [accountId])).rowCount).toBe(1);
  });
});

describe("item 2: a caravan cannot be deleted out from under its ladder", () => {
  it("refuses DELETE FROM caravan while the account exists", async () => {
    const err = await expectDbError(owner, "DELETE FROM caravan WHERE id = $1", [caravanId]);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("permanent while its account exists");
    expect((await owner.query("SELECT 1 FROM pool_progress WHERE id = $1", [livingId])).rowCount).toBe(1);
  });

  it("still cascades away with its account", async () => {
    const { account, caravan } = await registerAccount(owner, { username: unique("gone"), password: "password123", regionId: "badlands" });
    await owner.query("DELETE FROM account WHERE id = $1", [account.id]);
    expect((await owner.query("SELECT 1 FROM caravan WHERE id = $1", [caravan.id])).rowCount).toBe(0);
  });
});

describe("item 13: unlock_points_spent never decreases (no refund, no respec)", () => {
  it("can rise within the granted total but not fall", async () => {
    await owner.query("UPDATE pool_progress SET unlock_points_granted = 3 WHERE id = $1", [livingId]);
    await owner.query("UPDATE pool_progress SET unlock_points_spent = 2 WHERE id = $1", [livingId]);
    const err = await expectDbError(owner, "UPDATE pool_progress SET unlock_points_spent = 1 WHERE id = $1", [livingId]);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("unlock_points_spent may never decrease");
    await owner.query("UPDATE pool_progress SET unlock_points_spent = 3 WHERE id = $1", [livingId]);
  });
});

describe("item 14: unit_type_id is non-empty", () => {
  it("refuses the empty string", async () => {
    const err = await expectDbError(owner, "INSERT INTO unit_instance (caravan_id, unit_type_id) VALUES ($1, '')", [caravanId]);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("unit_instance_type_nonempty");
  });
});

describe("item 3: the server's DB role cannot switch the guards off", () => {
  it("is not a superuser and does not own the tables", async () => {
    const who = await appDb.query<{ u: string; su: boolean }>("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su");
    expect(who.rows[0]).toEqual({ u: APP_DB_ROLE, su: false });
    const owners = await appDb.query<{ tableowner: string }>("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'");
    expect(owners.rows.map((r) => r.tableowner)).not.toContain(APP_DB_ROLE);
  });

  it("can do ordinary DML (the game still works)", async () => {
    const { account } = await registerAccount(appDb, { username: unique("app"), password: "password123", regionId: "mountain" });
    const res = await appDb.query("UPDATE account SET coin_balance = 5 WHERE id = $1 RETURNING coin_balance", [account.id]);
    expect(res.rows[0]).toEqual({ coin_balance: 5 });
    await appDb.query("DELETE FROM session WHERE account_id = $1", [account.id]);
  });

  it.each([
    "ALTER TABLE pool_progress DISABLE TRIGGER pool_progress_guard_permanence",
    "ALTER TABLE pool_progress DISABLE TRIGGER ALL",
    "ALTER TABLE caravan DISABLE TRIGGER caravan_guard_delete",
    "ALTER TABLE pool_progress DROP CONSTRAINT pool_progress_scope_matches_pool",
    "DROP TRIGGER pool_progress_guard_permanence ON pool_progress",
    "TRUNCATE pool_progress",
    "TRUNCATE account CASCADE",
    "DROP TABLE pool_progress",
    "CREATE TABLE sneaky (id int)",
    "DELETE FROM schema_migrations",
  ])("refuses: %s", async (sql) => {
    const err = await expectDbError(appDb, sql);
    expect(err).not.toBeNull();
    // 42501 insufficient_privilege; the TRUNCATEs would also hit the trigger if they got that far.
    expect(err?.code).toBe("42501");
  });

  it("the guards still bite through the app role, so they are not merely owner-only policy", async () => {
    const dec = await expectDbError(appDb, "UPDATE pool_progress SET ladder_level = ladder_level - 1 WHERE id = $1", [livingId]);
    expect(dec?.code).toBe("23514");
    const del = await expectDbError(appDb, "DELETE FROM caravan WHERE id = $1", [caravanId]);
    expect(del?.code).toBe("23514");
  });

  it("default privileges cover tables the owner creates later", async () => {
    await owner.query("CREATE TABLE qa01_future (id serial PRIMARY KEY, n int)");
    try {
      await appDb.query("INSERT INTO qa01_future (n) VALUES (1)");
      expect((await appDb.query("SELECT n FROM qa01_future")).rows).toEqual([{ n: 1 }]);
      expect((await expectDbError(appDb, "TRUNCATE qa01_future"))?.code).toBe("42501");
    } finally {
      await owner.query("DROP TABLE qa01_future");
    }
  });
});

describe("item 9: input bounds", () => {
  it("rejects an over-long password and an empty, over-long or untrimmed caravan name", async () => {
    const base = { username: unique("b"), region: "desert" };
    const long = await app.inject({ method: "POST", url: "/auth/register", payload: { ...base, password: "x".repeat(PASSWORD_MAX + 1) } });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toBe("invalid_password");
    const empty = await app.inject({ method: "POST", url: "/auth/register", payload: { ...base, password: "password123", caravanName: "   " } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("invalid_caravan_name");
    const big = await app.inject({ method: "POST", url: "/auth/register", payload: { ...base, password: "password123", caravanName: "n".repeat(CARAVAN_NAME_MAX + 1) } });
    expect(big.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/auth/register", payload: { ...base, password: "x".repeat(PASSWORD_MAX), caravanName: "  Dusty Trail  " } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().caravan.name).toBe("Dusty Trail");
  });
});

describe("item 10: login timing does not reveal whether a username exists", () => {
  it("unknown username costs about the same as a wrong password", async () => {
    const username = unique("t");
    await app.inject({ method: "POST", url: "/auth/register", payload: { username, password: "password123", region: "desert" } });
    const time = async (u: string): Promise<number> => {
      const t0 = process.hrtime.bigint();
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: u, password: "wrong password" } });
      expect(res.statusCode).toBe(401);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await time(username));
      unknown.push(await time(unique("nobody")));
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    // The old code returned in ~1 ms for an unknown user; scrypt costs tens of ms. Require
    // the unknown path to cost at least half the known path.
    expect(median(unknown)).toBeGreaterThan(median(known) / 2);
    const over = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "x".repeat(PASSWORD_MAX + 1) } });
    expect(over.statusCode).toBe(401);
  });
});

describe("item 11: Authorization header is exactly `Bearer <token>`", () => {
  it("accepts case-insensitive scheme and extra spaces; rejects trailing tokens and junk", async () => {
    const username = unique("h");
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { username, password: "password123", region: "desert" } });
    const token = reg.json().token as string;
    const get = (authorization: string) => app.inject({ method: "GET", url: "/me", headers: { authorization } });
    expect((await get(`Bearer ${token}`)).statusCode).toBe(200);
    expect((await get(`bearer   ${token}`)).statusCode).toBe(200);
    expect((await get(`Bearer ${token} extra`)).statusCode).toBe(401);
    expect((await get(`Bearer ${token},`)).statusCode).toBe(401);
    expect((await get(`Bearer`)).statusCode).toBe(401);
    expect((await get(`Bearer `)).statusCode).toBe(401);
    expect((await get(`Bearer${token}`)).statusCode).toBe(401);
    expect((await get(`Token ${token}`)).statusCode).toBe(401);
  });
});

describe("item 12: session hygiene on login", () => {
  it("purges expired sessions and caps live ones at SESSIONS_PER_ACCOUNT_MAX, oldest first", async () => {
    const username = unique("s");
    const password = "password123";
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { username, password, region: "desert" } });
    const id = reg.json().account.id as string;
    const first = reg.json().token as string;
    await owner.query("UPDATE session SET expires_at = now() - interval '1 second' WHERE account_id = $1", [id]);
    const login = async (): Promise<string> => {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
      expect(res.statusCode).toBe(200);
      return res.json().token as string;
    };
    const tokens: string[] = [];
    tokens.push(await login());
    // The expired registration session was purged by that login.
    expect(await countSessionsForAccount(owner, id)).toBe(1);
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${first}` } })).statusCode).toBe(401);

    for (let i = 0; i < SESSIONS_PER_ACCOUNT_MAX + 2; i++) tokens.push(await login());
    expect(await countSessionsForAccount(owner, id)).toBe(SESSIONS_PER_ACCOUNT_MAX);
    const live = tokens.slice(-SESSIONS_PER_ACCOUNT_MAX);
    const evicted = tokens.slice(0, tokens.length - SESSIONS_PER_ACCOUNT_MAX);
    for (const t of evicted) {
      expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(401);
    }
    for (const t of live) {
      expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(200);
    }
  });
});

describe("item 16: migration loader orders by numeric id and rejects duplicates", () => {
  const write = (dir: string, name: string): void => {
    writeFileSync(path.join(dir, `${name}.up.sql`), "SELECT 1;");
    writeFileSync(path.join(dir, `${name}.down.sql`), "SELECT 1;");
  };

  it("sorts 10 after 9 regardless of padding", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "caravan-mig-"));
    try {
      write(dir, "10_ten");
      write(dir, "9_nine");
      write(dir, "001_one");
      expect(loadMigrations(dir).map((m) => m.id)).toEqual([1, 9, 10]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses two files with the same id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "caravan-mig-"));
    try {
      write(dir, "002_a");
      write(dir, "2_b");
      expect(() => loadMigrations(dir)).toThrow(/Duplicate migration id 2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

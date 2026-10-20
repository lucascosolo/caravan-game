/**
 * Final whole-game review fix round (roadmap/qa/final-guardrail-review.md):
 *   S1 / N5  the seed: authored parties only by default; the dev account only with --dev, refused in
 *            production, its roster granted through grantUnit so the ledger rebuild equals live state;
 *   S2       single-process hosting (SERVE_WEB): the API under /api, the client from its dist
 *            directory, no source maps in production, security headers; production config checks;
 *   D1       STORE_MODE: off by default in production; previews stay, purchases 409, no funnel counted;
 *   N2       .env loading never overrides the real environment;
 *   N7       a role-level setting on the app role is reported, and never changes the pool's search_path.
 * (D2 lives with the other rate-limit tests in account-lifecycle.test.ts; N4 in stakes / party tests.)
 */
import { TUNABLES, startingNodeIds, unlockWebFor } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { assertProductionDatabaseUrl, loadDotEnv, ProductionConfigError, serveWebFromEnv, storeModeFromEnv } from "../src/config.js";
import { RoleSettingsCheckError, checkRoleSettings, readRoleSettings } from "../src/db/roleSettings.js";
import { appRoleUrl, resolveTestDatabaseUrl } from "./db-url.js";
import { DevSeedRefusedError, devSeedRequested, seedDevAccount } from "../src/dev/devAccount.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { liveRoster, rebuildAuthoredRoster } from "../src/matchmaking/authored.js";
import { appRolePool, testPool, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
beforeAll(() => {
  appRole = appRolePool();
});
afterAll(async () => {
  await appRole.end();
  await pool.end();
});

async function registerOn(app: FastifyInstance, prefix = ""): Promise<{ token: string; accountId: string; caravanId: string }> {
  const res = await app.inject({ method: "POST", url: `${prefix}/auth/register`, payload: { username: unique("fr"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  return { token: b.token, accountId: b.account.id, caravanId: b.caravan.id };
}

describe("S1 / N5: the seed", () => {
  it("--dev is refused under NODE_ENV=production; without it no login account is asked for", () => {
    expect(() => devSeedRequested(["--dev"], { NODE_ENV: "production" })).toThrow(DevSeedRefusedError);
    expect(devSeedRequested([], { NODE_ENV: "production" })).toBe(false);
    expect(devSeedRequested(["--dev"], { NODE_ENV: "test" })).toBe(true);
    expect(devSeedRequested([], {})).toBe(false);
  });

  it("the dev account is an ordinary registration: only the starting roster, every unit acquired through the ledger, and the ledger rebuild equals the live state", async () => {
    const username = unique("dev");
    const r = await seedDevAccount(appRole, { username, password: "devpassword", regionId: "desert" });
    expect(r.created).toBe(true);
    const caravanId = r.caravanIds[0]!;
    const live = await liveRoster(pool, caravanId);
    const starters = new Set(startingNodeIds(unlockWebFor("living", "desert")));
    expect(live.length).toBe(starters.size * TUNABLES.STARTING_ROSTER.copiesPerStarterType);
    expect(live.every((u) => starters.has(u.unitTypeId) && u.mergeLevel === 1)).toBe(true);
    // Every instance has its unit_acquired event: the ledger's roster IS the live roster.
    expect(await rebuildAuthoredRoster(pool, caravanId)).toEqual(live);
    const v = await verifyProjection(pool, r.accountId);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    // Idempotent: a second run changes nothing.
    const again = await seedDevAccount(appRole, { username, password: "devpassword", regionId: "desert" });
    expect(again).toMatchObject({ created: false, accountId: r.accountId });
    expect(await liveRoster(pool, caravanId)).toEqual(live);
  });
});

describe("S2: production configuration", () => {
  it("in production a database URL must be explicit and must not use a repo default (or empty) password", () => {
    const prod = { NODE_ENV: "production" };
    expect(() => assertProductionDatabaseUrl(prod, undefined, "DATABASE_URL")).toThrow(ProductionConfigError);
    expect(() => assertProductionDatabaseUrl(prod, "postgres://caravan_app:caravan_app@db/caravan", "DATABASE_URL")).toThrow(/default password/);
    expect(() => assertProductionDatabaseUrl(prod, "postgres://caravan:caravan@db/caravan", "MIGRATE_DATABASE_URL")).toThrow(/default password/);
    expect(() => assertProductionDatabaseUrl(prod, "postgres://caravan_app@db/caravan", "DATABASE_URL")).toThrow(/no password/);
    expect(() => assertProductionDatabaseUrl(prod, "not a url", "DATABASE_URL")).toThrow(/valid/);
    expect(() => assertProductionDatabaseUrl(prod, "postgres://caravan_app:Xk9%23long-random@db/caravan", "DATABASE_URL")).not.toThrow();
    // Outside production: anything goes (local development, the test suite).
    expect(() => assertProductionDatabaseUrl({}, undefined, "DATABASE_URL")).not.toThrow();
    expect(() => assertProductionDatabaseUrl({ NODE_ENV: "test" }, "postgres://caravan_app:caravan_app@db/x", "DATABASE_URL")).not.toThrow();
  });

  it("SERVE_WEB is off unless 1, and refuses a directory with no index.html", () => {
    expect(serveWebFromEnv({}, "/nonexistent")).toBeNull();
    expect(serveWebFromEnv({ SERVE_WEB: "0" }, "/nonexistent")).toBeNull();
    expect(() => serveWebFromEnv({ SERVE_WEB: "yes" }, "/nonexistent")).toThrow(/SERVE_WEB/);
    expect(() => serveWebFromEnv({ SERVE_WEB: "1" }, "/nonexistent")).toThrow(/index.html/);
  });
});

describe("N2: .env loading", () => {
  it("reads KEY=VALUE lines (comments, export, quotes) and never overrides a variable already set", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "caravan-env-"));
    try {
      writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n");
      writeFileSync(path.join(dir, ".env"), "# a comment\n\nA_VAR=one\nexport B_VAR='two words'\nC_VAR=\"three\"\nSET_ALREADY=from-file\nnot a line\n");
      mkdirSync(path.join(dir, "apps", "server"), { recursive: true });
      const env: NodeJS.ProcessEnv = { SET_ALREADY: "from-env" };
      expect(loadDotEnv(env, path.join(dir, "apps", "server"))).toBe(path.join(dir, ".env"));
      expect(env).toEqual({ A_VAR: "one", B_VAR: "two words", C_VAR: "three", SET_ALREADY: "from-env" });
      // ENV_FILE names another file; a missing file is not an error.
      expect(loadDotEnv({ ENV_FILE: "missing.env" }, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("D1: STORE_MODE", () => {
  it("defaults to off in production and sandbox elsewhere; only the two values are accepted", () => {
    expect(storeModeFromEnv({ NODE_ENV: "production" })).toBe("off");
    expect(storeModeFromEnv({})).toBe("sandbox");
    expect(storeModeFromEnv({ NODE_ENV: "test" })).toBe("sandbox");
    // Final guardrail review r3 N4: an explicit sandbox under production needs the second switch.
    expect(() => storeModeFromEnv({ NODE_ENV: "production", STORE_MODE: "sandbox" })).toThrow(/STORE_MODE=sandbox is refused when NODE_ENV=production/);
    expect(() => storeModeFromEnv({ NODE_ENV: "production", STORE_MODE: "sandbox", STORE_SANDBOX_IN_PRODUCTION: "true" })).toThrow(/refused/);
    expect(storeModeFromEnv({ NODE_ENV: "production", STORE_MODE: "sandbox", STORE_SANDBOX_IN_PRODUCTION: "1" })).toBe("sandbox");
    expect(storeModeFromEnv({ NODE_ENV: "production", STORE_MODE: "off", STORE_SANDBOX_IN_PRODUCTION: "1" })).toBe("off");
    expect(storeModeFromEnv({ STORE_MODE: "off" })).toBe("off");
    expect(() => storeModeFromEnv({ STORE_MODE: "live" })).toThrow(/STORE_MODE/);
  });

  it("off: the store still previews every offer (mode off), a purchase is 409 store_unavailable and moves nothing, and the dashboard counts no funnel", async () => {
    const app = await buildApp({ db: appRole, storeMode: "off" });
    try {
      const p = await registerOn(app);
      const auth = { authorization: `Bearer ${p.token}` };
      const store = await app.inject({ method: "GET", url: "/me/store", headers: auth });
      expect(store.statusCode).toBe(200);
      const view = store.json();
      expect(view.mode).toBe("off");
      expect(view.offers).toHaveLength(3);
      expect(view.offers[0].contents.length).toBeGreaterThan(0);
      const o = view.offers[0];
      const buy = await app.inject({ method: "POST", url: "/me/store/purchase", headers: auth, payload: { tier: o.tier, weekIndex: view.week.index, contentsHash: o.contentsHash } });
      expect(buy.statusCode).toBe(409);
      expect(buy.json()).toMatchObject({ error: "store_unavailable" });
      expect((await pool.query("SELECT count(*)::int AS c FROM pack_purchase WHERE account_id = $1", [p.accountId])).rows[0].c).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS c FROM ledger_event WHERE account_id = $1 AND event_type = 'coin_purchased'", [p.accountId])).rows[0].c).toBe(0);
      // The rest of the economy is untouched: the same account's economy view reads as usual.
      expect((await app.inject({ method: "GET", url: "/me/economy", headers: auth })).statusCode).toBe(200);
      // Dashboard: the funnel is reported as not counted.
      const { buildDashboard } = await import("../src/analytics/dashboard.js");
      const off = await buildDashboard(appRole, { nowMs: Date.now(), days: 7, storeMode: "off" });
      expect(off.panels.packFunnel).toEqual({ viewers: 0, storeViewers: 0, buyers: 0, allBuyers: 0, tiers: [], storeMode: "off", counted: false });
      const on = await buildDashboard(appRole, { nowMs: Date.now(), days: 7 });
      expect(on.panels.packFunnel).toMatchObject({ storeMode: "sandbox", counted: true });
    } finally {
      await app.close();
    }
  });

  it("sandbox (the default here): the store says so and a purchase goes through", async () => {
    const app = await buildApp({ db: appRole });
    try {
      expect(app.storeMode).toBe("sandbox");
      const p = await registerOn(app);
      const auth = { authorization: `Bearer ${p.token}` };
      const view = (await app.inject({ method: "GET", url: "/me/store", headers: auth })).json();
      expect(view.mode).toBe("sandbox");
      const o = view.offers[0];
      const buy = await app.inject({ method: "POST", url: "/me/store/purchase", headers: auth, payload: { tier: o.tier, weekIndex: view.week.index, contentsHash: o.contentsHash } });
      expect(buy.statusCode, buy.body).toBe(201);
    } finally {
      await app.close();
    }
  });
});

describe("S2: single-process hosting (SERVE_WEB)", () => {
  let dist: string;
  let prodApp: FastifyInstance;
  let devApp: FastifyInstance;
  beforeAll(async () => {
    dist = mkdtempSync(path.join(os.tmpdir(), "caravan-dist-"));
    mkdirSync(path.join(dist, "assets"));
    writeFileSync(path.join(dist, "index.html"), '<!doctype html><html><head><script type="module" src="/assets/app-abc.js"></script></head><body><div id="root"></div></body></html>');
    writeFileSync(path.join(dist, "assets", "app-abc.js"), "console.log('app');\n");
    writeFileSync(path.join(dist, "assets", "app-abc.js.map"), '{"version":3,"sources":["secret.ts"]}');
    writeFileSync(path.join(dist, "manifest.webmanifest"), '{"name":"Caravan Vaults"}');
    writeFileSync(path.join(dist, ".hidden"), "nope");
    prodApp = await buildApp({ db: appRole, serveWeb: { dir: dist, production: true } });
    devApp = await buildApp({ db: appRole, serveWeb: { dir: dist, production: false } });
  });
  afterAll(async () => {
    await prodApp.close();
    await devApp.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves the client at / with security headers and no-cache; deep links fall back to index.html", async () => {
    for (const url of ["/", "/index.html", "/town", "/some/deep/link"]) {
      const r = await prodApp.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers["content-type"]).toMatch(/^text\/html/);
      expect(r.body).toContain('<div id="root">');
      expect(r.headers["cache-control"]).toBe("no-cache");
      expect(r.headers["content-security-policy"]).toMatch(/default-src 'self'/);
      expect(r.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["strict-transport-security"]).toBe("max-age=31536000");
    }
    expect((await prodApp.inject({ method: "HEAD", url: "/" })).statusCode).toBe(200);
  });

  it("assets are immutable-cached with their type; a missing asset is a real 404, not HTML", async () => {
    const js = await prodApp.inject({ method: "GET", url: "/assets/app-abc.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.body).toContain("console.log");
    const manifest = await prodApp.inject({ method: "GET", url: "/manifest.webmanifest" });
    expect(manifest.headers["content-type"]).toMatch(/^application\/manifest\+json/);
    const missing = await prodApp.inject({ method: "GET", url: "/assets/app-old.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("<html");
  });

  it("source maps are not served in production (they are in a dev hosting run)", async () => {
    expect((await prodApp.inject({ method: "GET", url: "/assets/app-abc.js.map" })).statusCode).toBe(404);
    expect((await devApp.inject({ method: "GET", url: "/assets/app-abc.js.map" })).statusCode).toBe(200);
    expect((await devApp.inject({ method: "GET", url: "/" })).headers["strict-transport-security"]).toBeUndefined();
  });

  it("never serves outside the directory, a dotfile or a NUL", async () => {
    for (const url of ["/../package.json", "/assets/../../package.json", "/%2e%2e/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/.hidden", "/assets/%00.js", "/%E0%A4%A"]) {
      const r = await prodApp.inject({ method: "GET", url });
      expect(r.body, url).not.toContain('"name"');
      expect(r.body, url).not.toBe("nope");
      expect([200, 400, 404], url).toContain(r.statusCode);
    }
  });

  it("the whole API lives under /api (health at both), unknown /api paths are JSON 404s, and the root API paths are gone", async () => {
    expect((await prodApp.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
    expect((await prodApp.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ ok: true });
    const p = await registerOn(prodApp, "/api");
    const me = await prodApp.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${p.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.headers["x-content-type-options"]).toBe("nosniff");
    expect((await prodApp.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    const unknown = await prodApp.inject({ method: "GET", url: "/api/nope" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "Not Found", statusCode: 404 });
    // /me at the root is the client's fallback page, never the API.
    const rootMe = await prodApp.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${p.token}` } });
    expect(rootMe.headers["content-type"]).toMatch(/^text\/html/);
    // The admin catch-all moved with the API.
    expect((await prodApp.inject({ method: "GET", url: "/api/admin/dashboard" })).statusCode).toBe(404);
  });

  it("without SERVE_WEB the API stays at the root (dev, the tests, vite's proxy)", async () => {
    const plain = await buildApp({ db: appRole });
    try {
      expect((await plain.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
      expect((await plain.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(404);
      expect((await plain.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("N7: role-level settings on the app role", () => {
  it("round-2 N4: a role-level statement_timeout = 1 is REPORTED by the boot check (its own connection overrides it), not a crash; an unreachable database is a plain RoleSettingsCheckError", async () => {
    const name = (await pool.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
    await pool.query(`ALTER ROLE caravan_app IN DATABASE "${name}" SET statement_timeout = 1`);
    try {
      const settings = await readRoleSettings(appRoleUrl(resolveTestDatabaseUrl()));
      expect(settings).toEqual(["statement_timeout=1 (this database)"]);
    } finally {
      await pool.query(`ALTER ROLE caravan_app IN DATABASE "${name}" RESET ALL`);
    }
    const bad = new URL(appRoleUrl(resolveTestDatabaseUrl()));
    bad.password = "not-the-password";
    await expect(readRoleSettings(bad.toString())).rejects.toBeInstanceOf(RoleSettingsCheckError);
    expect(await readRoleSettings(appRoleUrl(resolveTestDatabaseUrl()))).toEqual([]);
  });

  it("are reported at boot, and a role-level search_path never reaches the pool's connections", async () => {
    // Scoped to THIS database only (IN DATABASE), so no other database's server sees it.
    const name = (await pool.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
    expect(name.length).toBeGreaterThan(0);
    await pool.query(`ALTER ROLE caravan_app IN DATABASE "${name}" SET search_path = pg_temp, pg_catalog`);
    await pool.query(`ALTER ROLE caravan_app IN DATABASE "${name}" SET statement_timeout = '123s'`);
    const fresh = appRolePool();
    try {
      const settings = await checkRoleSettings(fresh);
      expect(settings.some((s) => s.startsWith("statement_timeout=123s"))).toBe(true);
      expect(settings.some((s) => s.startsWith("search_path="))).toBe(true);
      expect((await fresh.query<{ p: string }>("SELECT current_setting('search_path') AS p")).rows[0]!.p).toBe("public");
    } finally {
      await fresh.end();
      await pool.query(`ALTER ROLE caravan_app IN DATABASE "${name}" RESET ALL`);
    }
    const after = appRolePool();
    try {
      expect(await checkRoleSettings(after)).toEqual([]);
    } finally {
      await after.end();
    }
  });
});

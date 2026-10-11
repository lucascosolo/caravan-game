/**
 * Chunk 30 — the account lifecycle (PHASE-2 §30, play-test cut).
 *
 *   guest-first      POST /auth/guest, the device cookie, POST /auth/resume
 *   linking          POST /me/account/link: same id, nothing migrated, a linked username is permanent
 *   devices          GET /me/devices, DELETE /me/devices/:id, POST /me/devices/revoke-others, logout
 *   export           GET /me/export: the player's own data, nobody else's ids, no secrets
 *   rate limits      login (per IP and per username), registration, guest creation, link, export
 *   deletion (DoD)   guest → linked → deleted, with the REAL resolver: the other participants'
 *                    replays still render, their ledgers still rebuild, verifyJobReplay still
 *                    holds, and no row anywhere still names the deleted account
 *   app-role guards  the anonymization exception cannot be opened or used by the server's role
 */
import { entryBand, RING_SEGMENTS, type Formation, type PartyConfig } from "@caravan/circle";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_HANDLERS, type EncounterJobInput } from "../src/jobs/handlers/encounterResolution.js";
import { getJob } from "../src/jobs/queue.js";
import { drain, verifyJobReplay } from "../src/jobs/worker.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { DELETE_CONFIRM_PHRASE, DEVICE_COOKIE, RATE_LIMITS, type RateLimitConfig } from "../src/account/tunables.js";
import { deviceLabel } from "../src/account/device.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  cookie: string;
  username: string | null;
  units: string[];
}

function cookieOf(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  const line = (Array.isArray(raw) ? raw : [raw ?? ""]).find((l) => String(l).startsWith(`${DEVICE_COOKIE}=`));
  expect(line, "the device cookie").toBeDefined();
  return String(line).split(";")[0]!;
}

function call(p: Pick<Player, "token"> | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, extra: Record<string, string> = {}, via: FastifyInstance = app): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { ...(p ? { authorization: `Bearer ${p.token}` } : {}), ...extra } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return via.inject(opts);
}

async function guest(region = "desert", via: FastifyInstance = app, ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36"): Promise<Player> {
  const res = await via.inject({ method: "POST", url: "/auth/guest", payload: { region }, headers: { "user-agent": ua } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  return { token: b.token, accountId: b.account.id, caravanId: b.caravan.id, cookie: cookieOf(res), username: null, units: [] };
}

async function register(): Promise<Player> {
  const username = unique("al");
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username, password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  return { token: b.token, accountId: b.account.id, caravanId: b.caravan.id, cookie: cookieOf(res), username, units: [] };
}

async function link(p: Player, password = "correct horse battery"): Promise<void> {
  const username = unique("lk");
  const res = await call(p, "POST", "/me/account/link", { username, password });
  expect(res.statusCode, res.body).toBe(200);
  p.username = username;
}

async function giveUnits(p: Player, n: number, typeId: string, mergeLevel: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
  p.units.push(...ids);
  return ids;
}

const EDGES = ["north", "east", "south", "west"] as const;
/** A standing party of three dust riders and a battering wagon, rated at the defenders' band centre. */
async function raiseParty(p: Player): Promise<void> {
  const refs = await giveUnits(p, 3, "desert.dust_rider", 1);
  const party: PartyConfig = { v: 1, units: refs.map((ref, i) => ({ ref, stance: "nearest" as const, edge: EDGES[i % 4]!, cell: entryBand(EDGES[i % 4]!)[i]! })), siege: ["siege.battering_wagon"] };
  const res = await call(p, "PUT", "/me/party", party);
  expect(res.statusCode, res.body).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE account_id = $1 AND pool = 'siege'", [p.accountId]);
}

/** A strong circle packed from units of its own (not the party's). */
async function packStrong(p: Player): Promise<void> {
  const units = [...(await giveUnits(p, 2, "desert.dust_rider", 5)), ...(await giveUnits(p, 2, "desert.well_digger", 5))];
  await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
  const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 12 } });
  expect(res.statusCode, res.body).toBe(201);
  expect((await call(p, "POST", `/me/caravans/${p.caravanId}/trip/start`)).statusCode).toBe(201);
}

function arrangement(m: { units: { ref: string; hp: number }[]; traps: { ref: string; spent: boolean }[]; fences: { ref: string; hp: number }[] }): Formation {
  const postCells = [{ x: 15, y: 13 }, { x: 13, y: 15 }, { x: 17, y: 15 }, { x: 15, y: 17 }];
  return {
    v: 2,
    fences: m.fences.filter((f) => f.hp > 0).map((f, k) => ({ ref: f.ref, segment: k % RING_SEGMENTS.length })),
    traps: m.traps.filter((t) => !t.spent).map((t) => ({ ref: t.ref, cell: { x: 15, y: 9 } })),
    posts: m.units.filter((u) => u.hp > 0).map((u, k) => ({ ref: u.ref, cell: postCells[k]!, stance: "hold" as const })),
  };
}

/** Encounter 1 of `d`'s open trip against the party whose owner display name is `ownerName`; resolved by the real resolver and settled. */
async function fightAgainst(d: Player, ownerName: string): Promise<string> {
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
  expect(s.statusCode, s.body).toBe(201);
  const pick = (s.json().menu.candidates as { candidateId: string; owner: { displayName: string } }[]).find((c) => c.owner.displayName === ownerName);
  expect(pick, `a candidate owned by ${ownerName}`).toBeDefined();
  expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: pick!.candidateId })).statusCode).toBe(200);
  const survivors = (await call(d, "GET", `/caravans/${d.caravanId}/manifest`)).json().manifest.survivors;
  expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, arrangement(survivors))).statusCode).toBe(200);
  const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/1/commit`);
  expect([200, 202], c.body).toContain(c.statusCode);
  const jobId = c.json().jobId as string;
  await drain(pool, { workerId: "acct", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 });
  expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).statusCode).toBe(200);
  expect((await getJob(pool, jobId))!.status).toBe("completed");
  return jobId;
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole, rateLimits: null });
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("guest-first", () => {
  it("POST /auth/guest creates an account with no username or password, its town, party, progress, onboarding and first caravan, and a device cookie the page cannot read", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/guest", payload: { region: "mountain", caravanName: "  Night Train  " } });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b.account).toMatchObject({ username: null, guest: true, coinBalance: 0 });
    expect(b.caravan).toMatchObject({ region_id: "mountain", name: "Night Train", state: "in_town" });
    expect(JSON.stringify(b)).not.toContain(cookieOf(res).split("=")[1]!);
    const line = String(([] as unknown[]).concat(res.headers["set-cookie"]).find((l) => String(l).startsWith(DEVICE_COOKIE)));
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Strict/);
    expect(line).toMatch(/Path=\//);
    expect(line).toMatch(/Max-Age=\d+/);
    const row = (await pool.query("SELECT username, password_hash, linked_at, is_system FROM account WHERE id = $1", [b.account.id])).rows[0];
    expect(row).toEqual({ username: null, password_hash: null, linked_at: null, is_system: false });
    for (const t of ["home_town", "standing_party", "account_onboarding"]) {
      expect((await pool.query(`SELECT 1 FROM ${t} WHERE account_id = $1`, [b.account.id])).rowCount, t).toBe(1);
    }
    expect((await pool.query("SELECT pool FROM pool_progress WHERE account_id = $1 ORDER BY pool", [b.account.id])).rows.map((r) => r.pool)).toEqual(["trap", "siege"]);
    expect((await pool.query("SELECT 1 FROM pool_progress WHERE caravan_id = $1 AND pool = 'living'", [b.caravan.id])).rowCount).toBe(1);
    const me = await call({ token: b.token }, "GET", "/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().account.guest).toBe(true);
    // The whole tutorial plays as a guest: the onboarding guide starts at the first screen.
    expect((await call({ token: b.token }, "GET", "/me/onboarding")).json().onboarding).toMatchObject({ step: "welcome", enrolled: true });
  });

  it("refuses a bad region and a bad caravan name like registration does", async () => {
    expect((await app.inject({ method: "POST", url: "/auth/guest", payload: { region: "atlantis" } })).json().error).toBe("invalid_region");
    expect((await app.inject({ method: "POST", url: "/auth/guest", payload: { region: "desert", caravanName: "   " } })).json().error).toBe("invalid_caravan_name");
    expect((await app.inject({ method: "POST", url: "/auth/guest", payload: {} })).statusCode).toBe(400);
  });

  it("the device cookie survives a reload: /auth/resume answers a fresh bearer session on the same account; no cookie, a forged or an expired one is 401 no_device", async () => {
    const g = await guest();
    const r = await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: `other=1; ${g.cookie}` } });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.account.id).toBe(g.accountId);
    expect(body.token).not.toBe(g.token);
    expect((await call({ token: body.token }, "GET", "/me")).statusCode).toBe(200);
    // Both tabs stay signed in: resume adds a session to the device, it does not replace the first one.
    expect((await call(g, "GET", "/me")).statusCode).toBe(200);
    expect(cookieOf(r)).toBe(g.cookie);

    expect((await app.inject({ method: "POST", url: "/auth/resume" })).json().error).toBe("no_device");
    const forged = await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: `${DEVICE_COOKIE}=${"A".repeat(43)}` } });
    expect([forged.statusCode, forged.json().error]).toEqual([401, "no_device"]);
    expect(String(forged.headers["set-cookie"])).toMatch(/Max-Age=0/);
    await pool.query("UPDATE device SET expires_at = now() - interval '1 second' WHERE account_id = $1", [g.accountId]);
    expect((await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: g.cookie } })).statusCode).toBe(401);
  });

  it("a device keeps at most DEVICE_SESSIONS_MAX sessions; registration and login are devices too", async () => {
    const p = await register();
    const tokens: string[] = [p.token];
    for (let i = 0; i < 4; i++) tokens.push((await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: p.cookie } })).json().token);
    const live = await Promise.all(tokens.map(async (t) => (await call({ token: t }, "GET", "/me")).statusCode));
    expect(live).toEqual([401, 401, 200, 200, 200]);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: p.username, password: "correct horse battery" } });
    expect(cookieOf(login)).not.toBe(p.cookie);
    expect((await pool.query("SELECT count(*)::int AS n FROM device WHERE account_id = $1", [p.accountId])).rows[0].n).toBe(2);
  });
});

describe("linking a guest", () => {
  it("guest → linked keeps the account id, the caravan, its region and everything earned; then logs in with the new credentials", async () => {
    const g = await guest("badlands");
    await giveUnits(g, 2, "desert.dust_rider", 1);
    const before = (await call(g, "GET", "/me")).json();
    const res = await call(g, "POST", "/me/account/link", { username: "  Trail_Boss_7 ", password: "correct horse battery" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().account).toMatchObject({ id: g.accountId, username: "trail_boss_7", guest: false, linkedAt: expect.any(String) });
    const after = (await call(g, "GET", "/me")).json();
    expect(after.caravans).toEqual(before.caravans);
    expect(after.poolProgress).toEqual(before.poolProgress);
    expect(after.account).toMatchObject({ ...before.account, username: "trail_boss_7", guest: false });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "trail_boss_7", password: "correct horse battery" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().account.id).toBe(g.accountId);
    // Once linked: no second link, no rename, no unlink — refused by the route and by the database itself.
    expect((await call(g, "POST", "/me/account/link", { username: unique("x"), password: "correct horse battery" })).json().error).toBe("already_linked");
    expect((await expectDbError(appRole, "UPDATE account SET username = 'renamed' WHERE id = $1", [g.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE account SET username = NULL, password_hash = NULL WHERE id = $1", [g.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE account SET linked_at = now() - interval '1 day' WHERE id = $1", [g.accountId]))?.code).toBe("23514");
    // Region stays one-time per caravan: the caravan's region is still refused a change.
    expect((await expectDbError(appRole, "UPDATE caravan SET region_id = 'desert' WHERE id = $1", [g.caravanId]))?.code).toBe("23514");
  });

  it("refuses a taken username, a reserved one, a short password; a username without a password cannot exist", async () => {
    const taken = await register();
    const g = await guest();
    expect((await call(g, "POST", "/me/account/link", { username: taken.username, password: "correct horse battery" })).json().error).toBe("username_taken");
    expect((await call(g, "POST", "/me/account/link", { username: "sys_outfit_mine", password: "correct horse battery" })).json().error).toBe("reserved_username");
    expect((await call(g, "POST", "/me/account/link", { username: unique("ok"), password: "short" })).json().error).toBe("invalid_password");
    expect((await call(g, "POST", "/me/account/link", { username: "no", password: "correct horse battery" })).json().error).toBe("invalid_username");
    expect((await expectDbError(appRole, "UPDATE account SET username = 'half_linked' WHERE id = $1", [g.accountId]))?.code).toBe("23514");
    expect((await call(g, "GET", "/me")).json().account.guest).toBe(true);
  });
});

describe("devices and sign-out", () => {
  it("lists this account's devices (the current one flagged), revokes one or every other one, and refuses a foreign or malformed id", async () => {
    const p = await register();
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15";
    const second = await app.inject({ method: "POST", url: "/auth/login", payload: { username: p.username, password: "correct horse battery" }, headers: { "user-agent": ua } });
    const other = { token: second.json().token as string };
    const list = (await call(p, "GET", "/me/devices")).json().devices as { id: string; label: string; current: boolean }[];
    expect(list).toHaveLength(2);
    expect(list.filter((d) => d.current)).toHaveLength(1);
    expect(list.map((d) => d.label)).toContain("Safari on macOS");
    const otherId = list.find((d) => !d.current)!.id;
    const stranger = await register();
    expect((await call(stranger, "DELETE", `/me/devices/${otherId}`)).statusCode).toBe(404);
    expect((await call(p, "DELETE", "/me/devices/not-a-uuid")).statusCode).toBe(404);
    expect((await call(p, "DELETE", `/me/devices/${otherId}`)).statusCode).toBe(204);
    expect((await call(other, "GET", "/me")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: cookieOf(second) } })).statusCode).toBe(401);
    // revoke-others
    for (let i = 0; i < 2; i++) await app.inject({ method: "POST", url: "/auth/login", payload: { username: p.username, password: "correct horse battery" } });
    expect((await call(p, "POST", "/me/devices/revoke-others")).json()).toEqual({ revoked: 2 });
    expect((await call(p, "GET", "/me/devices")).json().devices).toHaveLength(1);
    expect((await call(p, "GET", "/me/account")).json()).toMatchObject({ account: { id: p.accountId, guest: false }, deletion: { confirmPhrase: DELETE_CONFIRM_PHRASE, requiresPassword: true } });
  });

  it("a guest cannot sign out or revoke its own device by accident (it would lose the account); with abandon: true it can", async () => {
    const g = await guest();
    const current = ((await call(g, "GET", "/me/devices")).json().devices as { id: string; current: boolean }[]).find((d) => d.current)!;
    expect((await call(g, "DELETE", `/me/devices/${current.id}`)).json().error).toBe("guest_sign_out");
    expect((await call(g, "POST", "/auth/logout")).json().error).toBe("guest_sign_out");
    expect((await call(g, "GET", "/me")).statusCode).toBe(200);
    const out = await call(g, "POST", "/auth/logout", { abandon: true });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: g.cookie } })).statusCode).toBe(401);
  });

  it("a linked sign-out forgets the device: its sessions and its cookie", async () => {
    const p = await register();
    const tab2 = (await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: p.cookie } })).json().token as string;
    expect((await call(p, "POST", "/auth/logout")).statusCode).toBe(204);
    expect((await call({ token: tab2 }, "GET", "/me")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: p.cookie } })).statusCode).toBe(401);
  });

  it("labels say browser and platform, nothing finer", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Firefox on Linux");
    expect(deviceLabel(undefined)).toBe("Unknown device");
  });
});

describe("rate limits", () => {
  const small: RateLimitConfig = { ...RATE_LIMITS, loginPerIp: { limit: 6, windowMs: 60_000 }, loginPerUsername: { limit: 3, windowMs: 60_000 }, registerPerIp: { limit: 2, windowMs: 60_000 }, guestPerIp: { limit: 2, windowMs: 60_000 }, linkPerAccount: { limit: 2, windowMs: 60_000 }, exportPerAccount: { limit: 1, windowMs: 60_000 } };
  let limited: FastifyInstance;
  let clock = 1_000_000;
  beforeAll(async () => {
    limited = await buildApp({ db: appRole, rateLimits: small, rateLimitClock: () => clock });
  });
  afterAll(async () => limited.close());

  const login = (username: string, password: string, ip = "10.0.0.1") => limited.inject({ method: "POST", url: "/auth/login", payload: { username, password }, remoteAddress: ip });

  it("login: per username across addresses, per address across usernames, 429 with Retry-After and retryAfterMs, and the window resets", async () => {
    const p = await register();
    for (let i = 0; i < 3; i++) expect((await login(p.username!, "wrong password", `10.1.0.${i}`)).statusCode).toBe(401);
    const over = await login(p.username!, "correct horse battery", "10.1.0.9");
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: "rate_limited", retryAfterMs: expect.any(Number) });
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    clock += 60_000;
    expect((await login(p.username!, "correct horse battery", "10.1.0.9")).statusCode).toBe(200);
    // Per address: six attempts at six different usernames, then the seventh is refused before any hash runs.
    for (let i = 0; i < 6; i++) expect((await login(`nobody_${i}`, "whatever pass", "10.2.0.1")).statusCode).toBe(401);
    expect((await login("nobody_7", "whatever pass", "10.2.0.1")).statusCode).toBe(429);
    expect((await login("nobody_7", "whatever pass", "10.2.0.2")).statusCode).toBe(401);
  });

  it("registration and guest creation are limited per address; link and export per account", async () => {
    const reg = (ip: string) => limited.inject({ method: "POST", url: "/auth/register", payload: { username: unique("rl"), password: "correct horse battery", region: "desert" }, remoteAddress: ip });
    expect((await reg("10.3.0.1")).statusCode).toBe(201);
    expect((await reg("10.3.0.1")).statusCode).toBe(201);
    expect((await reg("10.3.0.1")).statusCode).toBe(429);
    expect((await reg("10.3.0.2")).statusCode).toBe(201);
    const g1 = await limited.inject({ method: "POST", url: "/auth/guest", payload: { region: "desert" }, remoteAddress: "10.4.0.1" });
    await limited.inject({ method: "POST", url: "/auth/guest", payload: { region: "desert" }, remoteAddress: "10.4.0.1" });
    expect((await limited.inject({ method: "POST", url: "/auth/guest", payload: { region: "desert" }, remoteAddress: "10.4.0.1" })).statusCode).toBe(429);
    const g = { token: g1.json().token as string };
    expect((await call(g, "POST", "/me/account/link", { username: "no", password: "correct horse battery" }, {}, limited)).statusCode).toBe(400);
    expect((await call(g, "POST", "/me/account/link", { username: "no", password: "correct horse battery" }, {}, limited)).statusCode).toBe(400);
    expect((await call(g, "POST", "/me/account/link", { username: unique("ok"), password: "correct horse battery" }, {}, limited)).statusCode).toBe(429);
    expect((await call(g, "GET", "/me/export", undefined, {}, limited)).statusCode).toBe(200);
    expect((await call(g, "GET", "/me/export", undefined, {}, limited)).statusCode).toBe(429);
  });

  it("CARAVAN_RATE_LIMITS=off is refused in production and anything but on/off is refused", async () => {
    const { rateLimitsFromEnv } = await import("../src/account/rateLimit.js");
    expect(rateLimitsFromEnv({})).toBe(RATE_LIMITS);
    expect(rateLimitsFromEnv({ CARAVAN_RATE_LIMITS: "off", NODE_ENV: "test" })).toBeNull();
    expect(() => rateLimitsFromEnv({ CARAVAN_RATE_LIMITS: "off", NODE_ENV: "production" })).toThrow(/production/);
    expect(() => rateLimitsFromEnv({ CARAVAN_RATE_LIMITS: "maybe" })).toThrow();
  });
});

describe("export", () => {
  it("is the player's own data as JSON — account, caravans, roster, ledger, purchases, devices — with no secret and no other player's id", async () => {
    const p = await register();
    const store = (await call(p, "GET", "/me/store")).json();
    expect((await call(p, "POST", "/me/store/purchase", { tier: 1, weekIndex: store.week.index, contentsHash: store.offers[0].contentsHash })).statusCode).toBe(201);
    const res = await call(p, "GET", "/me/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="caravan-vaults-export-/);
    const x = res.json();
    expect(x).toMatchObject({ format: "caravan-vaults-account-export", version: 1, account: { id: p.accountId, username: p.username, guest: false } });
    expect(x.caravans).toHaveLength(1);
    expect(x.caravans[0].id).toBe(p.caravanId);
    expect(x.purchases).toHaveLength(1);
    expect(x.ledger.some((e: { event_type: string }) => e.event_type === "coin_purchased")).toBe(true);
    expect(x.devices).toHaveLength(1);
    const text = res.body;
    for (const secret of ["password_hash", "token_hash", "scrypt$"]) expect(text).not.toContain(secret);
    expect(text).not.toContain(p.token);
    expect(text).not.toContain(p.cookie.split("=")[1]!);
  });
});

// ── deletion: the definition-of-done round trip ─────────────────────────────────────────

describe("deletion (DoD): guest → linked → deleted, and the other participants' replays stay playable", () => {
  let x: Player; // the account that is deleted
  let y: Player; // a party owner whose party struck X's caravan
  let z: Player; // a defender whose caravan X's party struck
  let fillers: Player[];
  let jobXDefended: string;
  let jobXStruck: string;
  let xCaravanIds: string[];

  beforeAll(async () => {
    // X starts as a guest, plays, links.
    x = await guest();
    await link(x);
    await raiseParty(x);
    fillers = [];
    for (let i = 0; i < 2; i++) {
      const f = await register();
      await raiseParty(f);
      fillers.push(f);
    }
    // Z meets X's party (only X and the two fillers are servable yet, so X is on Z's menu).
    z = await register();
    await packStrong(z);
    jobXStruck = await fightAgainst(z, x.username!);
    // Y raises a party; X's caravan meets it.
    y = await register();
    await raiseParty(y);
    await packStrong(x);
    jobXDefended = await fightAgainst(x, y.username!);
    // X buys a pack (a purchase record that must go).
    const store = (await call(x, "GET", "/me/store")).json();
    expect((await call(x, "POST", "/me/store/purchase", { tier: 1, weekIndex: store.week.index, contentsHash: store.offers[0].contentsHash })).statusCode).toBe(201);
    // Chunk 29 / 24 state of X's own: inbox read marks and preferences, the onboarding marker.
    expect((await call(x, "PUT", "/me/inbox/preferences", { preferences: { refugees_arrived: true } })).statusCode).toBe(200);
    const xItems = (await call(x, "GET", "/me/inbox")).json().items as { key: string; version: number }[];
    const mark = await call(x, "POST", "/me/inbox/read", { marks: xItems.slice(0, 1).map((i) => ({ key: i.key, version: i.version })) });
    expect(mark.statusCode, mark.body).toBe(200);
    await pool.query("INSERT INTO inbox_read (account_id, item_key, version) VALUES ($1, 'test:mark', 1) ON CONFLICT DO NOTHING", [x.accountId]);
    expect((await call(x, "POST", "/me/onboarding/advance", { step: "roster" })).statusCode).toBe(200);
    xCaravanIds = (await pool.query("SELECT id FROM caravan WHERE account_id = $1", [x.accountId])).rows.map((r) => r.id as string);
    expect((await getJob(pool, jobXStruck))!.input).toMatchObject({ partyOwnerAccountId: x.accountId, defenderAccountId: z.accountId });
    expect((await getJob(pool, jobXDefended))!.input).toMatchObject({ partyOwnerAccountId: y.accountId, defenderAccountId: x.accountId });
    // Both replays render before the deletion.
    for (const [who, job] of [[y, jobXDefended], [z, jobXStruck]] as const) {
      const r = await call(who, "GET", `/me/encounters/${job}/replay`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().renderable).toBe(true);
    }
  });

  it("asks for the typed phrase and (once linked) the password", async () => {
    expect((await call(x, "POST", "/me/account/delete", {})).json().error).toBe("confirm_required");
    expect((await call(x, "POST", "/me/account/delete", { confirm: "yes" })).json().error).toBe("confirm_required");
    expect((await call(x, "POST", "/me/account/delete", { confirm: DELETE_CONFIRM_PHRASE })).json().error).toBe("password_required");
    expect((await call(x, "POST", "/me/account/delete", { confirm: DELETE_CONFIRM_PHRASE, password: "wrong password" })).json().error).toBe("wrong_password");
    expect((await call(x, "GET", "/me")).statusCode).toBe(200);
  });

  it("deletes the account, its caravans, its party, its purchases, its sessions and devices — and its own ledger rows", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE account_id = $1", [x.accountId])).rows[0].n as number;
    expect(before).toBeGreaterThan(0);
    const res = await call(x, "POST", "/me/account/delete", { confirm: DELETE_CONFIRM_PHRASE, password: "correct horse battery" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, counts: { fightsDefendedKept: 1, replaysDefendedAnonymized: 1, fightsStruckAnonymized: 1, replaysStruckAnonymized: 1, purchasesDeleted: 1, caravansDeleted: 1 } });
    expect(String(res.headers["set-cookie"])).toMatch(/Max-Age=0/);
    expect((await call(x, "GET", "/me")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/resume", headers: { cookie: x.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { username: x.username, password: "correct horse battery" } })).statusCode).toBe(401);
    for (const [t, col] of [["account", "id"], ["caravan", "account_id"], ["standing_party", "account_id"], ["pack_purchase", "account_id"], ["cosmetic_ownership", "account_id"], ["session", "account_id"], ["device", "account_id"], ["ledger_event", "account_id"], ["home_town", "account_id"], ["pool_progress", "account_id"], ["inbox_read", "account_id"], ["inbox_preference", "account_id"], ["account_onboarding", "account_id"]] as const) {
      expect((await pool.query(`SELECT 1 FROM ${t} WHERE ${col} = $1`, [x.accountId])).rowCount, t).toBe(0);
    }
    expect((await pool.query("SELECT 1 FROM unit_instance WHERE caravan_id = ANY($1::uuid[])", [xCaravanIds])).rowCount).toBe(0);
    // The username is free again: a later player may take it (the old one is gone, not reserved).
    expect((await pool.query("SELECT 1 FROM account WHERE username = $1", [x.username])).rowCount).toBe(0);
  });

  it("the party owner's replay of the fight X defended still renders, and so does the defender's replay of the fight X's party struck", async () => {
    const yr = await call(y, "GET", `/me/encounters/${jobXDefended}/replay`);
    expect(yr.statusCode, yr.body).toBe(200);
    expect(yr.json()).toMatchObject({ viewer: "party_owner", renderable: true });
    expect(yr.json().log).not.toBeNull();
    const zr = await call(z, "GET", `/me/encounters/${jobXStruck}/replay`);
    expect(zr.statusCode, zr.body).toBe(200);
    expect(zr.json()).toMatchObject({ viewer: "caravan", renderable: true });
    for (const r of [yr, zr]) expect(r.body).not.toContain(x.accountId);
  });

  it("the job records still replay deterministically (verifyJobReplay) and every other participant's ledger still rebuilds to its live balances", async () => {
    for (const job of [jobXDefended, jobXStruck]) {
      const check = await verifyJobReplay(pool, DEFAULT_HANDLERS, job);
      expect(check.ok, job).toBe(true);
    }
    for (const p of [y, z, ...fillers]) {
      const v = await verifyProjection(pool, p.accountId);
      expect(v.ok, p.username ?? p.accountId).toBe(true);
    }
  });

  it("their feeds still show the strike, naming nobody", async () => {
    const feed = (await call(y, "GET", "/me/party/feed")).json().entries as { jobId: string; defender: Record<string, unknown> }[];
    const entry = feed.find((e) => e.jobId === jobXDefended);
    expect(entry).toBeDefined();
    expect(entry!.defender).toMatchObject({ username: null, caravanName: null, regionId: null });
    const inbox = await call(y, "GET", "/me/inbox");
    expect(inbox.statusCode).toBe(200);
    expect(inbox.body).not.toContain(x.username!);
    // Z's trip goes on: the stored menu shows the departed owner under a generic name.
    const menu = (await pool.query("SELECT candidates FROM encounter_candidates ec JOIN trip t ON t.id = ec.trip_id WHERE t.caravan_id = $1", [z.caravanId])).rows;
    expect(JSON.stringify(menu)).toContain("Departed outfit");
    expect(JSON.stringify(menu)).not.toContain(x.username!);
    expect((await call(z, "GET", `/me/caravans/${z.caravanId}/trip`)).statusCode).toBe(200);
  });

  it("no row in any table still names the deleted account, its caravans or its username", async () => {
    const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")).rows.map((r) => r.table_name);
    const needles = [x.accountId, ...xCaravanIds, `"${x.username}"`];
    for (const t of tables) {
      const hits = await pool.query(`SELECT count(*)::int AS n FROM ${t} r WHERE ${needles.map((_, i) => `position($${i + 1} in to_jsonb(r)::text) > 0`).join(" OR ")}`, needles);
      expect(hits.rows[0].n, `${t} still names the deleted account`).toBe(0);
    }
  });

  it("the erasure is audited — when, a guest or not, how many rows — and the audit names nobody", async () => {
    const audit = await pool.query("SELECT * FROM account_erasure_audit ORDER BY erased_at DESC LIMIT 1");
    expect(audit.rows[0]).toMatchObject({ reason: "player_request", was_guest: false });
    expect(JSON.stringify(audit.rows[0])).not.toContain(x.accountId);
    expect((await pool.query("SELECT count(*)::int AS n FROM account_erasure_active")).rows[0].n).toBe(0);
  });

  it("a party owner deleted while another player's fight against their party is still queued: the fight resolves and settles against the tombstone, which is paid nothing", async () => {
    const v = await register();
    await raiseParty(v);
    // Exactly three servable parties in band (V and the fillers), so V is on the menu.
    await pool.query("UPDATE pool_progress SET reputation = 100000 WHERE account_id = $1 AND pool = 'siege'", [y.accountId]);
    const w = await register();
    await packStrong(w);
    const s = await call(w, "POST", `/me/caravans/${w.caravanId}/encounters/1/search`);
    expect(s.statusCode, s.body).toBe(201);
    const pick = (s.json().menu.candidates as { candidateId: string; owner: { displayName: string } }[]).find((c) => c.owner.displayName === v.username)!;
    expect(pick).toBeDefined();
    expect((await call(w, "POST", `/me/caravans/${w.caravanId}/encounters/1/choose`, { candidateId: pick.candidateId })).statusCode).toBe(200);
    const survivors = (await call(w, "GET", `/caravans/${w.caravanId}/manifest`)).json().manifest.survivors;
    expect((await call(w, "PUT", `/caravans/${w.caravanId}/encounters/1/formation`, arrangement(survivors))).statusCode).toBe(200);
    const jobId = (await call(w, "POST", `/me/caravans/${w.caravanId}/trip/encounters/1/commit`)).json().jobId as string;
    expect((await getJob(pool, jobId))!.status).toBe("queued");
    const del = await call(v, "POST", "/me/account/delete", { confirm: DELETE_CONFIRM_PHRASE, password: "correct horse battery" });
    expect(del.statusCode, del.body).toBe(200);
    const tomb = (await pool.query("SELECT account_erasure_tombstone_account() AS t")).rows[0].t as string;
    expect(((await getJob(pool, jobId))!.input as EncounterJobInput).partyOwnerAccountId).toBe(tomb);
    const ran = await drain(pool, { workerId: "acct", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 });
    const st = await call(w, "GET", `/me/caravans/${w.caravanId}/trip`);
    expect(st.statusCode, `${st.body} ${JSON.stringify(ran)}`).toBe(200);
    expect((await getJob(pool, jobId))!.status).toBe("completed");
    const r = await call(w, "GET", `/me/encounters/${jobId}/replay`);
    expect([r.statusCode, r.json().renderable]).toEqual([200, true]);
    expect((await pool.query("SELECT coin_balance FROM account WHERE id = $1", [tomb])).rows[0].coin_balance).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE account_id = $1 AND event_type::text LIKE 'coin%'", [tomb])).rows[0].n).toBe(0);
    expect((await verifyJobReplay(pool, DEFAULT_HANDLERS, jobId)).ok).toBe(true);
    expect((await verifyProjection(pool, w.accountId)).ok).toBe(true);
  });

  it("a guest that never linked deletes with the phrase alone", async () => {
    const g = await guest();
    expect((await call(g, "GET", "/me/account")).json().deletion).toEqual({ confirmPhrase: DELETE_CONFIRM_PHRASE, requiresPassword: false });
    const res = await call(g, "POST", "/me/account/delete", { confirm: DELETE_CONFIRM_PHRASE });
    expect(res.statusCode, res.body).toBe(200);
    expect((await pool.query("SELECT 1 FROM account WHERE id = $1", [g.accountId])).rowCount).toBe(0);
    expect((await pool.query("SELECT was_guest FROM account_erasure_audit ORDER BY erased_at DESC LIMIT 1")).rows[0].was_guest).toBe(true);
  });
});

describe("the anonymization exception, as the app role", () => {
  let y: Player;
  let jobId: string;
  beforeAll(async () => {
    // A completed fight kept for its party owner after its defender was deleted (from the suite above).
    const row = (await pool.query("SELECT id, input FROM resolution_job WHERE account_id = account_erasure_tombstone_account() LIMIT 1")).rows[0];
    jobId = row.id;
    y = { token: "", accountId: (row.input as EncounterJobInput).partyOwnerAccountId, caravanId: "", cookie: "", username: null, units: [] };
  });

  it("cannot open it: account_erasure_active and the audit are not writable", async () => {
    const r = await expectDbError(appRole, "INSERT INTO account_erasure_active (txid, map) VALUES (txid_current(), '{}')");
    expect(r?.code).toBe("42501");
    expect((await expectDbError(appRole, "DELETE FROM account_erasure_audit"))?.code).toBe("42501");
    expect((await expectDbError(appRole, "UPDATE account_erasure_audit SET was_guest = NOT was_guest"))?.code).toBe("42501");
  });

  it("without an active erasure every guarded row is as immutable as before — even an id-for-tombstone swap", async () => {
    const tomb = (await pool.query("SELECT account_erasure_tombstone_account() AS t")).rows[0].t as string;
    // Even a no-op UPDATE is refused: an unchanged row is not "exactly the rewrite" of anything.
    expect((await expectDbError(appRole, "UPDATE ledger_event SET payload = payload WHERE account_id = $1", [y.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE ledger_event SET payload = payload || '{\"x\":1}' WHERE account_id = $1", [y.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE resolution_job SET input = jsonb_set(input, '{partyOwnerAccountId}', to_jsonb($2::text)) WHERE id = $1", [jobId, tomb]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE encounter_log SET party_owner_account_id = $2 WHERE job_id = $1", [jobId, tomb]))?.code).toBe("42501");
    expect((await expectDbError(appRole, "UPDATE trip_encounter SET party_owner_account_id = $1 WHERE job_id = $2", [tomb, jobId]))).toBeNull(); // no such row (its trip went with the caravan)
    // The anonymized row cannot be pointed back at anyone (here: the party owner's account).
    const te = (await pool.query("SELECT trip_id, encounter_index FROM trip_encounter WHERE party_owner_account_id = $1 LIMIT 1", [tomb])).rows[0];
    expect((await expectDbError(appRole, "UPDATE trip_encounter SET party_owner_account_id = $3 WHERE trip_id = $1 AND encounter_index = $2", [te.trip_id, te.encounter_index, y.accountId]))?.code).toBe("23514");
    const ec = (await pool.query("SELECT trip_id, encounter_index, search_seq FROM encounter_candidates LIMIT 1")).rows[0];
    expect((await expectDbError(appRole, "UPDATE encounter_candidates SET candidates = '[]' WHERE trip_id = $1 AND encounter_index = $2 AND search_seq = $3", [ec.trip_id, ec.encounter_index, ec.search_seq]))?.code).toBe("23514");
    // The owner role too: the exception is the active-erasure row, not the role.
    expect((await expectDbError(pool, "UPDATE ledger_event SET payload = payload || '{\"x\":1}' WHERE account_id = $1", [y.accountId]))?.code).toBe("23514");
  });

  it("even while an erasure is active (as the owner, by hand) only the exact rewrite passes — any other edit is refused", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ev = (await client.query("SELECT seq, payload FROM ledger_event WHERE account_id = $1 LIMIT 1", [y.accountId])).rows[0];
      await client.query("INSERT INTO account_erasure_active (txid, map) VALUES (txid_current(), $1)", [JSON.stringify({ [y.accountId]: "00000000-0000-4000-8000-0000000000d0" })]);
      const err = await client.query("UPDATE ledger_event SET payload = payload || '{\"forged\":true}' WHERE seq = $1", [ev.seq]).then(() => null, (e: { code?: string }) => e);
      expect(err?.code).toBe("23514");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("account_erase refuses a system account (the tombstone included) and an unknown id", async () => {
    const tomb = (await pool.query("SELECT account_erasure_tombstone_account() AS t")).rows[0].t as string;
    expect((await expectDbError(appRole, "SELECT account_erase($1, 'x')", [tomb]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "SELECT account_erase($1, 'x')", ["00000000-0000-4000-8000-00000000ffff"]))?.code).toBe("P0002");
  });

  it("account_erase needs the caller's own live RAW bearer token: not a stored hash, not another account's token, not an expired one", async () => {
    const victim = await register();
    const attacker = await register();
    const hash = (await pool.query("SELECT token_hash FROM session WHERE account_id = $1 LIMIT 1", [victim.accountId])).rows[0].token_hash as string;
    // Everything the app role can read: the account id and the stored hash. Neither is enough.
    expect((await expectDbError(appRole, "SELECT account_erase($1, $2)", [victim.accountId, hash]))?.code).toBe("42501");
    expect((await expectDbError(appRole, "SELECT account_erase($1, $2)", [victim.accountId, attacker.token]))?.code).toBe("42501");
    expect((await expectDbError(appRole, "SELECT account_erase($1, NULL)", [victim.accountId]))?.code).toBe("42501");
    await pool.query("UPDATE session SET expires_at = now() - interval '1 second' WHERE account_id = $1", [victim.accountId]);
    expect((await expectDbError(appRole, "SELECT account_erase($1, $2)", [victim.accountId, victim.token]))?.code).toBe("42501");
    expect((await pool.query("SELECT 1 FROM account WHERE id = $1", [victim.accountId])).rowCount).toBe(1);
    // With its own live token it goes.
    const fresh = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: victim.username, password: "correct horse battery" } })).json().token as string;
    expect((await expectDbError(appRole, "SELECT account_erase($1, $2)", [victim.accountId, fresh]))).toBeNull();
    expect((await pool.query("SELECT 1 FROM account WHERE id = $1", [victim.accountId])).rowCount).toBe(0);
    expect((await expectDbError(appRole, "SELECT 1 FROM account_erasure_active"))).toBeNull(); // readable (the guards read it)
  });
});

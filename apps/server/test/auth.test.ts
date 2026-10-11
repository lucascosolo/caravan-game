/**
 * Auth: register, log in, get a session, authorize a request. Nothing fancy.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let app: FastifyInstance;

beforeAll(async () => {
  await truncateAll(pool);
  app = await buildApp({ db: pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("auth flow", () => {
  const username = unique("player");
  const password = "correct horse battery";
  let token: string;

  it("GET /health works", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("registers an account with a caravan in the chosen region and returns a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: username.toUpperCase(), password, region: "desert" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe("string");
    expect(body.account.username).toBe(username);
    expect(body.account.coinBalance).toBe(0);
    expect(body.account.coinStorageCap).toBe(50_000);
    expect(body.account.password_hash).toBeUndefined();
    expect(body.caravan.region_id).toBe("desert");
    expect(body.caravan.state).toBe("in_town");
    token = body.token;
  });

  it("rejects a duplicate username, bad region, short password, bad username", async () => {
    const dup = await app.inject({ method: "POST", url: "/auth/register", payload: { username, password, region: "desert" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("username_taken");
    const region = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("x"), password, region: "moon" } });
    expect(region.statusCode).toBe(400);
    const short = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("x"), password: "short", region: "desert" } });
    expect(short.statusCode).toBe(400);
    const badName = await app.inject({ method: "POST", url: "/auth/register", payload: { username: "a b", password, region: "desert" } });
    expect(badName.statusCode).toBe(400);
    const noBody = await app.inject({ method: "POST", url: "/auth/register" });
    expect(noBody.statusCode).toBe(400);
  });

  it("authorizes a request with the session token", async () => {
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.account.username).toBe(username);
    expect(Array.isArray(body.caravans)).toBe(true);
    expect(body.caravans).toHaveLength(1);
    expect(body.caravans[0].units).toEqual([]);
    expect(body.poolProgress.map((p: { pool: string }) => p.pool).sort()).toEqual(["living", "siege", "trap"]);
  });

  it("rejects missing, malformed and unknown tokens", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: "Basic abc" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
  });

  it("logs in with the right password and not the wrong one", async () => {
    const bad = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "wrong password" } });
    expect(bad.statusCode).toBe(401);
    const unknown = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "nobody_here", password } });
    expect(unknown.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).not.toBe(token);
    const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${ok.json().token}` } });
    expect(me.statusCode).toBe(200);
  });

  it("logout revokes the session; an expired session is not accepted", async () => {
    const out = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
    const fresh = login.json().token as string;
    await pool.query("UPDATE session SET expires_at = now() - interval '1 second'");
    const expired = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${fresh}` } });
    expect(expired.statusCode).toBe(401);
  });

  it("stores only a hash of the token and of the password", async () => {
    const sessions = await pool.query<{ token_hash: string }>("SELECT token_hash FROM session");
    for (const s of sessions.rows) expect(s.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const acct = await pool.query<{ password_hash: string }>("SELECT password_hash FROM account WHERE username = $1", [username]);
    expect(acct.rows[0]!.password_hash.startsWith("scrypt$")).toBe(true);
    expect(acct.rows[0]!.password_hash).not.toContain(password);
  });
});

/**
 * Chunk 24: onboarding progress (PHASE-2 §24). Account-level, forward-only, skippable after the
 * first screen, and a marker only: walking it end to end grants no Coin, no unit, no unlock
 * point and writes no ledger event.
 */
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ONBOARDING_STEPS } from "../src/onboarding/steps.js";
import { markOnboardingDone } from "../src/onboarding/service.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  // The server's own DML-only role, as in production.
  app = await buildApp({ db: appRole });
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

async function register(): Promise<{ token: string; accountId: string; caravanId: string }> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("newbie"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  return { token: b.token, accountId: b.account.id, caravanId: b.caravan.id };
}

function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function holdings(accountId: string, caravanId: string): Promise<{ coin: number; units: number; events: number; points: number }> {
  const coin = await pool.query<{ coin_balance: string }>("SELECT coin_balance FROM account WHERE id = $1", [accountId]);
  const units = await pool.query<{ n: string }>("SELECT count(*) AS n FROM unit_instance WHERE caravan_id = $1", [caravanId]);
  const events = await pool.query<{ n: string }>("SELECT count(*) AS n FROM ledger_event WHERE account_id = $1", [accountId]);
  const points = await pool.query<{ n: string }>(
    "SELECT COALESCE(sum(unlock_points_granted), 0) AS n FROM pool_progress WHERE account_id = $1 OR caravan_id = $2",
    [accountId, caravanId],
  );
  return { coin: Number(coin.rows[0]!.coin_balance), units: Number(units.rows[0]!.n), events: Number(events.rows[0]!.n), points: Number(points.rows[0]!.n) };
}

describe("onboarding (chunk 24)", () => {
  it("the server's step list matches migration 017's CHECK and rank function", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(path.resolve(here, "../migrations/017_onboarding.up.sql"), "utf8");
    const quoted = ONBOARDING_STEPS.map((s) => `'${s}'`).join(", ");
    expect(sql).toContain(`step IN (${quoted})`);
    expect(sql).toContain(`ARRAY[${quoted}]`);
  });

  it("a new account starts at the first screen; it cannot be skipped there", async () => {
    const p = await register();
    const res = await call(p.token, "GET", "/me/onboarding");
    expect(res.statusCode).toBe(200);
    expect(res.json().onboarding).toMatchObject({ step: "welcome", enrolled: true, completed: false, skipped: false, canSkip: false, steps: [...ONBOARDING_STEPS] });
    const skip = await call(p.token, "POST", "/me/onboarding/skip");
    expect(skip.statusCode).toBe(409);
    expect(skip.json().error).toBe("onboarding_first_screen");
    // The progress is on the ACCOUNT (GUARDRAILS §5): there is no caravan column at all.
    const cols = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'account_onboarding'");
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["account_id", "completed_at", "created_at", "skipped_at", "step", "updated_at"]);
  });

  it("advances forward only: an earlier or equal step is a no-op, an unknown one a 400", async () => {
    const p = await register();
    const a = await call(p.token, "POST", "/me/onboarding/advance", { step: "roster" });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ changed: true, onboarding: { step: "roster", canSkip: true } });
    const jump = await call(p.token, "POST", "/me/onboarding/advance", { step: "scout" });
    expect(jump.json()).toMatchObject({ changed: true, onboarding: { step: "scout" } });
    const back = await call(p.token, "POST", "/me/onboarding/advance", { step: "roster" });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ changed: false, onboarding: { step: "scout" } });
    const same = await call(p.token, "POST", "/me/onboarding/advance", { step: "scout" });
    expect(same.json().changed).toBe(false);
    const bad = await call(p.token, "POST", "/me/onboarding/advance", { step: "attack" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_step");
    const anon = await app.inject({ method: "GET", url: "/me/onboarding" });
    expect(anon.statusCode).toBe(401);
  });

  it("skip after the first screen finishes the guide for good", async () => {
    const p = await register();
    await call(p.token, "POST", "/me/onboarding/advance", { step: "roster" });
    const s = await call(p.token, "POST", "/me/onboarding/skip");
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ changed: true, onboarding: { step: "done", completed: true, skipped: true, canSkip: false } });
    const again = await call(p.token, "POST", "/me/onboarding/skip");
    expect(again.json()).toMatchObject({ changed: false, onboarding: { step: "done", skipped: true } });
    const reopen = await call(p.token, "POST", "/me/onboarding/advance", { step: "welcome" });
    expect(reopen.json()).toMatchObject({ changed: false, onboarding: { step: "done" } });
  });

  it("the schema holds the rules against the server's own role: no step back, a finished guide stays finished", async () => {
    const p = await register();
    await call(p.token, "POST", "/me/onboarding/advance", { step: "outfit" });
    const back = await expectDbError(appRole, "UPDATE account_onboarding SET step = 'welcome' WHERE account_id = $1", [p.accountId]);
    expect(back?.message).toMatch(/cannot move back/);
    const unknown = await expectDbError(appRole, "UPDATE account_onboarding SET step = 'raid' WHERE account_id = $1", [p.accountId]);
    expect(unknown?.code).toBe("23514");
    await call(p.token, "POST", "/me/onboarding/advance", { step: "done" });
    const reopen = await expectDbError(appRole, "UPDATE account_onboarding SET completed_at = NULL, step = 'done' WHERE account_id = $1", [p.accountId]);
    expect(reopen).not.toBeNull();
  });

  it("walking every step grants nothing: Coin, units, unlock points and the ledger are untouched", async () => {
    const p = await register();
    const before = await holdings(p.accountId, p.caravanId);
    expect(before.coin).toBe(0);
    expect(before.units).toBe(0);
    for (const step of ONBOARDING_STEPS.slice(1)) {
      const r = await call(p.token, "POST", "/me/onboarding/advance", { step });
      expect(r.statusCode).toBe(200);
      expect(r.json().onboarding.step).toBe(step);
    }
    expect(await holdings(p.accountId, p.caravanId)).toEqual(before);
    const done = (await call(p.token, "GET", "/me/onboarding")).json().onboarding;
    expect(done).toMatchObject({ step: "done", completed: true, skipped: false });
  });

  it("an account with no row (made before chunk 24, or a fixture marked done) reads as done", async () => {
    const p = await register();
    await pool.query("DELETE FROM account_onboarding WHERE account_id = $1", [p.accountId]);
    const res = (await call(p.token, "GET", "/me/onboarding")).json().onboarding;
    expect(res).toMatchObject({ step: "done", enrolled: false, completed: true, canSkip: false });
    const adv = await call(p.token, "POST", "/me/onboarding/advance", { step: "roster" });
    expect(adv.json()).toMatchObject({ changed: false, onboarding: { step: "done" } });
    await markOnboardingDone(appRole, p.accountId);
    expect((await call(p.token, "GET", "/me/onboarding")).json().onboarding).toMatchObject({ step: "done", enrolled: true, completed: true, skipped: false });
  });
});

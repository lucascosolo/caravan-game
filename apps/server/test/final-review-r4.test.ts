/**
 * Final guardrail review, round 4 (roadmap/qa/final-guardrail-review-r4.md):
 *   S1  a caravan is never stranded: the authored-only filter runs before the raider cap, a search
 *       that cannot fill a menu is 409 `pool_empty` with `returnToTown`, and "Return to town"
 *       (POST …/trip/return) voids the trip through the void path — only when no menu can be filled;
 *   D1  the bands 0–1 packed-unit cap is keyed on the caravan's band (matchmaking-pure covers the rule;
 *       matchmaking.test.ts the stored record), and the suggested party stops at SUGGESTED_PARTY_MAX;
 *   N1  PUBLIC can neither connect to the database nor execute any function in it;
 *   N4  a menu drawn under another resolver version or content hash is never chosen or committed
 *       (409 `menu_stale`); the player searches again at once and chooses from the fresh menu.
 * The pool-empty case needs a database WITHOUT the authored set, so this file seeds it only after it.
 */
import { TUNABLES } from "@caravan/content";
import { RESOLVER_VERSION } from "@caravan/resolver";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { suggestParty } from "../src/party/service.js";
import { resolveTestDatabaseUrl } from "./db-url.js";
import { appRolePool, seasonCaravan, testPool, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
}

beforeAll(async () => {
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

function call(p: Player, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

async function register(region = "desert", seasoned = true): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("r4"), password: "correct horse battery", region } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  if (seasoned) await seasonCaravan(pool, body.caravan.id);
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id };
}

async function unitIds(p: Player): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM unit_instance WHERE caravan_id = $1 ORDER BY id", [p.caravanId])).rows.map((r) => r.id);
}

/** A live standing party of `n` of the owner's own units, at the given siege Reputation. */
async function liveParty(n: number, siegeRep: number, region = "mountain"): Promise<Player> {
  const o = await register(region);
  const party = (await call(o, "GET", "/me/party")).json().party;
  const cfg = { ...party.suggested, units: party.suggested.units.slice(0, n) };
  const put = await call(o, "PUT", "/me/party", cfg);
  expect(put.statusCode, put.body).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [o.accountId, siegeRep]);
  return o;
}

/** Pack `count` units and ride out through the routes (one trip-cap use). */
async function rideOut(p: Player, count: number, livingRep = 400): Promise<string> {
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId, livingRep]);
  const ids = (await unitIds(p)).slice(0, count);
  const packed = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: ids, traps: [], fence: null });
  expect(packed.statusCode, packed.body).toBe(201);
  const start = await call(p, "POST", `/me/caravans/${p.caravanId}/trip/start`);
  expect(start.statusCode, start.body).toBe(201);
  return start.json().tripId;
}

describe("final guardrail review r4 S1: a caravan with no servable menu returns to town", () => {
  it("no authored set and two live parties: search → 409 pool_empty with returnToTown; return voids the trip (cause no_menu, nothing credited, cap not refunded); with a menu, return is refused", async () => {
    await liveParty(2, 250);
    await liveParty(2, 260);
    const d = await register("desert");
    const tripId = await rideOut(d, 3);
    const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    expect(s.statusCode, s.body).toBe(409);
    expect(s.json()).toMatchObject({ error: "pool_empty", returnToTown: true });
    expect(s.json().message).not.toMatch(/seed|pnpm/);
    // Refused before it is due: a bad body, another trip, a later encounter.
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/return`, { tripId: "x", encounterIndex: 1 })).statusCode).toBe(400);
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/return`, { tripId, encounterIndex: 2 })).json().error).toBe("not_current");
    const capBefore = (await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).json().cap;
    const r = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/return`, { tripId, encounterIndex: 1 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ returned: true, voided: { cause: "no_menu", encountersSurvived: 0, credited: 0, tripCapRefunded: false } });
    expect(r.json().status.caravan.state).toBe("in_town");
    expect(r.json().status.trip).toMatchObject({ endReason: "voided" });
    expect(r.json().status.cap.available).toBe(capBefore.available);
    const ev = await pool.query<{ payload: { reason: string; cause: string } }>("SELECT payload FROM ledger_event WHERE event_type = 'trip_voided' AND caravan_id = $1", [d.caravanId]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.payload.cause).toBe("no_menu");
    // The packed units are home and can be packed again; a replay of the return is refused (the trip ended).
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/return`, { tripId, encounterIndex: 1 })).json().error).toBe("trip_ended");
    expect((await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: (await unitIds(d)).slice(0, 3), traps: [], fence: null })).statusCode).toBe(201);

    // A third live party: a menu can be filled, so a return is refused (it is never a way out of a menu).
    await liveParty(2, 270);
    const start = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`);
    expect(start.statusCode, start.body).toBe(201);
    const t2 = start.json().tripId;
    const refusedEarly = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/return`, { tripId: t2, encounterIndex: 1 });
    expect(refusedEarly.json().error).toBe("menu_available");
    // ... and the refused probe stored no menu and started no reroll wait: the first search is immediate.
    expect((await call(d, "GET", `/me/caravans/${d.caravanId}/encounters/1/candidates`)).json()).toMatchObject({ menu: null, searched: false });
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).statusCode).toBe(201);
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/return`, { tripId: t2, encounterIndex: 1 })).json().error).toBe("menu_available");
  });

  it("the authored-only filter runs before the raider cap: three live one-raider parties at the centre and a 1-unit caravan before 2 banks still get a full authored menu", async () => {
    await seedAuthoredParties(appRole);
    for (let i = 0; i < 3; i++) await liveParty(1, 250 + i);
    const d = await register("desert", false); // not seasoned: its trips are authored-only
    const tripId = await rideOut(d, 1); // centre 250, band 0
    const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    expect(s.statusCode, s.body).toBe(201);
    const menu = s.json().menu;
    expect(menu.authoredOnlyTrip).toBe(true);
    expect(menu.candidates).toHaveLength(TUNABLES.CANDIDATES_PER_SEARCH);
    for (const c of menu.candidates) {
      expect(c.owner.authored).toBe(true);
      expect(c.scout.units.length).toBeLessThanOrEqual(2);
    }
    // The cap relaxed over the parties the draw could serve (authored only): from 1 to the floor outfits' 2.
    expect(menu.raiderCap).toMatchObject({ packedUnits: 1, cap: 2, relaxed: true });
    const row = await pool.query<{ raider_cap: { caravanBand: number } }>("SELECT raider_cap FROM encounter_candidates WHERE trip_id = $1", [tripId]);
    expect(row.rows[0]!.raider_cap.caravanBand).toBe(1);
  });
});

describe("final guardrail review r4 N4: a menu drawn under other rules is never fought", () => {
  /** Owner role, triggers off for one statement: stands in for a menu drawn before an upgrade. */
  async function ageMenu(tripId: string, seq: number): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query("UPDATE encounter_candidates SET resolver_version = $3 WHERE trip_id = $1 AND search_seq = $2", [tripId, seq, RESOLVER_VERSION - 1]);
    } finally {
      await c.query("SET session_replication_role = origin");
      c.release();
    }
  }

  it("commit of a stale chosen menu → 409 menu_stale; a search at once (no wait) replaces it; the fresh choice commits, against the fresh snapshot", async () => {
    const d = await register("desert");
    const tripId = await rideOut(d, 1, 700);
    const m1 = (await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).json().menu;
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: m1.candidates[0].candidateId })).statusCode).toBe(200);
    const [unit] = await unitIds(d);
    const ref = (await pool.query<{ packed: { units: { ref: string }[] } }>("SELECT packed FROM wagon_manifest WHERE caravan_id = $1 AND closed_at IS NULL", [d.caravanId])).rows[0]!.packed.units[0]!.ref;
    expect(ref).toBe(unit);
    const put = await call(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, { v: 2, fences: [], traps: [], posts: [{ ref, cell: { x: 13, y: 13 }, stance: "guard" }] });
    expect(put.statusCode, put.body).toBe(200);
    await ageMenu(tripId, 1);
    const commit = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/1/commit`);
    expect(commit.statusCode, commit.body).toBe(409);
    expect(commit.json().error).toBe("menu_stale");
    // Nothing was committed or queued.
    expect((await pool.query("SELECT 1 FROM resolution_job WHERE id = $1", [`encounter:${tripId}:1`])).rowCount).toBe(0);
    expect((await pool.query("SELECT committed_at FROM wagon_formation WHERE encounter_index = 1 AND manifest_id = (SELECT manifest_id FROM trip WHERE id = $1)", [tripId])).rows[0]?.committed_at ?? null).toBeNull();
    // A search right away (well inside REROLL_COOLDOWN_SECONDS, though a candidate was chosen) draws a fresh, stamped menu.
    const s2 = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    expect(s2.statusCode, s2.body).toBe(201);
    const m2 = s2.json().menu;
    expect(m2.searchSeq).toBe(2);
    expect((await call(d, "GET", `/me/caravans/${d.caravanId}/encounters/1/candidates`)).json().menu.searchSeq).toBe(2);
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: m2.candidates[1].candidateId })).statusCode).toBe(200);
    // Now there is a current choice: another search is already_chosen again.
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).json().error).toBe("already_chosen");
    const ok = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/1/commit`);
    expect(ok.statusCode, ok.body).toBe(202);
    const job = await pool.query<{ input: { party: { partyId: string } } }>("SELECT input FROM resolution_job WHERE id = $1", [`encounter:${tripId}:1`]);
    expect(job.rows[0]!.input.party.partyId).toBe(m2.candidates[1].partyId);
  });

  it("choosing from a stale menu → 409 menu_stale, and the search that replaces it has no wait", async () => {
    const d = await register("desert");
    const tripId = await rideOut(d, 1, 700);
    const m1 = (await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).json().menu;
    await ageMenu(tripId, 1);
    const ch = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: m1.candidates[0].candidateId });
    expect(ch.statusCode).toBe(409);
    expect(ch.json().error).toBe("menu_stale");
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).statusCode).toBe(201);
  });
});

describe("final guardrail review r4 N1: nothing for PUBLIC", () => {
  it("a login with no grants can neither connect nor execute any function in schema public; the app role keeps every definer function it uses", async () => {
    const role = `r4_stranger_${Date.now().toString(36)}`;
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'stranger-password-r4'`);
    try {
      const db = (await pool.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
      expect((await pool.query<{ ok: boolean }>("SELECT has_database_privilege($1, $2, 'CONNECT') AS ok", [role, db])).rows[0]!.ok).toBe(false);
      const url = new URL(resolveTestDatabaseUrl());
      url.username = role;
      url.password = "stranger-password-r4";
      const c = new pg.Client({ connectionString: url.toString() });
      const err = await c.connect().then(() => null, (e: Error & { code?: string }) => e);
      await c.end().catch(() => undefined);
      expect(err?.code, String(err)).toBe("42501");
      const fns = (await pool.query<{ fn: string; secdef: boolean; pub: boolean; stranger: boolean; app: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS secdef, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege($1, p.oid, 'EXECUTE') AS stranger, has_function_privilege('caravan_app', p.oid, 'EXECUTE') AS app
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`,
        [role],
      )).rows;
      expect(fns.length).toBeGreaterThan(50);
      expect(fns.filter((f) => f.pub || f.stranger).map((f) => f.fn)).toEqual([]);
      const definers = fns.filter((f) => f.secdef);
      for (const name of ["session_issue", "resolution_job_park_other_version", "account_erase", "encounter_log_write", "ledger_event_project", "resolution_job_lease"]) {
        expect(definers.find((f) => f.fn.startsWith(`${name}(`))?.app, name).toBe(true);
      }
      for (const name of ["account_erasure_core", "encounter_log_compact_rows"]) expect(definers.find((f) => f.fn.startsWith(`${name}(`))?.app, name).toBe(false);
      // Even inside an allowed connection, the stranger's role cannot call a definer function.
      const owner = await pool.connect();
      try {
        await owner.query(`SET ROLE ${role}`);
        const e2 = await owner.query("SELECT * FROM resolution_job_park_other_version('stranger', 0, 'r4')").then(() => null, (e: Error & { code?: string }) => e);
        expect(e2?.code).toBe("42501");
      } finally {
        await owner.query("RESET ROLE");
        owner.release();
      }
    } finally {
      await pool.query(`DROP ROLE ${role}`);
    }
  });
});

describe("final guardrail review r4 D1: the suggested party stops at SUGGESTED_PARTY_MAX", () => {
  it("adds roster units up to 5, never cuts a saved party that is already larger", () => {
    expect(TUNABLES.SUGGESTED_PARTY_MAX).toBe(5);
    const roster = Array.from({ length: 7 }, (_, i) => ({ instanceId: `00000000-0000-4000-8000-00000000000${i}`, caravanId: "00000000-0000-4000-8000-0000000000aa", typeId: "desert.dust_rider", unlocked: true }));
    const s = suggestParty({ v: 1, units: [], siege: [] }, roster, () => false);
    expect(s!.units).toHaveLength(5);
    const big = { v: 1 as const, units: roster.slice(0, 6).map((r, i) => ({ ref: r.instanceId, stance: "nearest" as const, edge: "north" as const, cell: { x: 2 + i * 3, y: 0 } })), siege: [] };
    expect(suggestParty(big, roster, () => false)).toBeNull();
  });
});

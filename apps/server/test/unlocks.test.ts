/**
 * Chunk 05 — the unlock webs against the database and the HTTP boundary: the whole web is
 * readable with every cost (legibility), spending validates everything server-side and is
 * idempotent under retries and under concurrency, reaching a node grants access and
 * nothing else, access lands on the right side of the account/caravan split, nothing here
 * funds points, and nothing — a wipe streak included — ever takes a reached node away.
 */
import { TUNABLES, UNLOCK_WEBS, type UnlockPool } from "@caravan/content";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { accessCheckFor, isUnlocked, unlockedTypeIds } from "../src/circle/access.js";
import { withTransaction } from "../src/db/pool.js";
import { appendEvents } from "../src/ledger/ledger.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { applyEncounterOutcome, progressionCausationId } from "../src/progression/index.js";
import { getAccountPoolProgress, getCaravanPoolProgress } from "../src/repo/poolProgress.js";
import { createUnitInstance, listUnitInstancesForCaravan } from "../src/repo/unitInstances.js";
import { hasAccess, purchasedNodeIds, unlockCausationId } from "../src/unlocks/index.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  regionId: "desert" | "mountain";
}

async function registerPlayer(region: "desert" | "mountain" = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("u"), password: "correct horse battery", region } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, regionId: region };
}

function call(p: Player, method: "GET" | "POST", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

const spend = (p: Player, pool: UnlockPool, nodeId: string, caravanId?: string | null) =>
  call(p, "POST", "/me/unlocks/spend", { pool, nodeId, ...(caravanId === undefined ? {} : { caravanId }) });

const owner = (p: Player) => ({ accountId: p.accountId, caravanId: p.caravanId, regionId: p.regionId });

let rungCounter = 100;
/**
 * TEST FIXTURE ONLY: the production source of unlock points is chunk 04's rung crossing
 * (`unlock_points_granted` from progression/outcome.ts). This writes the same event
 * directly so the spend tests do not have to climb a ladder; one test below drives the
 * real path end to end.
 */
async function grant(p: Player, pool: UnlockPool, points: number): Promise<void> {
  await withTransaction(pool === "living" ? testPoolRef : testPoolRef, async (c) => {
    const rung = ++rungCounter;
    await appendEvents(c, `test:grant:${p.accountId}:${pool}:${rung}`, [
      { type: "unlock_points_granted", accountId: p.accountId, caravanId: pool === "living" ? p.caravanId : null, payload: { pool, points, rung } },
    ]);
  });
}
const testPoolRef = pool;

async function points(p: Player, pool: UnlockPool) {
  const row = pool === "living" ? await getCaravanPoolProgress(testPoolRef, p.caravanId) : await getAccountPoolProgress(testPoolRef, p.accountId, pool);
  return { granted: row!.unlock_points_granted, spent: row!.unlock_points_spent, available: row!.unlock_points_granted - row!.unlock_points_spent };
}

async function purchaseEventCount(p: Player): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_event WHERE account_id = $1 AND event_type = 'unlock_node_purchased'", [p.accountId]);
  return Number(r.rows[0]!.n);
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("legibility: the whole web is readable, costs and all, before any spend", () => {
  it("GET /unlocks/webs is public and lists every web, every node, every cost — identical for everyone", async () => {
    const res = await app.inject({ method: "GET", url: "/unlocks/webs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.costByTier).toEqual([0, 1, 2, 4, 6]);
    expect(body.pointsPerPoolAtLadderCap).toBe(30);
    expect(body.webs.map((w: { id: string }) => w.id)).toEqual(UNLOCK_WEBS.map((w) => w.id));
    const trap = body.webs.find((w: { id: string }) => w.id === "trap");
    expect(trap.scope).toBe("account");
    expect(trap.nodes).toHaveLength(TUNABLES.TRAP_WEB_NODES);
    expect(trap.nodes.find((n: { id: string }) => n.id === "fence.stacked_stone")).toEqual({ id: "fence.stacked_stone", tier: 4, cost: 6, requires: ["fence.barbed_wire"], starting: false });
    const again = await app.inject({ method: "GET", url: "/unlocks/webs" });
    expect(again.body).toBe(res.body);
  });

  it("GET /me/unlocks shows a new player every node of their three webs, unaffordable and unreachable ones included, with the exact cost", async () => {
    const p = await registerPlayer("desert");
    const res = await call(p, "GET", "/me/unlocks");
    expect(res.statusCode).toBe(200);
    const webs = res.json().webs as { id: string; pool: string; scope: string; caravanId: string | null; points: { granted: number; spent: number; available: number }; nodes: { id: string; cost: number; reached: boolean; affordable: boolean; prerequisitesMet: boolean; missing: string[] }[] }[];
    expect(webs.map((w) => [w.id, w.scope, w.caravanId])).toEqual([
      ["trap", "account", null],
      ["siege", "account", null],
      ["living.desert", "caravan", p.caravanId],
    ]);
    for (const w of webs) {
      expect(w.points).toEqual({ granted: 0, spent: 0, available: 0 });
      const authored = UNLOCK_WEBS.find((x) => x.id === w.id)!;
      expect(w.nodes.map((n) => n.id)).toEqual(authored.nodes.map((n) => n.id));
      for (const n of w.nodes) {
        expect(typeof n.cost).toBe("number");
        expect(n.affordable).toBe(false); // no points yet — but every node is listed with its price
      }
    }
    const living = webs[2]!;
    expect(living.nodes.filter((n) => n.reached).map((n) => n.id)).toEqual(["desert.dust_rider", "desert.well_digger"]);
    expect(living.nodes.find((n) => n.id === "desert.vaquero")).toMatchObject({ cost: 6, reached: false, prerequisitesMet: false, missing: ["desert.canteen_carrier"] });
    // the living web is the caravan's region's: no other region's unit appears anywhere in the response
    expect(JSON.stringify(webs)).not.toMatch(/mountain\.|badlands\.|high_plains\./);
  });

  it("needs auth", async () => {
    expect((await app.inject({ method: "GET", url: "/me/unlocks" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/me/unlocks/spend", payload: { pool: "trap", nodeId: "trap.jaw_trap" } })).statusCode).toBe(401);
  });
});

describe("spending: full server-side validation by hand-crafted request", () => {
  let p: Player;
  let other: Player;
  beforeAll(async () => {
    p = await registerPlayer("desert");
    other = await registerPlayer("desert");
  });

  it("refuses a type nobody has, a unit from another region, and a node named under the wrong pool", async () => {
    await grant(p, "living", 30);
    await grant(p, "siege", 30);
    const nobody = await spend(p, "living", "desert.ghost_rider", p.caravanId);
    expect(nobody.statusCode).toBe(400);
    expect(nobody.json().error).toBe("node_not_in_web");
    const foreign = await spend(p, "living", "mountain.grizzly", p.caravanId);
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ error: "node_not_in_web", message: expect.stringContaining("living.desert") });
    const wrongPool = await spend(p, "siege", "trap.jaw_trap");
    expect(wrongPool.statusCode).toBe(400);
    expect(wrongPool.json().error).toBe("node_not_in_web");
    const unitUnderSiege = await spend(p, "siege", "desert.sand_sharpshooter");
    expect(unitUnderSiege.json().error).toBe("node_not_in_web");
    expect(await purchaseEventCount(p)).toBe(0);
    expect((await points(p, "living")).spent).toBe(0);
    expect((await points(p, "siege")).spent).toBe(0);
  });

  it("refuses the wrong scope: living without a caravan, trap/siege with one, and someone else's caravan", async () => {
    expect((await spend(p, "living", "desert.sand_sharpshooter")).json()).toMatchObject({ error: "caravan_required" });
    expect((await spend(p, "trap", "trap.jaw_trap", p.caravanId)).json()).toMatchObject({ error: "wrong_scope" });
    expect((await spend(p, "siege", "siege.bridging_planks", p.caravanId)).json()).toMatchObject({ error: "wrong_scope" });
    const theirs = await spend(p, "living", "desert.sand_sharpshooter", other.caravanId);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json().error).toBe("no_caravan");
    expect((await spend(p, "nope" as UnlockPool, "trap.jaw_trap")).json()).toMatchObject({ error: "bad_pool" });
    expect((await call(p, "POST", "/me/unlocks/spend", { pool: "trap" })).json()).toMatchObject({ error: "bad_node" });
    expect((await spend(p, "living", "desert.sand_sharpshooter", "not-a-uuid")).json()).toMatchObject({ error: "bad_caravan" });
    expect(await purchaseEventCount(p)).toBe(0);
    // the other player's caravan was not touched
    expect((await points(other, "living")).spent).toBe(0);
  });

  it("refuses a node the player cannot afford, and a node whose prerequisites are not reached — even with points to spare", async () => {
    const poor = await spend(p, "trap", "trap.jaw_trap"); // 0 trap points
    expect(poor.statusCode).toBe(409);
    expect(poor.json()).toMatchObject({ error: "insufficient_points", message: expect.stringContaining("costs 1") });
    const deep = await spend(p, "living", "desert.vaquero", p.caravanId); // 30 living points, chain not reached
    expect(deep.statusCode).toBe(409);
    expect(deep.json()).toMatchObject({ error: "prerequisites_unmet", message: expect.stringContaining("desert.canteen_carrier") });
    const rejoin = await spend(p, "living", "desert.longhorn_bull", p.caravanId);
    expect(rejoin.json()).toMatchObject({ error: "prerequisites_unmet" });
    expect(rejoin.json().message).toMatch(/coyote_pack.*powder_monkey/);
    expect(await purchaseEventCount(p)).toBe(0);
  });

  it("points are per pool: 30 living points buy nothing in the trap web", async () => {
    expect((await points(p, "living")).available).toBe(30);
    expect((await spend(p, "trap", "trap.tripwire_snare")).json().error).toBe("insufficient_points");
  });

  it("a legal spend appends exactly one unlock_node_purchased, moves spent, and the response is the redrawn web", async () => {
    const res = await spend(p, "living", "desert.sand_sharpshooter", p.caravanId);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ created: true, webId: "living.desert", pool: "living", scope: "caravan", caravanId: p.caravanId, points: { granted: 30, spent: 1, available: 29 } });
    expect(body.node).toMatchObject({ id: "desert.sand_sharpshooter", reached: true, affordable: false, cost: 1 });
    expect(body.nodes.find((n: { id: string }) => n.id === "desert.canteen_carrier")).toMatchObject({ reached: false, prerequisitesMet: true, affordable: true, cost: 4 });
    expect(await purchaseEventCount(p)).toBe(1);
    const ev = await pool.query("SELECT * FROM ledger_event WHERE account_id = $1 AND event_type = 'unlock_node_purchased'", [p.accountId]);
    expect(ev.rows[0]).toMatchObject({ caravan_id: p.caravanId, causation_id: unlockCausationId("living", p.caravanId, "desert.sand_sharpshooter"), payload: { pool: "living", nodeId: "desert.sand_sharpshooter", cost: 1, tier: 1 } });
    expect(await points(p, "living")).toEqual({ granted: 30, spent: 1, available: 29 });
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });

  it("is idempotent: resending the same spend returns the reached state with created=false and appends nothing; a starting node is the same", async () => {
    const again = await spend(p, "living", "desert.sand_sharpshooter", p.caravanId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, points: { spent: 1, available: 29 } });
    expect(again.json().node.reached).toBe(true);
    const starter = await spend(p, "living", "desert.dust_rider", p.caravanId);
    expect(starter.statusCode).toBe(200);
    expect(starter.json()).toMatchObject({ created: false, node: { id: "desert.dust_rider", starting: true, reached: true, cost: 0 } });
    expect(await purchaseEventCount(p)).toBe(1);
    expect(await points(p, "living")).toEqual({ granted: 30, spent: 1, available: 29 });
  });

  it("is idempotent under concurrent retries: eight identical requests at once reach the node once", async () => {
    await grant(p, "trap", 30);
    const results = await Promise.all(Array.from({ length: 8 }, () => spend(p, "trap", "trap.tripwire_snare")));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(await points(p, "trap")).toEqual({ granted: 30, spent: 1, available: 29 });
    expect(await purchasedNodeIds(pool, "trap", { accountId: p.accountId })).toEqual(["trap.tripwire_snare"]);
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });

  it("walks a chain only in order, and an exact budget can be spent to zero but not below", async () => {
    // siege: 30 points; planks(1) -> dousing(2); wagon(start) -> cutters(2) -> blasting(6) = 11
    for (const id of ["siege.bridging_planks", "siege.dousing_wagon", "siege.fence_cutters", "siege.blasting_crate"]) {
      expect((await spend(p, "siege", id)).statusCode).toBe(201);
    }
    expect(await points(p, "siege")).toEqual({ granted: 30, spent: 11, available: 19 });
    const q = await registerPlayer("desert");
    await grant(q, "siege", 3);
    expect((await spend(q, "siege", "siege.bridging_planks")).statusCode).toBe(201); // 2 left
    expect((await spend(q, "siege", "siege.fence_cutters")).statusCode).toBe(201); // 0 left
    expect(await points(q, "siege")).toEqual({ granted: 3, spent: 3, available: 0 });
    expect((await spend(q, "siege", "siege.dousing_wagon")).json().error).toBe("insufficient_points");
    expect((await verifyProjection(pool, q.accountId)).ok).toBe(true);
  });

  it("the real funding path: chunk 04 rung crossings grant the point that is then spent here", async () => {
    const r = await registerPlayer("desert");
    const opponent = await registerPlayer("mountain");
    let n = 0;
    while ((await points(r, "living")).available === 0) {
      await withTransaction(pool, (c) =>
        applyEncounterOutcome(c, progressionCausationId(`encounter:unlocktest:${r.accountId}:${++n}`), {
          outcome: "caravan_held",
          caravan: { accountId: r.accountId, caravanId: r.caravanId, poolsUsed: ["living"] },
          party: { ownerAccountId: opponent.accountId, poolsUsed: [] },
        }),
      );
      expect(n).toBeLessThan(50);
    }
    expect(await points(r, "living")).toEqual({ granted: 1, spent: 0, available: 1 });
    expect((await spend(r, "living", "desert.sand_sharpshooter", r.caravanId)).statusCode).toBe(201);
    expect(await points(r, "living")).toEqual({ granted: 1, spent: 1, available: 0 });
  });
});

describe("reaching a node grants ACCESS and nothing else", () => {
  it("the roster, Coin, ladders and granted points are byte-identical before and after an unlock", async () => {
    const p = await registerPlayer("desert");
    await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: "desert.dust_rider" });
    await grant(p, "living", 30);
    await grant(p, "trap", 30);
    const snapshot = async () => ({
      units: await listUnitInstancesForCaravan(pool, p.caravanId),
      account: (await pool.query("SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1", [p.accountId])).rows[0],
      living: (({ ladder_level, ladder_points, reputation, unlock_points_granted }) => ({ ladder_level, ladder_points, reputation, unlock_points_granted }))((await getCaravanPoolProgress(pool, p.caravanId))!),
      trap: (({ ladder_level, ladder_points, reputation, unlock_points_granted }) => ({ ladder_level, ladder_points, reputation, unlock_points_granted }))((await getAccountPoolProgress(pool, p.accountId, "trap"))!),
    });
    const before = await snapshot();
    expect((await spend(p, "living", "desert.sand_sharpshooter", p.caravanId)).statusCode).toBe(201);
    expect((await spend(p, "trap", "trap.jaw_trap")).statusCode).toBe(201);
    expect((await spend(p, "trap", "fence.split_rail")).statusCode).toBe(201);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.units).toHaveLength(1); // still one dust rider; no sharpshooter instance appeared
    // the only events this produced are purchases
    const types = await pool.query<{ event_type: string }>("SELECT DISTINCT event_type FROM ledger_event WHERE account_id = $1 AND event_type <> 'unlock_points_granted'", [p.accountId]);
    expect(types.rows.map((r) => r.event_type)).toEqual(["unlock_node_purchased"]);
  });

  it("the circle's access seam sees the new node immediately, through the same predicate", async () => {
    const p = await registerPlayer("desert");
    const o = owner(p);
    expect(await hasAccess(pool, o, "desert.coyote_pack")).toBe(false);
    expect((await accessCheckFor(pool, o))("trap.jaw_trap")).toBe(false);
    await grant(p, "living", 30);
    await grant(p, "trap", 30);
    expect((await spend(p, "living", "desert.coyote_pack", p.caravanId)).statusCode).toBe(201);
    expect((await spend(p, "trap", "trap.jaw_trap")).statusCode).toBe(201);
    expect(await hasAccess(pool, o, "desert.coyote_pack")).toBe(true);
    expect(await isUnlocked(pool, o, "desert.coyote_pack")).toBe(true);
    const check = await accessCheckFor(pool, o);
    expect(check("trap.jaw_trap")).toBe(true);
    expect(check("trap.powder_keg")).toBe(false);
    expect([...(await unlockedTypeIds(pool, o))].sort()).toEqual(["desert.coyote_pack", "desert.dust_rider", "desert.well_digger", "fence.brush_pile", "siege.battering_wagon", "trap.jaw_trap", "trap.spike_pit"]);
  });
});

describe("the account / caravan split (GUARDRAILS §5)", () => {
  it("a living node reached on one caravan is not reached for another player's caravan in the same region; a trap node lands on the account", async () => {
    const a = await registerPlayer("desert");
    const b = await registerPlayer("desert");
    await grant(a, "living", 30);
    await grant(a, "trap", 30);
    expect((await spend(a, "living", "desert.sand_sharpshooter", a.caravanId)).statusCode).toBe(201);
    expect((await spend(a, "trap", "trap.jaw_trap")).statusCode).toBe(201);
    expect(await hasAccess(pool, owner(a), "desert.sand_sharpshooter")).toBe(true);
    expect(await hasAccess(pool, owner(b), "desert.sand_sharpshooter")).toBe(false);
    expect(await hasAccess(pool, owner(a), "trap.jaw_trap")).toBe(true);
    expect(await hasAccess(pool, owner(b), "trap.jaw_trap")).toBe(false);
    // the events sit on the right rows: living with the caravan id, trap without
    const ev = await pool.query<{ caravan_id: string | null; payload: { pool: string } }>("SELECT caravan_id, payload FROM ledger_event WHERE account_id = $1 AND event_type = 'unlock_node_purchased' ORDER BY seq", [a.accountId]);
    expect(ev.rows.map((r) => [r.payload.pool, r.caravan_id])).toEqual([["living", a.caravanId], ["trap", null]]);
    // and b's view reports both nodes unreached
    const view = (await call(b, "GET", "/me/unlocks")).json().webs as { id: string; nodes: { id: string; reached: boolean }[] }[];
    expect(view.find((w) => w.id === "trap")!.nodes.find((n) => n.id === "trap.jaw_trap")!.reached).toBe(false);
    expect(view.find((w) => w.id === "living.desert")!.nodes.find((n) => n.id === "desert.sand_sharpshooter")!.reached).toBe(false);
  });

  it("the storage layer refuses a living purchase without a caravan and an account purchase with one", async () => {
    const a = await registerPlayer("desert");
    const living = await expectDbError(pool, "INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ('unlock_node_purchased', $1, NULL, 'bad:1', 0, '{\"pool\":\"living\",\"nodeId\":\"desert.vaquero\",\"cost\":6}')", [a.accountId]);
    expect(living?.code).toBe("23514");
    const trap = await expectDbError(pool, "INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ('unlock_node_purchased', $1, $2, 'bad:2', 0, '{\"pool\":\"trap\",\"nodeId\":\"trap.tar_pot\",\"cost\":4}')", [a.accountId, a.caravanId]);
    expect(trap?.code).toBe("23514");
  });
});

describe("permanence: access, once granted, is never revoked", () => {
  it("a wipe streak, a stripped roster and a direct attack on the rows all leave every reached node reached and every unspent point unspent", async () => {
    const p = await registerPlayer("desert");
    const opponent = await registerPlayer("mountain");
    await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: "desert.dust_rider" });
    await grant(p, "living", 10);
    await grant(p, "trap", 10);
    await grant(p, "siege", 10);
    for (const [pl, id, cid] of [["living", "desert.sand_sharpshooter", p.caravanId], ["living", "desert.coyote_pack", p.caravanId], ["trap", "trap.jaw_trap", null], ["siege", "siege.bridging_planks", null]] as const) {
      expect((await spend(p, pl, id, cid)).statusCode).toBe(201);
    }
    const reachedBefore = [...(await unlockedTypeIds(pool, owner(p)))].sort();
    const pointsBefore = { living: await points(p, "living"), trap: await points(p, "trap"), siege: await points(p, "siege") };
    expect(pointsBefore.living.available).toBe(7);

    // 40 overruns in a row: the harshest outcome the game has, on every pool
    for (let i = 0; i < 40; i++) {
      await withTransaction(pool, (c) =>
        applyEncounterOutcome(c, progressionCausationId(`encounter:wipe:${p.accountId}:${i}`), {
          outcome: "caravan_overrun",
          caravan: { accountId: p.accountId, caravanId: p.caravanId, poolsUsed: ["living", "trap"] },
          party: { ownerAccountId: opponent.accountId, poolsUsed: ["siege"] },
        }),
      );
    }
    // and the roster is gone (what a final wipe does to instances)
    await pool.query("DELETE FROM unit_instance WHERE caravan_id = $1", [p.caravanId]);
    expect(await listUnitInstancesForCaravan(pool, p.caravanId)).toEqual([]);

    expect([...(await unlockedTypeIds(pool, owner(p)))].sort()).toEqual(reachedBefore);
    for (const pl of ["living", "trap", "siege"] as const) {
      const now = await points(p, pl);
      expect(now.spent).toBe(pointsBefore[pl].spent);
      expect(now.granted).toBeGreaterThanOrEqual(pointsBefore[pl].granted);
      expect(now.available).toBeGreaterThanOrEqual(pointsBefore[pl].available);
    }
    // the view agrees
    const view = (await call(p, "GET", "/me/unlocks")).json().webs as { id: string; nodes: { id: string; reached: boolean }[] }[];
    expect(view.flatMap((w) => w.nodes.filter((n) => n.reached).map((n) => n.id)).sort()).toEqual(reachedBefore);

    // nothing can take it back, even the owner role: no refund, no delete, no second purchase
    const refund = await expectDbError(pool, "UPDATE pool_progress SET unlock_points_spent = unlock_points_spent - 1 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
    expect(refund?.message).toMatch(/never decrease/);
    const del = await expectDbError(pool, "DELETE FROM ledger_event WHERE account_id = $1 AND event_type = 'unlock_node_purchased'", [p.accountId]);
    expect(del?.message).toMatch(/append-only/);
    const twice = await expectDbError(pool, "INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ('unlock_node_purchased', $1, NULL, 'bad:twice', 0, '{\"pool\":\"trap\",\"nodeId\":\"trap.jaw_trap\",\"cost\":1}')", [p.accountId]);
    expect(twice?.code).toBe("23505");
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });
});

describe("no path funds unlock points or mints access except the ones the design names", () => {
  const SRC = join(__dirname, "..", "src");
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const full = join(dir, f);
      return statSync(full).isDirectory() ? sources(full) : full.endsWith(".ts") ? [full] : [];
    });
  }
  const rel = (f: string) => f.slice(SRC.length + 1);

  it("unlock_points_granted is written only by chunk 04's outcome service; unlock_node_purchased only by the spend service", () => {
    const writers = (needle: string) => sources(SRC).filter((f) => {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return new RegExp(`type:\\s*["']${needle}["']`).test(code);
    }).map(rel);
    expect(writers("unlock_points_granted")).toEqual(["progression/outcome.ts"]);
    expect(writers("unlock_node_purchased")).toEqual(["unlocks/spend.ts"]);
  });

  it("the unlocks module never touches Coin, ladders, grants, instances or purchases", () => {
    for (const f of sources(join(SRC, "unlocks")).concat([join(SRC, "routes", "unlocks.ts")])) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, rel(f)).not.toMatch(/coin|grantUnlockPoints|raiseLadderLevel|unit_instance|createUnitInstance|purchase_|entitlement|coin_purchased/i);
      // reading the granted column to compute "available" is fine; moving it is not
      expect(code, rel(f)).not.toMatch(/unlock_points_granted\s*[+=]|SET unlock_points_granted|type:\s*["']unlock_points_granted/);
    }
  });

  it("the access predicate is read-only: nothing in it writes", () => {
    const code = readFileSync(join(SRC, "unlocks", "access.ts"), "utf8");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

/**
 * Chunk 05 — the unlock webs against the database and the HTTP boundary: the whole web is
 * readable with every cost (legibility), spending validates everything server-side and is
 * idempotent under retries and under concurrency, reaching a node grants access and
 * nothing else, access lands on the right side of the account/caravan split, nothing here
 * funds points, and nothing — a wipe streak included — ever takes a reached node away.
 */
import { TUNABLES, UNLOCK_WEBS, nodeCost, type UnlockPool } from "@caravan/content";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { accessCheckFor, isUnlocked, unlockedTypeIds } from "../src/circle/access.js";
import { withTransaction } from "../src/db/pool.js";
import type { JsonObject } from "../src/ledger/events.js";
import { appendEvents } from "../src/ledger/ledger.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { applyEncounterOutcome, progressionCausationId } from "../src/progression/index.js";
import { insertCaravan } from "../src/repo/caravans.js";
import { createCaravanPoolProgress, getAccountPoolProgress, getCaravanPoolProgress } from "../src/repo/poolProgress.js";
import { createUnitInstance, listUnitInstancesForCaravan } from "../src/repo/unitInstances.js";
import { hasAccess, purchasedNodeIds, readOwnerSnapshot, unlockCausationId, unlockWebsSnapshot } from "../src/unlocks/index.js";
import { isUuid } from "../src/util/uuid.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";
import { startingRosterTypes } from "../src/acquisition/startingRoster.js";

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

function call(p: Player, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}`, ...headers } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

const spend = (p: Player, pool: UnlockPool, nodeId: string, caravanId?: string | null) =>
  call(p, "POST", "/me/unlocks/spend", { pool, nodeId, ...(caravanId === undefined ? {} : { caravanId }) });

const owner = (p: Player) => ({ accountId: p.accountId, caravanId: p.caravanId, regionId: p.regionId });

// Rungs are 1..LADDER_RUNGS_PER_POOL and unique per (pool, owner); count per owner+pool.
const rungCounters: Record<string, number> = {};
/**
 * TEST FIXTURE ONLY: the production source of unlock points is chunk 04's rung crossing
 * (`unlock_points_granted` from progression/outcome.ts). This writes the same event
 * directly so the spend tests do not have to climb a ladder; one test below drives the
 * real path end to end.
 */
async function grant(p: Player, pool: UnlockPool, points: number, caravanId: string = p.caravanId): Promise<void> {
  await withTransaction(testPoolRef, async (c) => {
    const key = `${p.accountId}:${pool === "living" ? caravanId : ""}:${pool}`;
    // Count DOWN from the top rung so fixture grants never collide with a real rung-1
    // crossing driven by the end-to-end test below.
    const n = (rungCounters[key] = (rungCounters[key] ?? 0) + 1);
    const rung = 21 - n;
    if (rung < 1) throw new Error(`test fixture: more than 20 grants for ${key}`);
    await appendEvents(c, `test:grant:${key}:${rung}`, [
      { type: "unlock_points_granted", accountId: p.accountId, caravanId: pool === "living" ? caravanId : null, payload: { pool, points, rung } },
    ]);
  });
}
const testPoolRef = pool;

async function points(p: Player, pool: UnlockPool, caravanId: string = p.caravanId) {
  const row = pool === "living" ? await getCaravanPoolProgress(testPoolRef, caravanId) : await getAccountPoolProgress(testPoolRef, p.accountId, pool);
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
    expect(body.costByTier).toEqual({ living: [0, 1, 2, 8, 14], trap: [0, 1, 3, 7, 10], siege: [0, 1, 8, 15, 21] });
    expect(body.pointsPerPoolAtLadderCap).toBe(30);
    expect(body.webs.map((w: { id: string }) => w.id)).toEqual(UNLOCK_WEBS.map((w) => w.id));
    const trap = body.webs.find((w: { id: string }) => w.id === "trap");
    expect(trap.scope).toBe("account");
    expect(trap.nodes).toHaveLength(TUNABLES.TRAP_WEB_NODES);
    expect(trap.nodes.find((n: { id: string }) => n.id === "fence.stacked_stone")).toEqual({ id: "fence.stacked_stone", tier: 4, cost: 10, requires: ["fence.barbed_wire"], starting: false });
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
    expect(living.nodes.find((n) => n.id === "desert.vaquero")).toMatchObject({ cost: 14, reached: false, prerequisitesMet: false, missing: ["desert.canteen_carrier"] });
    // every cost in the view is the authored (pool, tier) cost — nothing per player
    for (const w of webs) for (const n of w.nodes) expect(n.cost).toBe(nodeCost(UNLOCK_WEBS.find((x) => x.id === w.id)!, UNLOCK_WEBS.find((x) => x.id === w.id)!.nodes.find((x) => x.id === n.id)!));
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
    expect(body.nodes.find((n: { id: string }) => n.id === "desert.canteen_carrier")).toMatchObject({ reached: false, prerequisitesMet: true, affordable: true, cost: 8 });
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

  it("walks a chain only in order, a capped ladder cannot buy the whole web, and an exact budget can be spent to zero but not below", async () => {
    // siege: 30 points (a capped ladder); planks(1) -> dousing(8); wagon(start) -> cutters(8) -> blasting(21) = 38 > 30
    for (const id of ["siege.bridging_planks", "siege.dousing_wagon", "siege.fence_cutters"]) {
      expect((await spend(p, "siege", id)).statusCode).toBe(201);
    }
    expect(await points(p, "siege")).toEqual({ granted: 30, spent: 17, available: 13 });
    const capstone = await spend(p, "siege", "siege.blasting_crate");
    expect(capstone.statusCode).toBe(409);
    expect(capstone.json()).toMatchObject({ error: "insufficient_points", message: expect.stringContaining("costs 21") });
    const q = await registerPlayer("desert");
    await grant(q, "siege", 9);
    expect((await spend(q, "siege", "siege.bridging_planks")).statusCode).toBe(201); // 8 left
    expect((await spend(q, "siege", "siege.fence_cutters")).statusCode).toBe(201); // 0 left
    expect(await points(q, "siege")).toEqual({ granted: 9, spent: 9, available: 0 });
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
    // Still one dust rider beside the starting roster (chunk 24 QA D1); no sharpshooter instance appeared.
    expect(after.units).toHaveLength(1 + startingRosterTypes("desert").length);
    expect(after.units.some((u) => u.unit_type_id === "desert.sand_sharpshooter")).toBe(false);
    // the only events this produced are purchases (the caravan's creation grant aside)
    const types = await pool.query<{ event_type: string }>("SELECT DISTINCT event_type FROM ledger_event WHERE account_id = $1 AND event_type <> 'unlock_points_granted' AND NOT starts_with(causation_id, 'starting_roster:')", [p.accountId]);
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
    // Ten granted, a tier-1 and a tier-2 living node bought (final play-test review D8: tier 2 costs 2).
    expect(pointsBefore.living.available).toBe(10 - TUNABLES.UNLOCK_NODE_COST_BY_TIER.living[1]! - TUNABLES.UNLOCK_NODE_COST_BY_TIER.living[2]!);

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

describe("QA-05 S1: ids from the outside are canonical uuids or they are refused before the database sees them", () => {
  it("isUuid accepts the canonical 8-4-4-4-12 form only", () => {
    expect(isUuid("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isUuid("3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toBe(true);
    for (const bad of ["------------------------------------", "a".repeat(36), "aaaaaaaa-aaaa-aaaa-aaaaaaaaa-aaaaaaa", "3f2504e0-4f89-11d3-9a0c-0305e82c330", "3f2504e0-4f89-11d3-9a0c-0305e82c33011", "", 7, null, undefined, {}]) {
      expect(isUuid(bad), String(bad)).toBe(false);
    }
  });

  it("POST /me/unlocks/spend: every malformed body is a 4xx, never a 500 — the 36-character non-uuids included", async () => {
    const p = await registerPlayer("desert");
    const cases: [string, string, number, string | null][] = [
      ["json string", JSON.stringify("hello"), 400, "bad_body"],
      ["json array", "[]", 400, null],
      ["json null", "null", 400, "bad_body"],
      ["json number", "7", 400, "bad_body"],
      ["invalid json", "{nope", 400, null],
      ["empty body", "", 400, null],
      ["pool array", JSON.stringify({ pool: ["trap"], nodeId: "trap.jaw_trap" }), 400, "bad_pool"],
      ["nodeId number", JSON.stringify({ pool: "trap", nodeId: 5 }), 400, "bad_node"],
      ["caravanId object", JSON.stringify({ pool: "living", nodeId: "desert.sand_sharpshooter", caravanId: {} }), 400, "bad_caravan"],
      ["caravanId 36 dashes", JSON.stringify({ pool: "living", nodeId: "desert.sand_sharpshooter", caravanId: "------------------------------------" }), 400, "bad_caravan"],
      ["caravanId 36 hex no dashes", JSON.stringify({ pool: "living", nodeId: "desert.sand_sharpshooter", caravanId: "a".repeat(36) }), 400, "bad_caravan"],
      ["caravanId mis-grouped dashes", JSON.stringify({ pool: "living", nodeId: "desert.sand_sharpshooter", caravanId: "aaaaaaaa-aaaa-aaaa-aaaaaaaaa-aaaaaaa" }), 400, "bad_caravan"],
    ];
    for (const [name, body, code, error] of cases) {
      const res = await call(p, "POST", "/me/unlocks/spend", body, { "content-type": "application/json" });
      expect(res.statusCode, name).toBe(code);
      if (error) expect(res.json().error, name).toBe(error);
    }
    expect(await purchaseEventCount(p)).toBe(0);
  });

  it("the circle routes: a 36-character non-uuid caravan id is a 404, not a 500", async () => {
    const p = await registerPlayer("desert");
    for (const id of ["------------------------------------", "a".repeat(36), "aaaaaaaa-aaaa-aaaa-aaaaaaaaa-aaaaaaa"]) {
      const res = await call(p, "GET", `/caravans/${id}/manifest`);
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error).toBe("no_caravan");
    }
  });
});

describe("QA-05 S2: hasAccess reads region and ownership from the caravan row — the caller's word is not trusted", () => {
  it("a desert caravan with a caller-supplied regionId of mountain is refused outright: no mountain starter, no desert starter, nothing", async () => {
    const p = await registerPlayer("desert");
    const wrong = { accountId: p.accountId, caravanId: p.caravanId, regionId: "mountain" as const };
    expect(await hasAccess(pool, wrong, "mountain.grizzly")).toBe(false);
    expect(await hasAccess(pool, wrong, "desert.dust_rider")).toBe(false);
    expect(await hasAccess(pool, wrong, "trap.spike_pit")).toBe(false);
    expect([...(await unlockedTypeIds(pool, wrong))]).toEqual([]);
    expect((await accessCheckFor(pool, wrong))("desert.dust_rider")).toBe(false);
    expect(await readOwnerSnapshot(pool, wrong)).toBeNull();
    // the same pair without a region, or with the right one, is the real owner
    const right = { accountId: p.accountId, caravanId: p.caravanId };
    expect(await hasAccess(pool, right, "desert.dust_rider")).toBe(true);
    expect(await hasAccess(pool, right, "mountain.grizzly")).toBe(false);
    expect(await hasAccess(pool, { ...right, regionId: "desert" }, "desert.dust_rider")).toBe(true);
    expect((await readOwnerSnapshot(pool, right))?.regionId).toBe("desert");
  });

  it("another account's caravan, a caravan that does not exist, and a non-uuid id are all refused, never a throw", async () => {
    const a = await registerPlayer("desert");
    const b = await registerPlayer("desert");
    await grant(a, "living", 30);
    expect((await spend(a, "living", "desert.sand_sharpshooter", a.caravanId)).statusCode).toBe(201);
    // b naming a's caravan gets nothing, not even a's starters, and not a's purchase
    const theft = { accountId: b.accountId, caravanId: a.caravanId, regionId: "desert" as const };
    expect(await hasAccess(pool, theft, "desert.sand_sharpshooter")).toBe(false);
    expect(await hasAccess(pool, theft, "desert.dust_rider")).toBe(false);
    expect(await hasAccess(pool, theft, "trap.spike_pit")).toBe(false);
    expect([...(await unlockedTypeIds(pool, theft))]).toEqual([]);
    expect(await hasAccess(pool, { accountId: a.accountId, caravanId: "00000000-0000-0000-0000-000000000000" }, "desert.dust_rider")).toBe(false);
    expect(await hasAccess(pool, { accountId: a.accountId, caravanId: "a".repeat(36) }, "desert.dust_rider")).toBe(false);
    expect(await hasAccess(pool, { accountId: "not-a-uuid", caravanId: a.caravanId }, "desert.dust_rider")).toBe(false);
    expect((await accessCheckFor(pool, { accountId: a.accountId, caravanId: "nope" }))("desert.dust_rider")).toBe(false);
  });

  it("accessCheckFor is a snapshot per call, not shared across calls or owners", async () => {
    const p = await registerPlayer("desert");
    const o = owner(p);
    const before = await accessCheckFor(pool, o);
    await grant(p, "living", 1);
    expect((await spend(p, "living", "desert.sand_sharpshooter", p.caravanId)).statusCode).toBe(201);
    expect(before("desert.sand_sharpshooter")).toBe(false);
    expect((await accessCheckFor(pool, o))("desert.sand_sharpshooter")).toBe(true);
    expect((await accessCheckFor(pool, o))("desert.nobody")).toBe(false);
    const q = await registerPlayer("desert");
    expect((await accessCheckFor(pool, owner(q)))("desert.sand_sharpshooter")).toBe(false);
  });
});

describe("QA-05 S3: the storage layer refuses a free or nameless purchase, as the app role", () => {
  const craft = (p: Player, tag: string, caravanId: string | null, payload: JsonObject) =>
    withTransaction(appRole, (c) => appendEvents(c, `test:craft:${p.accountId}:${tag}`, [{ type: "unlock_node_purchased", accountId: p.accountId, caravanId, payload }]));
  const code = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };

  it("cost 0 (would mint access for nothing), a negative cost, a string cost, a missing, empty or non-string nodeId are all 23514", async () => {
    const p = await registerPlayer("desert");
    expect(await code(() => craft(p, "zero", p.caravanId, { pool: "living", nodeId: "desert.vaquero", cost: 0, tier: 4 }))).toBe("23514");
    expect(await code(() => craft(p, "neg", p.caravanId, { pool: "living", nodeId: "desert.canteen_carrier", cost: -1, tier: 3 }))).toBe("23514");
    expect(await code(() => craft(p, "str", p.caravanId, { pool: "living", nodeId: "desert.canteen_carrier", cost: "1", tier: 3 }))).toBe("23514");
    expect(await code(() => craft(p, "none", null, { pool: "trap", cost: 1 }))).toBe("23514");
    expect(await code(() => craft(p, "empty", null, { pool: "trap", nodeId: "", cost: 1 }))).toBe("23514");
    expect(await code(() => craft(p, "num", null, { pool: "trap", nodeId: 7, cost: 1 }))).toBe("23514");
    expect(await code(() => craft(p, "null", null, { pool: "trap", nodeId: null, cost: 1 }))).toBe("23514");
    expect(await hasAccess(pool, owner(p), "desert.vaquero")).toBe(false);
    expect(await purchaseEventCount(p)).toBe(0);
    expect(await points(p, "living")).toEqual({ granted: 0, spent: 0, available: 0 });
    // a well-formed purchase from the same role still lands (the constraint is a shape check, not a lock-out)
    await grant(p, "trap", 1);
    expect(await code(() => craft(p, "ok", null, { pool: "trap", nodeId: "trap.jaw_trap", cost: 1, tier: 1 }))).toBeUndefined();
    expect(await points(p, "trap")).toEqual({ granted: 1, spent: 1, available: 0 });
  });

  it("the constraint is a shape check only: a crafted purchase naming a node outside the owner's web charges points and grants nothing (the spend service is the gate)", async () => {
    const p = await registerPlayer("desert");
    await grant(p, "living", 6);
    await craft(p, "foreign", p.caravanId, { pool: "living", nodeId: "mountain.grizzly", cost: 6, tier: 4 });
    expect(await hasAccess(pool, owner(p), "mountain.grizzly")).toBe(false);
    expect([...(await unlockedTypeIds(pool, owner(p)))].sort()).toEqual(["desert.dust_rider", "desert.well_digger", "fence.brush_pile", "siege.battering_wagon", "trap.spike_pit"]);
    expect(await points(p, "living")).toEqual({ granted: 6, spent: 6, available: 0 });
    const v = await call(p, "GET", "/me/unlocks");
    expect(v.statusCode).toBe(200);
    expect(JSON.stringify(v.json())).not.toMatch(/mountain\./);
  });
});

describe("QA-05 N1/N4: races, two caravans of one account, and the view as one snapshot", () => {
  it("two different nodes racing with points for only one: exactly one lands, spent is 1, and the ledger holds one purchase", async () => {
    const p = await registerPlayer("desert");
    await grant(p, "trap", 1);
    const rs = await Promise.all([spend(p, "trap", "trap.tripwire_snare"), spend(p, "trap", "trap.jaw_trap"), spend(p, "trap", "trap.jaw_trap"), spend(p, "trap", "trap.tripwire_snare")]);
    const codes = rs.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(1); // the replay of the winner
    expect(codes.filter((c) => c === 409)).toHaveLength(2); // the loser, twice: insufficient_points
    for (const r of rs) if (r.statusCode === 409) expect(r.json().error).toBe("insufficient_points");
    expect(await points(p, "trap")).toEqual({ granted: 1, spent: 1, available: 0 });
    expect(await purchasedNodeIds(pool, "trap", { accountId: p.accountId })).toHaveLength(1);
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });

  it("a spend racing a grant never makes spent exceed granted", async () => {
    const p = await registerPlayer("desert");
    await grant(p, "siege", 1);
    await Promise.all([spend(p, "siege", "siege.bridging_planks"), grant(p, "siege", 2), spend(p, "siege", "siege.bridging_planks")]);
    const row = await points(p, "siege");
    expect(row.spent).toBeLessThanOrEqual(row.granted);
    expect(row.spent).toBe(1);
    expect(row.granted).toBe(3);
  });

  it("two caravans of one account: the living web is per caravan, A's points cannot buy B's node, the same node id is reached once per caravan (the once-per-node index is per caravan), and the view lists both", async () => {
    const p = await registerPlayer("desert");
    const second = await withTransaction(pool, async (c) => {
      const cv = await insertCaravan(c, { accountId: p.accountId, regionId: "desert", name: "Second" });
      await createCaravanPoolProgress(c, cv.id);
      return cv;
    });
    await grant(p, "living", 10, p.caravanId); // only caravan A has points
    const onB = await spend(p, "living", "desert.sand_sharpshooter", second.id);
    expect(onB.statusCode).toBe(409);
    expect(onB.json().error).toBe("insufficient_points");
    expect((await spend(p, "living", "desert.sand_sharpshooter", p.caravanId)).statusCode).toBe(201);
    expect(await hasAccess(pool, { accountId: p.accountId, caravanId: second.id }, "desert.sand_sharpshooter")).toBe(false);
    expect(await hasAccess(pool, { accountId: p.accountId, caravanId: p.caravanId }, "desert.sand_sharpshooter")).toBe(true);
    // B buys the same node id with its own points: the unique index is keyed per caravan
    await grant(p, "living", 10, second.id);
    expect((await spend(p, "living", "desert.sand_sharpshooter", second.id)).statusCode).toBe(201);
    expect((await spend(p, "living", "desert.sand_sharpshooter", second.id)).statusCode).toBe(200);
    expect(await hasAccess(pool, { accountId: p.accountId, caravanId: second.id }, "desert.sand_sharpshooter")).toBe(true);
    expect(await points(p, "living", p.caravanId)).toEqual({ granted: 10, spent: 1, available: 9 });
    expect(await points(p, "living", second.id)).toEqual({ granted: 10, spent: 1, available: 9 });
    // trap and siege are on the account: one web, shared by both caravans
    await grant(p, "trap", 1);
    expect((await spend(p, "trap", "trap.jaw_trap")).statusCode).toBe(201);
    expect(await hasAccess(pool, { accountId: p.accountId, caravanId: second.id }, "trap.jaw_trap")).toBe(true);
    const view = (await call(p, "GET", "/me/unlocks")).json().webs as { id: string; caravanId: string | null; nodes: { id: string; reached: boolean }[] }[];
    expect(view.map((w) => [w.id, w.caravanId])).toEqual([["trap", null], ["siege", null], ["living.desert", p.caravanId], ["living.desert", second.id]]);
    expect(view.filter((w) => w.id === "living.desert").map((w) => w.nodes.find((n) => n.id === "desert.sand_sharpshooter")!.reached)).toEqual([true, true]);
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });

  it("GET /me/unlocks is one read-only snapshot: the route reads through a READ ONLY transaction, and a replayed spend's body is identical except `created`", async () => {
    const p = await registerPlayer("desert");
    await grant(p, "trap", 5);
    const a = (await spend(p, "trap", "trap.jaw_trap")).json();
    const b = (await spend(p, "trap", "trap.jaw_trap")).json();
    expect({ ...a, created: null }).toEqual({ ...b, created: null });
    expect([a.created, b.created]).toEqual([true, false]);
    // the snapshot read agrees with the route, and with the spend's redrawn web
    const snap = await unlockWebsSnapshot(pool, p.accountId);
    expect((await call(p, "GET", "/me/unlocks")).json().webs).toEqual(JSON.parse(JSON.stringify(snap)));
    expect(snap.find((w) => w.id === "trap")!.nodes).toEqual(b.nodes);
    const route = readFileSync(join(__dirname, "..", "src", "routes", "unlocks.ts"), "utf8");
    expect(route).toMatch(/unlockWebsSnapshot\(/);
    expect(route).not.toMatch(/unlockWebsForAccount\(/);
    expect(readFileSync(join(__dirname, "..", "src", "unlocks", "view.ts"), "utf8")).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  });

  it("legibility: `affordable` is false while prerequisites are missing even with points to spare, and the public web carries no account data", async () => {
    const p = await registerPlayer("desert");
    await grant(p, "living", 30);
    const view = (await call(p, "GET", "/me/unlocks")).json().webs as { id: string; nodes: Record<string, unknown>[] }[];
    const living = view.find((w) => w.id === "living.desert")!;
    expect(living.nodes).toHaveLength(8);
    expect(living.nodes.find((n) => n.id === "desert.vaquero")).toMatchObject({ cost: 14, reached: false, prerequisitesMet: false, affordable: false, missing: ["desert.canteen_carrier"] });
    expect(living.nodes.find((n) => n.id === "desert.longhorn_bull")).toMatchObject({ affordable: false, missing: ["desert.coyote_pack", "desert.powder_monkey"] });
    const pub = await app.inject({ method: "GET", url: "/unlocks/webs" });
    expect(pub.body).not.toMatch(/accountId|caravanId|reached|affordable|token/);
    expect(pub.json().webs).toHaveLength(6);
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
    // chunk 25: the authored set grants the rungs a SYSTEM account's party needs (then spends them through
    // spend.ts like anyone); never a player path, never a node reached without a purchase event.
    expect(writers("unlock_points_granted").sort()).toEqual(["matchmaking/authored.ts", "progression/outcome.ts"]);
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

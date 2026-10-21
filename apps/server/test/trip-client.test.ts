/**
 * Chunk 23 (trip client flow), server half:
 *   - the trip status read model the client renders: `nowMs` (the cap countdown runs from
 *     server time), each settled encounter's `result` (the fight's own delta, from the job),
 *     and `ending` (banked / overrun, from the ledger event, without the party owner's id);
 *   - CARAVAN_TEST_RESOLVER=double: refused in production, unknown values refused, and when
 *     installed a committed encounter resolves in-process with no worker call from the test.
 */
import { entryBand, INTERIOR_POST_CELLS, type PartyConfig } from "@caravan/circle";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DOUBLE_UNIT_DAMAGE, TestResolverRefusedError, inlineWorkerFromEnv } from "../src/dev/testResolver.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import type { TripStatusView } from "../src/trip/service.js";
import { endingOfOverrun, encounterResultOf } from "../src/trip/views.js";
import { appRolePool, seasonCaravan, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

async function register(): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("c23"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  await seasonCaravan(pool, b.caravan.id); // r2 S2: the trips a test starts are not the caravan's first (this file serves live parties only)
  return { token: b.token, accountId: b.account.id, caravanId: b.caravan.id };
}

async function units(p: Player, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: "desert.dust_rider", mergeLevel: 1 })).id);
  return ids;
}

async function makeOwner(): Promise<void> {
  const o = await register();
  const ids = await units(o, 2);
  const edges = ["north", "east"] as const;
  const party: PartyConfig = { v: 1, units: ids.map((ref, i) => ({ ref, stance: "nearest" as const, edge: edges[i]!, cell: entryBand(edges[i]!)[i]! })), siege: [] };
  expect((await call(o, "PUT", "/me/party", party)).statusCode).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE account_id = $1 AND pool = 'siege'", [o.accountId]);
}

async function status(p: Player): Promise<TripStatusView> {
  const res = await call(p, "GET", `/me/caravans/${p.caravanId}/trip`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function until(p: Player, phase: string): Promise<TripStatusView> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const s = await status(p);
    if (s.trip?.phase === phase) return s;
    if (Date.now() > deadline) throw new Error(`trip never reached ${phase}: ${JSON.stringify(s.trip)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function fight(p: Player, n: number, posts: string[], withTrapAndFence: boolean): Promise<void> {
  const s = await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/${n}/search`);
  expect(s.statusCode, s.body).toBe(201);
  expect((await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/${n}/choose`, { candidateId: s.json().menu.candidates[0].candidateId })).statusCode).toBe(200);
  const cells = INTERIOR_POST_CELLS;
  const formation = {
    v: 3,
    fences: withTrapAndFence ? [{ ref: "f0", segment: 0 }] : [],
    traps: withTrapAndFence ? [{ ref: "t0", cell: { x: cells[0]!.x, y: cells[0]!.y } }] : [],
    posts: posts.map((ref, i) => ({ ref, cell: { x: cells[1 + i]!.x, y: cells[1 + i]!.y }, stance: "guard" })),
  };
  const f = await call(p, "PUT", `/caravans/${p.caravanId}/encounters/${n}/formation`, formation);
  expect(f.statusCode, f.body).toBe(200);
  const commit = await call(p, "POST", `/me/caravans/${p.caravanId}/trip/encounters/${n}/commit`);
  expect(commit.statusCode, commit.body).toBe(202);
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole, inlineEncounterWorker: inlineWorkerFromEnv({ CARAVAN_TEST_RESOLVER: "double", NODE_ENV: "test" }) });
  for (let i = 0; i < 6; i++) await makeOwner();
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("CARAVAN_TEST_RESOLVER (dev/test only)", () => {
  it("is off when unset, refused in production, and only 'double' is accepted", () => {
    expect(inlineWorkerFromEnv({})).toBeNull();
    expect(inlineWorkerFromEnv({ CARAVAN_TEST_RESOLVER: "" })).toBeNull();
    expect(() => inlineWorkerFromEnv({ CARAVAN_TEST_RESOLVER: "double", NODE_ENV: "production" })).toThrow(TestResolverRefusedError);
    expect(() => inlineWorkerFromEnv({ CARAVAN_TEST_RESOLVER: "double", NODE_ENV: "production" })).toThrow(/refused when NODE_ENV=production/);
    expect(() => inlineWorkerFromEnv({ CARAVAN_TEST_RESOLVER: "real", NODE_ENV: "test" })).toThrow(/must be "double"/);
    expect(inlineWorkerFromEnv({ CARAVAN_TEST_RESOLVER: "double" })?.name).toBe("test-double");
  });

  it("a production app (no flag) installs nothing", async () => {
    const plain = await buildApp({ db: appRole });
    expect(plain.inlineEncounterWorker).toBeNull();
    expect(plain.encounterWorker).toBeNull();
    expect(app.encounterWorker?.name).toBe("test-double");
    await plain.close();
  });
});

describe("the trip status the client renders (chunk 23), over a whole trip resolved by the inline double", () => {
  it("resolving → decide with the encounter's result → push → encounter 2 → bank → ending banked; nowMs and the cap", async () => {
    const p = await register();
    const riders = await units(p, 2);
    await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
    expect((await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: riders, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 11 } })).statusCode).toBe(201);
    const before = Date.now();
    const packed = await status(p);
    // In town: no open trip (the fixture's earlier, finished trip may be shown as the last one).
    expect(packed.trip === null || packed.trip.endedAt !== null).toBe(true);
    expect(packed.nowMs).toBeGreaterThanOrEqual(before);
    expect(packed.nowMs).toBeLessThanOrEqual(Date.now());
    const start = await call(p, "POST", `/me/caravans/${p.caravanId}/trip/start`);
    expect(start.statusCode, start.body).toBe(201);
    const tripId = start.json().tripId as string;

    await fight(p, 1, riders, true);
    const resolving = await status(p);
    expect(resolving.trip!.phase).toBe("resolving"); // the inline worker waits a moment after the commit
    const decide = await until(p, "decide");
    const e1 = decide.trip!.encounters[0]!;
    expect(e1).toMatchObject({ index: 1, outcome: "caravan_held", decision: null });
    expect(e1.result!.jobId).toBe(`encounter:${tripId}:1`);
    expect(e1.result!.unitsKilled).toEqual([]);
    expect(e1.result!.unitsDamaged.map((u) => [u.ref, u.hpBefore - u.hpAfter]).sort()).toEqual(riders.map((r) => [r, DOUBLE_UNIT_DAMAGE]).sort());
    expect(e1.result!.trapsSpent).toEqual([{ ref: "t0", typeId: "trap.spike_pit" }]);
    expect(e1.result!.fencesBroken).toEqual([expect.objectContaining({ ref: "f0", tierId: "fence.brush_pile" })]);
    expect(decide.trip!.ending).toBeNull();
    expect(decide.cap.available).toBe(2);

    expect((await call(p, "POST", `/me/caravans/${p.caravanId}/trip/push`, { tripId, encounterIndex: 1 })).statusCode).toBe(200);
    await fight(p, 2, riders, false);
    const d2 = await until(p, "decide");
    const e2 = d2.trip!.encounters[1]!;
    expect(e2.result!.trapsSpent).toEqual([]);
    expect(e2.result!.fencesBroken).toEqual([]);
    expect(e2.result!.unitsDamaged.every((u) => u.hpBefore === u.maxHp - DOUBLE_UNIT_DAMAGE)).toBe(true); // attrition carried
    // Chunk 23 QA D3: the inline double's encounter-2 script kills the lowest-ref post; the caravan holds.
    const lowest = [...riders].sort()[0]!;
    expect(e2.outcome).toBe("caravan_held");
    expect(e2.result!.unitsKilled.map((u) => u.ref)).toEqual([lowest]);
    expect(e2.deaths).toEqual([lowest]);
    const preview = (await call(p, "GET", `/me/caravans/${p.caravanId}/trip/preview`)).json();
    expect(preview.bankNow.unitsDeMerged).toEqual([{ ref: lowest, typeId: "desert.dust_rider", fromLevel: 1, toLevel: 1, diedAtEncounter: 2 }]);
    const bank = await call(p, "POST", `/me/caravans/${p.caravanId}/trip/bank`, { tripId, encounterIndex: 2 });
    expect(bank.statusCode, bank.body).toBe(200);
    expect(bank.json().restored.deMerged).toEqual(preview.bankNow.unitsDeMerged);
    const after = await status(p);
    expect(after.trip!.phase).toBe("ended");
    expect(after.trip!.ending).toMatchObject({ kind: "banked", encountersSurvived: 2, requested: bank.json().requested, credited: bank.json().credited, discarded: bank.json().discarded });
    expect(after.caravan.state).toBe("in_town");
    expect(after.cap.available).toBe(2);
    expect(after.cap.nextRegenAtMs! - after.nowMs).toBeGreaterThan(0);
    // No owner account id anywhere in what the client reads.
    expect(JSON.stringify(after)).not.toMatch(/ownerAccountId|partyOwner/);
  });
});

describe("projections (pure)", () => {
  it("an overrun ending drops the party owner's id and says each dead unit's level after", () => {
    const e = endingOfOverrun({
      encounterIndex: 2,
      unbankedCoin: 900,
      partyOwnerAccountId: "secret",
      partyOwnerAuthored: false,
      unitsAliveAtCollapse: [{ ref: "a", typeId: "desert.dust_rider", mergeLevel: 3, hp: 10 }],
      unitsDiedOnTrip: [{ ref: "b", typeId: "desert.dust_rider", mergeLevel: 3, diedAtEncounter: 1 }, { ref: "c", typeId: "desert.dust_rider", mergeLevel: 1, diedAtEncounter: 2 }],
      lossesApplied: false,
    });
    expect(JSON.stringify(e)).not.toContain("secret");
    expect(e).toEqual({
      kind: "overrun",
      encounterIndex: 2,
      coinLost: 900,
      unitsLostOutright: [{ ref: "a", typeId: "desert.dust_rider", mergeLevel: 3 }],
      unitsDeMerged: [
        { ref: "b", typeId: "desert.dust_rider", mergeLevel: 3, mergeLevelAfter: 2, diedAtEncounter: 1 },
        { ref: "c", typeId: "desert.dust_rider", mergeLevel: 1, mergeLevelAfter: 1, diedAtEncounter: 2 },
      ],
      lossesApplied: false,
    });
  });

  it("a job that is not completed, or whose outcome names a unit not in the fight, has no result (never a guess)", () => {
    expect(encounterResultOf(null)).toBeNull();
    expect(encounterResultOf({ id: "j", status: "queued" } as never)).toBeNull();
    expect(encounterResultOf({ id: "j", status: "completed", input: {}, result: { outcome: { kind: "caravan_held" } } } as never)).toBeNull();
  });
});

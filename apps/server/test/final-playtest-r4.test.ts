/**
 * Final play-test review, round 4 polish (roadmap/qa/final-playtest-review-r4.md, orchestrator decisions):
 *   D2   the suggested party (the guide's one-tap raise) alternates over the caravan's two starter
 *        edges with each unit's stance from its role (@caravan/circle raiseUnits);
 *   N1   GET /me/economy?caravanId= carries that caravan's band-scaled shortest trip;
 *   N6   party changes close together are one inbox notice with the final count;
 *   N8   a strike window still open at the read says so (`windowOpen`);
 *   N11  generated caravan names never share a first part with another caravan's name while one is free.
 */
import { raiseStance, starterEdges, type PartyConfig } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { coinForDelivery, coinForEncounter } from "../src/economy/coin.js";
import { partyChangedItems, strikeItem } from "../src/inbox/derive.js";
import { INBOX_PARTY_CHANGE_COALESCE_MS, INBOX_STRIKE_BATCH_WINDOW_MS } from "../src/inbox/tunables.js";
import { bandOf } from "../src/matchmaking/band.js";
import { getCaravanPoolProgress } from "../src/repo/poolProgress.js";
import { GENERATED_NAME_FIRST_PARTS } from "../src/services/caravanNames.js";
import { registerAccount } from "../src/services/onboarding.js";
import { appRolePool, testPool, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

interface Player {
  token: string;
  caravanId: string;
}

async function register(region = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("p4"), password: "correct horse battery", region } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  return { token: b.token, caravanId: b.caravan.id };
}

function get(p: Player, url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${p.token}` } });
}

describe("r4 D2: the suggested party varies its edges and stances, deterministically", () => {
  it("alternates over the caravan's two starter edges, each unit's stance from its role", async () => {
    for (const region of ["desert", "high_plains"]) {
      const p = await register(region);
      const view = (await get(p, "/me/party")).json().party;
      const suggested = view.suggested as PartyConfig;
      expect(suggested.units.length).toBe(Math.min(TUNABLES.PARTY_SLOT_CAP, TUNABLES.SUGGESTED_PARTY_MAX, (view.roster as { unlocked: boolean }[]).filter((r) => r.unlocked).length));
      const [a, b] = starterEdges(p.caravanId);
      const types = new Map((view.roster as { instanceId: string; typeId: string }[]).map((r) => [r.instanceId, r.typeId]));
      // normalizePartyConfig may reorder units; check each unit against the rule by its place in roster order.
      const order = (view.roster as { instanceId: string; unlocked: boolean }[]).filter((r) => r.unlocked).map((r) => r.instanceId);
      for (const u of suggested.units) {
        const i = order.indexOf(u.ref);
        expect(u.edge, u.ref).toBe(i % 2 === 0 ? a : b);
        expect(u.stance, u.ref).toBe(raiseStance(types.get(u.ref)!));
      }
      expect(new Set(suggested.units.map((u) => u.edge)).size).toBe(suggested.units.length > 1 ? 2 : 1);
      // The same read again is the same suggestion.
      expect((await get(p, "/me/party")).json().party.suggested).toEqual(suggested);
    }
  });
});

describe("r4 N1: the outfit's forecast at the caravan's band", () => {
  it("GET /me/economy?caravanId= adds the band-scaled first encounter and shortest trip; another's caravan is 404, a bad id 400", async () => {
    const p = await register();
    const base = (await get(p, "/me/economy")).json();
    expect(base.earn.caravan).toBeUndefined();
    const res = await get(p, `/me/economy?caravanId=${p.caravanId}`);
    expect(res.statusCode, res.body).toBe(200);
    const band = bandOf((await getCaravanPoolProgress(pool, p.caravanId))!.reputation).index;
    expect(res.json().earn.caravan).toEqual({ caravanId: p.caravanId, band, firstEncounter: coinForEncounter(1, band), shortestTrip: coinForEncounter(1, band) + coinForDelivery(1) });
    const other = await register();
    expect((await get(p, `/me/economy?caravanId=${other.caravanId}`)).statusCode).toBe(404);
    expect((await get(p, "/me/economy?caravanId=nope")).statusCode).toBe(400);
  });
});

describe("r4 N6 / N8: the inbox's wording (pure)", () => {
  const ev = (seq: number, ms: number, reason: "merge" | "trip_loss", units: number) => ({ seq, occurredAtMs: ms, payload: { reason, repointed: reason === "merge" ? ["x"] : [], dropped: reason === "merge" ? [] : ["y"], units, empty: units === 0 } });

  it("N6: four merges in one visit are one notice with the final count; a later change or another reason is its own", () => {
    const t = 1_790_000_000_000;
    const items = partyChangedItems([ev(4, t + 30_000, "merge", 3), ev(1, t, "merge", 6), ev(2, t + 10_000, "merge", 5), ev(3, t + 20_000, "merge", 4), ev(5, t + 40_000, "trip_loss", 2), ev(6, t + 40_000 + INBOX_PARTY_CHANGE_COALESCE_MS + 1, "trip_loss", 1)], INBOX_PARTY_CHANGE_COALESCE_MS);
    expect(items.map((i) => [i.key, i.version])).toEqual([["party:6", 1], ["party:5", 1], ["party:1", 4]]);
    expect(items[2]!.detail).toEqual({ reason: "merge", carriedOver: 4, dropped: 0, unitsNow: 3, empty: false, changes: 4 });
    expect(items[2]!.occurredAtMs).toBe(t + 30_000);
    // A lone change keeps the key and version it always had.
    expect(partyChangedItems([ev(9, t, "trip_loss", 0)], INBOX_PARTY_CHANGE_COALESCE_MS)[0]).toMatchObject({ key: "party:9", version: 1, detail: { empty: true, changes: 1 } });
  });

  it("N8: windowOpen is true only while the read is inside the window", () => {
    const W = INBOX_STRIKE_BATCH_WINDOW_MS;
    const w = 500_000;
    const totals = { window: w, count: 1, maxSeq: 1, newestAtMs: w * W + 5, held: 1, overran: 0, stalemate: 0, coinEarned: 0, coinTransferred: 0, coinDiscardedAtCap: 0, reputationDelta: 0, ladderPointsGained: 0 };
    expect(strikeItem(totals, null, W, w * W + 10).detail).toMatchObject({ windowOpen: true });
    expect(strikeItem(totals, null, W, (w + 1) * W).detail).toMatchObject({ windowOpen: false });
    expect(strikeItem(totals, null, W).detail).toMatchObject({ windowOpen: false });
  });
});

describe("r4 N11: generated caravan names read as different caravans", () => {
  it("while a first part is free, a generated name never starts with another caravan's first part", async () => {
    const names: string[] = [];
    for (let i = 0; i < 8; i++) names.push((await registerAccount(pool, { username: unique("nm4"), password: "password123", regionId: "desert" })).caravan.name);
    const firstOf = (n: string): string => [...GENERATED_NAME_FIRST_PARTS].sort((x, y) => y.length - x.length).find((f) => n.startsWith(`${f} `)) ?? n;
    const firsts = names.map(firstOf);
    expect(new Set(firsts).size, names.join(" | ")).toBe(names.length);
  });
});

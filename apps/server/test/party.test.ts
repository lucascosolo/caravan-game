/**
 * Chunk 09 server-side: the standing raid party routes, every validation rule enforced
 * at the HTTP boundary (caps, stance, edge, band, duplicates, roster membership, the
 * access gate), free instant editing, the preview == scout identity, the results feed,
 * the DB guards, and — the load-bearing check — that nothing consumes a party: served
 * into many resolutions, including ones where it is annihilated, the owner's roster and
 * party row are byte-identical afterwards; a trip's attrition lands only on the caravan's
 * manifest; and an instance that stops existing makes the party INVALID at the next
 * read/edit rather than the party being damaged by a fight.
 */
import { TUNABLES, getUnitType } from "@caravan/content";
import { RESOLVER_VERSION } from "@caravan/resolver";
import { RING_ANCHORS, RING_SEGMENTS, entryBand, partyFromJson, scoutParty, serializePartyConfig, type Formation, type PartyConfig } from "@caravan/circle";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { applyOutcome } from "../src/circle/service.js";
import { withTransaction } from "../src/db/pool.js";
import { appendCoinCredits } from "../src/economy/coin.js";
import { enqueueEncounterResolution } from "../src/jobs/handlers/encounterResolution.js";
import { getJob } from "../src/jobs/queue.js";
import { StandingPartyInvalidError, snapshotStandingParty } from "../src/jobs/snapshots.js";
import { PARTY_SAVE_RATE_LIMIT_PER_MINUTE } from "../src/jobs/tunables.js";
import { drain, type HandlerRegistry } from "../src/jobs/worker.js";
import { LEDGER_EVENT_TYPES, canonicalJson, type Json } from "../src/ledger/events.js";
import { listEventsForAccount } from "../src/ledger/ledger.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { partySaveLimiter } from "../src/routes/party.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique, commitFormationInTown } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: string[];
}

async function registerPlayer(region = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("p"), password: "correct horse battery", region } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: [] };
}

async function giveUnits(p: Player, n: number, typeId = "desert.dust_rider", mergeLevel = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
  p.units.push(...ids);
  return ids;
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  // Chunk 15 QA N4: the raw commit route is trip-only now; chunk 07's model tests commit through the service.
  return commitFormationInTown(appRole, p.caravanId, method, url).then((r) => (r as unknown as LightMyRequestResponse | null) ?? app.inject(opts));
}

const north = entryBand("north");
const south = entryBand("south");
const east = entryBand("east");
const west = entryBand("west");
const EDGES = [
  ["north", north],
  ["east", east],
  ["south", south],
  ["west", west],
] as const;

/** A full party: every unit on a different edge in turn, stances cycling, one siege piece. */
function fullParty(units: string[], siege: string[] = ["siege.battering_wagon"]): PartyConfig {
  const stances = ["nearest", "traps", "core"] as const;
  return {
    v: 1,
    units: units.map((ref, i) => {
      const [edge, band] = EDGES[i % 4]!;
      return { ref, stance: stances[i % 3]!, edge, cell: band[i]! };
    }),
    siege,
  };
}

async function rosterBytes(caravanId: string): Promise<string> {
  const res = await pool.query<{ j: string }>("SELECT coalesce(json_agg(row_to_json(u) ORDER BY u.id)::text, '[]') AS j FROM unit_instance u WHERE caravan_id = $1", [caravanId]);
  return res.rows[0]!.j;
}
async function partyBytes(accountId: string): Promise<string> {
  const res = await pool.query<{ j: string }>("SELECT row_to_json(sp)::text AS j FROM standing_party sp WHERE account_id = $1", [accountId]);
  return res.rows[0]!.j;
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
});
// The abuse limit on PUT /me/party (QA S4) is per sliding minute; this file issues far more
// than that per player, so it is reset between cases. The S4 case below exercises it.
beforeEach(() => partySaveLimiter.reset());
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("GET /me/party on a fresh account", () => {
  it("is a valid empty party with the caps, the rules, the roster and the siege counter table", async () => {
    const p = await registerPlayer();
    await giveUnits(p, 2);
    const res = await call(p, "GET", "/me/party");
    expect(res.statusCode).toBe(200);
    const v = res.json().party;
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.config).toEqual({ v: 1, units: [], siege: [] });
    expect(v.party).toEqual({ v: 1, units: [], siege: [] });
    expect(v.scout).toMatchObject({ v: 1, units: [], siege: [], edges: [], unitSlots: { used: 0, cap: 8 }, siegeSlots: { used: 0, cap: 3 } });
    expect(v.caps).toEqual({ units: 8, siege: 3, edges: 4, editCooldownMs: 0, partiesPerAccount: 1 });
    expect(v.rules).toEqual({ template: true, neverConsumed: true, unitsMayAlsoBePackedOnTrips: true, ratingInUse: "offense", stances: ["nearest", "traps", "core"] });
    expect(v.roster.length).toBe(2);
    expect(v.roster[0]).toMatchObject({ typeId: "desert.dust_rider", mergeLevel: 1, slotCost: 1, offense: 95, defense: 55, unlocked: true, inParty: false, packedOnTrip: false, aliveOnTrip: null });
    expect(v.siegeCatalog.map((s: { typeId: string; unlocked: boolean }) => [s.typeId, s.unlocked])).toEqual([
      ["siege.battering_wagon", true],
      ["siege.fence_cutters", false],
      ["siege.blasting_crate", false],
      ["siege.bridging_planks", false],
      ["siege.dousing_wagon", false],
    ]);
    expect(v.siegeCatalog[0]).toMatchObject({ counters: { kind: "fence", category: "timber" }, effect: "accelerates", targetTypeIds: ["fence.brush_pile", "fence.split_rail"] });
    expect(typeof v.savedAt).toBe("string");
    expect(v.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires auth", async () => {
    expect((await app.inject({ method: "GET", url: "/me/party" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/me/party", payload: { v: 1, units: [], siege: [] } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me/party/feed" })).statusCode).toBe(401);
  });
});

describe("PUT /me/party — composition, stances, edges, positions", () => {
  let p: Player;
  beforeAll(async () => {
    p = await registerPlayer();
    await giveUnits(p, 5, "desert.dust_rider");
    await giveUnits(p, 3, "desert.well_digger", 3);
  });

  it("stores a full party split across all four edges, resolved to the live roster, and appends one account-scoped event", async () => {
    const before = (await call(p, "GET", "/me/party")).json().party;
    const config = fullParty(p.units);
    const res = await call(p, "PUT", "/me/party", config);
    expect(res.statusCode).toBe(200);
    const v = res.json().party;
    expect(v.valid).toBe(true);
    expect(v.party.units.length).toBe(8);
    expect(v.party.siege).toEqual([{ typeId: "siege.battering_wagon" }]);
    expect(v.party.units.map((u: { ref: string }) => u.ref)).toEqual([...p.units].sort());
    expect(v.party.units.find((u: { ref: string }) => u.ref === p.units[5])).toMatchObject({ typeId: "desert.well_digger", mergeLevel: 3 });
    expect(v.edges).toEqual(["north", "east", "south", "west"]);
    expect(v.scout.units.length).toBe(8);
    expect(v.scout.edges).toEqual(["north", "east", "south", "west"]);
    expect(v.roster.filter((r: { inParty: boolean }) => r.inParty).length).toBe(8);
    expect(v.savedAt).not.toBe(before.savedAt);
    expect(v.hash).not.toBe(before.hash);
    const events = (await listEventsForAccount(pool, p.accountId)).filter((e) => e.event_type === "standing_party_saved");
    expect(events.length).toBe(1);
    expect(events[0]!.caravan_id).toBeNull();
    expect(events[0]!.causation_id).toBe(`party_saved:${v.id}:1`);
    expect(events[0]!.payload).toMatchObject({ partyId: v.id, slot: 0, saveSeq: 1, hash: v.hash, units: 8, siege: 1, edges: ["north", "east", "south", "west"] });
    expect(canonicalJson(events[0]!.payload["config"] as Json)).toBe(serializePartyConfig(config));
  });

  it("is idempotent: the same party in another order is a no-op — same hash, same savedAt, no new event", async () => {
    const cur = (await call(p, "GET", "/me/party")).json().party;
    const config = fullParty(p.units);
    const res = await call(p, "PUT", "/me/party", { ...config, units: [...config.units].reverse() });
    expect(res.statusCode).toBe(200);
    expect(res.json().party.hash).toBe(cur.hash);
    expect(res.json().party.savedAt).toBe(cur.savedAt);
    expect((await listEventsForAccount(pool, p.accountId)).filter((e) => e.event_type === "standing_party_saved").length).toBe(1);
  });

  it("the stored row is canonical and re-serializes byte-identically to its hash input", async () => {
    const row = await pool.query<{ composition: unknown }>("SELECT composition FROM standing_party WHERE account_id = $1", [p.accountId]);
    expect(canonicalJson(row.rows[0]!.composition as Json)).toBe(serializePartyConfig(fullParty(p.units)));
  });

  it("refuses the ninth unit (PARTY_SLOT_CAP) and the fourth siege piece (SIEGE_SLOT_CAP), server-side", async () => {
    const extra = await giveUnits(p, 1);
    const over = fullParty([...p.units], ["siege.battering_wagon", "siege.fence_cutters", "siege.blasting_crate", "siege.dousing_wagon"]);
    const res = await call(p, "PUT", "/me/party", over);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_party");
    const codes = res.json().issues.map((i: { code: string }) => i.code);
    expect(codes).toContain("slot_cap_units");
    expect(codes).toContain("slot_cap_siege");
    expect(TUNABLES.PARTY_SLOT_CAP).toBe(TUNABLES.DEPLOYMENT_SLOT_CAP);
    p.units = p.units.filter((u) => u !== extra[0]);
  });

  it("refuses a stance outside nearest|traps|core and an edge outside the four, by name, before validation", async () => {
    const config = fullParty(p.units);
    const badStance = await call(p, "PUT", "/me/party", { ...config, units: [{ ...config.units[0], stance: "aggressive" }, ...config.units.slice(1)] });
    expect(badStance.statusCode).toBe(400);
    expect(badStance.json()).toMatchObject({ error: "malformed_party" });
    expect(badStance.json().message).toContain("nearest, traps, core");
    const badEdge = await call(p, "PUT", "/me/party", { ...config, units: [{ ...config.units[0], edge: "up" }, ...config.units.slice(1)] });
    expect(badEdge.statusCode).toBe(400);
    expect(badEdge.json().message).toContain("north, east, south, west");
  });

  it("refuses a starting cell outside the chosen edge's entry band, and off the lattice", async () => {
    const config = fullParty(p.units);
    const res = await call(p, "PUT", "/me/party", {
      ...config,
      units: [
        { ...config.units[0], cell: { x: 15, y: 15 } }, // the core
        { ...config.units[1], cell: north[0] }, // a north cell for an east-edge unit
        { ...config.units[2], cell: { x: 5, y: 5 } }, // interior
        ...config.units.slice(3),
      ],
    });
    expect(res.statusCode).toBe(400);
    // Issues come in canonical (ref) order, since the config is normalized before validation.
    expect(res.json().issues.map((i: { code: string; subject: string }) => [i.code, i.subject])).toEqual(
      [p.units[0], p.units[1], p.units[2]].sort().map((ref) => ["cell_off_band", ref]),
    );
    const off = await call(p, "PUT", "/me/party", { ...config, units: [{ ...config.units[0], cell: { x: -1, y: 0 } }, ...config.units.slice(1)] });
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toBe("malformed_party");
  });

  it("refuses duplicates: the same instance twice, the same siege type twice", async () => {
    const config = fullParty(p.units.slice(0, 7));
    const res = await call(p, "PUT", "/me/party", { ...config, units: [...config.units, { ...config.units[0] }], siege: ["siege.battering_wagon", "siege.battering_wagon"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { code: string }) => i.code)).toEqual(["duplicate_ref", "duplicate_siege"]);
  });

  it("refuses another player's instance as unknown_ref, with no hint that it exists", async () => {
    const other = await registerPlayer();
    const [theirs] = await giveUnits(other, 1);
    const res = await call(p, "PUT", "/me/party", fullParty([...p.units.slice(0, 7), theirs!]));
    expect(res.statusCode).toBe(400);
    // QA S1: the message names the entry by its (canonical) position only; the id rides in `subject`.
    const position = [...p.units.slice(0, 7), theirs!].sort().indexOf(theirs!);
    expect(res.json().issues).toEqual([{ code: "unknown_ref", message: `party unit #${position} is not in your roster (it may have been lost on a trip or consumed by a merge)`, subject: theirs }]);
  });

  it("the access gate: a locked living type the caravan owns and a locked siege type are refused by hand-crafted request", async () => {
    const [vaquero] = await giveUnits(p, 1, "desert.vaquero");
    const res = await call(p, "PUT", "/me/party", fullParty([...p.units.slice(0, 7), vaquero!], ["siege.fence_cutters"]));
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { code: string; subject: string }) => [i.code, i.subject])).toEqual([
      ["type_locked", "desert.vaquero"],
      ["type_locked", "siege.fence_cutters"],
    ]);
    const unknown = await call(p, "PUT", "/me/party", fullParty(p.units.slice(0, 7), ["siege.catapult"]));
    expect(unknown.json().issues).toEqual([{ code: "unknown_type", message: "party siege #0 is an unknown siege type", subject: "siege.catapult" }]);
    p.units = p.units.filter((u) => u !== vaquero);
  });

  it("parses strictly: unknown keys, a float cell, a smuggled stat, an array body, a wrong version", async () => {
    const config = fullParty(p.units);
    for (const body of [
      { ...config, cooldown: 0 },
      { ...config, units: [{ ...config.units[0], cell: { x: 0.5, y: 0 } }, ...config.units.slice(1)] },
      { ...config, units: [{ ...config.units[0], hp: 9999 }, ...config.units.slice(1)] },
      { ...config, siege: [{ typeId: "siege.battering_wagon" }] },
      { ...config, v: 2 },
      [],
      null,
    ]) {
      const res = await call(p, "PUT", "/me/party", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe("malformed_party");
    }
    expect((await call(p, "GET", "/me/party")).json().party.valid).toBe(true);
  });

  it("a hostile body is refused with one oversized issue", async () => {
    const units = Array.from({ length: 500 }, (_, i) => ({ ref: `x${i}`, stance: "core", edge: "north", cell: north[0] }));
    const res = await call(p, "PUT", "/me/party", { v: 1, units, siege: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toEqual([{ code: "oversized", message: "500 units is far beyond the 8-unit cap" }]);
  });

  it("editing is free and instant: twenty alternating saves in a row all succeed, each its own numbered event, no cooldown anywhere", async () => {
    const a = fullParty(p.units);
    const b = fullParty(p.units.slice(0, 4), []);
    const start = (await listEventsForAccount(pool, p.accountId)).filter((e) => e.event_type === "standing_party_saved").length;
    for (let i = 0; i < 20; i++) {
      const res = await call(p, "PUT", "/me/party", i % 2 === 0 ? b : a);
      expect(res.statusCode).toBe(200);
    }
    const saves = (await listEventsForAccount(pool, p.accountId, { limit: 500 })).filter((e) => e.event_type === "standing_party_saved");
    expect(saves.length).toBe(start + 20);
    expect(saves.map((e) => e.payload["saveSeq"])).toEqual(saves.map((_, i) => i + 1));
    expect(TUNABLES.PARTY_EDIT_COOLDOWN_MS).toBe(0);
    expect((await call(p, "GET", "/me/party")).json().party.config.units.length).toBe(8); // the last save was `a`
    expect((await call(p, "PUT", "/me/party", b)).statusCode).toBe(200);
    expect((await call(p, "GET", "/me/party")).json().party.config.units.length).toBe(4);
    expect((await call(p, "PUT", "/me/party", a)).statusCode).toBe(200);
  });

  it("clearing the party is a legal edit", async () => {
    const res = await call(p, "PUT", "/me/party", { v: 1, units: [], siege: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json().party).toMatchObject({ valid: true, party: { v: 1, units: [], siege: [] } });
    expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
  });
});

describe("the preview is the scout: what the owner sees is byte-for-byte what a defender is served", () => {
  it("snapshotStandingParty resolves the same party, and scoutParty of the snapshot equals the owner's preview", async () => {
    const p = await registerPlayer();
    await giveUnits(p, 6, "desert.dust_rider", 2);
    await giveUnits(p, 2, "desert.well_digger", 5);
    expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
    const view = (await call(p, "GET", "/me/party")).json().party;
    const snap = await snapshotStandingParty(pool, p.accountId);
    expect(snap).toMatchObject({ ownerAccountId: p.accountId, partyId: view.id, slot: 0, savedAt: view.savedAt, hash: view.hash });
    expect(canonicalJson(snap.composition)).toBe(canonicalJson(view.party as Json));
    const served = scoutParty(partyFromJson(snap.composition));
    expect(canonicalJson(served as unknown as Json)).toBe(canonicalJson(view.scout as Json));
    // Every field the model carries reaches the scout: stance, edge, cell, both ratings, merged hp, ability, siege counters.
    const u = served.units.find((x) => x.mergeLevel === 5)!;
    expect(u).toMatchObject({ typeId: "desert.well_digger", ratingInUse: "offense", slotCost: 1 });
    expect(Object.keys(u).sort()).toEqual(["ability", "abilityDisplay", "affinity", "attackCooldown", "attackRange", "cell", "damagePerHitMult", "defense", "displayName", "edge", "hp", "mergeLevel", "moveSpeed", "offense", "pos", "ratingInUse", "ref", "slotCost", "stance", "typeId"]);
    expect(served.siege[0]!.targetTypeIds).toEqual(["fence.brush_pile", "fence.split_rail"]);
  });
});

/** A stand-in for chunk 13's resolution: alternating outcomes, the party-side earn paths on an overrun. */
const outcomeHandlers: HandlerRegistry = {
  encounter_resolution: (job) => {
    const input = job.input as { tripId: string; encounterIndex: number; defenderAccountId: string; defenderCaravanId: string; partyOwnerAccountId: string; party: { savedAt: string } };
    const overrun = input.encounterIndex % 2 === 0;
    const outcome = { kind: overrun ? "caravan_overrun" : "caravan_held", depth: input.encounterIndex, resolverVersion: RESOLVER_VERSION };
    const base = { jobId: job.id, tripId: input.tripId, encounterIndex: input.encounterIndex };
    return {
      events: [
        { type: "encounter_resolved", accountId: input.defenderAccountId, caravanId: input.defenderCaravanId, resolverVersion: RESOLVER_VERSION, payload: { ...base, partyOwnerAccountId: input.partyOwnerAccountId, outcome } },
        { type: "party_served_as_encounter", accountId: input.partyOwnerAccountId, resolverVersion: RESOLVER_VERSION, payload: { ...base, defenderAccountId: input.defenderAccountId, defenderCaravanId: input.defenderCaravanId, partySavedAt: input.party.savedAt, outcome } },
        ...(overrun
          ? [
              { type: "coin_earned" as const, accountId: input.partyOwnerAccountId, payload: { amount: TUNABLES.COIN_PER_PARTY_WIN, reason: "party_win", ...base } },
              { type: "reputation_changed" as const, accountId: input.partyOwnerAccountId, payload: { pool: "siege", delta: 12, reason: "party_win" } },
              { type: "ladder_progress_gained" as const, accountId: input.partyOwnerAccountId, payload: { pool: "siege", pointsDelta: 5, levelsGained: 0 } },
            ]
          : [{ type: "reputation_changed" as const, accountId: input.partyOwnerAccountId, payload: { pool: "siege", delta: -8, reason: "party_wiped" } }]),
      ],
      result: { outcome },
    };
  },
};

describe("THE GUARANTEE: a party is never consumed, never loses a unit, never de-merges", () => {
  const N = 12;
  let owner: Player;
  let defenders: Player[];
  let rosterBefore: string;
  let partyBefore: string;
  let viewBefore: unknown;

  beforeAll(async () => {
    owner = await registerPlayer("desert");
    await giveUnits(owner, 4, "desert.dust_rider", 1);
    await giveUnits(owner, 4, "desert.well_digger", 4);
    expect((await call(owner, "PUT", "/me/party", fullParty(owner.units))).statusCode).toBe(200);
    defenders = [];
    for (let i = 0; i < N; i++) defenders.push(await registerPlayer(i % 2 ? "mountain" : "badlands"));
    rosterBefore = await rosterBytes(owner.caravanId);
    partyBefore = await partyBytes(owner.accountId);
    viewBefore = (await call(owner, "GET", "/me/party")).json().party;
  });

  it("served into twelve resolutions, half of them annihilations: roster, party row and view are byte-identical; every job saw one identical snapshot", async () => {
    await Promise.all(
      defenders.map((d, i) =>
        withTransaction(pool, async (c) =>
          enqueueEncounterResolution(c, {
            tripId: `trail-${i}`,
            encounterIndex: i + 1,
            defenderAccountId: d.accountId,
            defenderCaravanId: d.caravanId,
            partyOwnerAccountId: owner.accountId,
            formation: { fences: [], traps: [], posts: [] },
            party: await snapshotStandingParty(c, owner.accountId),
          }),
        ),
      ),
    );
    const outcomes = (await Promise.all([0, 1, 2].map((i) => drain(pool, { workerId: `w${i}`, handlers: outcomeHandlers, retryBackoffMs: () => 0 })))).flat();
    expect(outcomes.map((o) => o.kind)).toEqual(Array(N).fill("completed"));

    expect(await rosterBytes(owner.caravanId)).toBe(rosterBefore);
    expect(await partyBytes(owner.accountId)).toBe(partyBefore);
    expect((await call(owner, "GET", "/me/party")).json().party).toEqual(viewBefore);
    const snapshots = new Set<string>();
    for (let i = 0; i < N; i++) {
      const job = (await getJob(pool, `encounter:trail-${i}:${i + 1}`))!;
      expect(job.status).toBe("completed");
      snapshots.add(canonicalJson(job.input["party"] as Json));
    }
    expect(snapshots.size).toBe(1);
    const snap = [...snapshots][0]!;
    expect(JSON.parse(snap)).toMatchObject({ ownerAccountId: owner.accountId, savedAt: (viewBefore as { savedAt: string }).savedAt, hash: (viewBefore as { hash: string }).hash });
    expect(partyFromJson(JSON.parse(snap).composition).units.length).toBe(8);
  });

  it("the feed: where it struck, the outcome, the depth, Coin and Reputation — newest first, paged", async () => {
    const res = await call(owner, "GET", "/me/party/feed?limit=5");
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.entries.length).toBe(5);
    expect(page.hasMore).toBe(true);
    expect(page.entries.map((e: { seq: number }) => e.seq)).toEqual([...page.entries.map((e: { seq: number }) => e.seq)].sort((a, b) => b - a));
    const all: { seq: number; encounterIndex: number; outcomeKind: string; coinEarned: number; reputationDelta: number; ladderPointsGained: number; defender: Record<string, string | null>; tripId: string; partySavedAt: string; resolverVersion: number }[] = [];
    let before = 0;
    for (;;) {
      const r = (await call(owner, "GET", `/me/party/feed?limit=5&before=${before}`)).json();
      all.push(...r.entries);
      if (!r.hasMore) break;
      before = r.nextBefore;
    }
    expect(all.length).toBe(N);
    for (const e of all) {
      const i = e.encounterIndex - 1;
      const d = defenders[i]!;
      expect(e.tripId).toBe(`trail-${i}`);
      expect(e.defender).toMatchObject({ caravanId: d.caravanId, regionId: i % 2 ? "mountain" : "badlands" });
      expect(e.defender).not.toHaveProperty("accountId"); // chunk 19 QA S1: account ids are not public
      expect(typeof e.defender["caravanName"]).toBe("string");
      expect(typeof e.defender["username"]).toBe("string");
      expect(e.partySavedAt).toBe((viewBefore as { savedAt: string }).savedAt);
      expect(e.resolverVersion).toBe(RESOLVER_VERSION);
      if (e.encounterIndex % 2 === 0) {
        expect(e.outcomeKind).toBe("caravan_overrun");
        expect(e.coinEarned).toBe(TUNABLES.COIN_PER_PARTY_WIN);
        expect(e.reputationDelta).toBe(12);
        expect(e.ladderPointsGained).toBe(5);
      } else {
        expect(e.outcomeKind).toBe("caravan_held");
        expect(e.coinEarned).toBe(0);
        expect(e.reputationDelta).toBe(-8);
        expect(e.ladderPointsGained).toBe(0);
      }
    }
    expect((await call(owner, "GET", "/me/party/feed?limit=0")).statusCode).toBe(400);
    expect((await call(owner, "GET", "/me/party/feed?before=-1")).statusCode).toBe(400);
    // A defender sees nothing of this on their own party feed.
    expect((await call(defenders[0]!, "GET", "/me/party/feed")).json().entries).toEqual([]);
  });

  it("editing after being served changes nothing already resolved: the old jobs keep their snapshot, a new serve gets the new one", async () => {
    const smaller = fullParty(owner.units.slice(0, 3), []);
    expect((await call(owner, "PUT", "/me/party", smaller)).statusCode).toBe(200);
    const job = (await getJob(pool, "encounter:trail-0:1"))!;
    expect(partyFromJson((job.input["party"] as { composition: unknown }).composition).units.length).toBe(8);
    const snap = await snapshotStandingParty(pool, owner.accountId);
    expect(partyFromJson(snap.composition).units.length).toBe(3);
    expect(snap.savedAt).not.toBe((job.input["party"] as { savedAt: string }).savedAt);
    expect(await rosterBytes(owner.caravanId)).toBe(rosterBefore);
  });
});

describe("a unit both in the party and packed on a trip", () => {
  let p: Player;
  let shared: string;
  let manifestId: string;

  /** Fences on consecutive ring positions; posts on inner cells (chunk 07's test helper). */
  function arrangement(manifest: { units: { ref: string; hp: number }[]; traps: { ref: string; spent: boolean }[]; fences: { ref: string; hp: number }[] }): Formation {
    const corner = RING_ANCHORS[0]!;
    const cells: { x: number; y: number }[] = [];
    for (let y = corner.y + 1; y < corner.y + 4; y++) for (let x = corner.x + 1; x < corner.x + 8; x++) cells.push({ x, y });
    let i = 0;
    return {
      v: 2,
      fences: manifest.fences.filter((f) => f.hp > 0).map((f, k) => ({ ref: f.ref, segment: k % RING_SEGMENTS.length })),
      traps: manifest.traps.filter((t) => !t.spent).map((t) => ({ ref: t.ref, cell: cells[i++]! })),
      posts: manifest.units.filter((u) => u.hp > 0).map((u) => ({ ref: u.ref, cell: cells[i++]!, stance: "guard" as const })),
    };
  }

  beforeAll(async () => {
    p = await registerPlayer();
    await giveUnits(p, 3, "desert.dust_rider");
    await giveUnits(p, 1, "desert.well_digger", 2);
    shared = p.units[0]!;
    expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
  });

  it("packing the unit on a trip is legal while it rides in the party, and the view says so", async () => {
    const packed = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: [shared, p.units[1]], traps: [], fence: { tierId: "fence.brush_pile", count: 4 } });
    expect(packed.statusCode).toBe(201);
    manifestId = packed.json().manifest.id;
    const view = (await call(p, "GET", "/me/party")).json().party;
    expect(view.valid).toBe(true);
    const r = view.roster.find((x: { instanceId: string }) => x.instanceId === shared);
    expect(r).toMatchObject({ inParty: true, packedOnTrip: true, aliveOnTrip: true });
    expect(view.roster.find((x: { instanceId: string }) => x.instanceId === p.units[2])).toMatchObject({ inParty: true, packedOnTrip: false, aliveOnTrip: null });
    expect(view.rules.unitsMayAlsoBePackedOnTrips).toBe(true);
  });

  it("the unit dies on the trip: attrition lands on the manifest only — roster, party row and served snapshot untouched, the party rides at full strength", async () => {
    const m = (await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest;
    expect((await call(p, "PUT", `/caravans/${p.caravanId}/encounters/1/formation`, arrangement(m.survivors))).statusCode).toBe(200);
    expect((await call(p, "POST", `/caravans/${p.caravanId}/encounters/1/formation/commit`)).statusCode).toBe(200);
    const rosterBefore = await rosterBytes(p.caravanId);
    const partyBefore = await partyBytes(p.accountId);
    const snapBefore = canonicalJson((await snapshotStandingParty(pool, p.accountId)).composition);
    await withTransaction(pool, (c) => applyOutcome(c, manifestId, 1, { units: [{ ref: shared, hp: 0 }], spentTraps: [], fences: [] }));
    const m2 = (await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest;
    expect(m2.survivors.units.find((u: { ref: string }) => u.ref === shared).hp).toBe(0);
    expect(await rosterBytes(p.caravanId)).toBe(rosterBefore);
    expect(await partyBytes(p.accountId)).toBe(partyBefore);
    expect(canonicalJson((await snapshotStandingParty(pool, p.accountId)).composition)).toBe(snapBefore);
    const view = (await call(p, "GET", "/me/party")).json().party;
    expect(view.valid).toBe(true);
    expect(view.roster.find((x: { instanceId: string }) => x.instanceId === shared)).toMatchObject({ inParty: true, packedOnTrip: true, aliveOnTrip: false });
    expect(view.scout.units.find((u: { ref: string }) => u.ref === shared).hp).toBe(620); // full type hp, level 1
  });

  it("when the loss reaches the roster (chunk 19 removes the instance), the party becomes INVALID at the next read/edit and the edit endpoint says so — it was never damaged by the fight", async () => {
    await pool.query("DELETE FROM unit_instance WHERE id = $1", [shared]);
    const view = (await call(p, "GET", "/me/party")).json().party;
    expect(view.valid).toBe(false);
    expect(view.party).toBeNull();
    expect(view.scout).toBeNull();
    const position = (view.config.units as { ref: string }[]).findIndex((u) => u.ref === shared);
    expect(view.issues).toEqual([{ code: "unknown_ref", message: `party unit #${position} is not in your roster (it may have been lost on a trip or consumed by a merge)`, subject: shared }]);
    expect(view.config.units.length).toBe(4); // the choices are kept, not trimmed
    const put = await call(p, "PUT", "/me/party", fullParty(p.units));
    expect(put.statusCode).toBe(400);
    expect(put.json()).toMatchObject({ error: "invalid_party", issues: view.issues });
    await expect(snapshotStandingParty(pool, p.accountId)).rejects.toBeInstanceOf(StandingPartyInvalidError);
    p.units = p.units.filter((u) => u !== shared);
    const fixed = await call(p, "PUT", "/me/party", fullParty(p.units));
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().party.valid).toBe(true);
    expect((await snapshotStandingParty(pool, p.accountId)).composition["units"]).toHaveLength(3);
  });

  it("a de-merge on the roster (chunk 19's per-death penalty) is reflected, not a validity problem: the party rides the live level", async () => {
    const before = (await call(p, "GET", "/me/party")).json().party;
    const digger: string = before.roster.find((x: { typeId: string }) => x.typeId === "desert.well_digger").instanceId;
    expect(before.scout.units.find((u: { ref: string }) => u.ref === digger).mergeLevel).toBe(2);
    await pool.query("UPDATE unit_instance SET merge_level = 1 WHERE id = $1", [digger]);
    const view = (await call(p, "GET", "/me/party")).json().party;
    expect(view.valid).toBe(true);
    expect(view.scout.units.find((u: { ref: string }) => u.ref === digger)).toMatchObject({ mergeLevel: 1, hp: getUnitType("desert.well_digger")!.hp });
  });
});

describe("database guards and the schema", () => {
  it("one party per account in v1 (slot 0), schema allows more; identity immutable; delete refused; composition shape checked; updated_at moves only with the composition", async () => {
    const p = await registerPlayer();
    const row = (await pool.query<{ id: string; slot: number; updated_at: Date }>("SELECT id, slot, updated_at FROM standing_party WHERE account_id = $1", [p.accountId])).rows[0]!;
    expect(row.slot).toBe(0);
    expect(TUNABLES.PARTIES_PER_ACCOUNT).toBe(1);
    // A second party in the same slot is refused; another slot is schema-legal (PHASE-2 §43).
    expect((await expectDbError(appRole, "INSERT INTO standing_party (account_id) VALUES ($1)", [p.accountId]))?.code).toBe("23505");
    await appRole.query("INSERT INTO standing_party (account_id, slot) VALUES ($1, 1)", [p.accountId]);
    expect((await call(p, "GET", "/me/party")).json().party.slot).toBe(0);
    for (const [sql, params] of [
      ["UPDATE standing_party SET account_id = (SELECT id FROM account WHERE id <> $1 LIMIT 1) WHERE id = $2", [p.accountId, row.id]],
      ["UPDATE standing_party SET slot = 7 WHERE id = $1", [row.id]],
      ["UPDATE standing_party SET composition = '{\"v\":1}' WHERE id = $1", [row.id]],
      ["UPDATE standing_party SET composition = '[]' WHERE id = $1", [row.id]],
      ["DELETE FROM standing_party WHERE id = $1", [row.id]],
    ] as const) {
      expect((await expectDbError(appRole, sql, [...params]))?.code, sql).toBe("23514");
    }
    expect((await expectDbError(appRole, "TRUNCATE standing_party"))).not.toBeNull();
    expect((await expectDbError(pool, "TRUNCATE standing_party"))?.code).toBe("23514");
    // A no-op update leaves the version stamp alone; a composition change moves it.
    await appRole.query("UPDATE standing_party SET slot = slot WHERE id = $1", [row.id]);
    expect((await pool.query<{ updated_at: Date }>("SELECT updated_at FROM standing_party WHERE id = $1", [row.id])).rows[0]!.updated_at.getTime()).toBe(row.updated_at.getTime());
    await appRole.query(`UPDATE standing_party SET composition = '{"siege":["siege.battering_wagon"],"units":[],"v":1}', save_seq = save_seq + 1 WHERE id = $1`, [row.id]);
    expect((await pool.query<{ updated_at: Date }>("SELECT updated_at FROM standing_party WHERE id = $1", [row.id])).rows[0]!.updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
    // Account-level (GUARDRAILS §5): no caravan column, and the event is account-scoped.
    const cols = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'standing_party'");
    expect(cols.rows.map((c) => c.column_name).filter((c) => /caravan/.test(c))).toEqual([]);
  });
});

describe("structural: no code on the party or snapshot path can write the roster, and nothing about a party is for sale", () => {
  it("src/party and jobs/snapshots.ts never INSERT/UPDATE/DELETE unit_instance and never read Coin, purchases or entitlements", () => {
    const srcDir = join(__dirname, "..", "src");
    const files = [...readdirSync(join(srcDir, "party")).map((f) => join(srcDir, "party", f)), join(srcDir, "jobs", "snapshots.ts"), join(srcDir, "routes", "party.ts")];
    const stripped = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const f of files) {
      const code = stripped(readFileSync(f, "utf8"));
      expect(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+unit_instance/i.test(code), f).toBe(false);
      expect(/coin_balance|coin_spent|spendCoin|purchase|entitlement|billing/i.test(code), f).toBe(false);
    }
    // The only writers of a party's composition are the service and nothing else in src.
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/UPDATE\s+standing_party/i.test(stripped(readFileSync(full, "utf8")))) writers.push(full.slice(srcDir.length + 1));
      }
    };
    walk(srcDir);
    expect(writers).toEqual(["party/repo.ts"]);
  });
});

// ── chunk 09 QA punch list (roadmap/qa/09-punchlist.md) ─────────────────────────────────

/** Coin for a merge: credited through the only credit path, under its own cause. */
async function giveCoin(accountId: string, amount: number): Promise<void> {
  await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:${unique("coin")}`, accountId, credits: [{ amount, reason: "test_setup" }] }));
}

describe("QA S3: a merge that consumes a unit the standing party names", () => {
  let p: Player;
  let inParty: string[];
  let spare: string[];
  beforeAll(async () => {
    p = await registerPlayer();
    inParty = await giveUnits(p, 2, "desert.dust_rider");
    spare = await giveUnits(p, 2, "desert.dust_rider");
    await giveCoin(p.accountId, 5000);
    expect((await call(p, "PUT", "/me/party", fullParty(inParty))).statusCode).toBe(200);
  });

  it("the preview reports which consumed instances ride in the party; the commit is refused with 409 unit_in_party until confirmed; nothing moves", async () => {
    const pv = await call(p, "POST", `/me/caravans/${p.caravanId}/merge/preview`, { instanceIds: inParty });
    expect(pv.statusCode).toBe(200);
    expect(pv.json().consumed.inParty).toEqual([...inParty].sort());
    expect(pv.json().requiresConfirmInParty).toBe(true);
    const rosterBefore = await rosterBytes(p.caravanId);
    const eventsBefore = (await listEventsForAccount(pool, p.accountId)).length;
    for (const body of [{ instanceIds: inParty }, { instanceIds: inParty, confirmInParty: "true" }, { instanceIds: inParty, confirmInParty: 1 }]) {
      const res = await call(p, "POST", `/me/caravans/${p.caravanId}/merge`, body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "unit_in_party", inParty: [...inParty].sort() });
    }
    expect(await rosterBytes(p.caravanId)).toBe(rosterBefore);
    expect((await listEventsForAccount(pool, p.accountId)).length).toBe(eventsBefore);
    expect((await call(p, "GET", "/me/party")).json().party.valid).toBe(true);
  });

  it("a merge of units the party does not name needs no confirmation and appends no invalidation event", async () => {
    const pv = await call(p, "POST", `/me/caravans/${p.caravanId}/merge/preview`, { instanceIds: spare });
    expect(pv.json().consumed.inParty).toEqual([]);
    expect(pv.json().requiresConfirmInParty).toBe(false);
    const res = await call(p, "POST", `/me/caravans/${p.caravanId}/merge`, { instanceIds: spare });
    expect(res.statusCode).toBe(200);
    expect(res.json().events.map((e: { type: string }) => e.type)).toEqual(["coin_spent", "unit_merged"]);
    expect((await call(p, "GET", "/me/party")).json().party.valid).toBe(true);
  });

  it("confirmed: the merge goes ahead, an account-scoped standing_party_invalidated event lands under the merge's own causation with the issue list, and the party reads invalid until edited", async () => {
    const view = (await call(p, "GET", "/me/party")).json().party;
    const res = await call(p, "POST", `/me/caravans/${p.caravanId}/merge`, { instanceIds: inParty, confirmInParty: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().events.map((e: { type: string }) => e.type)).toEqual(["coin_spent", "unit_merged", "standing_party_invalidated"]);
    const events = await listEventsForAccount(pool, p.accountId, { limit: 500 });
    const inv = events.filter((e) => e.event_type === "standing_party_invalidated");
    expect(inv).toHaveLength(1);
    const merged = events.find((e) => e.event_type === "unit_merged" && JSON.stringify(e.payload["consumedInstanceIds"]) === JSON.stringify([...inParty].sort()))!;
    expect(merged).toBeDefined();
    expect(inv[0]!.causation_id).toBe(merged.causation_id);
    expect(inv[0]!.caravan_id).toBeNull(); // account-scoped: the party is account-level (GUARDRAILS §5)
    expect(inv[0]!.payload).toMatchObject({ partyId: view.id, slot: 0, hash: view.hash, reason: "merge", removedRefs: [...inParty].sort(), valid: false });
    const issues = inv[0]!.payload["issues"] as { code: string; subject: string }[];
    expect(issues.map((i) => i.code)).toEqual(["unknown_ref", "unknown_ref"]);
    expect(issues.map((i) => i.subject).sort()).toEqual([...inParty].sort());
    const after = (await call(p, "GET", "/me/party")).json().party;
    expect(after).toMatchObject({ valid: false, party: null, hash: view.hash }); // the choices are untouched; only the roster moved
    expect(after.issues).toEqual(issues);
    // Editing fixes it, as before.
    const produced: string = res.json().producedInstanceIds[0];
    expect((await call(p, "PUT", "/me/party", fullParty([produced]))).statusCode).toBe(200);
    expect((await call(p, "GET", "/me/party")).json().party.valid).toBe(true);
  });
});

describe("QA S2: a save and a merge on the same account serialize on the account append lock", () => {
  it("over repeated races, a stored party that names a consumed instance always has its invalidation event: no save ever validates against a roster a merge is removing from", async () => {
    for (let round = 0; round < 6; round++) {
      const p = await registerPlayer();
      const [a, b] = await giveUnits(p, 2, "desert.dust_rider");
      await giveCoin(p.accountId, 1000);
      const [save, merge] = await Promise.all([
        call(p, "PUT", "/me/party", fullParty([a!])),
        call(p, "POST", `/me/caravans/${p.caravanId}/merge`, { instanceIds: [a, b], confirmInParty: true }),
      ]);
      expect(merge.statusCode).toBe(200);
      expect([200, 400]).toContain(save.statusCode);
      const view = (await call(p, "GET", "/me/party")).json().party;
      const events = await listEventsForAccount(pool, p.accountId, { limit: 500 });
      const invalidated = events.filter((e) => e.event_type === "standing_party_invalidated").length;
      if (save.statusCode === 200) {
        // The save landed first and the merge saw it: the party is invalid AND says so in the ledger.
        expect(view.valid).toBe(false);
        expect(invalidated).toBe(1);
      } else {
        // The merge landed first: the save was validated against the post-merge roster and refused.
        expect(save.json()).toMatchObject({ error: "invalid_party" });
        expect(view.valid).toBe(true);
        expect(view.config.units).toEqual([]);
        expect(invalidated).toBe(0);
      }
    }
  });
});

describe("QA S4: the per-account abuse limit on PUT /me/party, and save_seq as a column", () => {
  it(`the ${PARTY_SAVE_RATE_LIMIT_PER_MINUTE + 1}th save within a minute is 429 with retry-after; other accounts are unaffected; no gameplay cooldown exists`, async () => {
    expect(PARTY_SAVE_RATE_LIMIT_PER_MINUTE).toBe(30);
    expect(TUNABLES.PARTY_EDIT_COOLDOWN_MS).toBe(0);
    const p = await registerPlayer();
    const q = await registerPlayer();
    await giveUnits(p, 2);
    await giveUnits(q, 2);
    const a = fullParty(p.units);
    const b = fullParty(p.units.slice(0, 1), []);
    for (let i = 0; i < PARTY_SAVE_RATE_LIMIT_PER_MINUTE; i++) expect((await call(p, "PUT", "/me/party", i % 2 ? a : b)).statusCode).toBe(200);
    const limited = await call(p, "PUT", "/me/party", a);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // A refused request wrote nothing: the row and the ledger are where the 30th left them.
    const row = (await pool.query<{ save_seq: number }>("SELECT save_seq FROM standing_party WHERE account_id = $1", [p.accountId])).rows[0]!;
    expect(row.save_seq).toBe(PARTY_SAVE_RATE_LIMIT_PER_MINUTE);
    const saves = (await listEventsForAccount(pool, p.accountId, { limit: 500 })).filter((e) => e.event_type === "standing_party_saved");
    expect(saves.map((e) => e.payload["saveSeq"])).toEqual(saves.map((_, i) => i + 1));
    expect(saves.at(-1)!.payload["saveSeq"]).toBe(row.save_seq);
    expect((await call(q, "PUT", "/me/party", fullParty(q.units))).statusCode).toBe(200);
    // Idempotent re-saves count as requests too (the limit is on requests, not on changes).
    expect((await call(p, "PUT", "/me/party", b)).statusCode).toBe(429);
    partySaveLimiter.reset(p.accountId);
    expect((await call(p, "PUT", "/me/party", b)).statusCode).toBe(200); // the 30th stored `a`; `b` is a real change
    expect((await pool.query<{ save_seq: number }>("SELECT save_seq FROM standing_party WHERE account_id = $1", [p.accountId])).rows[0]!.save_seq).toBe(PARTY_SAVE_RATE_LIMIT_PER_MINUTE + 1);
  });

  it("the trigger pins save_seq to the composition: it must advance by exactly one with a change and may not move otherwise; the redundant account index is gone (N4)", async () => {
    const p = await registerPlayer();
    const other = '{"siege":["siege.battering_wagon"],"units":[],"v":1}';
    expect((await expectDbError(appRole, "UPDATE standing_party SET composition = $2::jsonb WHERE account_id = $1", [p.accountId, other]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE standing_party SET composition = $2::jsonb, save_seq = save_seq + 2 WHERE account_id = $1", [p.accountId, other]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE standing_party SET save_seq = save_seq + 1 WHERE account_id = $1", [p.accountId]))?.code).toBe("23514");
    expect(await expectDbError(appRole, "UPDATE standing_party SET save_seq = 0 WHERE account_id = $1", [p.accountId])).toBeNull();
    await appRole.query("UPDATE standing_party SET composition = $2::jsonb, save_seq = save_seq + 1 WHERE account_id = $1", [p.accountId, other]);
    expect((await pool.query<{ save_seq: number }>("SELECT save_seq FROM standing_party WHERE account_id = $1", [p.accountId])).rows[0]!.save_seq).toBe(1);
    const idx = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'standing_party'");
    expect(idx.rows.map((r) => r.indexname)).not.toContain("standing_party_account_idx");
    expect(idx.rows.map((r) => r.indexname)).toContain("standing_party_one_per_slot");
  });
});

describe("QA X2 / N1 / S1 / N3 / N5: naming, parse prefix, id bound, snapshot identity, row lock", () => {
  it("X2: the ledger vocabulary names the receiver as the party owner, in code and in the database enum, and the two agree", async () => {
    expect(LEDGER_EVENT_TYPES).toContain("coin_transferred_to_party_owner");
    expect(LEDGER_EVENT_TYPES).toContain("standing_party_invalidated");
    expect(LEDGER_EVENT_TYPES).toContain("unit_retired");
    expect(LEDGER_EVENT_TYPES as readonly string[]).not.toContain("coin_transferred_to_defender");
    const labels = await pool.query<{ l: string }>("SELECT unnest(enum_range(NULL::ledger_event_type))::text AS l");
    expect(labels.rows.map((r) => r.l).sort()).toEqual([...LEDGER_EVENT_TYPES].sort());
    // Scope in the DB too: the new event is account-level, so a caravan id on it is refused.
    const p = await registerPlayer();
    const err = await expectDbError(appRole, "INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ('standing_party_invalidated', $1, $2, 'x2:scope', 1, '{}')", [p.accountId, p.caravanId]);
    expect(err?.code).toBe("23514");
  });

  it("N1: a party parse error is reported as 'malformed party', never 'malformed snapshot'; S1: an over-long id is refused by name without being echoed", async () => {
    const p = await registerPlayer();
    const res = await call(p, "PUT", "/me/party", { v: 1, units: [], siege: [], hp: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message.startsWith("malformed party: ")).toBe(true);
    const long = "q".repeat(5000);
    const big = await call(p, "PUT", "/me/party", { v: 1, units: [{ ref: long, stance: "nearest", edge: "north", cell: north[0]! }], siege: [] });
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toBe("malformed_party");
    expect(big.json().message).not.toContain("qqqq");
    expect(big.json().message.length).toBeLessThan(200);
  });

  it("N3 + N5: the snapshot carries partyId and hash, and the snapshot path reads the party row FOR SHARE", async () => {
    const p = await registerPlayer();
    await giveUnits(p, 1);
    expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
    const view = (await call(p, "GET", "/me/party")).json().party;
    const snap = await snapshotStandingParty(pool, p.accountId);
    expect(snap.partyId).toBe(view.id);
    expect(snap.hash).toBe(view.hash);
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    const src = readFileSync(join(__dirname, "..", "src", "jobs", "snapshots.ts"), "utf8");
    expect(src).toMatch(/resolveStandingParty\(db, ownerAccountId, \{ lock: "share" \}\)/);
    expect(readFileSync(join(__dirname, "..", "src", "party", "repo.ts"), "utf8")).toContain("FOR SHARE");
  });
});

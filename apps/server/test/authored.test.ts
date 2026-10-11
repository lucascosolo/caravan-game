/**
 * Chunk 25: authored cold-start parties. The set seeds at least twelve parties per band
 * across the whole floor-to-ceiling range on an empty database, idempotently and
 * versioned; three distinct, fully scoutable candidates are served at every band to a
 * fresh account; the resolver inputs of an authored encounter are indistinguishable in
 * shape from a live one; the served-share stage of retire-by-ratio triggers and releases
 * deterministically from stored rows; and the system owners are unmistakably system —
 * login refused, is_system permanent, zero Coin, no credit path, ratings through the
 * ledger. Also closes chunk 14 QA B1, B2, S5, N1, N2 (roadmap/qa/14-punchlist.md).
 */
import { entryBand, partyFromJson, scoutParty, type PartyConfig } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { appliedMigrationIds, migrateDown, migrateUp } from "../src/db/migrate.js";
import { withTransaction } from "../src/db/pool.js";
import type { CaravanRow } from "../src/db/types.js";
import { SystemAccountCreditError, appendCoinCredits, creditBankedTrip, creditPartyWin } from "../src/economy/coin.js";
import { accrueTrickleTx } from "../src/economy/trickle.js";
import { snapshotStandingParty } from "../src/jobs/snapshots.js";
import { canonicalJson, type Json } from "../src/ledger/events.js";
import { verifyProjection } from "../src/ledger/projection.js";
import {
  AUTHORED_BANDS,
  AUTHORED_PARTIES_PER_BAND,
  AUTHORED_SET_VERSION,
  AUTHORED_USERNAME_PREFIX,
  applyAuthoredSpec,
  authoredBands,
  authoredOutfitFor,
  authoredPartySpecs,
  reassertSystemAccounts,
  seedAuthoredParties,
  specHash,
} from "../src/matchmaking/authored.js";
import { authoredServedShare } from "../src/matchmaking/authoredShare.js";
import { AUTHORED_SERVED_SHARE_WINDOW, REROLL_COOLDOWN_SECONDS, bandCentre, bandOf } from "../src/matchmaking/band.js";
import { chooseCandidate, replaySearch, searchCandidates, type CandidateMenuView, type EncounterCandidatesRow } from "../src/matchmaking/service.js";
import { createTrip } from "../src/matchmaking/trips.js";
import { createAccount, findAccountByUsername } from "../src/repo/accounts.js";
import { findCaravanById } from "../src/repo/caravans.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { RESERVED_USERNAME_PREFIX } from "../src/services/onboarding.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: string[];
}

const COOLDOWN_MS = REROLL_COOLDOWN_SECONDS * 1000;
const REGIONS = ["desert", "high_plains", "mountain", "badlands"] as const;
const STARTING_TYPE: Record<string, string> = { desert: "desert.dust_rider", high_plains: "high_plains.homesteader", mountain: "mountain.grizzly", badlands: "badlands.gunslinger" };
const EDGES = ["north", "east", "south", "west"] as const;

async function registerPlayer(region: string = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("p"), password: "correct horse battery", region } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: [] };
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

async function giveUnits(p: Player, n: number, typeId: string, mergeLevel = 1): Promise<void> {
  for (let i = 0; i < n; i++) p.units.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
}

function fullParty(units: string[]): PartyConfig {
  const stances = ["nearest", "traps", "core"] as const;
  return { v: 1, units: units.map((ref, i) => ({ ref, stance: stances[i % 3]!, edge: EDGES[i % 4]!, cell: entryBand(EDGES[i % 4]!)[i]! })), siege: ["siege.battering_wagon"] };
}

/** A live party owner at the given siege Reputation (ratings are ledger projections; the suite's owner role sets them directly). */
async function makeOwner(region: string, siegeRep: number): Promise<Player> {
  const p = await registerPlayer(region);
  await giveUnits(p, 4, STARTING_TYPE[region]!);
  expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [p.accountId, siegeRep]);
  return p;
}

/** A defender: packed, locked and on a trip, at the given living Reputation. */
async function makeDefender(region: string, livingRep: number): Promise<Player & { caravan: CaravanRow; tripId: string }> {
  const p = await registerPlayer(region);
  await giveUnits(p, 2, STARTING_TYPE[region]!);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId, livingRep]);
  expect((await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: p.units, traps: [], fence: null })).statusCode).toBe(201);
  const trip = await withTransaction(pool, (c) => createTrip(c, p.caravanId));
  return { ...p, caravan: (await findCaravanById(pool, p.caravanId))!, tripId: trip.id };
}

async function searchAt(d: Player & { caravan: CaravanRow }, nowMs: number): Promise<CandidateMenuView> {
  return withTransaction(appRole, (c) => searchCandidates(c, d.caravan, 1, { nowMs }));
}
async function menuRow(tripId: string, seq: number): Promise<EncounterCandidatesRow> {
  const res = await pool.query<EncounterCandidatesRow>("SELECT * FROM encounter_candidates WHERE trip_id = $1 AND encounter_index = 1 AND search_seq = $2", [tripId, seq]);
  return res.rows[0]!;
}

/** The deep key shape of a JSON value: what the resolver (and anything else) could tell two inputs apart by. */
function shapeOf(v: Json): Json {
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, Json>)[k]!)]));
  return typeof v;
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

describe("the authored set on an empty database", () => {
  it("seeds at least twelve parties in every band from the floor to the ceiling, as the app role, idempotently and versioned", async () => {
    const specs = authoredPartySpecs();
    const t0 = Date.now();
    const first = await seedAuthoredParties(appRole);
    const seconds = (Date.now() - t0) / 1000;
    expect(first.version).toBe(AUTHORED_SET_VERSION);
    expect(first.created.length).toBe(specs.length);
    expect(first.created.length).toBe(AUTHORED_BANDS * AUTHORED_PARTIES_PER_BAND);
    expect(first.updated).toEqual([]);
    expect(first.existing).toEqual([]);
    // Every system account's siege rating lands in its band, through the ledger (chunk 14 QA S5).
    const rows = await pool.query<{ username: string; reputation: number; coin_balance: number; is_system: boolean; set_version: number; spec_hash: string }>(
      `SELECT a.username, pp.reputation, a.coin_balance, a.is_system, ap.set_version, ap.spec_hash
         FROM account a JOIN pool_progress pp ON pp.account_id = a.id AND pp.pool = 'siege' JOIN authored_party ap ON ap.account_id = a.id
        WHERE a.username LIKE $1`,
      [`${AUTHORED_USERNAME_PREFIX}%`],
    );
    expect(rows.rows.length).toBe(specs.length);
    const perBand = new Map<number, number>();
    for (const r of rows.rows) {
      const spec = specs.find((s) => s.username === r.username)!;
      expect(r.reputation).toBe(spec.rating);
      expect(r.coin_balance).toBe(0);
      expect(r.is_system).toBe(true);
      expect(r.set_version).toBe(AUTHORED_SET_VERSION);
      expect(r.spec_hash).toBe(specHash(spec));
      const b = bandOf(r.reputation).index;
      perBand.set(b, (perBand.get(b) ?? 0) + 1);
    }
    for (const b of authoredBands()) expect(perBand.get(b), `band ${b}`).toBeGreaterThanOrEqual(12);
    // The second run changes nothing.
    const second = await seedAuthoredParties(appRole);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.existing.length).toBe(specs.length);
    const events = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_event");
    const again = await seedAuthoredParties(appRole);
    expect(again.existing.length).toBe(specs.length);
    expect((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_event")).rows[0]!.n).toBe(events.rows[0]!.n);
    console.log(`seeded ${specs.length} authored parties in ${seconds.toFixed(1)}s`);
  });

  it("every system account's party stands: the stored composition resolves, is byte-identical to the owner's preview, and reads back its outfit", async () => {
    for (const spec of authoredPartySpecs()) {
      const account = (await findAccountByUsername(pool, spec.username))!;
      const snap = await snapshotStandingParty(appRole, account.id);
      const party = partyFromJson(snap.composition);
      expect(party.units.length).toBe(spec.units.length);
      expect(party.siege.map((s) => s.typeId).sort()).toEqual([...spec.siege].sort());
      expect([...new Set(party.units.map((u) => u.typeId))].sort()).toEqual([...new Set(spec.units.map((u) => u.typeId))].sort());
      expect(party.units.map((u) => u.mergeLevel).sort()).toEqual(spec.units.map((u) => u.mergeLevel).sort());
      expect(new Set(party.units.map((u) => u.edge)).size).toBe(spec.edgeCount);
      const stances = new Set(party.units.map((u) => u.stance));
      if (spec.stancePattern === "mixed") expect(stances.size).toBe(3);
      else expect([...stances]).toEqual([spec.stancePattern]);
      expect(authoredOutfitFor(spec.username)?.name).toBe(spec.outfit.name);
    }
    // The caravan carries the outfit's name; a quick read of a well-known one.
    const name = await pool.query<{ name: string }>("SELECT c.name FROM caravan c JOIN account a ON a.id = c.account_id WHERE a.username = $1", [`${AUTHORED_USERNAME_PREFIX}dry_gulch_boys`]);
    expect(name.rows[0]!.name).toBe("Dry Gulch Boys");
  });

  it("serves three distinct, fully scoutable candidates to a fresh account at EVERY band, each the same object as a live party", async () => {
    // A live owner for the shape comparison: the resolver input of an authored encounter must have exactly a live one's shape.
    const live = await makeOwner("mountain", 5000); // far outside every band: never drawn below
    const liveSnap = await snapshotStandingParty(appRole, live.accountId);
    for (const [k, b] of authoredBands().entries()) {
      const d = await makeDefender(REGIONS[k % REGIONS.length]!, bandCentre(b));
      const res = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
      expect(res.statusCode, res.body).toBe(201);
      const m: CandidateMenuView = res.json().menu;
      expect(m.candidates.length).toBe(3);
      expect(new Set(m.candidates.map((c) => c.partyId)).size).toBe(3);
      expect(m.authoredOutsideBand).toBe(false);
      for (const c of m.candidates) {
        expect(c.owner.authored).toBe(true);
        expect(c.owner.displayName.startsWith(AUTHORED_USERNAME_PREFIX)).toBe(true);
        expect(c.scout.units.length).toBeGreaterThanOrEqual(3);
        expect(canonicalJson(scoutParty(partyFromJson(c.snapshot.composition)) as unknown as Json)).toBe(canonicalJson(c.scout as unknown as Json));
        // Indistinguishable in shape from a live snapshot (a party may field no siege; the element shapes match), and nothing inside names the owner as authored.
        expect(shapeOf(c.snapshot as unknown as Json)).toEqual(shapeOf(liveSnap as unknown as Json));
        const comp = c.snapshot.composition as { units: Json[]; siege: Json[] };
        const liveComp = liveSnap.composition as { units: Json[]; siege: Json[] };
        expect(shapeOf(comp.units[0]!)).toEqual(shapeOf(liveComp.units[0]!));
        if (comp.siege.length) expect(shapeOf(comp.siege[0]!)).toEqual(shapeOf(liveComp.siege[0]!));
        expect(JSON.stringify(c.snapshot)).not.toMatch(/authored|system|sys_outfit/i);
        expect(JSON.stringify(c.scout)).not.toMatch(/authored|system|sys_outfit/i);
      }
    }
  });
});

describe("system accounts are unmistakably system", () => {
  it("login is refused with 401 even with the right password (chunk 14 QA B1); the prefix is reserved at registration (N2)", async () => {
    const username = authoredPartySpecs()[0]!.username;
    await pool.query("UPDATE account SET password_hash = $2 WHERE username = $1", [username, await hashPassword("known password")]);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "known password" } });
    expect(login.statusCode).toBe(401);
    expect(RESERVED_USERNAME_PREFIX).toBe(AUTHORED_USERNAME_PREFIX);
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { username: `${AUTHORED_USERNAME_PREFIX}newcomer`, password: "correct horse battery", region: "desert" } });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe("reserved_username");
    expect((await app.inject({ method: "POST", url: "/auth/register", payload: { username: "SYS_OUTFIT_shouty", password: "correct horse battery", region: "desert" } })).statusCode).toBe(400);
  });

  it("is_system is permanent and settable only on an account that owns nothing (chunk 14 QA N1); the seed re-asserts it (B2)", async () => {
    const sys = (await findAccountByUsername(pool, authoredPartySpecs()[1]!.username))!;
    expect((await expectDbError(appRole, "UPDATE account SET is_system = false WHERE id = $1", [sys.id]))?.code).toBe("23514");
    const player = await registerPlayer("badlands");
    expect((await expectDbError(appRole, "UPDATE account SET is_system = true WHERE id = $1", [player.accountId]))?.code).toBe("23514");
    expect((await expectDbError(pool, "UPDATE account SET is_system = true WHERE id = $1", [player.accountId]))?.code).toBe("23514"); // the owner role too
    // A bare account under the prefix (no caravan, no events) is the one case the seed may re-flag.
    const bare = await createAccount(pool, { username: `${AUTHORED_USERNAME_PREFIX}zz_bare`, passwordHash: "x" });
    expect(bare.is_system).toBe(false);
    expect(await reassertSystemAccounts(appRole)).toEqual([bare.username]);
    expect((await findAccountByUsername(pool, bare.username))!.is_system).toBe(true);
    expect(await reassertSystemAccounts(appRole)).toEqual([]);
    await pool.query("DELETE FROM account WHERE id = $1", [bare.id]);
  });

  it("ratings and access went through the ledger: a projection rebuild equals the live rows for every system account (chunk 14 QA S5)", async () => {
    const ids = await pool.query<{ id: string }>("SELECT id FROM account WHERE is_system");
    expect(ids.rows.length).toBe(authoredPartySpecs().length);
    for (const r of ids.rows) {
      const v = await verifyProjection(pool, r.id);
      expect(v.ok, JSON.stringify(v)).toBe(true);
    }
    // And nothing reached a node without paying: spent ≤ granted on every row, granted only by rung events.
    const bad = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pool_progress pp JOIN account a ON a.id = pp.account_id OR a.id = (SELECT account_id FROM caravan WHERE id = pp.caravan_id)
        WHERE a.is_system AND pp.unlock_points_spent > pp.unlock_points_granted`,
    );
    expect(bad.rows[0]!.n).toBe("0");
  });

  it("no Coin credit path can credit a system account; the ledger refuses the row even as a hand-written insert", async () => {
    const sys = (await findAccountByUsername(pool, authoredPartySpecs()[2]!.username))!;
    const cause = (s: string) => `test:${sys.id}:${s}:${unique("c")}`;
    await expect(withTransaction(appRole, (c) => appendCoinCredits(c, { causationId: cause("a"), accountId: sys.id, credits: [{ amount: 100, reason: "test" }] }))).rejects.toBeInstanceOf(SystemAccountCreditError);
    await expect(withTransaction(appRole, (c) => creditPartyWin(c, { accountId: sys.id, causationId: cause("b"), tripId: "t", encounterIndex: 1 }))).rejects.toBeInstanceOf(SystemAccountCreditError);
    await expect(withTransaction(appRole, (c) => creditBankedTrip(c, { accountId: sys.id, causationId: cause("c"), tripId: "t", encountersSurvived: 2 }))).rejects.toBeInstanceOf(SystemAccountCreditError);
    await expect(withTransaction(appRole, (c) => accrueTrickleTx(c, sys.id, Date.now() + 86_400_000, { force: true }))).rejects.toBeInstanceOf(SystemAccountCreditError);
    for (const type of ["coin_earned", "coin_purchased", "coin_transferred_to_party_owner"]) {
      const err = await expectDbError(
        appRole,
        "INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ($1, $2, NULL, $3, 0, '{\"amount\": 5, \"reason\": \"x\"}'::jsonb)",
        [type, sys.id, cause(type)],
      );
      expect(err?.code, type).toBe("23514");
      expect(err?.message).toMatch(/system account/);
    }
    expect((await findAccountByUsername(pool, sys.username))!.coin_balance).toBe(0);
    // A player's credit still works, so the guard is the flag and nothing else.
    const player = await registerPlayer("desert");
    const ok = await withTransaction(appRole, (c) => appendCoinCredits(c, { causationId: cause("p"), accountId: player.accountId, credits: [{ amount: 100, reason: "test" }] }));
    expect(ok.credited).toBe(100);
  });
});

describe("retire by ratio, second stage: the served share per band", () => {
  it("triggers when authored parties took more than the share of a band's recent encounters, weights them down, and releases as live parties are served — all from stored rows", async () => {
    // Band 0 (centre 250): twelve live parties at the centre next to the twelve authored ones.
    for (let i = 0; i < 12; i++) await makeOwner(REGIONS[i % 4]!, bandCentre(0));
    const band = bandOf(bandCentre(0));
    const before = await authoredServedShare(appRole, band);
    expect(before).toEqual({ band: 0, window: AUTHORED_SERVED_SHARE_WINDOW, served: 0, authored: 0 });
    let now = Date.now();
    const chooseKind = async (authored: boolean): Promise<void> => {
      const d = await makeDefender("desert", bandCentre(0));
      for (let tries = 0; tries < 12; tries++) {
        const m = await searchAt(d, now);
        now += COOLDOWN_MS;
        const pick = m.candidates.find((c) => c.owner.authored === authored);
        if (!pick) continue;
        await withTransaction(appRole, (c) => chooseCandidate(c, d.caravan, 1, pick.candidateId, now));
        return;
      }
      throw new Error(`no ${authored ? "authored" : "live"} candidate offered in 12 menus`);
    };
    // Two served encounters, both authored: 100% > 30%. The next search in the band is weighted down.
    await chooseKind(true);
    await chooseKind(true);
    expect(await authoredServedShare(appRole, band)).toEqual({ band: 0, window: AUTHORED_SERVED_SHARE_WINDOW, served: 2, authored: 2 });
    const probe = await makeDefender("high_plains", bandCentre(0));
    const weighted = await searchAt(probe, now);
    now += COOLDOWN_MS;
    expect(weighted.authoredServed).toEqual({ band: 0, window: AUTHORED_SERVED_SHARE_WINDOW, served: 2, authored: 2, weightedDown: true });
    expect(weighted.passes[0]!.live).toBeGreaterThanOrEqual(12);
    expect(weighted.passes[0]!.authoredAllowed).toBe(Math.floor((Math.floor((weighted.passes[0]!.live * 3000) / 7000) * TUNABLES.AUTHORED_OVER_SHARE_WEIGHT_BP) / 10_000));
    expect(weighted.passes[0]!.authoredAllowed).toBeLessThan(Math.floor((weighted.passes[0]!.live * 3000) / 7000));
    // The stored row carries the share and replays to the same menu.
    const row = await menuRow(probe.tripId, weighted.searchSeq);
    expect(row.authored_served).toEqual({ band: 0, window: AUTHORED_SERVED_SHARE_WINDOW, served: 2, authored: 2 });
    const replay = replaySearch(row);
    expect(replay.partyIds).toEqual(row.candidates.map((c) => c.partyId));
    expect(replay.authoredWeightedDown).toBe(true);
    // Five live encounters served: 2 of 7 = 28.6% ≤ 30%. The weight lifts by itself.
    for (let i = 0; i < 5; i++) await chooseKind(false);
    expect(await authoredServedShare(appRole, band)).toEqual({ band: 0, window: AUTHORED_SERVED_SHARE_WINDOW, served: 7, authored: 2 });
    const released = await searchAt(probe, now);
    expect(released.authoredServed).toEqual({ band: 0, window: AUTHORED_SERVED_SHARE_WINDOW, served: 7, authored: 2, weightedDown: false });
    expect(released.passes[0]!.authoredAllowed).toBe(Math.floor((released.passes[0]!.live * 3000) / 7000));
    // Another band is untouched by band 0's history.
    expect(await authoredServedShare(appRole, bandOf(bandCentre(3)))).toEqual({ band: 3, window: AUTHORED_SERVED_SHARE_WINDOW, served: 0, authored: 0 });
    // The stored share is immutable like every other replay input.
    expect((await expectDbError(appRole, "UPDATE encounter_candidates SET authored_served = '{}'::jsonb WHERE trip_id = $1", [probe.tripId]))?.code).toBe("23514");
  });
});

describe("content drops", () => {
  it("a changed spec is applied in place: rating through the ledger, new nodes reached the ordinary way, roster rebuilt, party re-saved; the seed then reports it updated and restores it", async () => {
    const spec = authoredPartySpecs().find((s) => s.band === 3 && s.regionId === "desert")!;
    const account = (await findAccountByUsername(pool, spec.username))!;
    const caravan = (await pool.query<{ id: string }>("SELECT id FROM caravan WHERE account_id = $1", [account.id])).rows[0]!;
    const drop = {
      ...spec,
      rating: spec.rating + 50,
      units: [...Array(5)].map(() => ({ typeId: "desert.sand_sharpshooter", mergeLevel: 3 })),
      siege: ["siege.battering_wagon", "siege.fence_cutters", "siege.dousing_wagon"],
      siegeNodes: ["siege.bridging_planks", "siege.fence_cutters", "siege.dousing_wagon"],
      siegePoints: 18,
      stancePattern: "core" as const,
    };
    await withTransaction(appRole, (c) => applyAuthoredSpec(c, drop, account.id, caravan.id, `test:drop:${unique("d")}`));
    const rep = await pool.query<{ reputation: number; ladder_level: number }>("SELECT reputation, ladder_level FROM pool_progress WHERE account_id = $1 AND pool = 'siege'", [account.id]);
    expect(rep.rows[0]!.reputation).toBe(spec.rating + 50);
    expect(rep.rows[0]!.ladder_level).toBeGreaterThanOrEqual(14); // 18 points: rungs 1-10 pay 10, 11-14 pay 8
    expect((await verifyProjection(pool, account.id)).ok).toBe(true);
    const snap = await snapshotStandingParty(appRole, account.id);
    const party = partyFromJson(snap.composition);
    expect(party.units.length).toBe(5);
    expect(party.units.every((u) => u.typeId === "desert.sand_sharpshooter" && u.mergeLevel === 3 && u.stance === "core")).toBe(true);
    expect(party.siege.map((s) => s.typeId)).toEqual(["siege.battering_wagon", "siege.dousing_wagon", "siege.fence_cutters"]);
    expect((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM unit_instance WHERE caravan_id = $1", [caravan.id])).rows[0]!.n).toBe("5");
    expect((await pool.query<{ spec_hash: string }>("SELECT spec_hash FROM authored_party WHERE account_id = $1", [account.id])).rows[0]!.spec_hash).toBe(specHash(drop));
    // The seed sees the recorded hash differ from the canonical set and brings the party back, in place: same account, same party row.
    const partyId = snap.partyId;
    const result = await seedAuthoredParties(appRole);
    expect(result.updated).toEqual([spec.username]);
    expect(result.created).toEqual([]);
    const restored = await snapshotStandingParty(appRole, account.id);
    expect(restored.partyId).toBe(partyId);
    expect(partyFromJson(restored.composition).units.length).toBe(spec.units.length);
    expect((await pool.query<{ reputation: number }>("SELECT reputation FROM pool_progress WHERE account_id = $1 AND pool = 'siege'", [account.id])).rows[0]!.reputation).toBe(spec.rating);
    expect((await verifyProjection(pool, account.id)).ok).toBe(true);
    expect((await seedAuthoredParties(appRole)).updated).toEqual([]);
  });
});

describe("migration guard (chunk 14 QA B2)", () => {
  it("migration 009 refuses to roll back while system accounts exist, so a down/up can never de-flag them", async () => {
    const all = await appliedMigrationIds(pool);
    try {
      // Roll back through 009 whatever is numbered after it (010 store, 011 authored, ...).
      const depth = all.filter((id) => id >= 9).length;
      await expect(migrateDown(pool, depth)).rejects.toThrow(/system .*accounts exist/);
    } finally {
      await migrateUp(pool);
    }
    expect((await appliedMigrationIds(pool)).length).toBe(all.length);
    expect((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM account WHERE is_system")).rows[0]!.n).toBe(String(authoredPartySpecs().length));
  });
});

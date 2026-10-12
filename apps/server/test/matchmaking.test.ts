/**
 * Chunk 14 server-side: the search / candidates / choose routes; exactly three candidates,
 * each scoutable in full and byte-identical to the owner's own preview; banding by the
 * caravan's LIVING Reputation against owners' SIEGE Reputation; cross-region candidates;
 * self, linked-account and recent-opponent exclusion; escalation per encounter; the free,
 * time-gated reroll with no Coin path; reproducible menus; the SNAPSHOT CONTRACT (one
 * snapshot per candidate at generation, stored, served into the job byte-identical, immune
 * to the owner's later edits or losses); the authored fallback on an empty pool and the
 * authored share cap; the DB guards against the app role.
 */
import { entryBand, partyFromJson, scoutParty, type PartyConfig } from "@caravan/circle";
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import type { CaravanRow } from "../src/db/types.js";
import { enqueueEncounterResolution } from "../src/jobs/handlers/encounterResolution.js";
import { getJob } from "../src/jobs/queue.js";
import { snapshotStandingParty } from "../src/jobs/snapshots.js";
import { canonicalJson, type Json } from "../src/ledger/events.js";
import { AUTHORED_BANDS, AUTHORED_PARTIES_PER_BAND, AUTHORED_USERNAME_PREFIX, seedAuthoredParties } from "../src/matchmaking/authored.js";
import { CANDIDATES_PER_SEARCH, ESCALATION_PER_ENCOUNTER, RECENT_OPPONENT_EXCLUSION, REPUTATION_BAND_WIDTH_MAX, REROLL_COOLDOWN_SECONDS, bandOf, sandbagEarnMultiplier } from "../src/matchmaking/band.js";
import { chooseCandidate, enqueueChosenEncounter, readCandidates, replaySearch, searchCandidates, type Candidate, type CandidateMenuView, type CandidateView, type EncounterCandidatesRow } from "../src/matchmaking/service.js";
import { createTrip, endTrip } from "../src/matchmaking/trips.js";
import { findCaravanById } from "../src/repo/caravans.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
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
  return app.inject(opts);
}

const EDGES = ["north", "east", "south", "west"] as const;
function fullParty(units: string[], siege: string[] = ["siege.battering_wagon"]): PartyConfig {
  const stances = ["nearest", "traps", "core"] as const;
  return {
    v: 1,
    units: units.map((ref, i) => {
      const edge = EDGES[i % 4]!;
      return { ref, stance: stances[i % 3]!, edge, cell: entryBand(edge)[i]! };
    }),
    siege,
  };
}

const STARTING_TYPE: Record<string, string> = { desert: "desert.dust_rider", high_plains: "high_plains.homesteader", mountain: "mountain.grizzly", badlands: "badlands.gunslinger" };

/** A party owner: a registered player with a standing party of `n` units and the given siege Reputation. */
async function makeOwner(region: string, siegeRep: number, n = 4): Promise<Player & { partyId: string }> {
  const p = await registerPlayer(region);
  await giveUnits(p, n, STARTING_TYPE[region]!, 1 + (n % 3));
  expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
  await setSiegeRep(p.accountId, siegeRep);
  const row = await pool.query<{ id: string }>("SELECT id FROM standing_party WHERE account_id = $1", [p.accountId]);
  return { ...p, partyId: row.rows[0]!.id };
}

/** Ratings are ledger projections; the test suite (owner role) sets them directly. */
async function setSiegeRep(accountId: string, rep: number): Promise<void> {
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [accountId, rep]);
}
async function setLivingRep(caravanId: string, rep: number): Promise<void> {
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE caravan_id = $1 AND pool = 'living'", [caravanId, rep]);
}

/** A defender: packed, locked and on a trip. */
async function makeDefender(region = "desert", livingRep = 1000): Promise<Player & { caravan: CaravanRow; tripId: string }> {
  const p = await registerPlayer(region);
  await giveUnits(p, 2, STARTING_TYPE[region]!);
  await setLivingRep(p.caravanId, livingRep);
  const packed = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: p.units, traps: [], fence: null });
  expect(packed.statusCode).toBe(201);
  const trip = await withTransaction(pool, (c) => createTrip(c, p.caravanId));
  const caravan = (await findCaravanById(pool, p.caravanId))!;
  return { ...p, caravan, tripId: trip.id };
}

async function search(d: Player, n = 1): Promise<CandidateMenuView> {
  const res = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/search`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().menu;
}
async function searchAt(d: Player & { caravan: CaravanRow }, n: number, nowMs: number, linked?: (db: unknown, id: string) => Promise<string[]>): Promise<CandidateMenuView> {
  return withTransaction(appRole, (c) => searchCandidates(c, d.caravan, n, linked ? { nowMs, linkedAccounts: linked } : { nowMs }));
}
async function storedCandidate(tripId: string, candidateId: string): Promise<Candidate> {
  const res = await pool.query<{ candidates: Candidate[] }>("SELECT candidates FROM encounter_candidates WHERE trip_id = $1", [tripId]);
  return res.rows.flatMap((r) => r.candidates).find((c) => c.candidateId === candidateId)!;
}
async function menuRow(tripId: string, n: number, seq: number): Promise<EncounterCandidatesRow> {
  const res = await pool.query<EncounterCandidatesRow>("SELECT * FROM encounter_candidates WHERE trip_id = $1 AND encounter_index = $2 AND search_seq = $3", [tripId, n, seq]);
  return res.rows[0]!;
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

describe("search returns exactly three fully scoutable candidates", () => {
  let owners: Awaited<ReturnType<typeof makeOwner>>[];
  let d: Awaited<ReturnType<typeof makeDefender>>;
  let menu: CandidateMenuView;

  beforeAll(async () => {
    // Eight owners within ±150 of 1000, across all four regions; plus one far away.
    owners = [];
    const regions = ["desert", "high_plains", "mountain", "badlands"];
    for (let i = 0; i < 8; i++) owners.push(await makeOwner(regions[i % 4]!, 900 + i * 25, 3 + (i % 5)));
    owners.push(await makeOwner("desert", 2500));
    d = await makeDefender("desert", 1000);
    menu = await search(d);
  });

  it("three distinct candidates, each with a stable id, owner display name, Reputation band and the full scout view", async () => {
    expect(menu.candidates.length).toBe(CANDIDATES_PER_SEARCH);
    expect(new Set(menu.candidates.map((c) => c.partyId)).size).toBe(3);
    for (const c of menu.candidates) {
      expect(c.candidateId).toMatch(/^[0-9a-f]{32}$/);
      const owner = owners.find((o) => o.partyId === c.partyId)!;
      expect(owner).toBeDefined();
      // QA N4: the client view names the owner but carries no account id; the stored row does.
      expect(c.owner).toEqual({ displayName: expect.stringMatching(/^p_/), authored: false, flavor: null });
      // Chunk 25 QA D4: nor inside the snapshot.
      expect(c.snapshot).not.toHaveProperty("ownerAccountId");
      expect(JSON.stringify(c)).not.toContain(owner.accountId);
      expect(c.reputation.band).toEqual(bandOf(c.reputation.rating));
      expect(Math.abs(c.reputation.rating - 1000)).toBeLessThanOrEqual(150);
      expect(c.reputation.gapFromCaravan).toBe(1000 - c.reputation.rating);
      expect(c.reputation.gapBeyondBand).toBe(0);
      expect(c.reputation.sandbagEarnMultiplier).toBe(1024);
      // Legibility: every unit with stats, ability, stance, edge, cell; every siege piece; the edges.
      expect(c.scout.units.length).toBe(owner.units.length);
      for (const u of c.scout.units) {
        for (const k of ["ref", "typeId", "displayName", "affinity", "mergeLevel", "stance", "edge", "cell", "pos", "offense", "defense", "hp", "moveSpeed", "attackRange", "attackCooldown", "ability"]) expect(u, k).toHaveProperty(k);
      }
      expect(c.scout.siege.length).toBe(1);
      expect(c.scout.siege[0]).toHaveProperty("counters");
      expect(c.scout.edges.length).toBeGreaterThan(0);
      // The snapshot is a resolved Party and the scout view is derived from it, not from a live resolve.
      expect(canonicalJson(scoutParty(partyFromJson(c.snapshot.composition)) as unknown as Json)).toBe(canonicalJson(c.scout as unknown as Json));
    }
    expect(menu.caravan).toEqual({ rating: 1000, ratingPool: "living", band: { index: 3, low: 1000, high: 1299 } });
    // Chunk 19 QA D2b: encounter 1 is centred FIRST_ENCOUNTER_CENTRE_OFFSET below the caravan.
    expect(menu.centre).toBe(1000 + TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
    expect(menu.bandWidthUsed).toBe(150);
    expect(menu.widened).toBe(false);
    expect(menu.authoredOutsideBand).toBe(false);
    expect(menu.authoredShare).toEqual({ authored: 0, of: 3, shareBp: 0, maxShareBp: 3000 });
    expect(menu).not.toHaveProperty("usedAuthoredFallback");
    expect(menu).not.toHaveProperty("skippedPartyIds");
    const stored = await menuRow(d.tripId, 1, 1);
    expect(stored.skipped_party_ids).toEqual([]);
    for (const c of stored.candidates) expect(c.owner.accountId).toBe(owners.find((o) => o.partyId === c.partyId)!.accountId);
    for (const c of menu.candidates) expect(Object.keys(c.owner).sort()).toEqual(["authored", "displayName", "flavor"]);
    for (const c of stored.candidates) expect(c.snapshot.ownerAccountId).toBe(c.owner.accountId);
    expect(menu.rules.reroll).toEqual({ gate: "time", cooldownSeconds: REROLL_COOLDOWN_SECONDS });
    expect(menu.rules.selfExcluded).toBe(true);
    expect(menu.rules.recentOpponentsExcluded).toBe(RECENT_OPPONENT_EXCLUSION);
    expect(menu.rules.escalation.perEncounter).toBe(ESCALATION_PER_ENCOUNTER);
    expect(menu.reroll).toMatchObject({ gate: "time", cooldownSeconds: REROLL_COOLDOWN_SECONDS, available: false });
    expect(menu.reroll.availableAtMs).toBe(menu.searchedAtMs + COOLDOWN_MS);
    expect(JSON.stringify(menu)).not.toMatch(/\b(cost|coin|price)\b/i);
  });

  it("the scout view is byte-identical to what the party's own builder previews (GET /me/party scout)", async () => {
    for (const c of menu.candidates) {
      const owner = owners.find((o) => o.partyId === c.partyId)!;
      const preview = (await call(owner, "GET", "/me/party")).json().party;
      expect(canonicalJson(c.scout as unknown as Json)).toBe(canonicalJson(preview.scout));
      expect(canonicalJson(c.snapshot.composition)).toBe(canonicalJson(preview.party));
      expect(c.snapshot.hash).toBe(preview.hash);
      expect(c.snapshot.savedAt).toBe(preview.savedAt);
    }
  });

  it("GET candidates returns the same menu; it is not a filter on region or build", async () => {
    const res = await call(d, "GET", `/me/caravans/${d.caravanId}/encounters/1/candidates`);
    expect(res.statusCode).toBe(200);
    expect(canonicalJson(res.json().menu.candidates)).toBe(canonicalJson(menu.candidates as unknown as Json));
    expect(res.json().menu.chosen).toBeNull();
    // Region-agnostic: the eligible pool spans every region; across rerolls cross-region parties appear.
    const regionsOf = (m: CandidateMenuView) => m.candidates.map((c) => c.scout.units[0]!.typeId.split(".")[0]);
    const seen = new Set(regionsOf(menu));
    let now = menu.searchedAtMs;
    // The seed includes the caravan's random id, so this is a probabilistic sweep: with the
    // authored pool spread over four regions, 30 draws make a miss astronomically unlikely.
    for (let i = 0; i < 30 && !(seen.size >= 3 && seen.has("desert")); i++) {
      now += COOLDOWN_MS;
      for (const r of regionsOf(await searchAt(d, 1, now))) seen.add(r);
    }
    expect(seen.has("desert")).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(3);
    // The far party (2500) never appears while the band holds enough — and (QA S2) it is not
    // even scanned or stored: the pool is bounded in SQL to ±REPUTATION_BAND_WIDTH_MAX of the centre.
    const all = await pool.query<{ candidates: Candidate[]; pool: EncounterCandidatesRow["pool"] }>("SELECT candidates, pool FROM encounter_candidates WHERE trip_id = $1", [d.tripId]);
    expect(all.rows.flatMap((r) => r.candidates).some((c) => c.reputation.rating === 2500)).toBe(false);
    expect(all.rows.flatMap((r) => r.pool).some((p) => p.rating === 2500)).toBe(false);
    expect(all.rows.flatMap((r) => r.pool).every((p) => p.authored || Math.abs(p.rating - 1000) <= REPUTATION_BAND_WIDTH_MAX)).toBe(true);
    const idx = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'pool_progress' AND indexname = 'pool_progress_pool_reputation_idx'");
    expect(idx.rows[0]?.indexdef).toMatch(/\(pool, reputation\)/);
  });

  it("requires auth, refuses another account's caravan as 404, and a caravan in town as no_trip", async () => {
    expect((await app.inject({ method: "POST", url: `/me/caravans/${d.caravanId}/encounters/1/search` })).statusCode).toBe(401);
    const other = await registerPlayer();
    expect((await call(other, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).statusCode).toBe(404);
    expect((await call(other, "GET", `/me/caravans/${d.caravanId}/encounters/1/candidates`)).statusCode).toBe(404);
    const town = await call(other, "POST", `/me/caravans/${other.caravanId}/encounters/1/search`);
    expect(town.statusCode).toBe(404);
    expect(town.json().error).toBe("no_trip");
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/2/search`)).json().error).toBe("wrong_encounter");
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/0/search`)).statusCode).toBe(400);
  });
});

describe("the reroll is free and time-gated; nothing shortens it", () => {
  it("a second search within the cooldown is 409 reroll_cooldown with Retry-After; after it, a fresh menu with the next sequence", async () => {
    for (let i = 0; i < 4; i++) await makeOwner("desert", 1000 + i * 10);
    const d = await makeDefender("desert", 1000);
    const first = await search(d);
    expect(first.searchSeq).toBe(1);
    const again = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "reroll_cooldown", gate: "time", availableAtMs: first.searchedAtMs + COOLDOWN_MS });
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(again.headers["retry-after"])).toBeLessThanOrEqual(REROLL_COOLDOWN_SECONDS);
    expect(JSON.stringify(again.json())).not.toMatch(/coin|cost|price|skip/i);
    // One millisecond short: still gated. On the dot: free.
    await expect(searchAt(d, 1, first.searchedAtMs + COOLDOWN_MS - 1)).rejects.toMatchObject({ code: "reroll_cooldown" });
    const second = await searchAt(d, 1, first.searchedAtMs + COOLDOWN_MS);
    expect(second.searchSeq).toBe(2);
    expect(second.seed).not.toBe(first.seed);
    // The current menu is the latest; the earlier one is history (replayable, see below).
    const current = await readCandidates(appRole, d.caravan, 1, second.searchedAtMs);
    expect(current.searchSeq).toBe(2);
    expect(current.reroll.available).toBe(false);
    expect((await readCandidates(appRole, d.caravan, 1, second.searchedAtMs + COOLDOWN_MS)).reroll.available).toBe(true);
  });
});

describe("menus are seeded and reproducible from stored state", () => {
  it("the stored (pool, seed, centre, skipped) replays to the stored candidates; the seed is a function of caravan/trip/index/seq", async () => {
    for (let i = 0; i < 5; i++) await makeOwner("mountain", 1000 + i * 30);
    const d = await makeDefender("desert", 1000);
    const m1 = await search(d);
    const m2 = await searchAt(d, 1, m1.searchedAtMs + COOLDOWN_MS);
    for (const m of [m1, m2]) {
      const row = await menuRow(d.tripId, 1, m.searchSeq);
      const replay = replaySearch(row);
      expect(replay.partyIds).toEqual(row.candidates.map((c) => c.partyId));
      expect(replay.bandWidthUsed).toBe(row.band_width_used);
      expect(Number(row.seed)).toBe(m.seed);
      expect(row.pool.every((p) => Number.isInteger(p.rating))).toBe(true);
    }
    expect(m1.seed).not.toBe(m2.seed);
  });
});

describe("exclusions are enforced server-side", () => {
  it("self: the defender's own (valid, in-band) party is never offered", async () => {
    const d = await makeDefender("desert", 1000);
    await giveUnits(d, 3);
    expect((await call(d, "PUT", "/me/party", fullParty(d.units.slice(2)))).statusCode).toBe(200);
    const own = (await pool.query<{ id: string }>("SELECT id FROM standing_party WHERE account_id = $1", [d.accountId])).rows[0]!.id;
    for (let i = 0; i < 2; i++) await makeOwner("badlands", 1000);
    let now = Date.now();
    for (let i = 0; i < 4; i++) {
      const m = await searchAt(d, 1, now);
      expect(m.candidates.map((c) => c.partyId)).not.toContain(own);
      const row = await menuRow(d.tripId, 1, m.searchSeq);
      expect(row.candidates.map((c) => c.owner.accountId)).not.toContain(d.accountId);
      expect(row.pool.map((p) => p.partyId)).not.toContain(own);
      now += COOLDOWN_MS;
    }
  });

  it("linked accounts (PHASE-2 §31 seam) are excluded like self", async () => {
    const alt = await makeOwner("desert", 1000);
    for (let i = 0; i < 3; i++) await makeOwner("desert", 1000);
    const d = await makeDefender("desert", 1000);
    const linked = async (_db: unknown, id: string) => (id === d.accountId ? [alt.accountId] : []);
    const m = await searchAt(d, 1, Date.now(), linked);
    expect(m.candidates.map((c) => c.partyId)).not.toContain(alt.partyId);
    expect((await menuRow(d.tripId, 1, 1)).pool.map((p) => p.ownerAccountId)).not.toContain(alt.accountId);
    // Without the link, the alt is in the pool.
    const m2 = await searchAt(d, 1, Date.now() + COOLDOWN_MS * 2);
    expect((await menuRow(d.tripId, 1, m2.searchSeq)).pool.map((p) => p.ownerAccountId)).toContain(alt.accountId);
  });

  it("recent opponents: the last five parties this account committed to are excluded, across trips", async () => {
    // A distinct rating pocket so only these parties are in band.
    const pocket = 3000;
    const owners = [];
    for (let i = 0; i < 9; i++) owners.push(await makeOwner("high_plains", pocket + (i % 3) * 10));
    const d = await makeDefender("desert", pocket);
    const chosen: string[] = [];
    let trip = d.tripId;
    let now = Date.now();
    for (let round = 0; round < 6; round++) {
      const m = await withTransaction(appRole, (c) => searchCandidates(c, d.caravan, 1, { nowMs: now }));
      const row = await menuRow(trip, 1, 1);
      // Every previously chosen party (up to the last five) is excluded from the pool, and recorded.
      const expectExcluded = chosen.slice(-RECENT_OPPONENT_EXCLUSION);
      for (const id of expectExcluded) {
        expect(row.pool.map((p) => p.partyId)).not.toContain(id);
        expect(row.excluded_party_ids).toContain(id);
        expect(m.candidates.map((c) => c.partyId)).not.toContain(id);
      }
      // The sixth-last is back in the pool.
      if (chosen.length > RECENT_OPPONENT_EXCLUSION) expect(row.pool.map((p) => p.partyId)).toContain(chosen[chosen.length - RECENT_OPPONENT_EXCLUSION - 1]);
      const pick = m.candidates[0]!;
      const choice = await withTransaction(appRole, (c) => chooseCandidate(c, d.caravan, 1, pick.candidateId, now));
      expect(choice.chosen.partyId).toBe(pick.partyId);
      chosen.push(pick.partyId);
      // End the trip and start the next one on a fresh manifest.
      await withTransaction(pool, async (c) => {
        await endTrip(c, trip);
        await c.query("UPDATE wagon_manifest SET closed_at = now() WHERE caravan_id = $1 AND closed_at IS NULL", [d.caravanId]);
      });
      expect((await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: d.units, traps: [], fence: null })).statusCode).toBe(201);
      trip = (await withTransaction(pool, (c) => createTrip(c, d.caravanId))).id;
      now += 1000;
    }
    expect(new Set(chosen.slice(0, 6)).size).toBe(6);
  });
});

describe("difficulty escalates within a trip", () => {
  it("the band centre rises by ESCALATION_PER_ENCOUNTER per encounter index and the menu says so before the player pushes", async () => {
    for (let i = 0; i < 6; i++) await makeOwner("desert", 1500 + i * 20);
    const d = await makeDefender("desert", 1500);
    const m1 = await search(d);
    // Chunk 19 QA D2b: encounter 1 sits FIRST_ENCOUNTER_CENTRE_OFFSET below; escalation from 2 on is unchanged.
    expect(m1.centre).toBe(1500 + TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
    expect(m1.escalation).toEqual({ applied: TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET, perEncounter: ESCALATION_PER_ENCOUNTER, nextEncounter: ESCALATION_PER_ENCOUNTER });
    expect(m1.rules.escalation.firstEncounterOffset).toBe(TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
    // Advance the trip (chunk 15 will do this through outcomes; here the manifest counter moves directly).
    await pool.query("UPDATE wagon_manifest SET encounters_resolved = 1 WHERE caravan_id = $1 AND closed_at IS NULL", [d.caravanId]);
    const m2 = await search(d, 2);
    expect(m2.centre).toBe(1500 + ESCALATION_PER_ENCOUNTER);
    expect(m2.escalation).toEqual({ applied: ESCALATION_PER_ENCOUNTER, perEncounter: ESCALATION_PER_ENCOUNTER, nextEncounter: 2 * ESCALATION_PER_ENCOUNTER });
    await pool.query("UPDATE wagon_manifest SET encounters_resolved = 2 WHERE caravan_id = $1 AND closed_at IS NULL", [d.caravanId]);
    const m3 = await search(d, 3);
    expect(m3.centre).toBe(1500 + 2 * ESCALATION_PER_ENCOUNTER);
    expect((await menuRow(d.tripId, 3, 1)).centre).toBe(m3.centre);
  });
});

describe("server-initiated widening never triggers the sandbagging floor (QA S3)", () => {
  it("a party the search had to widen to is paid in full: the floor reads the gap BEYOND band_width_used", async () => {
    // A pocket of its own: two live parties at the centre and one 550 below. The first four
    // passes (±150 … ±450) hold only two; ±550 reaches the third. Its raw gap (700 from the
    // caravan: 550 below the centre, which encounter 1 puts 150 below the caravan — chunk 19
    // QA D2b) is past SANDBAG_EARN_GAP_START, but the server chose that width AND that centre,
    // not the player.
    const near = [await makeOwner("desert", 7000), await makeOwner("mountain", 7000)];
    const far = await makeOwner("badlands", 6450);
    const d = await makeDefender("desert", 7000 - TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
    const m = await search(d);
    expect(m.bandWidthUsed).toBe(550);
    expect(m.widened).toBe(true);
    expect(m.candidates.map((c) => c.partyId).sort()).toEqual([...near.map((o) => o.partyId), far.partyId].sort());
    const weak = m.candidates.find((c) => c.partyId === far.partyId)!;
    expect(m.centre).toBe(7000);
    expect(weak.reputation.gapFromCaravan).toBe(700);
    expect(sandbagEarnMultiplier(700)).toBeLessThan(FIXED_ONE); // the raw gap would have been floored
    expect(sandbagEarnMultiplier(700 - 550)).toBe(FIXED_ONE); // and so would nothing else, once measured from the band's edge
    expect(weak.reputation.gapBeyondBand).toBe(0);
    expect(weak.reputation.sandbagEarnMultiplier).toBe(FIXED_ONE);
    for (const c of m.candidates) expect(Math.abs(c.reputation.rating - m.centre)).toBeLessThanOrEqual(m.bandWidthUsed);
    // What chunk 19 will read is on the stored row, identical.
    const row = await menuRow(d.tripId, 1, 1);
    expect(row.candidates.find((c) => c.partyId === far.partyId)!.reputation).toEqual(weak.reputation);
  });
});

describe("the enqueue takes the scouted snapshot and nothing else (QA S1)", () => {
  it("enqueueEncounterResolution without a party snapshot throws and creates nothing; a snapshot of another owner is refused", async () => {
    const owner = await makeOwner("desert", 8000);
    const other = await makeOwner("desert", 8000);
    await makeOwner("mountain", 8000);
    const d = await makeDefender("desert", 8000);
    const base = { tripId: d.tripId, encounterIndex: 1, defenderAccountId: d.accountId, defenderCaravanId: d.caravanId, partyOwnerAccountId: owner.accountId, formation: { fences: [], traps: [], posts: [] } };
    await expect(withTransaction(appRole, (c) => enqueueEncounterResolution(c, base as never))).rejects.toThrow(/party snapshot is required/);
    await expect(withTransaction(appRole, async (c) => enqueueEncounterResolution(c, { ...base, party: await snapshotStandingParty(c, other.accountId) }))).rejects.toThrow(/belongs to account/);
    expect(await getJob(pool, `encounter:${d.tripId}:1`)).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_event WHERE causation_id = $1", [`enqueue:encounter:${d.tripId}:1`])).rows[0]!.n).toBe(0);
    // Through matchmaking, the chosen snapshot is what goes in.
    const m = await search(d);
    const pick = m.candidates[0]!;
    await withTransaction(appRole, (c) => chooseCandidate(c, d.caravan, 1, pick.candidateId, m.searchedAtMs));
    // Chunk 25 QA N1: once a candidate is chosen, the direct enqueue accepts only THAT snapshot, byte for byte.
    const chosenStored = await storedCandidate(d.tripId, pick.candidateId);
    const notChosen = m.candidates.find((c) => c.candidateId !== pick.candidateId)!;
    const notChosenStored = await storedCandidate(d.tripId, notChosen.candidateId);
    const direct = (party: typeof chosenStored.snapshot, ownerId: string) =>
      withTransaction(appRole, (c) => enqueueEncounterResolution(c, { ...base, partyOwnerAccountId: ownerId, party }));
    await expect(direct(notChosenStored.snapshot, notChosenStored.owner.accountId)).rejects.toThrow(/not the chosen candidate/);
    await expect(direct({ ...chosenStored.snapshot, savedAt: "2000-01-01T00:00:00.000Z" }, chosenStored.owner.accountId)).rejects.toThrow(/not the chosen candidate/);
    expect(await getJob(pool, `encounter:${d.tripId}:1`)).toBeNull();
    const { job } = await withTransaction(appRole, (c) => enqueueChosenEncounter(c, d.caravan, 1, { fences: [], traps: [], posts: [] }));
    // The view carries no account id (QA D4); the job input is the STORED snapshot, owner included.
    expect(canonicalJson(job.input["party"] as Json)).toBe(canonicalJson({ ...pick.snapshot, ownerAccountId: (await storedCandidate(d.tripId, pick.candidateId)).owner.accountId }));
  });
});

describe("the snapshot contract: scouted == chosen == fought", () => {
  let owner: Awaited<ReturnType<typeof makeOwner>>;
  let d: Awaited<ReturnType<typeof makeDefender>>;
  let menu: CandidateMenuView;
  let pick: CandidateView;

  beforeAll(async () => {
    // One owner alone in a pocket plus two fillers, so the pocket's menu always holds the owner.
    owner = await makeOwner("badlands", 4000, 5);
    for (let i = 0; i < 2; i++) await makeOwner("mountain", 4000);
    // Encounter 1 is centred FIRST_ENCOUNTER_CENTRE_OFFSET below the caravan (chunk 19 QA D2b): centre the pocket.
    d = await makeDefender("desert", 4000 - TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
    menu = await search(d);
    pick = menu.candidates.find((c) => c.partyId === owner.partyId)!;
    expect(pick).toBeDefined();
  });

  it("choosing commits the scouted snapshot; GET shows it; a different choice afterwards is refused; the same one is idempotent", async () => {
    const res = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: pick.candidateId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().chosen.candidateId).toBe(pick.candidateId);
    expect(res.json().menu.chosen.candidateId).toBe(pick.candidateId);
    const get = (await call(d, "GET", `/me/caravans/${d.caravanId}/encounters/1/candidates`)).json().menu;
    expect(get.chosen.candidateId).toBe(pick.candidateId);
    expect(get.reroll.available).toBe(false);
    const other = menu.candidates.find((c) => c.candidateId !== pick.candidateId)!;
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: other.candidateId })).json().error).toBe("already_chosen");
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: pick.candidateId })).statusCode).toBe(200);
    // Searching again once chosen is refused: the circle is arranged against THIS party.
    await expect(searchAt(d, 1, Date.now() + COOLDOWN_MS * 10)).rejects.toMatchObject({ code: "already_chosen" });
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: "nope" })).statusCode).toBe(400);
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: pick.candidateId, extra: 1 })).statusCode).toBe(400);
  });

  it("the owner editing, merging and losing units AFTER the search changes nothing: the job's party input is byte-identical to the scouted snapshot", async () => {
    const scoutedSnapshot = canonicalJson({ ...pick.snapshot, ownerAccountId: owner.accountId });
    const scoutedView = canonicalJson(pick.scout as unknown as Json);
    // The owner rearranges, then de-merges a unit, then loses one outright.
    const edited = fullParty(owner.units.slice(0, 3), []);
    expect((await call(owner, "PUT", "/me/party", edited)).statusCode).toBe(200);
    await pool.query("UPDATE unit_instance SET merge_level = 1 WHERE id = $1", [owner.units[0]]);
    await pool.query("DELETE FROM unit_instance WHERE id = $1", [owner.units[4]]);
    const live = (await call(owner, "GET", "/me/party")).json().party;
    expect(canonicalJson(live.party)).not.toBe(canonicalJson(pick.snapshot.composition));
    // Enqueue through the seam chunk 15 will use.
    const { job, created } = await withTransaction(appRole, (c) => enqueueChosenEncounter(c, d.caravan, 1, { fences: [], traps: [], posts: [] }));
    expect(created).toBe(true);
    const stored = (await getJob(pool, job.id))!;
    const input = stored.input as { party: Json; partyOwnerAccountId: string; tripId: string; encounterIndex: number };
    expect(canonicalJson(input.party)).toBe(scoutedSnapshot);
    expect(input.partyOwnerAccountId).toBe(owner.accountId);
    expect(input.tripId).toBe(d.tripId);
    expect(input.encounterIndex).toBe(1);
    // The resolver-side scout of the job input is byte-identical to what the defender was shown.
    const fought = scoutParty(partyFromJson((input.party as { composition: Record<string, unknown> }).composition));
    expect(canonicalJson(fought as unknown as Json)).toBe(scoutedView);
    // A retry of the same commit returns the same job (idempotent), still with the scouted party.
    const again = await withTransaction(appRole, (c) => enqueueChosenEncounter(c, d.caravan, 1, { fences: [], traps: [], posts: [] }));
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(job.id);
    expect(canonicalJson((await getJob(pool, job.id))!.input["party"] as Json)).toBe(scoutedSnapshot);
  });

  it("a party that stopped resolving between searches is skipped at generation (recorded) and the menu is still full; choosing an invalid-now party is still honoured from its snapshot", async () => {
    // A fresh pocket: three owners; one of them loses a unit before the defender searches.
    const a = await makeOwner("desert", 5000);
    const b = await makeOwner("desert", 5000);
    const c = await makeOwner("desert", 5000);
    // The filler sits outside the first band, so the first pass draws exactly a, b, c; a is
    // invalid, so the draw re-runs without it, widens, and takes the filler.
    const filler = await makeOwner("desert", 5200);
    const d2 = await makeDefender("desert", 5000 - TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET); // encounter 1 centred at 5000 (chunk 19 QA D2b)
    await pool.query("DELETE FROM unit_instance WHERE id = $1", [a.units[0]]);
    expect((await call(a, "GET", "/me/party")).json().party.valid).toBe(false);
    const m = await search(d2);
    expect(m.candidates.length).toBe(3);
    expect(m.candidates.map((x) => x.partyId)).not.toContain(a.partyId);
    const row = await menuRow(d2.tripId, 1, 1);
    expect(row.skipped_party_ids).toEqual([a.partyId]);
    expect(row.pool.map((p) => p.partyId)).toContain(a.partyId); // in the pool, skipped by the draw: replayable
    expect(replaySearch(row).partyIds).toEqual(m.candidates.map((x) => x.partyId));
    expect(m.bandWidthUsed).toBe(250);
    expect(m.candidates.map((x) => x.partyId).sort()).toEqual([b.partyId, c.partyId, filler.partyId].sort());
    // Now b loses a unit AFTER being scouted: choosing b still works, from the stored snapshot.
    await pool.query("DELETE FROM unit_instance WHERE id = $1", [b.units[0]]);
    const pickB = m.candidates.find((x) => x.partyId === b.partyId)!;
    const res = await call(d2, "POST", `/me/caravans/${d2.caravanId}/encounters/1/choose`, { candidateId: pickB.candidateId });
    expect(res.statusCode, res.body).toBe(200);
    const { job } = await withTransaction(appRole, (cl) => enqueueChosenEncounter(cl, d2.caravan, 1, { fences: [], traps: [], posts: [] }));
    expect(canonicalJson((await getJob(pool, job.id))!.input["party"] as Json)).toBe(canonicalJson({ ...pickB.snapshot, ownerAccountId: b.accountId }));
  });

  it("a candidate from a rerolled-away menu is stale_candidate; an unknown id is 404", async () => {
    for (let i = 0; i < 3; i++) await makeOwner("desert", 6000);
    const d3 = await makeDefender("desert", 6000);
    const m1 = await search(d3);
    await searchAt(d3, 1, m1.searchedAtMs + COOLDOWN_MS);
    const stale = await call(d3, "POST", `/me/caravans/${d3.caravanId}/encounters/1/choose`, { candidateId: m1.candidates[0]!.candidateId });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("stale_candidate");
    expect((await call(d3, "POST", `/me/caravans/${d3.caravanId}/encounters/1/choose`, { candidateId: "0".repeat(32) })).statusCode).toBe(404);
  });
});

describe("authored fallback (PHASE-2 §25 seam)", () => {
  it("on an empty live pool the menu is three distinct authored parties, fully scoutable and the same object as any party; seeding is idempotent", async () => {
    const first = await seedAuthoredParties(appRole);
    expect(first.created.length).toBe(AUTHORED_BANDS * AUTHORED_PARTIES_PER_BAND);
    const second = await seedAuthoredParties(appRole);
    expect(second.created).toEqual([]);
    expect(second.existing.length).toBe(first.created.length);
    // A caravan in band 0: the three authored band-0 parties. Since the chunk 37 balance pass
    // REPUTATION_START (400) is within the widest pass of band 0, so any live party this suite
    // left at the starting siege rating is parked far away first (the owner role sets ratings).
    await pool.query("UPDATE pool_progress SET reputation = 20000 WHERE pool = 'siege' AND reputation = $1 AND account_id IN (SELECT id FROM account WHERE NOT is_system)", [TUNABLES.REPUTATION_START]);
    const d = await makeDefender("high_plains", 250);
    const m = await search(d);
    expect(m.candidates.length).toBe(3);
    expect(new Set(m.candidates.map((c) => c.partyId)).size).toBe(3);
    for (const c of m.candidates) {
      expect(c.owner.authored).toBe(true);
      // Chunk 25 QA N3: the outfit's name (and flavour), never the sys_outfit_* handle.
      expect(c.owner.displayName.startsWith(AUTHORED_USERNAME_PREFIX)).toBe(false);
      expect(c.owner.displayName.length).toBeGreaterThan(0);
      expect(c.owner.flavor?.length).toBeGreaterThan(0);
      expect(c.scout.units.length).toBeGreaterThanOrEqual(3);
      expect(canonicalJson(scoutParty(partyFromJson(c.snapshot.composition)) as unknown as Json)).toBe(canonicalJson(c.scout as unknown as Json));
      // Same shape as a live snapshot: nothing marks it authored inside the snapshot.
      expect(Object.keys(c.snapshot).sort()).toEqual(["composition", "hash", "partyId", "savedAt", "slot"]);
      expect(JSON.stringify(c.snapshot)).not.toMatch(/authored|system/i);
    }
    expect(m.authoredOutsideBand).toBe(false);
    expect(m.authoredShare).toEqual({ authored: 3, of: 3, shareBp: 10_000, maxShareBp: 3000 });
    // System accounts cannot log in and are flagged.
    const sys = await pool.query<{ is_system: boolean; username: string }>("SELECT is_system, username FROM account WHERE username LIKE $1", [`${AUTHORED_USERNAME_PREFIX}%`]);
    expect(sys.rows.length).toBe(first.created.length);
    expect(sys.rows.every((r) => r.is_system)).toBe(true);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: sys.rows[0]!.username, password: "password" } });
    expect(login.statusCode).toBe(401);
  }, 60_000); // chunk 25: the full set is 96 parties, ~8 s to seed through the ledger

  it("a fresh player pushed to encounter 6 is paid in full on every candidate (QA S3); only the outside-band fallback can still be floored, and the menu says so", async () => {
    // Fresh account: living Reputation at REPUTATION_START, never set by the test. Encounter 6
    // escalates the centre by 5 steps; whatever the pool offers from inside the (widened)
    // band carries no earn penalty.
    const d = await makeDefender("desert", TUNABLES.REPUTATION_START);
    for (let k = 1; k <= 5; k++) await pool.query("UPDATE wagon_manifest SET encounters_resolved = $2 WHERE caravan_id = $1 AND closed_at IS NULL", [d.caravanId, k]);
    const m = await search(d, 6);
    expect(m.escalation.applied).toBe(5 * ESCALATION_PER_ENCOUNTER);
    expect(m.authoredOutsideBand).toBe(false);
    for (const c of m.candidates) {
      expect(Math.abs(c.reputation.rating - m.centre)).toBeLessThanOrEqual(m.bandWidthUsed);
      expect(c.reputation.gapBeyondBand).toBe(0);
      expect(c.reputation.sandbagEarnMultiplier).toBe(FIXED_ONE);
    }
    // An empty pocket far above every party: the fallback serves the nearest authored ones
    // from outside the widest band. That gap IS beyond the band, so the floor applies and is
    // shown before the player commits (the design keeps the floor; D2).
    const high = await makeDefender("desert", 9000);
    const far = await search(high);
    expect(far.authoredOutsideBand).toBe(true);
    expect(far.bandWidthUsed).toBe(REPUTATION_BAND_WIDTH_MAX);
    expect(far.authoredShare).toEqual({ authored: 3, of: 3, shareBp: 10_000, maxShareBp: 3000 });
    for (const c of far.candidates) {
      expect(c.owner.authored).toBe(true);
      // Measured beyond the band actually searched (chunk 19 QA D2b): encounter 1's centre sits
      // FIRST_ENCOUNTER_CENTRE_OFFSET below the caravan, so the band's low edge is centre − width.
      expect(c.reputation.gapBeyondBand).toBe(far.centre - REPUTATION_BAND_WIDTH_MAX - c.reputation.rating);
      expect(c.reputation.gapBeyondBand).toBe(c.reputation.gapFromCaravan - REPUTATION_BAND_WIDTH_MAX + TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
      expect(c.reputation.sandbagEarnMultiplier).toBe(sandbagEarnMultiplier(c.reputation.gapBeyondBand));
      expect(c.reputation.sandbagEarnMultiplier).toBeLessThan(FIXED_ONE);
    }
  });

  it("with live parties in band, authored ones are capped by ratio (never more than the allowance in the draw) and excluded when the live pool is deep", async () => {
    // Twelve live parties at the band-3 centre (1150), where three authored parties also sit.
    const owners = [];
    for (let i = 0; i < 12; i++) owners.push(await makeOwner("mountain", 1150));
    const d = await makeDefender("desert", 1150);
    let now = Date.now();
    let authoredPicks = 0;
    let menus = 0;
    for (let i = 0; i < 8; i++) {
      const m = await searchAt(d, 1, now);
      const row = await menuRow(d.tripId, 1, m.searchSeq);
      const pass = m.passes[0]!;
      expect(pass.live).toBeGreaterThanOrEqual(12);
      expect(pass.authoredAllowed).toBeLessThanOrEqual(Math.floor((pass.live * 3000) / 7000));
      expect(row.pool.filter((p) => p.authored).length).toBeGreaterThanOrEqual(3);
      authoredPicks += m.candidates.filter((c) => c.owner.authored).length;
      menus++;
      now += COOLDOWN_MS;
    }
    expect(authoredPicks / (menus * 3)).toBeLessThanOrEqual(0.5);
  });
});

describe("DB guards hold against the app role", () => {
  it("a stored menu is immutable, a chosen candidate is frozen, and trips / menus are history", async () => {
    const d = await makeDefender("desert", 1150);
    const m = await search(d);
    const row = await menuRow(d.tripId, 1, 1);
    const upd = await expectDbError(appRole, "UPDATE encounter_candidates SET candidates = '[]'::jsonb WHERE trip_id = $1", [d.tripId]);
    expect(upd?.code).toBe("23514");
    const seed = await expectDbError(appRole, "UPDATE encounter_candidates SET seed = seed + 1 WHERE trip_id = $1", [d.tripId]);
    expect(seed?.code).toBe("23514");
    // Choosing an id that was not offered is refused by the CHECK.
    const bogus = await expectDbError(appRole, "UPDATE encounter_candidates SET chosen_candidate_id = $2, chosen_at = now() WHERE trip_id = $1", [d.tripId, "f".repeat(32)]);
    expect(bogus?.code).toBe("23514");
    await appRole.query("UPDATE encounter_candidates SET chosen_candidate_id = $2, chosen_at = now() WHERE trip_id = $1", [d.tripId, row.candidates[0]!.candidateId]);
    const rechoose = await expectDbError(appRole, "UPDATE encounter_candidates SET chosen_candidate_id = $2 WHERE trip_id = $1", [d.tripId, row.candidates[1]!.candidateId]);
    expect(rechoose?.code).toBe("23514");
    const unchoose = await expectDbError(appRole, "UPDATE encounter_candidates SET chosen_candidate_id = NULL, chosen_at = NULL WHERE trip_id = $1", [d.tripId]);
    expect(unchoose?.code).toBe("23514");
    // A second chosen row for the same encounter cannot exist (even if inserted then chosen).
    await appRole.query(
      `INSERT INTO encounter_candidates (trip_id, encounter_index, search_seq, seed, caravan_rating, centre, band_width_used, pool, excluded_party_ids, skipped_party_ids, candidates, searched_at_ms)
       VALUES ($1, 1, 2, 1, 1150, 1150, 150, '[]', '[]', '[]', $2::jsonb, 0)`,
      [d.tripId, JSON.stringify(row.candidates)],
    );
    const twice = await expectDbError(appRole, "UPDATE encounter_candidates SET chosen_candidate_id = $2, chosen_at = now() WHERE trip_id = $1 AND search_seq = 2", [d.tripId, row.candidates[0]!.candidateId]);
    expect(twice?.code).toBe("23505");
    const inserted = await expectDbError(appRole, "INSERT INTO encounter_candidates (trip_id, encounter_index, search_seq, seed, caravan_rating, centre, band_width_used, pool, excluded_party_ids, skipped_party_ids, candidates, searched_at_ms, chosen_candidate_id, chosen_at) VALUES ($1, 1, 3, 1, 1, 1, 1, '[]', '[]', '[]', '[]', 0, 'x', now())", [d.tripId]);
    expect(inserted?.code).toBe("23514");
    expect((await expectDbError(appRole, "DELETE FROM encounter_candidates WHERE trip_id = $1", [d.tripId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "DELETE FROM trip WHERE id = $1", [d.tripId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "TRUNCATE trip"))?.code).toMatch(/42501|23514/);
    const ended = await withTransaction(appRole, (c) => endTrip(c, d.tripId));
    expect(ended.ended_at).not.toBeNull();
    expect((await expectDbError(appRole, "UPDATE trip SET ended_at = NULL WHERE id = $1", [d.tripId]))?.code).toBe("23514");
    // Caravan-level: no account column on trip or encounter_candidates; no Coin column anywhere.
    for (const t of ["trip", "encounter_candidates"]) {
      const cols = (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).rows.map((c) => c.column_name);
      expect(cols.filter((c) => /account|coin|cost|price/.test(c)), t).toEqual([]);
    }
    expect(m.candidates.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("final play-test review: the band-0 raider cap (S1), the centre's basis (N6) and guest owners' names (N8)", () => {
  /** A defender who packed `units` living units, at a living rating whose encounter-1 centre is `centre`. */
  async function packedDefender(units: number, centre: number): Promise<Player & { caravan: CaravanRow; tripId: string }> {
    const p = await registerPlayer("desert");
    await giveUnits(p, units, "desert.dust_rider");
    await setLivingRep(p.caravanId, centre - TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
    expect((await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: p.units, traps: [], fence: null })).statusCode).toBe(201);
    const trip = await withTransaction(pool, (c) => createTrip(c, p.caravanId));
    return { ...p, caravan: (await findCaravanById(pool, p.caravanId))!, tripId: trip.id };
  }

  it("S1: in band 0 no party with more raiders than the caravan packed units is offered; the cap is stored with the menu and the menu replays", async () => {
    const centre = 250; // band 0
    expect(bandOf(centre).index).toBe(0);
    for (const n of [1, 1, 2, 2, 2, 5, 5, 6, 6]) await makeOwner("mountain", centre, n);
    const d = await packedDefender(2, centre);
    for (let t = 0; t < 4; t++) {
      const m = await searchAt(d, 1, Date.now() + t * COOLDOWN_MS);
      expect(m.raiderCap).toMatchObject({ packedUnits: 2, cap: 2, relaxed: false });
      expect(m.raiderCap!.excluded).toBeGreaterThanOrEqual(4);
      for (const c of m.candidates) expect(c.scout.units.length, c.owner.displayName).toBeLessThanOrEqual(2);
      const row = await menuRow(d.tripId, 1, m.searchSeq);
      expect(row.raider_cap).toMatchObject({ band: 0, packedUnits: 2, cap: 2, relaxed: false });
      expect(row.pool.every((e) => !row.raider_cap!.excludedPartyIds.includes(e.partyId))).toBe(true);
      expect(replaySearch(row).partyIds).toEqual(row.candidates.map((c) => c.partyId));
    }
  });

  it("S1: outside band 0 the rule does not run (raiderCap null, nothing stored)", async () => {
    const centre = 1600;
    expect(bandOf(centre).index).toBeGreaterThan(0);
    for (const n of [5, 6, 7]) await makeOwner("badlands", centre, n);
    const d = await packedDefender(1, centre);
    const m = await searchAt(d, 1, Date.now());
    expect(m.raiderCap).toBeNull();
    expect((await menuRow(d.tripId, 1, m.searchSeq)).raider_cap).toBeNull();
  });

  it("N6: the menu says where its centre is and why — encounter 1 is searched below the caravan, not 'within its band'", async () => {
    const d = await packedDefender(2, 1600);
    const m = await searchAt(d, 1, Date.now());
    expect(m.centre).toBe(1600);
    expect(m.centreBasis).toMatchObject({ offset: TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET, reason: "first_encounter_offset" });
    expect(m.centreBasis.centreBand).toEqual(bandOf(1600));
    expect(m.centreBasis.inCaravanBand).toBe(bandOf(1600).index === bandOf(m.caravan.rating).index);
  });

  it("N8: every caravan is named at creation; a guest's party is offered under its caravan's name, never 'Unnamed drifter'", async () => {
    const centre = 11_000; // far above the authored set and every other party in this file: only these three are near
    const g = await app.inject({ method: "POST", url: "/auth/guest", payload: { region: "desert" } });
    expect(g.statusCode).toBe(201);
    const gb = g.json();
    expect(gb.caravan.name).not.toBe("Caravan");
    expect(gb.caravan.name.length).toBeGreaterThan(0);
    const guest: Player = { token: gb.token, accountId: gb.account.id, caravanId: gb.caravan.id, units: [] };
    await giveUnits(guest, 3, "desert.dust_rider");
    expect((await call(guest, "PUT", "/me/party", fullParty(guest.units))).statusCode).toBe(200);
    await setSiegeRep(guest.accountId, centre);
    for (let i = 0; i < 2; i++) await makeOwner("desert", centre + 1 + i, 3);
    const d = await packedDefender(3, centre);
    const m = await searchAt(d, 1, Date.now());
    const names = m.candidates.map((c) => c.owner.displayName);
    expect(names).toContain(gb.caravan.name);
    expect(names).not.toContain("Unnamed drifter");
  });
});

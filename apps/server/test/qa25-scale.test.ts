/**
 * Chunk 25 QA S4 / S5 at scale: ~10k standing parties and ~10k chosen menus. The matchmaking
 * pool scan and the served-share query must read through their indexes (EXPLAIN, not a
 * timing), and a search must store only what its draw could have picked — the parties
 * within the width it ended at (plus the authored fill set), never the ±600 scan.
 */
import { entryBand, type PartyConfig } from "@caravan/circle";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { AUTHORED_SERVED_SHARE_SQL } from "../src/matchmaking/authoredShare.js";
import { REPUTATION_BAND_WIDTH_MAX } from "../src/matchmaking/band.js";
import { POOL_SQL, replaySearch, searchCandidates, type EncounterCandidatesRow } from "../src/matchmaking/service.js";
import { createTrip } from "../src/matchmaking/trips.js";
import { findCaravanById } from "../src/repo/caravans.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { appRolePool, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;
const SYNTHETIC = 10_000;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
}

async function registerPlayer(): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("s"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id };
}
function call(p: Player, method: "POST" | "PUT", url: string, payload: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` }, payload: payload as NonNullable<InjectOptions["payload"]> };
  return app.inject(opts);
}
async function units(p: Player, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: "desert.dust_rider" })).id);
  return ids;
}
function party(refs: string[]): PartyConfig {
  return { v: 1, units: refs.map((ref, i) => ({ ref, stance: "nearest", edge: "north", cell: entryBand("north")[i]! })), siege: [] };
}

/** Every node of a JSON plan, flattened. */
function planNodes(plan: unknown): { "Node Type": string; "Index Name"?: string; "Relation Name"?: string }[] {
  const out: { "Node Type": string; "Index Name"?: string; "Relation Name"?: string }[] = [];
  const walk = (n: Record<string, unknown>): void => {
    out.push(n as never);
    for (const c of (n["Plans"] as Record<string, unknown>[] | undefined) ?? []) walk(c);
  };
  walk(((plan as { Plan: Record<string, unknown> }[])[0]!).Plan);
  return out;
}
async function explain(sql: string, params: unknown[]): Promise<ReturnType<typeof planNodes>> {
  const res = await pool.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  return planNodes(res.rows[0]!["QUERY PLAN"]);
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
  await seedAuthoredParties(appRole);
  // ~10k synthetic party owners, none within ±200 of 1000 (so no draw at 1000 ever picks
  // one), spread from 0 to 9999 otherwise: a slice of them falls inside the ±600 scan.
  await pool.query(
    `WITH g AS (SELECT n, CASE WHEN (n * 7) % 10000 BETWEEN 800 AND 1200 THEN 2000 + n % 500 ELSE (n * 7) % 10000 END AS rep FROM generate_series(1, $1::integer) n),
          a AS (INSERT INTO account (username, password_hash, coin_storage_cap) SELECT 'scale_' || n, 'x', 1000 FROM g RETURNING id, username)
     INSERT INTO pool_progress (pool, account_id, reputation) SELECT 'siege', a.id, g.rep FROM a JOIN g ON a.username = 'scale_' || g.n`,
    [SYNTHETIC],
  );
  await pool.query(
    `INSERT INTO standing_party (account_id, composition)
     SELECT id, '{"v":1,"units":[{"ref":"00000000-0000-4000-8000-000000000000","stance":"nearest","edge":"north","cell":0}],"siege":[]}'::jsonb FROM account WHERE username LIKE 'scale\\_%'`,
  );
  await pool.query("ANALYZE account; ANALYZE pool_progress; ANALYZE standing_party");
}, 120_000);
afterAll(async () => {
  await truncateAll(pool);
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("QA S5: the pool scan is two indexed branches, and a search stores only what it could pick", () => {
  it("EXPLAIN over ~10k parties: the live branch reads pool_progress by (pool, reputation), the system branch by account_system_idx — no sequential scan anywhere", async () => {
    const n = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM standing_party");
    expect(Number(n.rows[0]!.n)).toBeGreaterThan(SYNTHETIC);
    const nodes = await explain(POOL_SQL, [[], 1000, REPUTATION_BAND_WIDTH_MAX]);
    const indexes = nodes.map((x) => x["Index Name"]).filter(Boolean);
    expect(indexes).toContain("pool_progress_pool_reputation_idx");
    expect(indexes).toContain("account_system_idx");
    // Every other row is reached by key (LATERAL lookups): no sequential scan of any table.
    expect(nodes.filter((x) => x["Node Type"] === "Seq Scan").map((x) => x["Relation Name"])).toEqual([]);
    expect(indexes).toContain("standing_party_one_per_slot");
  });

  it("a search at 1000 scans the ±600 slice but stores only the parties within the width it ended at, and the row replays exactly", async () => {
    // Thirty real owners around 1000, so the first pass (±150) fills.
    const owners: Player[] = [];
    for (let i = 0; i < 30; i++) {
      const o = await registerPlayer();
      expect((await call(o, "PUT", "/me/party", party(await units(o, 3)))).statusCode).toBe(200);
      await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [o.accountId, 900 + i * 7]);
      owners.push(o);
    }
    const d = await registerPlayer();
    const mine = await units(d, 2);
    await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [d.caravanId]);
    expect((await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: mine, traps: [], fence: null })).statusCode).toBe(201);
    await withTransaction(pool, (c) => createTrip(c, d.caravanId));
    const caravan = (await findCaravanById(pool, d.caravanId))!;
    const scanned = (await pool.query(POOL_SQL, [[d.accountId], 1000, REPUTATION_BAND_WIDTH_MAX])).rows.length;
    const menu = await withTransaction(appRole, (c) => searchCandidates(c, caravan, 1, { nowMs: Date.now() }));
    expect(menu.bandWidthUsed).toBe(150);
    const row = (await pool.query<EncounterCandidatesRow>("SELECT * FROM encounter_candidates WHERE trip_id = (SELECT id FROM trip WHERE caravan_id = $1)", [d.caravanId])).rows[0]!;
    expect(scanned).toBeGreaterThan(300); // synthetic parties inside ±600 plus the authored set
    expect(row.pool.length).toBeLessThan(scanned / 5);
    for (const p of row.pool) expect(Math.abs(p.rating - row.centre)).toBeLessThanOrEqual(row.band_width_used);
    expect(row.pool.filter((p) => !p.authored).length).toBe(30);
    expect(replaySearch(row).partyIds).toEqual(row.candidates.map((c) => c.partyId));
    expect(row.band).toBe(3);
  }, 60_000);
});

describe("QA S4: the served-share query walks the band index and stops at the window", () => {
  it("EXPLAIN over ~10k chosen menus: an index scan of encounter_candidates_band_chosen_idx under a Limit, no sequential scan", async () => {
    const d = await registerPlayer();
    const mine = await units(d, 1);
    expect((await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: mine, traps: [], fence: null })).statusCode).toBe(201);
    const trip = await withTransaction(pool, (c) => createTrip(c, d.caravanId));
    await pool.query(
      `INSERT INTO encounter_candidates (trip_id, encounter_index, search_seq, seed, caravan_rating, centre, band_width_used, pool, excluded_party_ids, skipped_party_ids, candidates, searched_at_ms, band)
       SELECT $1, n, 1, n, 1000, 1000, 150, '[]', '[]', '[]', jsonb_build_array(jsonb_build_object('candidateId', 'c' || n, 'owner', jsonb_build_object('authored', n % 3 = 0))), n, n % 8
         FROM generate_series(1, 10000) n`,
      [trip.id],
    );
    await pool.query("UPDATE encounter_candidates SET chosen_candidate_id = 'c' || encounter_index, chosen_at = now() - (encounter_index || ' seconds')::interval WHERE trip_id = $1", [trip.id]);
    await pool.query("ANALYZE encounter_candidates");
    const nodes = await explain(AUTHORED_SERVED_SHARE_SQL, [3, 40]);
    expect(nodes.map((x) => x["Node Type"])).toContain("Limit");
    expect(nodes.some((x) => x["Index Name"] === "encounter_candidates_band_chosen_idx")).toBe(true);
    expect(nodes.filter((x) => x["Node Type"] === "Seq Scan").map((x) => x["Relation Name"])).not.toContain("encounter_candidates");
    // And it counts the window right: band 3 is encounter indices ≡ 3 (mod 8), newest = smallest index.
    const res = await pool.query<{ authored: boolean }>(AUTHORED_SERVED_SHARE_SQL, [3, 40]);
    expect(res.rows.length).toBe(40);
    const expected = [...Array(40)].map((_, i) => 3 + 8 * i).filter((n) => n % 3 === 0).length;
    expect(res.rows.filter((r) => r.authored).length).toBe(expected);
  }, 60_000);
});

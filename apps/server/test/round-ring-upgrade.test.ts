/**
 * Chunk 50, "Open trips, stored formations and old replays": the upgrade to the round wagon circle
 * (RESOLVER_VERSION 10, BATTLEFIELD_VERSION 3, migration 031).
 *   (a) an open trip whose next encounter is uncommitted and that rode out on battlefield version 2
 *       is voided by the upgrade step (cause "upgrade"), the caravan ends in town;
 *   (b) a committed job stamped resolver version 9 is parked and its trip voided (park + upgrade
 *       step together); a caravan packed in town, and a trip on the current geometry, are untouched;
 *   (c) a menu drawn under version 9 answers 409 menu_stale;
 *   (d) a version-9 replay answers renderable:false with the old-square-camp reason.
 */
import { INTERIOR_POST_CELLS } from "@caravan/circle";
import { BATTLEFIELD_VERSION, RESOLVER_VERSION } from "@caravan/resolver";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { parkOtherVersions } from "../src/jobs/worker.js";
import { OLD_SQUARE_CAMP_REASON } from "../src/routes/replay.js";
import { TRIP_SETTLE_HOOKS, voidTripsOfOtherGeometry } from "../src/trip/service.js";
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
  await seedAuthoredParties(appRole);
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

async function register(): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("rr"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  await seasonCaravan(pool, body.caravan.id);
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id };
}

async function unitIds(p: Player): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM unit_instance WHERE caravan_id = $1 ORDER BY id", [p.caravanId])).rows.map((r) => r.id);
}

async function pack(p: Player, count: number): Promise<void> {
  const packed = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: (await unitIds(p)).slice(0, count), traps: [], fence: null });
  expect(packed.statusCode, packed.body).toBe(201);
}

async function rideOut(p: Player, count: number): Promise<string> {
  await pool.query("UPDATE pool_progress SET reputation = 700 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
  await pack(p, count);
  const start = await call(p, "POST", `/me/caravans/${p.caravanId}/trip/start`);
  expect(start.statusCode, start.body).toBe(201);
  return start.json().tripId;
}

/** Owner role, triggers off for the statements: stands in for rows written before the upgrade. */
async function asBeforeUpgrade(statements: { sql: string; params: unknown[] }[]): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const s of statements) await c.query(s.sql, s.params);
  } finally {
    await c.query("SET session_replication_role = origin");
    c.release();
  }
}

const ageTrip = (tripId: string, version: number) => asBeforeUpgrade([{ sql: "UPDATE trip SET battlefield_version = $2 WHERE id = $1", params: [tripId, version] }]);

async function voidedEvents(caravanId: string): Promise<{ cause: string; encountersSurvived: number; credited: number; tripCapRefunded: boolean }[]> {
  const res = await pool.query<{ payload: { cause: string; encountersSurvived: number; credited: number; tripCapRefunded: boolean } }>("SELECT payload FROM ledger_event WHERE event_type = 'trip_voided' AND caravan_id = $1", [caravanId]);
  return res.rows.map((r) => r.payload);
}

async function commitFirstEncounter(p: Player): Promise<void> {
  const search = await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/1/search`);
  expect(search.statusCode, search.body).toBe(201);
  const chosen = await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/1/choose`, { candidateId: search.json().menu.candidates[0].candidateId });
  expect(chosen.statusCode, chosen.body).toBe(200);
  const ref = (await unitIds(p))[0]!;
  const cell = INTERIOR_POST_CELLS[0]!;
  const put = await call(p, "PUT", `/caravans/${p.caravanId}/encounters/1/formation`, { v: 3, fences: [], traps: [], posts: [{ ref, cell: { x: cell.x, y: cell.y }, stance: "guard" }] });
  expect(put.statusCode, put.body).toBe(200);
  const commit = await call(p, "POST", `/me/caravans/${p.caravanId}/trip/encounters/1/commit`);
  expect(commit.statusCode, commit.body).toBe(202);
}

describe("chunk 50: the round wagon circle upgrade", () => {
  it("every trip row states its geometry; the column is immutable", async () => {
    const d = await register();
    const tripId = await rideOut(d, 2);
    expect((await pool.query("SELECT battlefield_version FROM trip WHERE id = $1", [tripId])).rows[0]).toEqual({ battlefield_version: BATTLEFIELD_VERSION });
    await expect(pool.query("UPDATE trip SET battlefield_version = 2 WHERE id = $1", [tripId])).rejects.toThrow(/trip identity is immutable/);
  });

  it("(a) an open trip on battlefield version 2 with an uncommitted encounter is voided by the upgrade step; others are untouched", async () => {
    const old = await register();
    const oldTrip = await rideOut(old, 3);
    await ageTrip(oldTrip, 2);
    const current = await register();
    const currentTrip = await rideOut(current, 3);
    const packed = await register();
    await pack(packed, 2);

    const capBefore = (await call(old, "GET", `/me/caravans/${old.caravanId}/trip`)).json().cap;
    const voided = await voidTripsOfOtherGeometry(appRole);
    expect(voided).toEqual([oldTrip]);

    expect((await pool.query("SELECT state FROM caravan WHERE id = $1", [old.caravanId])).rows[0].state).toBe("in_town");
    expect((await pool.query("SELECT end_reason FROM trip WHERE id = $1", [oldTrip])).rows[0].end_reason).toBe("voided");
    expect(await voidedEvents(old.caravanId)).toEqual([expect.objectContaining({ cause: "upgrade", encountersSurvived: 0, credited: 0, tripCapRefunded: false })]);
    const after = (await call(old, "GET", `/me/caravans/${old.caravanId}/trip`)).json();
    expect(after.cap.available).toBe(capBefore.available); // the cap use is not refunded
    expect((await pool.query("SELECT 1 FROM wagon_manifest WHERE caravan_id = $1 AND closed_at IS NULL", [old.caravanId])).rowCount).toBe(0);

    // A trip on the current geometry and a caravan packed in town are untouched; a second pass finds nothing.
    expect((await pool.query("SELECT ended_at FROM trip WHERE id = $1", [currentTrip])).rows[0].ended_at).toBeNull();
    expect((await pool.query("SELECT state FROM caravan WHERE id = $1", [current.caravanId])).rows[0].state).toBe("on_trip");
    expect((await pool.query("SELECT state FROM caravan WHERE id = $1", [packed.caravanId])).rows[0].state).toBe("in_town");
    expect((await pool.query("SELECT 1 FROM wagon_manifest WHERE caravan_id = $1 AND closed_at IS NULL", [packed.caravanId])).rowCount).toBe(1);
    expect(await voidTripsOfOtherGeometry(appRole)).toEqual([]);
  });

  it("(b) a committed job stamped resolver version 9 is parked and its trip voided; the upgrade step leaves a trip with a job to that path", async () => {
    const d = await register();
    const tripId = await rideOut(d, 1);
    await commitFirstEncounter(d);
    const jobId = `encounter:${tripId}:1`;
    await asBeforeUpgrade([
      { sql: "UPDATE trip SET battlefield_version = 2 WHERE id = $1", params: [tripId] },
      { sql: "UPDATE resolution_job SET input = jsonb_set(input, '{resolverVersion}', '9'::jsonb) WHERE id = $1", params: [jobId] },
    ]);
    const bystander = await register();
    await pack(bystander, 2);

    // The upgrade step alone leaves it: a job is in flight.
    expect(await voidTripsOfOtherGeometry(appRole)).toEqual([]);
    expect((await pool.query("SELECT ended_at FROM trip WHERE id = $1", [tripId])).rows[0].ended_at).toBeNull();

    const parked = await parkOtherVersions(appRole, { workerId: "round-ring-test", afterParked: TRIP_SETTLE_HOOKS.afterParked });
    expect(parked.map((j) => j.id)).toEqual([jobId]);
    expect(await voidTripsOfOtherGeometry(appRole)).toEqual([]);

    expect((await pool.query("SELECT status FROM resolution_job WHERE id = $1", [jobId])).rows[0].status).toBe("parked");
    expect((await pool.query("SELECT end_reason FROM trip WHERE id = $1", [tripId])).rows[0].end_reason).toBe("voided");
    expect((await pool.query("SELECT state FROM caravan WHERE id = $1", [d.caravanId])).rows[0].state).toBe("in_town");
    expect(await voidedEvents(d.caravanId)).toEqual([expect.objectContaining({ cause: "parked", encountersSurvived: 0, tripCapRefunded: false })]);
    expect((await pool.query("SELECT 1 FROM wagon_manifest WHERE caravan_id = $1 AND closed_at IS NULL", [bystander.caravanId])).rowCount).toBe(1);
  });

  it("(c) a menu drawn under resolver version 9 answers 409 menu_stale", async () => {
    expect(RESOLVER_VERSION).toBeGreaterThan(9);
    const d = await register();
    const tripId = await rideOut(d, 2);
    const menu = (await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).json().menu;
    await asBeforeUpgrade([{ sql: "UPDATE encounter_candidates SET resolver_version = 9 WHERE trip_id = $1", params: [tripId] }]);
    const chosen = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: menu.candidates[0].candidateId });
    expect(chosen.statusCode).toBe(409);
    expect(chosen.json().error).toBe("menu_stale");
  });

  it("(d) a version-9 replay answers renderable:false with the old-square-camp reason; the post-fight summary stays readable", async () => {
    const d = await register();
    const jobId = "encounter:00000000-0000-4000-8050-000000000001:1";
    const input = { resolverVersion: 9, defenderAccountId: d.accountId, partyOwnerAccountId: d.accountId, tripId: "00000000-0000-4000-8050-000000000001", encounterIndex: 1, party: { partyId: "p", hash: "h", savedAt: "2026-01-01T00:00:00.000Z", composition: { units: [], siege: [] } }, formation: { posts: [] } };
    const result = { outcome: { kind: "caravan_held", depth: 0, endTick: 100, loot: 0 }, replay: { sha256: "x", tally: { raiders: 1, raidersFallen: 1, defenders: 1, defendersFallen: 0, fences: 0, fencesBroken: 0, traps: 0, trapsSprung: 0, trapsNullified: 0, coreReached: false, deepest: null } } };
    await pool.query("INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts, status, result, completed_at) VALUES ($1, 'encounter_resolution', $2, $3, $4::jsonb, 3, 'completed', $5::jsonb, now())", [jobId, d.accountId, d.caravanId, JSON.stringify(input), JSON.stringify(result)]);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("ALTER TABLE encounter_log DISABLE TRIGGER USER");
      await c.query(
        `INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log, raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash)
         VALUES ($1, $2, $3, $3, 9, 2, 'gzip', '\\x00'::bytea, 1, 1, 'x', 'x', 'x', 'x', 'x')`,
        [jobId, d.caravanId, d.accountId],
      );
      await c.query("ALTER TABLE encounter_log ENABLE TRIGGER USER");
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
    const res = await call(d, "GET", `/me/encounters/${encodeURIComponent(jobId)}/replay`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ renderable: false, reason: OLD_SQUARE_CAMP_REASON, resolverVersion: 9, log: null, outcome: { kind: "caravan_held" } });
    expect(OLD_SQUARE_CAMP_REASON).toBe("resolved on the old square camp");
  });
});

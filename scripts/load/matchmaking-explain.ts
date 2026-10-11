/**
 * PHASE-2 §36 — EXPLAIN plans for the matchmaking query on realistic data volumes, checked in under
 * apps/server/db/explain/. Re-run by a human whenever the query or its indexes change:
 *
 *   createdb -O caravan caravan_load            # any database whose name contains "load" (refused otherwise)
 *   pnpm --filter @caravan/server exec tsx ../../scripts/load/matchmaking-explain.ts \
 *     --db postgres://caravan:caravan@127.0.0.1:5432/caravan_load [--accounts 50000] [--active 2000] [--trips 25] [--heavy-trips 2000] [--write]
 *
 * DESTRUCTIVE to that database: it resets the schema (every migration down, then up, then
 * db/roles.sql), seeds the 96 authored parties and then, in bulk SQL as the owner role:
 *   - `--accounts` player accounts, each with a caravan, a siege and a living Reputation spread
 *     over 0..3999 and a standing party of 3-6 units (the band scan's population);
 *   - `--active` of them with `--trips` closed trips each, three encounters a trip, each a stored,
 *     CHOSEN menu of three candidates with party snapshots the size real ones are (~0.7 KB each);
 *   - one veteran account with `--heavy-trips` trips (the recent-opponent query's worst case).
 * Then ANALYZE, and EXPLAIN (ANALYZE, BUFFERS) of:
 *   1. POOL_SQL — the band scan (Reputation band ±600 at a 1000 centre, the linked-account
 *      exclusion as a 25-id `<> ALL` list: self + 5 recent opponents + 19 linked);
 *   2. RECENT_OPPONENTS_SQL for the veteran and for a typical active account, with the §36 index;
 *   3. the same with the §36 index dropped (inside a rolled-back transaction) and the pre-§36
 *      query text, to show what the index and the rewrite buy;
 *   4. AUTHORED_SERVED_SHARE_SQL (chunk 25's served-share window).
 * Each plan is printed; with --write it is also written to apps/server/db/explain/<name>.txt with
 * a header naming the volumes, the Postgres version and the date.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRoles, migrateReset } from "../../apps/server/src/db/migrate.js";
import { createPool } from "../../apps/server/src/db/pool.js";
import { seedAuthoredParties } from "../../apps/server/src/matchmaking/authored.js";
import { AUTHORED_SERVED_SHARE_SQL } from "../../apps/server/src/matchmaking/authoredShare.js";
import { REPUTATION_BAND_WIDTH_MAX } from "../../apps/server/src/matchmaking/band.js";
import { POOL_SQL, RECENT_OPPONENTS_SQL } from "../../apps/server/src/matchmaking/service.js";

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const num = (name: string, d: number): number => {
  const n = Number(arg(name, String(d)));
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};

const DB = arg("db", process.env["LOAD_DATABASE_URL"] ?? "");
const ACCOUNTS = num("accounts", 50_000);
const ACTIVE = Math.min(num("active", 2_000), ACCOUNTS - 1);
const TRIPS = num("trips", 25);
const HEAVY_TRIPS = num("heavy-trips", 2_000);
const WRITE = process.argv.includes("--write");
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/server/db/explain");

/** The recent-opponent query as it was before PHASE-2 §36 (for the comparison plan only). */
const PRE_36_RECENT_OPPONENTS_SQL = `SELECT c ->> 'partyId' AS party_id
       FROM encounter_candidates ec
       JOIN trip t ON t.id = ec.trip_id
       JOIN caravan cv ON cv.id = t.caravan_id
       CROSS JOIN LATERAL jsonb_array_elements(ec.candidates) c
      WHERE cv.account_id = $1 AND ec.chosen_at IS NOT NULL AND c ->> 'candidateId' = ec.chosen_candidate_id
      ORDER BY ec.chosen_at DESC, ec.trip_id, ec.encounter_index DESC
      LIMIT $2`;

if (!DB || !/load/i.test(new URL(DB).pathname)) {
  console.error("refusing: pass --db <owner-role URL of a database whose name contains 'load'> (this script resets its schema)");
  process.exit(2);
}

const pool = createPool(DB);
const t0 = Date.now();
const step = async (label: string, sql: string, params: unknown[] = []): Promise<void> => {
  const s = Date.now();
  await pool.query(sql, params);
  console.log(`  ${label}: ${((Date.now() - s) / 1000).toFixed(1)} s`);
};

try {
  console.log(`resetting ${new URL(DB).pathname.slice(1)} and seeding: ${ACCOUNTS} accounts, ${ACTIVE} active × ${TRIPS} trips × 3 encounters, 1 veteran × ${HEAVY_TRIPS} trips`);
  if ((await pool.query("SELECT to_regclass('account') AS t")).rows[0]?.t) await pool.query("DELETE FROM account");
  await pool.query("DROP TABLE IF EXISTS load_acct, load_car, load_trip");
  await migrateReset(pool);
  await applyRoles(pool);
  await seedAuthoredParties(pool);

  await step("accounts", `CREATE TABLE load_acct AS SELECT n, gen_random_uuid() AS id FROM generate_series(1, $1::integer) n`, [ACCOUNTS]);
  await step("account rows", `INSERT INTO account (id, username, password_hash, coin_storage_cap) SELECT id, 'load_' || n, 'x', 1000 FROM load_acct`);
  await step("caravans", `CREATE TABLE load_car AS SELECT n, id AS account_id, gen_random_uuid() AS caravan_id FROM load_acct`);
  await step("caravan rows", `INSERT INTO caravan (id, account_id, region_id, name) SELECT caravan_id, account_id, 'desert', 'Caravan ' || n FROM load_car`);
  // Reputation spread 0..3999; the siege pool is the one the band scan reads (account-level), living is per caravan.
  await step("siege reputation", `INSERT INTO pool_progress (pool, account_id, reputation) SELECT 'siege', id, (n * 37) % 4000 FROM load_acct`);
  await step("living reputation", `INSERT INTO pool_progress (pool, caravan_id, reputation) SELECT 'living', caravan_id, (n * 53) % 4000 FROM load_car`);
  await step(
    "standing parties",
    `INSERT INTO standing_party (account_id, composition)
     SELECT id, jsonb_build_object('v', 1, 'siege', jsonb_build_array('siege.battering_wagon'),
              'units', (SELECT jsonb_agg(jsonb_build_object('ref', gen_random_uuid()::text, 'stance', 'nearest', 'edge', 'north', 'cell', k)) FROM generate_series(1, 3 + n % 4) k))
       FROM load_acct`,
  );
  // Trips: the veteran (n = 1) and the active accounts (n = 2 .. ACTIVE + 1), all closed (banked).
  await step(
    "trips",
    `CREATE TABLE load_trip AS
     SELECT c.caravan_id, gen_random_uuid() AS trip_id, gen_random_uuid() AS manifest_id,
            now() - make_interval(mins => (k * 37 + c.n) % 500000) AS started_at
       FROM load_car c CROSS JOIN LATERAL generate_series(1, CASE WHEN c.n = 1 THEN $1::integer ELSE $2::integer END) k
      WHERE c.n <= $3::integer + 1`,
    [HEAVY_TRIPS, TRIPS, ACTIVE],
  );
  await step("manifest rows", `INSERT INTO wagon_manifest (id, caravan_id, packed, survivors, created_at, closed_at) SELECT manifest_id, caravan_id, '{"v":1}', '{"v":1}', started_at, started_at + interval '20 minutes' FROM load_trip`);
  await step("trip rows", `INSERT INTO trip (id, caravan_id, manifest_id, started_at, ended_at, end_reason) SELECT trip_id, caravan_id, manifest_id, started_at, started_at + interval '20 minutes', 'banked' FROM load_trip`);
  // Three encounters a trip; each a stored menu of three candidates sized like real ones (party snapshot + scout view).
  await step(
    "menus",
    `INSERT INTO encounter_candidates (trip_id, encounter_index, search_seq, seed, caravan_rating, centre, band_width_used, pool, excluded_party_ids, skipped_party_ids, candidates, searched_at_ms, band)
     SELECT t.trip_id, e, 1, e, 1000, 1000, 150, '[]', '[]', '[]',
            (SELECT jsonb_agg(jsonb_build_object(
                      'candidateId', md5(t.trip_id::text || e || j), 'partyId', gen_random_uuid()::text, 'rating', 900 + j * 50, 'authored', false,
                      'owner', jsonb_build_object('accountId', gen_random_uuid()::text, 'displayName', 'load_owner_' || j),
                      'snapshot', jsonb_build_object('partyId', gen_random_uuid()::text, 'hash', md5(t.trip_id::text || j), 'savedAt', '2026-10-01T00:00:00.000Z',
                        'composition', jsonb_build_object('v', 1, 'siege', jsonb_build_array('siege.battering_wagon'),
                          'units', (SELECT jsonb_agg(jsonb_build_object('ref', md5(t.trip_id::text || e || j || u), 'typeId', 'desert.dust_rider', 'level', 1 + u % 3, 'stance', 'nearest', 'edge', 'north', 'cell', u)) FROM generate_series(1, 5) u)))))
               FROM generate_series(1, 3) j),
            extract(epoch FROM t.started_at)::bigint * 1000, 3
       FROM load_trip t CROSS JOIN generate_series(1, 3) e`,
  );
  await step(
    "choices",
    `UPDATE encounter_candidates ec SET chosen_candidate_id = ec.candidates -> 0 ->> 'candidateId', chosen_at = t.started_at + make_interval(mins => ec.encounter_index * 5)
       FROM load_trip t WHERE t.trip_id = ec.trip_id`,
  );
  // A live database is autovacuumed: VACUUM sets the visibility map the index-only scans read.
  await step("vacuum analyze", "VACUUM ANALYZE");
  const counts = (
    await pool.query<{ accounts: string; parties: string; trips: string; menus: string; menu_mb: string }>(
      `SELECT (SELECT count(*) FROM account)::text AS accounts, (SELECT count(*) FROM standing_party)::text AS parties, (SELECT count(*) FROM trip)::text AS trips,
              (SELECT count(*) FROM encounter_candidates)::text AS menus, (pg_total_relation_size('encounter_candidates') / 1048576)::text AS menu_mb`,
    )
  ).rows[0]!;
  const version = (await pool.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]!.v;
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${counts.accounts} accounts, ${counts.parties} standing parties, ${counts.trips} trips, ${counts.menus} stored menus (${counts.menu_mb} MB)`);

  const ids = (await pool.query<{ id: string; n: number }>("SELECT id, n FROM load_acct WHERE n IN (1, 2) OR n BETWEEN 100 AND 123 ORDER BY n")).rows;
  const veteran = ids.find((r) => r.n === 1)!.id;
  const typical = ids.find((r) => r.n === 2)!.id;
  const exclusions = ids.filter((r) => r.n !== 1).map((r) => r.id).slice(0, 25);

  const header = (name: string, what: string): string =>
    [
      `-- ${name}: ${what}`,
      `-- PHASE-2 §36. Generated by scripts/load/matchmaking-explain.ts on ${new Date().toISOString().slice(0, 10)}, PostgreSQL ${version}.`,
      `-- Volumes: ${counts.accounts} accounts (${ACCOUNTS} players + the authored outfits), ${counts.parties} standing parties, ${counts.trips} trips,`,
      `--          ${counts.menus} stored chosen menus (${counts.menu_mb} MB); the veteran account has ${HEAVY_TRIPS} trips, a typical active one ${TRIPS}.`,
      `-- Timings are this machine's, from one run: read the plan's SHAPE (which index, where the Limit sits), not the milliseconds.`,
      "",
    ].join("\n");
  const plans: { name: string; what: string; text: string }[] = [];
  const explain = async (name: string, what: string, sql: string, params: unknown[], client: { query: typeof pool.query } = pool): Promise<void> => {
    const res = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    const text = res.rows.map((r) => r["QUERY PLAN"]).join("\n");
    plans.push({ name, what, text });
    console.log(`\n=== ${name}: ${what}\n${text}`);
  };

  // Warm the caches once so the plans read like a running server's.
  await pool.query(POOL_SQL, [exclusions, 1000, REPUTATION_BAND_WIDTH_MAX]);
  await pool.query(RECENT_OPPONENTS_SQL, [veteran, 5]);
  await explain("pool-scan", "the Reputation band scan (±600 at 1000) with a 25-account linked/recent exclusion list", POOL_SQL, [exclusions, 1000, REPUTATION_BAND_WIDTH_MAX]);
  await explain("recent-opponents-veteran", `the recent-opponent exclusion for the veteran (${HEAVY_TRIPS * 3} chosen menus), §36 query + index`, RECENT_OPPONENTS_SQL, [veteran, 5]);
  await explain("recent-opponents-typical", `the recent-opponent exclusion for a typical active account (${TRIPS * 3} chosen menus), §36 query + index`, RECENT_OPPONENTS_SQL, [typical, 5]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP INDEX encounter_candidates_chosen_recent_idx");
    await explain("recent-opponents-veteran-no-index", "the same for the veteran WITHOUT the §36 index (dropped in a rolled-back transaction)", RECENT_OPPONENTS_SQL, [veteran, 5], client);
    await explain("recent-opponents-veteran-pre36", "the pre-§36 query text for the veteran, without the §36 index (what shipped before)", PRE_36_RECENT_OPPONENTS_SQL, [veteran, 5], client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  await explain("authored-served-share", "chunk 25's served-share window (band 3, 40 rows)", AUTHORED_SERVED_SHARE_SQL, [3, 40]);

  if (WRITE) {
    mkdirSync(OUT, { recursive: true });
    for (const p of plans) writeFileSync(path.join(OUT, `${p.name}.txt`), `${header(p.name, p.what)}${p.text}\n`);
    console.log(`\nwrote ${plans.length} plans to ${path.relative(process.cwd(), OUT)}`);
  }
} finally {
  await pool.end();
}

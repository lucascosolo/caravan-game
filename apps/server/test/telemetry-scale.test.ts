/**
 * Chunk 32: the dashboard's aggregate queries are safe on a large ledger. A synthetic two-year
 * history (3 000 accounts, 30 000 trips with their encounters, jobs and menus, 300 000 ledger
 * events, 200 000 client events, refugee menus and pack purchases) is written straight into
 * the tables, ANALYZEd, and every windowed query is EXPLAINed over a 30-day window: no
 * sequential scan of any event-shaped table. The few "now" panels (ladder levels, pool
 * health, accounts near the cap) read one row per account / party / caravan and are allowed
 * to scan those state tables — O(players), never O(ledger).
 *
 * `pnpm --filter @caravan/server explain:analytics` reruns this with WRITE_EXPLAIN=1 and
 * writes the plans (COSTS OFF) to apps/server/db/explain/analytics/<query>.txt (the default
 * 30-day window) and <query>.<max>d.txt (ANALYTICS_MAX_WINDOW_DAYS, the widest the route
 * allows), which are checked in. Without WRITE_EXPLAIN the gate compares each live plan's scan
 * skeleton (sequential vs keyed scan of each event-shaped table) with the checked-in one (QA D6). The synthetic rows are inserted with session_replication_role = replica (the
 * owner role is a superuser locally and in CI), so the permanence triggers do not fire on
 * them; every reference is still consistent and the rows leave with their accounts.
 */
import { TUNABLES } from "@caravan/content";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as q from "../src/analytics/queries.js";
import { buildDashboard } from "../src/analytics/dashboard.js";
import { BAND_SPAN } from "../src/matchmaking/band.js";
import { ANALYTICS_DEFAULT_WINDOW_DAYS, ANALYTICS_MAX_WINDOW_DAYS, ANALYTICS_STATEMENT_TIMEOUT_MS } from "../src/analytics/tunables.js";
import { testPool, truncateAll } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../db/explain/analytics");
const pool = testPool();

const ACCOUNTS = 3000;
const TRIPS = 30_000;
const LEDGER = 300_000;
const CLIENT = 200_000;
const MENUS = 30_000;
const PURCHASES = 6000;
const DAYS = 730;

/** Event-shaped tables: a windowed query must never read these sequentially. */
const EVENT_TABLES = ["ledger_event", "trip", "trip_encounter", "resolution_job", "encounter_candidates", "refugee_menu", "pack_purchase", "analytics_client_event"];

const at = (expr: string): string => `now() - make_interval(days => (${expr}) % ${DAYS}, mins => (${expr}) % 1440)`;

async function seedSynthetic(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(
      `INSERT INTO account (id, username, password_hash, linked_at, coin_storage_cap, coin_balance, created_at)
       SELECT md5('tsyn-a' || n)::uuid, 'tsyn_' || n, 'x', now() - make_interval(days => n % ${DAYS}), 50000, (n * 17) % 50000, now() - make_interval(days => n % ${DAYS}) FROM generate_series(1, ${ACCOUNTS}) n`,
    );
    await c.query(`INSERT INTO caravan (id, account_id, region_id, name, created_at) SELECT md5('tsyn-c' || n)::uuid, md5('tsyn-a' || n)::uuid, 'desert', 'c', now() FROM generate_series(1, ${ACCOUNTS}) n`);
    await c.query(`INSERT INTO pool_progress (pool, caravan_id, reputation, ladder_level) SELECT 'living', md5('tsyn-c' || n)::uuid, 100 + (n * 37) % 3000, n % 21 FROM generate_series(1, ${ACCOUNTS}) n`);
    await c.query(`INSERT INTO pool_progress (pool, account_id, reputation, ladder_level) SELECT p, md5('tsyn-a' || n)::uuid, 100 + (n * 53) % 3000, n % 21 FROM generate_series(1, ${ACCOUNTS}) n, unnest(ARRAY['trap','siege']::pool[]) p`);
    await c.query(
      `INSERT INTO standing_party (account_id, composition) SELECT md5('tsyn-a' || n)::uuid,
         '{"v":1,"units":[{"ref":"00000000-0000-4000-8000-000000000000","stance":"nearest","edge":"north","cell":0}],"siege":[]}'::jsonb FROM generate_series(1, ${ACCOUNTS}) n`,
    );
    await c.query(
      `INSERT INTO account_analytics (account_id, analytics_id) SELECT md5('tsyn-a' || n)::uuid, md5('tsyn-x' || n)::uuid FROM generate_series(1, ${ACCOUNTS}) n`,
    );
    const acct = (t: string): string => `md5('tsyn-a' || ((${t}) % ${ACCOUNTS} + 1))::uuid`;
    const carv = (t: string): string => `md5('tsyn-c' || ((${t}) % ${ACCOUNTS} + 1))::uuid`;
    await c.query(`INSERT INTO wagon_manifest (id, caravan_id, packed, survivors, closed_at) SELECT md5('tsyn-m' || t)::uuid, ${carv("t")}, '{}', '{}', now() FROM generate_series(1, ${TRIPS}) t`);
    await c.query(
      `INSERT INTO trip (id, caravan_id, manifest_id, started_at, ended_at, end_reason)
       SELECT md5('tsyn-t' || t)::uuid, ${carv("t")}, md5('tsyn-m' || t)::uuid, ${at("t")}, ${at("t")} + interval '20 minutes',
              CASE t % 3 WHEN 0 THEN 'overrun' ELSE 'banked' END FROM generate_series(1, ${TRIPS}) t`,
    );
    await c.query(
      `INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, status, attempts, max_attempts, result, completed_at, created_at)
       SELECT 'tsyn:' || t, 'encounter_resolution', ${acct("t")}, ${carv("t")},
              jsonb_build_object('resolverVersion', 1, 'partyOwnerAccountId', ${acct("t + 7")},
                'formation', '{"fences":[{"ref":"f0","segment":0}],"traps":[{"ref":"t0","cell":{"x":1,"y":1}}],"posts":[{"ref":"u0","cell":{"x":2,"y":2},"stance":"guard"}]}'::jsonb,
                'survivors', '{"units":[{"ref":"u0","typeId":"desert.dust_rider","mergeLevel":1}],"traps":[{"ref":"t0","typeId":"trap.spike_pit"}],"fences":[{"ref":"f0","tierId":"fence.brush_pile","hp":300}]}'::jsonb,
                'party', '{"composition":{"units":[{"typeId":"desert.well_digger","mergeLevel":2}],"siege":[{"typeId":"siege.battering_wagon"}]}}'::jsonb),
              'completed', 1, 3, jsonb_build_object('outcome', jsonb_build_object('endTick', 600 + t % 3000, 'fences', jsonb_build_array(jsonb_build_object('ref', 'f0', 'hp', (t % 2) * 300)))), now(), now()
         FROM generate_series(1, ${TRIPS}) t`,
    );
    await c.query(
      `INSERT INTO trip_encounter (trip_id, encounter_index, job_id, outcome_kind, depth_fp, deaths, coin_accrued, party_owner_account_id, decision, decided_at, settled_at)
       SELECT md5('tsyn-t' || t)::uuid, 1, 'tsyn:' || t, CASE t % 3 WHEN 0 THEN 'caravan_overrun' ELSE 'caravan_held' END, 512, '[]', CASE t % 3 WHEN 0 THEN 0 ELSE 100 END,
              ${acct("t + 7")}, CASE t % 3 WHEN 0 THEN NULL ELSE 'banked' END, CASE t % 3 WHEN 0 THEN NULL ELSE now() END, ${at("t")} + interval '10 minutes'
         FROM generate_series(1, ${TRIPS}) t`,
    );
    await c.query(
      `INSERT INTO encounter_candidates (trip_id, encounter_index, search_seq, seed, caravan_rating, centre, band_width_used, pool, excluded_party_ids, skipped_party_ids, candidates, searched_at_ms, chosen_candidate_id, chosen_at, band)
       SELECT md5('tsyn-t' || t)::uuid, 1, 1, t, 1000 + t % 600, 850, 150, '[]', '[]', '[]', '[{"candidateId":"c1","owner":{"authored":false}}]', 0, 'c1', ${at("t")} + interval '5 minutes', t % 8
         FROM generate_series(1, ${TRIPS}) t`,
    );
    await c.query(
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload, occurred_at)
       SELECT k.type::ledger_event_type, ${acct("n")}, CASE WHEN k.type = 'trip_started' THEN ${carv("n")} END, 'tsyn:' || n, 0, k.payload, ${at("n")}
         FROM generate_series(1, ${LEDGER}) n
         CROSS JOIN LATERAL (SELECT (ARRAY['coin_earned','coin_spent','trip_started','ladder_progress_gained','unlock_node_purchased','coin_purchased','coin_transferred_to_party_owner','standing_party_saved'])[n % 8 + 1] AS type) t0
         CROSS JOIN LATERAL (SELECT t0.type, CASE t0.type
             WHEN 'coin_spent' THEN '{"amount":0,"reason":"merge","toLevel":2}'::jsonb
             WHEN 'trip_started' THEN '{"tripCap":{"availableAfter":1}}'::jsonb
             WHEN 'ladder_progress_gained' THEN '{"pool":"trap","pointsDelta":1,"levelsGained":0}'::jsonb
             WHEN 'unlock_node_purchased' THEN jsonb_build_object('pool', 'trap', 'nodeId', 'n' || n, 'cost', 1)
             WHEN 'standing_party_saved' THEN '{}'::jsonb
             ELSE '{"amount":0,"reason":"trickle"}'::jsonb END AS payload) k`,
    );
    await c.query(
      `INSERT INTO refugee_menu (caravan_id, sequence, origin, window_sequence, seed, pool_type_ids, offered_type_ids, generated_at_ms, window_opened_at_ms, created_at)
       SELECT ${carv("t")}, t / ${ACCOUNTS} + 1, 'free', t / ${ACCOUNTS} + 1, t, '[]', '[]', 0, 0, ${at("t")} FROM generate_series(1, ${MENUS}) t`,
    );
    await c.query(
      `INSERT INTO pack_purchase (account_id, week_index, tier, backend, sandbox_receipt, price_cents, contents, coin_requested, coin_credited, coin_discarded, causation_id, purchased_at, settled_at)
       SELECT ${acct("t")}, t / ${ACCOUNTS}, 1, 'sandbox_stub', 'r', 500, '[{"kind":"coin","amount":6000}]', 6000, 6000, 0, 'tsyn:p' || t, ${at("t")}, ${at("t")}
         FROM generate_series(1, ${PURCHASES}) t`,
    );
    await c.query(
      `INSERT INTO analytics_client_event (analytics_id, kind, screen, occurred_at, received_at)
       SELECT md5('tsyn-x' || (n % ${ACCOUNTS} + 1))::uuid, 'screen', (ARRAY['town','trail','party','webs','packs'])[n % 5 + 1], ${at("n")}, ${at("n")} FROM generate_series(1, ${CLIENT}) n`,
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
  await pool.query("ANALYZE");
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

const floorSpan = [TUNABLES.REPUTATION_FLOOR, BAND_SPAN];
/** The windows the gate holds at: the default, and the widest the route allows (QA D6). */
const WINDOWS = [ANALYTICS_DEFAULT_WINDOW_DAYS, ANALYTICS_MAX_WINDOW_DAYS] as const;
/** [name, sql, params, may seq-scan these state tables] over a `days` window. */
function cases(days: number): [string, string, unknown[], string[]][] {
  const ww = [new Date(Date.now() - days * 86_400_000), new Date()];
  const cohort = [new Date(Date.now() - 90 * 86_400_000), new Date()];
  const week = { from: new Date(Date.now() - 7 * 86_400_000), to: new Date() };
  return [
    ["trip-length", q.TRIP_LENGTH_SQL, ww, []],
    ["bank-vs-push", q.BANK_PUSH_SQL, ww, []],
    ["overrun-by-band", q.OVERRUN_BY_BAND_SQL, [...ww, ...floorSpan], []],
    ["defender-units", q.DEFENDER_UNITS_SQL, ww, []],
    ["attacker-units", q.ATTACKER_UNITS_SQL, ww, []],
    ["matchups", q.AFFINITY_MATCHUPS_SQL, [...ww, JSON.stringify(q.UNIT_AFFINITY)], []],
    ["merge-levels", q.MERGE_LEVELS_SQL, ww, []],
    ["fences", q.FENCES_SQL, ww, []],
    ["traps", q.TRAPS_SQL, ww, []],
    ["siege", q.SIEGE_SQL, ww, []],
    ["stances", q.STANCES_SQL, ww, []],
    ["slots", q.SLOTS_SQL, ww, []],
    ["tick-cap", q.TICK_CAP_SQL, [...ww, q.NEAR_TICK_CAP], []],
    ["spend-by-reason", q.SPEND_BY_REASON_SQL, ww, []],
    ["merge-by-day", q.MERGE_BY_DAY_SQL, ww, []],
    ["merge-by-level", q.MERGE_BY_LEVEL_SQL, ww, []],
    ["earn-by-source", q.EARN_BY_SOURCE_SQL, ww, []],
    ["trip-cap", q.TRIP_CAP_SQL, ww, []],
    ["grind-wall", q.GRIND_WALL_SQL, q.grindWallParams(week), []],
    ["ladder-gained", q.LADDER_GAINED_SQL, ww, []],
    ["unlocks", q.UNLOCKS_SQL, ww, []],
    ["refugees-by-day", q.REFUGEE_BY_DAY_SQL, ww, []],
    ["pack-funnel", q.PACK_FUNNEL_SQL, ww, ["account_analytics"]],
    ["pack-tiers", q.PACK_TIERS_SQL, ww, ["account_analytics"]],
    ["pack-buyers", q.PACK_BUYERS_SQL, ww, []],
    ["screens", q.SCREENS_SQL, ww, []],
    ["crashes", q.CRASHES_SQL, ww, []],
    ["sessions", q.SESSIONS_SQL, [...ww, 1_800_000], []],
    ["retention", q.RETENTION_SQL, [...cohort, [...q.ACTIVITY_EVENT_TYPES]], ["account_analytics"]],
    ["pool-served", q.POOL_SERVED_SQL, ww, []],
    // "Now" panels: one row per owner / party / caravan / account — O(players).
    ["near-cap", q.NEAR_CAP_SQL, [90], ["account"]],
    ["ladder-levels", q.LADDER_LEVELS_SQL, [], ["pool_progress", "caravan", "account"]],
    ["pool-parties", q.POOL_PARTIES_SQL, floorSpan, ["standing_party", "account", "pool_progress"]],
    ["pool-caravans", q.POOL_CARAVANS_SQL, floorSpan, ["pool_progress", "caravan", "account"]],
  ];
}

/** The plan file for a query at a window: `<name>.txt` (default window) / `<name>.<days>d.txt` (the widest). */
const planFile = (name: string, days: number): string => path.join(OUT, days === ANALYTICS_DEFAULT_WINDOW_DAYS ? `${name}.txt` : `${name}.${days}d.txt`);

/**
 * The plan's skeleton (QA D6): for each scan of an EVENT-shaped table, whether it is a
 * sequential scan or a keyed one (index, index-only or bitmap heap scan) — sorted, no
 * timestamps, no costs, no index names. Which keyed access path the planner picks flips with
 * stats (bitmap vs plain index scan; chunk 36 added a second chosen-menu index), and is not
 * the regression the gate is for; a keyed read turning into a full scan is. The O(players)
 * state tables may be read either way.
 */
function scanSkeleton(planText: string): string[] {
  const out: string[] = [];
  for (const line of planText.split("\n")) {
    const m = /(Seq Scan|Index Only Scan Backward|Index Only Scan|Index Scan Backward|Index Scan|Bitmap Heap Scan)(?: using \S+)? on (\S+)/.exec(line);
    if (m && EVENT_TABLES.includes(m[2]!)) out.push(`${m[1] === "Seq Scan" ? "seq" : "keyed"} ${m[2]}`);
  }
  return out.sort();
}

beforeAll(async () => {
  await truncateAll(pool);
  await seedSynthetic();
}, 300_000);
afterAll(async () => {
  await truncateAll(pool);
  await pool.end();
}, 300_000);

describe("chunk 32 at scale: every dashboard query reads through an index, not the ledger", () => {
  it("covers every SQL the dashboard runs", () => {
    const exported = Object.entries(q).filter(([k, v]) => k.endsWith("_SQL") && typeof v === "string").map(([, v]) => v as string);
    const covered = new Set(cases(30).map((c) => c[1]));
    expect(exported.filter((s) => !covered.has(s))).toEqual([]);
  });

  it(`EXPLAIN over a two-year synthetic history at ${WINDOWS.join(" and ")} days: no sequential scan of an event-shaped table, and the live plan's scans equal the checked-in plan's`, async () => {
    const failures: string[] = [];
    if (process.env["WRITE_EXPLAIN"] === "1") mkdirSync(OUT, { recursive: true });
    for (const days of WINDOWS) {
      for (const [name, sql, params, allowed] of cases(days)) {
        const json = await pool.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
        const all = nodes(json.rows[0]!["QUERY PLAN"][0]!.Plan);
        for (const n of all) {
          if (n["Node Type"] === "Seq Scan" && n["Relation Name"] && !allowed.includes(n["Relation Name"])) failures.push(`${name}@${days}d: Seq Scan on ${n["Relation Name"]}`);
          if (n["Node Type"] === "Seq Scan" && n["Relation Name"] && EVENT_TABLES.includes(n["Relation Name"])) failures.push(`${name}@${days}d: Seq Scan on event table ${n["Relation Name"]}`);
          // An index scan with no index condition walks the whole index: as bad as a seq scan.
          if ((n["Node Type"] === "Index Scan" || n["Node Type"] === "Index Only Scan") && n["Relation Name"] && EVENT_TABLES.includes(n["Relation Name"]) && !n["Index Cond"]) {
            failures.push(`${name}@${days}d: full ${n["Node Type"]} of ${n["Relation Name"]} (${n["Index Name"]}) with no index condition`);
          }
        }
        const text = (await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF) ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        const file = planFile(name, days);
        if (process.env["WRITE_EXPLAIN"] === "1") {
          const body = `-- chunk 32: ${name} over the synthetic history in test/telemetry-scale.test.ts (${days}-day window)\n${text}\n`;
          if (!existsSync(file) || readFileSync(file, "utf8") !== body) writeFileSync(file, body);
        } else if (!existsSync(file)) {
          failures.push(`${name}@${days}d: no checked-in plan ${path.basename(file)}`);
        } else {
          const want = scanSkeleton(readFileSync(file, "utf8"));
          const got = scanSkeleton(text);
          if (want.join("|") !== got.join("|")) failures.push(`${name}@${days}d: scans changed — checked in [${want.join("; ")}], live [${got.join("; ")}]`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it("the whole dashboard over the synthetic history builds in bounded time", async () => {
    const t0 = Date.now();
    const d = await buildDashboard(pool, { nowMs: Date.now(), days: ANALYTICS_MAX_WINDOW_DAYS });
    const ms = Date.now() - t0;
    expect(d.panels.bankVsPush[0]!.settled).toBeGreaterThan(0);
    expect(d.panels.poolHealth.bands.length).toBeGreaterThan(0);
    console.info(`chunk 32 scale: ${ANALYTICS_MAX_WINDOW_DAYS}-day dashboard over ${LEDGER} ledger events / ${TRIPS} trips built in ${ms} ms`);
    // Every statement also runs under ANALYTICS_STATEMENT_TIMEOUT_MS; the whole build stays well inside it here.
    expect(ms).toBeLessThan(ANALYTICS_STATEMENT_TIMEOUT_MS);
  }, 60_000);
});

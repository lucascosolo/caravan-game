/**
 * PHASE-2 §36 — job-queue load test at 100× the expected launch concurrency, with the REAL
 * resolver, the real worker (jobs/worker.ts: lease, one completion transaction with the ledger
 * events, the stored replay and the retention prune, then the trip loop's settle) and Postgres.
 * Re-run by a human; NOT part of `pnpm test` / CI (minutes, and it resets a database):
 *
 *   createdb -O caravan caravan_load          # any database whose name contains "load" (refused otherwise)
 *   pnpm load:queue -- --db postgres://caravan:caravan@127.0.0.1:5432/caravan_load \
 *     [--burst 10000] [--burst-parties 1] [--trips 500] [--processes 4] [--loops 2] [--profile] [--strict]
 *
 * Exit status (QA-36 D2): non-zero only when a CORRECTNESS check fails. The throughput target is
 * reported as MET / NOT MET with the host's load average; `--strict` (a dedicated host only) makes
 * a missed target fail the run too.
 *   (= pnpm --filter @caravan/server exec tsx ../../scripts/load/queue-load.ts …)
 *
 * ASSUMED LAUNCH CONCURRENCY (no live data exists yet; revisit with chunk 32's telemetry):
 * 100 trips in progress at the launch peak — a play-test/soft-launch cohort of a few hundred
 * daily players, a trip lasting ~6 minutes of arranging and committing 3-5 encounters, so about
 * one commit per trip per ~90 s: ~1.1 commits/s arriving. 100× that is 10 000 concurrent trips
 * and ~110 commits/s. THROUGHPUT TARGET: the queue resolves ≥ 110 encounters/s sustained on one
 * 4-core host running the server, the workers and Postgres — so 100× launch never builds a
 * backlog — and a 10 000-encounter burst (every one of those trips committing at once, the
 * worst case) drains completely, each job exactly once, nothing parked.
 *
 * Two phases, each checked, then the numbers:
 *   A. REAL TRIPS, concurrently: `--trips` defenders (HTTP, through the app as the DML-only app
 *      role) each start a trip, search, choose, arrange and commit encounter 1 at the same time;
 *      the workers resolve them with the trip loop's settle hooks. Checks: every job completed
 *      once, every trip settled (its manifest folded one encounter), nothing parked.
 *   B. THE 100× BURST — ONE STANDING PARTY SERVED INTO EVERY ENCOUNTER (chunk 02's case): `--burst`
 *      encounter jobs enqueued concurrently against the same party snapshot, spread over phase
 *      A's defenders and their committed circles, then drained by `--processes` worker processes
 *      × `--loops` drain loops each. Checks: every job completed exactly once (attempts = 1), 2
 *      ledger events per job, nothing parked, the party row byte-identical before and after, and
 *      every job with identical inputs produced the byte-identical log (same sha256) — the
 *      outcome does not depend on concurrency, ordering or which worker ran it.
 * Reported: enqueue rate, drain throughput (jobs/s), commit → resolved latency (database clock:
 * completed_at − created_at; p50 / p95 / p99 / max), worker CPU per job, stored log sizes.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { buildApp } from "../../apps/server/src/app.js";
import { applyRoles, migrateReset } from "../../apps/server/src/db/migrate.js";
import { createPool, withTransaction } from "../../apps/server/src/db/pool.js";
import { DEFAULT_HANDLERS, enqueueEncounterResolution } from "../../apps/server/src/jobs/handlers/encounterResolution.js";
import { snapshotStandingParty } from "../../apps/server/src/jobs/snapshots.js";
import { drain } from "../../apps/server/src/jobs/worker.js";
import type { JsonObject } from "../../apps/server/src/ledger/events.js";
import { seedAuthoredParties } from "../../apps/server/src/matchmaking/authored.js";
import { createUnitInstance } from "../../apps/server/src/repo/unitInstances.js";
import { TRIP_SETTLE_HOOKS } from "../../apps/server/src/trip/service.js";
import { verifyProjection } from "../../apps/server/src/ledger/projection.js";
import { TUNABLES } from "../../packages/content/src/index.js";
import { cpus, loadavg } from "node:os";

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const num = (name: string, d: number): number => {
  const n = Number(arg(name, String(d)));
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};

/** The DML-only app role on the same database (what the server runs as). */
function appRoleUrl(ownerUrl: string): string {
  const u = new URL(ownerUrl);
  u.username = "caravan_app";
  u.password = process.env["LOAD_APP_DB_PASSWORD"] ?? "caravan_app";
  return u.toString();
}

// ─── worker process ────────────────────────────────────────────────────────────────────────
// Long-lived: started before phase A, drains continuously (a 25 ms nap when the queue is empty),
// with the trip loop's settle hooks in phase A and none in phase B (its jobs have no trip),
// until told to stop. On "report" it sends what it completed and the CPU it used since the last.
if (process.argv.includes("--worker")) {
  // --profile: wall time per SQL statement (by its first words) and in the handler, to find the bottleneck.
  const profile = new Map<string, { n: number; ms: number }>();
  const note = (key: string, ms: number): void => {
    const e = profile.get(key) ?? { n: 0, ms: 0 };
    e.n++;
    e.ms += ms;
    profile.set(key, e);
  };
  if (process.argv.includes("--profile")) {
    // pg is the server's dependency, not the repo root's: resolve it from apps/server.
    const pgMod = createRequire(new URL("../../apps/server/package.json", import.meta.url))("pg") as typeof import("pg");
    const orig = pgMod.Client.prototype.query as (...a: unknown[]) => Promise<unknown>;
    pgMod.Client.prototype.query = function (this: unknown, ...a: unknown[]) {
      const text = typeof a[0] === "string" ? a[0] : ((a[0] as { text?: string })?.text ?? "?");
      const key = text.replace(/\s+/g, " ").trim().slice(0, 60);
      const t0 = performance.now();
      const r = orig.apply(this, a);
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(() => note(key, performance.now() - t0), () => note(key, performance.now() - t0));
      return r;
    } as never;
    for (const [k, h] of Object.entries(DEFAULT_HANDLERS)) {
      (DEFAULT_HANDLERS as Record<string, typeof h>)[k] = ((job: Parameters<typeof h>[0]) => {
        const t0 = performance.now();
        try {
          return h(job);
        } finally {
          note("(handler: resolve + encode + hash)", performance.now() - t0);
        }
      }) as typeof h;
    }
  }
  const pool = createPool(appRoleUrl(arg("db", "")));
  pool.options.max = num("loops", 2) + 2;
  const id = `load:${arg("id", "0")}`;
  let mode: "trip" | "none" = "trip";
  let stopping = false;
  let cpu0 = process.cpuUsage();
  let done = 0;
  let errors: string[] = [];
  process.on("message", (m: { cmd: string; mode?: "trip" | "none" }) => {
    if (m.cmd === "mode" && m.mode) mode = m.mode;
    else if (m.cmd === "report") {
      const cpu = process.cpuUsage(cpu0);
      const top = [...profile.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12).map(([k, v]) => ({ k, n: v.n, ms: Math.round(v.ms) }));
      profile.clear();
      process.send?.({ kind: "report", done, cpuMs: (cpu.user + cpu.system) / 1000, errors: errors.slice(0, 5), errorCount: errors.length, top });
      cpu0 = process.cpuUsage();
      done = 0;
      errors = [];
    } else if (m.cmd === "stop") stopping = true;
  });
  const loop = async (k: number): Promise<void> => {
    while (!stopping) {
      const hooks = mode === "trip" ? TRIP_SETTLE_HOOKS : {};
      const out = await drain(pool, { workerId: `${id}:${k}`, handlers: DEFAULT_HANDLERS, ...hooks, onHookError: (err) => errors.push(String(err)) });
      for (const o of out) {
        if (o.kind === "completed") done++;
        else if (o.kind !== "idle") errors.push(`${o.kind}: ${"error" in o ? String(o.error) : ""}`);
      }
      if (out.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
  };
  process.send?.({ kind: "ready" });
  await Promise.all(Array.from({ length: num("loops", 2) }, (_, k) => loop(k)));
  await pool.end();
  process.exit(0);
}

// ─── driver ────────────────────────────────────────────────────────────────────────────────
const DB = arg("db", process.env["LOAD_DATABASE_URL"] ?? "");
if (!DB || !/load/i.test(new URL(DB).pathname)) {
  console.error("refusing: pass --db <owner-role URL of a database whose name contains 'load'> (this script resets its schema)");
  process.exit(2);
}
const BURST = num("burst", 10_000);
/** Phase B's parties: 1 is chunk 02's "one party into many encounters" case; more spreads the burst (the party owner's account lock is per owner). */
const BURST_PARTIES = num("burst-parties", 1);
const TRIPS = num("trips", 500);
const PROCESSES = num("processes", 4);
const LOOPS = num("loops", 2);
const PROFILE = process.argv.includes("--profile");
/** QA-36 D2: on a dedicated host, a missed throughput target fails the run too. Elsewhere it is REPORTED (MET / NOT MET with the load average). */
const STRICT = process.argv.includes("--strict");
const LAUNCH_TRIPS = 100;
const LAUNCH_COMMITS_PER_S = 1.1;
const TARGET_JOBS_PER_S = Math.round(100 * LAUNCH_COMMITS_PER_S);

const owner = createPool(DB);
const appRole = createPool(appRoleUrl(DB));
appRole.options.max = 40;

/** Run `f` over `items` with at most `n` in flight. */
async function limited<T, R>(items: readonly T[], n: number, f: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]!, i);
      }
    }),
  );
  return out;
}

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

type WorkerReport = { done: number; cpuMs: number; errors: string[]; errorCount: number; top?: { k: string; n: number; ms: number }[] };
const workers: ChildProcess[] = [];

async function startWorkers(): Promise<void> {
  await Promise.all(
    Array.from(
      { length: PROCESSES },
      (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = fork(fileURLToPath(import.meta.url), ["--worker", "--db", DB, "--id", String(i), "--loops", String(LOOPS), ...(PROFILE ? ["--profile"] : [])], { execArgv: process.execArgv });
          workers.push(child);
          child.once("message", () => resolve());
          child.once("exit", (code) => (code === 0 ? undefined : reject(new Error(`worker ${i} exited ${code}`))));
        }),
    ),
  );
}

function setMode(mode: "trip" | "none"): void {
  for (const w of workers) w.send({ cmd: "mode", mode });
}

async function report(): Promise<WorkerReport> {
  const rs = await Promise.all(
    workers.map(
      (w) =>
        new Promise<WorkerReport>((resolve) => {
          w.once("message", (m) => resolve(m as WorkerReport));
          w.send({ cmd: "report" });
        }),
    ),
  );
  if (PROFILE) {
    const sum = new Map<string, { n: number; ms: number }>();
    for (const r of rs) for (const e of r.top ?? []) {
      const x = sum.get(e.k) ?? { n: 0, ms: 0 };
      x.n += e.n;
      x.ms += e.ms;
      sum.set(e.k, x);
    }
    const done = rs.reduce((a, r) => a + r.done, 0);
    if (done > 0) console.log(`  profile (wall ms per job, summed over workers): ${[...sum.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10).map(([k, v]) => `${(v.ms / done).toFixed(1)} ${k} [${v.n}]`).join("\n    ")}`);
  }
  return { done: rs.reduce((a, r) => a + r.done, 0), cpuMs: rs.reduce((a, r) => a + r.cpuMs, 0), errorCount: rs.reduce((a, r) => a + r.errorCount, 0), errors: rs.flatMap((r) => r.errors).slice(0, 5) };
}

async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => new Promise<void>((resolve) => (w.exitCode !== null ? resolve() : (w.once("exit", () => resolve()), w.send({ cmd: "stop" }))))));
}

/** Wait until none of `ids` is queued or leased. */
async function settled(ids: readonly string[]): Promise<void> {
  for (;;) {
    const r = await owner.query<{ n: string }>("SELECT count(*)::text AS n FROM resolution_job WHERE id = ANY($1) AND status IN ('queued', 'leased')", [ids]);
    if (Number(r.rows[0]!.n) === 0) return;
    await new Promise((res) => setTimeout(res, 100));
  }
}

/** Commit → resolved per job, and the span from the first commit to the last resolution (database clock). */
async function latency(jobIds: readonly string[]): Promise<{ p50: number; p95: number; p99: number; max: number; spanMs: number }> {
  const r = await owner.query<{ ms: number; c: Date; d: Date }>(
    "SELECT EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000 AS ms, created_at AS c, completed_at AS d FROM resolution_job WHERE id = ANY($1) AND status = 'completed'",
    [jobIds],
  );
  const ms = r.rows.map((x) => Number(x.ms)).sort((a, b) => a - b);
  const first = Math.min(...r.rows.map((x) => x.c.getTime()));
  const last = Math.max(...r.rows.map((x) => x.d.getTime()));
  return { p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: ms[ms.length - 1] ?? 0, spanMs: last - first };
}

const check = (ok: boolean, what: string): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

try {
  console.log(`queue load test — ${BURST} burst jobs, ${TRIPS} concurrent real trips, ${PROCESSES} worker processes × ${LOOPS} loops; ${new URL(DB).pathname.slice(1)}`);
  console.log(`assumed launch concurrency: ${LAUNCH_TRIPS} trips in progress, ~${LAUNCH_COMMITS_PER_S} commits/s; 100× = ${LAUNCH_TRIPS * 100} trips, target ≥ ${TARGET_JOBS_PER_S} resolutions/s`);
  if ((await owner.query("SELECT to_regclass('account') AS t")).rows[0]?.t) await owner.query("DELETE FROM account");
  await migrateReset(owner);
  await applyRoles(owner);
  await seedAuthoredParties(owner);
  // Chunk 30's auth rate limits are off here: hundreds of registrations from one address are the setup, not the load under test.
  const app = await buildApp({ db: appRole, rateLimits: null });
  type Player = { token: string; accountId: string; caravanId: string; units: string[] };
  const inject = async (p: Player | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: p ? { authorization: `Bearer ${p.token}` } : {}, ...(payload === undefined ? {} : { payload: payload as never }) });
    if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
    return res;
  };
  const register = async (prefix: string): Promise<Player> => {
    const b = (await inject(null, "POST", "/auth/register", { username: `${prefix}_${randomUUID().slice(0, 8)}`, password: "correct horse battery", region: "desert" })).json();
    return { token: b.token, accountId: b.account.id, caravanId: b.caravan.id, units: [] };
  };
  const give = async (p: Player, n: number, typeId: string, level: number) => {
    for (let i = 0; i < n; i++) p.units.push((await createUnitInstance(owner, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel: level })).id);
  };
  const EDGES = ["north", "east", "south", "west"] as const;
  const { entryBand, RING_SEGMENTS } = await import("../../packages/circle/src/index.js");

  // ── setup: live party owners around the defenders' band, and the defenders ──
  let t = Date.now();
  const owners = await limited(Array.from({ length: 24 }, (_, i) => i), 8, async (i) => {
    const o = await register("load_owner");
    await give(o, 6, i % 2 ? "desert.dust_rider" : "desert.well_digger", 1 + (i % 3));
    await inject(o, "PUT", "/me/party", { v: 1, units: o.units.map((ref, k) => ({ ref, stance: "nearest", edge: EDGES[k % 4], cell: entryBand(EDGES[k % 4]!)[k]! })), siege: ["siege.battering_wagon"] });
    await owner.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [o.accountId, 900 + i * 10]);
    return o;
  });
  const defenders = await limited(Array.from({ length: TRIPS }, (_, i) => i), 16, async (i) => {
    const d = await register("load_def");
    await give(d, 2, "desert.dust_rider", 1 + (i % 4));
    await give(d, 2, "desert.well_digger", 1 + ((i + 1) % 4));
    await owner.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [d.caravanId]);
    await inject(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: d.units, traps: ["trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 8 + (i % 13) } });
    return d;
  });
  console.log(`setup: ${owners.length} party owners, ${defenders.length} defenders with packed manifests in ${((Date.now() - t) / 1000).toFixed(1)} s`);

  // ── phase A: every defender rides out and commits encounter 1 at once ──
  await startWorkers();
  setMode("trip");
  await report();
  console.log(`\nphase A: ${TRIPS} real trips commit encounter 1 concurrently (HTTP, app role) while ${PROCESSES}×${LOOPS} workers resolve + settle`);
  t = Date.now();
  const formations: { d: Player; formation: JsonObject; survivors: JsonObject; partyLootFull: number }[] = [];
  const phaseA = await limited(defenders, 64, async (d, i) => {
    await inject(d, "POST", `/me/caravans/${d.caravanId}/trip/start`);
    const menu = (await inject(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`)).json().menu.candidates as { candidateId: string }[];
    await inject(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: menu[i % menu.length]!.candidateId });
    const m = (await inject(d, "GET", `/caravans/${d.caravanId}/manifest`)).json().manifest.survivors as { units: { ref: string }[]; traps: { ref: string }[]; fences: { ref: string }[] };
    const formation = {
      v: 2,
      fences: m.fences.map((f, k) => ({ ref: f.ref, segment: (k * 3 + i) % RING_SEGMENTS.length })),
      traps: m.traps.map((tr, k) => ({ ref: tr.ref, cell: [{ x: 15, y: 9 }, { x: 9, y: 15 }][k]! })),
      posts: m.units.map((u, k) => ({ ref: u.ref, cell: [{ x: 15, y: 13 }, { x: 13, y: 15 }, { x: 17, y: 15 }, { x: 15, y: 17 }][k]!, stance: (["hold", "guard"] as const)[(i + k) % 2] })),
    };
    await inject(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, formation);
    const c = (await inject(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/1/commit`)).json();
    const job = (await owner.query<{ input: { survivors: JsonObject; formation: JsonObject; partyLootFull: number } }>("SELECT input FROM resolution_job WHERE id = $1", [c.jobId])).rows[0]!;
    formations.push({ d, formation: job.input.formation, survivors: job.input.survivors, partyLootFull: job.input.partyLootFull });
    return c.jobId as string;
  });
  const commitA = Date.now() - t;
  console.log(`  ${phaseA.length} trips started, searched, chose, arranged and committed in ${(commitA / 1000).toFixed(1)} s (${((phaseA.length * 1000) / commitA).toFixed(0)} commits/s through HTTP, 64 in flight)`);
  await settled(phaseA);
  const wa = await report();
  const la = await latency(phaseA);
  // QA-36 D2: "settled" is scoped to phase A's own jobs, and to a SETTLED outcome: a trip_encounter
  // row per job whose kind is the job's own (a trip voided by a parked job has none).
  const sa = (await owner.query<{ completed: string; parked: string; attempts: string; settled: string }>(
    `SELECT count(*) FILTER (WHERE status = 'completed')::text AS completed, count(*) FILTER (WHERE status = 'parked')::text AS parked, sum(attempts)::text AS attempts,
            (SELECT count(*) FROM trip_encounter te JOIN resolution_job j ON j.id = te.job_id
              WHERE te.job_id = ANY($1) AND te.outcome_kind = j.result -> 'outcome' ->> 'kind')::text AS settled
       FROM resolution_job WHERE id = ANY($1)`,
    [phaseA],
  )).rows[0]!;
  console.log(`  first commit → last resolution ${(la.spanMs / 1000).toFixed(1)} s (${((Number(sa.completed) * 1000) / la.spanMs).toFixed(0)} jobs/s, bounded by the commit rate); commit→resolved p50 ${la.p50.toFixed(0)} ms, p95 ${la.p95.toFixed(0)} ms, p99 ${la.p99.toFixed(0)} ms, max ${la.max.toFixed(0)} ms; worker CPU ${(wa.cpuMs / Math.max(1, wa.done)).toFixed(1)} ms/job`);
  check(Number(sa.completed) === TRIPS && Number(sa.parked) === 0 && Number(sa.attempts) === TRIPS, `phase A: ${sa.completed}/${TRIPS} completed, ${sa.parked} parked, ${sa.attempts} leases (one each)`);
  check(Number(sa.settled) === TRIPS, `phase A: every trip settled its encounter with the job's own outcome (${sa.settled} trip_encounter rows of ${TRIPS})`);
  check(wa.errorCount === 0, `phase A: no worker errors${wa.errorCount ? ` (${wa.errorCount}: ${wa.errors.join(" | ")})` : ""}`);

  // ── phase B: the 100× burst, all against ONE standing party ──
  setMode("none");
  // QA-36 D2: retention under load — the owner lowers the size budget for phase B, so every
  // completion compacts its caravan's logs (the §36 prune, under its savepoint) while the other
  // workers complete, and a concurrent sweep loop runs beside them. Restored afterwards.
  await owner.query("UPDATE encounter_log_retention SET size_budget_bytes = 1024");
  let sweeping = true;
  let swept = 0;
  const sweepErrors: string[] = [];
  const sweeper = (async () => {
    while (sweeping) {
      try {
        swept += Number((await appRole.query<{ n: number }>("SELECT encounter_log_retention_sweep(500) AS n")).rows[0]!.n);
      } catch (err) {
        sweepErrors.push(String(err));
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  const stars = owners.slice(0, Math.min(BURST_PARTIES, owners.length));
  console.log(`\nphase B: ${BURST} encounters against ${stars.length === 1 ? "ONE standing party" : `${stars.length} standing parties`}, enqueued concurrently (48 in flight) while ${PROCESSES}×${LOOPS} workers drain`);
  const partyBytes = async () => (await owner.query<{ j: string }>("SELECT string_agg(row_to_json(sp)::text, '|' ORDER BY account_id) AS j FROM standing_party sp WHERE account_id = ANY($1)", [stars.map((x) => x.accountId)])).rows[0]!.j;
  const before = await partyBytes();
  const snapshots = await Promise.all(stars.map((x) => snapshotStandingParty(owner, x.accountId)));
  t = Date.now();
  const burstIds = await limited(Array.from({ length: BURST }, (_, i) => i), 48, async (i) => {
    const f = formations[i % formations.length]!;
    const { job } = await withTransaction(appRole, (c) =>
      enqueueEncounterResolution(c, {
        tripId: randomUUID(),
        encounterIndex: 1,
        defenderAccountId: f.d.accountId,
        defenderCaravanId: f.d.caravanId,
        partyOwnerAccountId: stars[i % stars.length]!.accountId,
        formation: f.formation,
        survivors: f.survivors,
        partyLootFull: f.partyLootFull,
        party: snapshots[i % stars.length]!,
      }),
    );
    return job.id;
  });
  const enqueueMs = Date.now() - t;
  console.log(`  enqueued ${burstIds.length} in ${(enqueueMs / 1000).toFixed(1)} s (${((burstIds.length * 1000) / enqueueMs).toFixed(0)} enqueues/s, 48 in flight)`);
  await settled(burstIds);
  sweeping = false;
  await sweeper;
  await owner.query("UPDATE encounter_log_retention SET size_budget_bytes = $1", [TUNABLES.LOG_SIZE_BUDGET_BYTES]);
  const wb = await report();
  const lb = await latency(burstIds);
  const sb = (await owner.query<{ completed: string; parked: string; attempts: string; events: string; logs: string; distinct_logs: string; compacted: string; avg_stored: string; max_stored: string; groups: string; mixed: string }>(
    `WITH j AS (SELECT id, status, attempts FROM resolution_job WHERE id = ANY($1)),
          -- A job's log is either still stored or compacted to its summary (which keeps its sha256 and size).
          stored AS (SELECT job_id, stored_bytes, log_sha256, false AS compacted FROM encounter_log WHERE job_id = ANY($1)
                     UNION ALL SELECT job_id, stored_bytes, log_sha256, true FROM encounter_log_summary WHERE job_id = ANY($1)),
          l AS (SELECT l.job_id, l.stored_bytes, l.log_sha256, l.compacted, (r.input -> 'formation')::text || (r.input -> 'survivors')::text || (r.input -> 'party')::text AS inputs
                  FROM stored l JOIN resolution_job r ON r.id = l.job_id),
          g AS (SELECT inputs, count(DISTINCT log_sha256) AS shas FROM l GROUP BY inputs)
     SELECT (SELECT count(*) FROM j WHERE status = 'completed')::text AS completed, (SELECT count(*) FROM j WHERE status = 'parked')::text AS parked,
            (SELECT sum(attempts) FROM j)::text AS attempts,
            (SELECT count(*) FROM ledger_event WHERE causation_id = ANY($1))::text AS events,
            (SELECT count(*) FROM l)::text AS logs, (SELECT count(DISTINCT job_id) FROM l)::text AS distinct_logs, (SELECT count(*) FROM l WHERE compacted)::text AS compacted, (SELECT round(avg(stored_bytes)) FROM l)::text AS avg_stored, (SELECT max(stored_bytes) FROM l)::text AS max_stored,
            (SELECT count(*) FROM g)::text AS groups, (SELECT count(*) FROM g WHERE shas > 1)::text AS mixed`,
    [burstIds],
  )).rows[0]!;
  const after = await partyBytes();
  const jobsPerS = (Number(sb.completed) * 1000) / lb.spanMs;
  console.log(`  first enqueue → last resolution ${(lb.spanMs / 1000).toFixed(1)} s: ${jobsPerS.toFixed(0)} jobs/s; enqueue→resolved p50 ${(lb.p50 / 1000).toFixed(1)} s, p95 ${(lb.p95 / 1000).toFixed(1)} s, p99 ${(lb.p99 / 1000).toFixed(1)} s, max ${(lb.max / 1000).toFixed(1)} s (a burst: the last job waits for all before it)`);
  console.log(`  worker CPU ${(wb.cpuMs / Math.max(1, wb.done)).toFixed(1)} ms/job (resolve + gzip + JSON + driver); stored logs avg ${sb.avg_stored} B, max ${sb.max_stored} B gzip`);
  check(Number(sb.completed) === BURST && Number(sb.parked) === 0, `phase B: ${sb.completed}/${BURST} completed, ${sb.parked} parked`);
  check(Number(sb.attempts) === BURST, `phase B: every job leased exactly once (${sb.attempts} leases)`);
  check(Number(sb.events) === 2 * BURST, `phase B: exactly two ledger events per job (${sb.events})`);
  check(Number(sb.logs) === BURST && Number(sb.distinct_logs) === BURST, `phase B: exactly one log or summary per job (${sb.logs}; ${sb.compacted} compacted under load; the concurrent sweep compacted ${swept} logs, phase A's included)`);
  check(Number(sb.compacted) > 0, `phase B: compaction ran concurrently with completions (${sb.compacted} summaries)`);
  check(sweepErrors.length === 0, `phase B: the concurrent sweep raised nothing${sweepErrors.length ? ` (${sweepErrors.length}: ${sweepErrors.slice(0, 2).join(" | ")})` : ""}`);
  check(before === after, `phase B: the standing party row${stars.length > 1 ? "s are" : " is"} byte-identical after being served into every encounter`);
  check(Number(sb.mixed) === 0, `phase B: identical inputs → byte-identical logs across workers and order (${sb.groups} input groups, ${sb.mixed} with more than one log)`);
  check(wb.errorCount === 0, `phase B: no worker errors${wb.errorCount ? ` (${wb.errorCount}: ${wb.errors.join(" | ")})` : ""}`);
  // QA-36 D2: the property the account locks exist for. Every touched account's projected balances
  // equal the fold of its ledger rows, Coin stays within its cap, and no overrun transfer was paid twice.
  const touched = [...new Set([...defenders.map((d) => d.accountId), ...owners.map((o) => o.accountId)])];
  let projectionBad = 0;
  let overCap = 0;
  for (const id of touched) {
    const v = await verifyProjection(owner, id);
    // Coin only: the setup seeds Reputation by a direct UPDATE (outside the ledger), so the rating
    // pools legitimately differ from the fold; Coin moves only through the ledger.
    if (v.error || v.live.coinBalance !== v.rebuilt.coinBalance) {
      projectionBad++;
      if (projectionBad === 1) console.log(`  first mismatch ${id}: live ${JSON.stringify(v.live)} rebuilt ${JSON.stringify(v.rebuilt)} ${v.error ?? ""}`.slice(0, 1500));
    }
  }
  overCap = Number((await owner.query<{ n: string }>("SELECT count(*)::text AS n FROM account WHERE id = ANY($1) AND coin_balance > coin_storage_cap", [touched])).rows[0]!.n);
  const doubleTransfers = Number(
    (await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM (SELECT causation_id FROM ledger_event WHERE event_type = 'coin_transferred_to_party_owner' GROUP BY causation_id, payload->>'jobId' HAVING count(*) > 1) x",
    )).rows[0]!.n,
  );
  check(projectionBad === 0, `Coin: every touched account's projected Coin equals the fold of its ledger (${touched.length} accounts, ${projectionBad} mismatched)`);
  check(overCap === 0, `Coin: no touched account above its storage cap (${overCap})`);
  check(doubleTransfers === 0, `Coin: each overrun transfer to a party owner credited at most once (${doubleTransfers} duplicates)`);

  // The throughput target: REPORTED with the host's load, a failure only with --strict (a dedicated host).
  const load = loadavg().map((x) => x.toFixed(2)).join(", ");
  const met = jobsPerS >= TARGET_JOBS_PER_S;
  console.log(`\nTHROUGHPUT TARGET ${met ? "MET" : "NOT MET"}: ${jobsPerS.toFixed(0)} resolutions/s vs ≥ ${TARGET_JOBS_PER_S} (100× the assumed launch rate), load average ${load} on ${cpus().length} cores${STRICT ? "" : " — reported only (pass --strict on a dedicated host to gate on it)"}`);
  if (STRICT && !met) process.exitCode = 1;
  await app.close();
} finally {
  await stopWorkers();
  await appRole.end();
  await owner.end();
}

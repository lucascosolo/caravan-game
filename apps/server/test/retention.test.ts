/**
 * PHASE-2 §36 — LOG_RETENTION and LOG_SIZE_BUDGET enforced by COMPACTION (migration 022):
 *   - the worker records the end-card tally in the job's immutable result at completion, and it
 *     equals the tally the web replay player derives from the reader's events;
 *   - a log past retention, or over the size budget, is compacted to its results summary
 *     (encounter_log_summary) by the owner's definers — at write (the caravan's own prune, after
 *     the job is completed) and by the scheduled sweep (every caravan, batched, oldest first);
 *   - the replay route then answers 200, renderable: false, log: null, with `compacted`
 *     (reason, when, the kept tally) beside the outcome it always sends, for both participants;
 *   - the app role cannot write, rewrite or delete a summary, cannot call the internal compactor,
 *     and still cannot delete a log; even the owner cannot delete a log that has no summary;
 *   - account removal cascades a summary away like the log it replaced.
 */
import { entryBand, RING_SEGMENTS, type Formation, type PartyConfig } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { RESOLVER_VERSION, readReplay, type ReplayLog } from "@caravan/resolver";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_HANDLERS, type EncounterJobInput } from "../src/jobs/handlers/encounterResolution.js";
import { getJob } from "../src/jobs/queue.js";
import { LogRetentionLoop } from "../src/jobs/retentionWorker.js";
import { drain } from "../src/jobs/worker.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { COMPACTED_REASON } from "../src/routes/replay.js";
import { encounterLogRetention, findEncounterLogSummary, pruneEncounterLogs, retentionMatchesTunables, sweepEncounterLogRetention } from "../src/replay/store.js";
import { replayTally } from "../src/replay/summary.js";
import { DELETE_CONFIRM_PHRASE } from "../src/account/tunables.js";
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

async function registerPlayer(): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("rt"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: [] };
}

async function giveUnits(p: Player, n: number, typeId: string, mergeLevel: number): Promise<void> {
  for (let i = 0; i < n; i++) p.units.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

const EDGES = ["north", "east", "south", "west"] as const;
async function makeOwner(siegeRep: number): Promise<Player> {
  const p = await registerPlayer();
  await giveUnits(p, 3, "desert.dust_rider", 1);
  const party: PartyConfig = { v: 1, units: p.units.map((ref, i) => ({ ref, stance: "nearest" as const, edge: EDGES[i % 4]!, cell: entryBand(EDGES[i % 4]!)[i]! })), siege: ["siege.battering_wagon"] };
  expect((await call(p, "PUT", "/me/party", party)).statusCode).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [p.accountId, siegeRep]);
  return p;
}

async function makeDefender(): Promise<Player> {
  const p = await registerPlayer();
  await giveUnits(p, 2, "desert.dust_rider", 3);
  await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
  const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: p.units, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 8 } });
  expect(res.statusCode, res.body).toBe(201);
  return p;
}

/** Start a trip and commit encounter 1 against a live candidate; returns the job id (not yet resolved). */
async function commitFirstEncounter(d: Player): Promise<string> {
  expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`)).statusCode).toBe(201);
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
  expect(s.statusCode, s.body).toBe(201);
  const live = (s.json().menu.candidates as { candidateId: string; owner: { authored: boolean } }[]).find((c) => !c.owner.authored)!;
  expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: live.candidateId })).statusCode).toBe(200);
  const m = (await call(d, "GET", `/caravans/${d.caravanId}/manifest`)).json().manifest.survivors as { units: { ref: string }[]; traps: { ref: string }[]; fences: { ref: string }[] };
  const formation: Formation = {
    v: 2,
    fences: m.fences.map((f, k) => ({ ref: f.ref, segment: k % RING_SEGMENTS.length })),
    traps: m.traps.map((t) => ({ ref: t.ref, cell: { x: 15, y: 9 } })),
    posts: m.units.map((u, k) => ({ ref: u.ref, cell: { x: 13 + 4 * k, y: 15 }, stance: "hold" as const })),
  };
  expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, formation)).statusCode).toBe(200);
  const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/1/commit`);
  expect([200, 202]).toContain(c.statusCode);
  return c.json().jobId as string;
}

const worker = () => drain(appRole, { workerId: "retention-real", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 });

/** The tally exactly as the web client derives it (apps/web/src/screens/replay/replayModel.ts), from the READER's events. */
function webTally(raw: ReplayLog) {
  const replay = readReplay(raw);
  const log = replay.log;
  const died = new Set<number>();
  const broke = new Set<number>();
  const fired = new Set<number>();
  const nullified = new Set<number>();
  let core = false;
  for (const e of replay.events) {
    if (e.k === "unit_died") died.add(e.u);
    else if (e.k === "fence_broken") broke.add(e.f);
    else if (e.k === "trap_fired") fired.add(e.i);
    else if (e.k === "trap_nullified") nullified.add(e.i);
    else if (e.k === "core_reached") core = true;
  }
  const isRaider = (u: number): boolean => log.units[u]?.side === "attacker";
  const raiders = log.units.filter((u) => u.side === "attacker").length;
  return {
    raidersFallen: [...died].filter(isRaider).length,
    raiders,
    defendersFallen: [...died].filter((u) => !isRaider(u)).length,
    defenders: log.units.length - raiders,
    fencesBroken: broke.size,
    fences: log.fences.length,
    trapsSprung: fired.size,
    trapsNullified: [...nullified].filter((i) => !fired.has(i)).length,
    traps: log.traps.length,
    coreReached: core,
  };
}

/** A completed encounter job + its encounter_log row, created_at backdated (owner, guards off for the one insert). */
async function syntheticLog(d: Player, k: number, ageDays: number, status: "completed" | "queued" = "completed"): Promise<string> {
  const id = `encounter:00000000-0000-4000-8036-${String(k).padStart(12, "0")}:1`;
  const result = { outcome: { kind: "caravan_held", depth: 0, endTick: 100, loot: 0 }, replay: { tally: { raiders: 1, raidersFallen: 1, defenders: 1, defendersFallen: 0, fences: 0, fencesBroken: 0, traps: 0, trapsSprung: 0, trapsNullified: 0, coreReached: false, deepest: null } } };
  if (status === "completed") {
    await pool.query("INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts, status, result, completed_at) VALUES ($1, 'encounter_resolution', $2, $3, $4::jsonb, 3, 'completed', $5::jsonb, now())", [
      id, d.accountId, d.caravanId, JSON.stringify({ resolverVersion: RESOLVER_VERSION }), JSON.stringify(result),
    ]);
  } else {
    await pool.query("INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts) VALUES ($1, 'encounter_resolution', $2, $3, $4::jsonb, 3)", [id, d.accountId, d.caravanId, JSON.stringify({ resolverVersion: RESOLVER_VERSION })]);
  }
  await ownerUnguarded(
    `INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log, raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash, created_at)
     VALUES ($1, $2, $3, $3, $4, 2, 'gzip', '\\x00'::bytea, 1, 1, 'x', 'x', 'x', 'x', 'x', now() - make_interval(days => $5::int))`,
    [id, d.caravanId, d.accountId, RESOLVER_VERSION, ageDays],
  );
  return id;
}

async function ownerUnguarded(sql: string, params: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE encounter_log DISABLE TRIGGER USER");
    await client.query(sql, params);
    await client.query("ALTER TABLE encounter_log ENABLE TRIGGER USER");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Run `f` with the size budget lowered to its floor (1 KB), restoring the tunable after. */
async function withTinyBudget<T>(f: () => Promise<T>): Promise<T> {
  await pool.query("UPDATE encounter_log_retention SET size_budget_bytes = 1024");
  try {
    return await f();
  } finally {
    await pool.query("UPDATE encounter_log_retention SET size_budget_bytes = $1", [TUNABLES.LOG_SIZE_BUDGET_BYTES]);
  }
}

const logCount = async (caravanId: string) => Number((await pool.query("SELECT count(*) FROM encounter_log WHERE caravan_id = $1", [caravanId])).rows[0].count);

const owners: Player[] = [];
beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
  for (let i = 0; i < 4; i++) owners.push(await makeOwner(950 + i * 25));
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("PHASE-2 §36: replay retention by compaction", () => {
  it("the database's retention row equals the tunables, size budget included", async () => {
    const r = await encounterLogRetention(pool);
    expect(r).toEqual({ days: TUNABLES.LOG_RETENTION_DAYS, minPerCaravan: TUNABLES.LOG_RETENTION_MIN_PER_CARAVAN, sizeBudgetBytes: TUNABLES.LOG_SIZE_BUDGET_BYTES });
    expect(retentionMatchesTunables(r)).toBe(true);
    expect(TUNABLES.LOG_SIZE_BUDGET_BYTES).toBe(100 * 1024);
  });

  it("a real fight records its end-card tally in the job result — the same tally the web player derives — and its compaction keeps it, for both participants", async () => {
    const d = await makeDefender();
    const jobId = await commitFirstEncounter(d);
    expect(await worker()).toHaveLength(1);
    const job = (await getJob(pool, jobId))!;
    expect(job.status).toBe("completed");
    const result = job.result as { outcome: Record<string, unknown>; replay: { tally: Record<string, unknown> & { deepest: { typeId: string } | null }; sha256: string } };
    const row = (await pool.query("SELECT * FROM encounter_log WHERE job_id = $1", [jobId])).rows[0] as { log: Buffer; stored_bytes: number; raw_bytes: number; log_sha256: string; resolver_version: number; log_format: number; created_at: Date };
    const log = JSON.parse(gunzipSync(row.log).toString("utf8")) as ReplayLog;
    const { deepest, ...counts } = result.replay.tally;
    expect(counts).toEqual(webTally(log));
    expect(result.replay.tally).toEqual(replayTally(log));
    if (log.outcome.deepestUnit >= 0) expect(deepest?.typeId).toBe(log.units[log.outcome.deepestUnit]!.typeId);
    const ownerId = (job.input as EncounterJobInput).partyOwnerAccountId;
    const fought = owners.find((o) => o.accountId === ownerId) ?? null;
    const url = `/me/encounters/${encodeURIComponent(jobId)}/replay`;
    const before = (await call(d, "GET", url)).json();
    expect(before).toMatchObject({ renderable: true });
    expect(before.compacted).toBeUndefined();
    expect(fought, "the live candidate is one of this file's owners").not.toBeNull();
    const ownerBefore = (await call(fought!, "GET", url)).json();

    // Not compactable yet: fresh, the caravan's newest, under budget. The sweep leaves it.
    expect(await sweepEncounterLogRetention(appRole, 500)).toBe(0);
    expect(await logCount(d.caravanId)).toBe(1);
    // Over a (lowered) size budget it is: the caravan's prune compacts it, as the app role.
    expect(row.stored_bytes).toBeGreaterThan(1024);
    expect(await withTinyBudget(() => pruneEncounterLogs(appRole, d.caravanId))).toBe(1);
    expect(await logCount(d.caravanId)).toBe(0);
    const s = (await findEncounterLogSummary(pool, jobId))!;
    expect(s).toMatchObject({ reason: "size_budget", caravan_id: d.caravanId, defender_account_id: d.accountId, party_owner_account_id: ownerId, resolver_version: row.resolver_version, log_format: row.log_format, raw_bytes: row.raw_bytes, stored_bytes: row.stored_bytes, log_sha256: row.log_sha256 });
    expect(s.log_created_at.toISOString()).toBe(row.created_at.toISOString());
    expect(s.summary.outcome).toEqual({ kind: result.outcome["kind"], depth: result.outcome["depth"], endTick: result.outcome["endTick"], loot: result.outcome["loot"] });
    expect(s.summary.tally).toEqual(result.replay.tally);

    // The route: 200, not renderable, no log, the outcome as before, and the kept summary.
    const after = await call(d, "GET", url);
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body).toMatchObject({ viewer: "caravan", renderable: false, reason: COMPACTED_REASON, log: null, outcome: before.outcome, depth: before.depth, party: before.party, labels: { units: [], fences: [], traps: [] } });
    expect(body.compacted).toMatchObject({ reason: "size_budget", tally: { ...counts } });
    if (deepest) expect(body.compacted.tally.deepest).toMatchObject({ typeId: deepest.typeId, displayName: expect.any(String) });
    expect(body.stored).toMatchObject({ sha256: row.log_sha256, rawBytes: row.raw_bytes, storedBytes: row.stored_bytes });
    // The party's owner sees the same summary from their side; anyone else still gets 404.
    expect((await call(fought!, "GET", url)).json()).toMatchObject({ viewer: "party_owner", renderable: false, outcome: ownerBefore.outcome, settled: ownerBefore.settled, stored: null, compacted: { reason: "size_budget" } });
    // Chunk 22's recent-fights list says the fight's summary is kept (not "pruned").
    await call(d, "GET", `/me/caravans/${d.caravanId}/trip`); // the trip loop settles lazily on read
    const recent = (await call(d, "GET", "/me/encounters")).json() as { encounters: { jobId: string; replay: string }[] };
    expect(recent.encounters.find((e) => e.jobId === jobId)?.replay).toBe("compacted");
    const stranger = await registerPlayer();
    expect((await call(stranger, "GET", url)).statusCode).toBe(404);
    // A second compaction of the same job is a no-op.
    expect(await withTinyBudget(() => pruneEncounterLogs(appRole, d.caravanId))).toBe(0);
  });

  it("LOG_SIZE_BUDGET at write: an over-budget log is compacted inside its own completion transaction, with the job's outcome and tally", async () => {
    const d = await makeDefender();
    const jobId = await commitFirstEncounter(d);
    await withTinyBudget(async () => expect(await worker()).toHaveLength(1));
    const job = (await getJob(pool, jobId))!;
    expect(job.status).toBe("completed");
    expect(await logCount(d.caravanId)).toBe(0);
    const s = (await findEncounterLogSummary(pool, jobId))!;
    expect(s.reason).toBe("size_budget");
    const result = job.result as { outcome: Record<string, unknown>; replay: { tally: unknown } };
    expect(s.summary.outcome).toMatchObject({ kind: result.outcome["kind"], depth: result.outcome["depth"] });
    expect(s.summary.tally).toEqual(result.replay.tally);
    // The trip carried on: the fight settled normally (compaction is storage only).
    const trip = (await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).json();
    expect(trip.trip.encounters).toHaveLength(1);
  });

  it("LOG_RETENTION by the scheduled sweep: every caravan, oldest first, batched; older than 30 days AND outside the newest 50; never a job that is not completed", async () => {
    const a = await registerPlayer();
    const b = await registerPlayer();
    const ids: string[] = [];
    for (let k = 0; k < 50; k++) ids.push(await syntheticLog(a, k, 40 + k)); // k = 49 is the oldest
    ids.push(await syntheticLog(a, 50, 1));
    ids.push(await syntheticLog(a, 51, 1));
    // A caravan with three old logs keeps them all (its newest 50).
    for (let k = 100; k < 103; k++) await syntheticLog(b, k, 90);
    // An old row outside the newest 50 whose job is not completed has no summary to keep: it stays.
    const pending = await syntheticLog(a, 200, 200, "queued");
    // Even the owner cannot delete a log without a summary.
    expect((await expectDbError(pool, "DELETE FROM encounter_log WHERE job_id = $1", [ids[49]]))?.message).toMatch(/no results summary/);

    expect(await sweepEncounterLogRetention(appRole, 1)).toBe(1);
    expect(await findEncounterLogSummary(pool, ids[49]!)).toMatchObject({ reason: "retention" }); // the oldest first
    expect(await findEncounterLogSummary(pool, ids[48]!)).toBeNull();
    // The loop drains the rest in batches and reports what it did.
    const errors: unknown[] = [];
    const loop = new LogRetentionLoop(appRole, { batch: 1, intervalMs: 3_600_000, onError: (err) => errors.push(err) });
    loop.start();
    const run = await loop.runNow();
    await loop.stop();
    expect(errors).toEqual([]);
    // 53 rows in caravan a: its newest 50 are kept; of the three outside, ids[49] went above and the
    // pending one has no completed job — so this run compacts ids[48] alone, in two calls (1, then 0).
    expect(run).toMatchObject({ compacted: 1, batches: 2 });
    expect(await logCount(a.caravanId)).toBe(51);
    expect(await logCount(b.caravanId)).toBe(3);
    expect((await pool.query("SELECT 1 FROM encounter_log WHERE job_id = $1", [pending])).rowCount).toBe(1);
    expect(await sweepEncounterLogRetention(appRole, 500)).toBe(0);
    const summaries = await pool.query<{ job_id: string; summary: { outcome: unknown; tally: unknown } }>("SELECT job_id, summary FROM encounter_log_summary WHERE caravan_id = $1 ORDER BY job_id", [a.caravanId]);
    expect(summaries.rows.map((r) => r.job_id).sort()).toEqual([ids[48]!, ids[49]!].sort());
    expect(summaries.rows[0]!.summary.outcome).toEqual({ kind: "caravan_held", depth: 0, endTick: 100, loot: 0 });
    // The limit cannot be widened past the batch cap.
    expect((await expectDbError(appRole, "SELECT encounter_log_retention_sweep(0)"))?.message).toMatch(/outside 1\.\.5000/);
    expect((await expectDbError(appRole, "SELECT encounter_log_retention_sweep(5001)"))?.message).toMatch(/outside 1\.\.5000/);
  });

  it("the app role cannot write, rewrite or delete a summary, nor call the compactor; the owner cannot rewrite or delete one either; removing the account cascades it", async () => {
    const s = (await pool.query<{ job_id: string; caravan_id: string }>("SELECT job_id, caravan_id FROM encounter_log_summary LIMIT 1")).rows[0]!;
    expect((await expectDbError(appRole, "UPDATE encounter_log_summary SET summary = '{\"outcome\":null,\"tally\":null}' WHERE job_id = $1", [s.job_id]))?.code).toBe("42501");
    expect((await expectDbError(appRole, "DELETE FROM encounter_log_summary WHERE job_id = $1", [s.job_id]))?.code).toBe("42501");
    expect(
      (await expectDbError(appRole, "INSERT INTO encounter_log_summary SELECT 'encounter:00000000-0000-4000-8000-000000000999:1', caravan_id, defender_account_id, party_owner_account_id, reason, resolver_version, log_format, raw_bytes, stored_bytes, log_sha256, content_hash, log_created_at, compacted_at, summary FROM encounter_log_summary WHERE job_id = $1", [s.job_id]))?.code,
    ).toBe("42501");
    expect((await expectDbError(appRole, "SELECT encounter_log_compact_rows(ARRAY[$1])", [s.job_id]))?.code).toBe("42501");
    expect((await expectDbError(appRole, "TRUNCATE encounter_log_summary"))?.code).toBe("42501");
    // The app role still has no direct way to delete a log, and lowering the window is not open to it.
    const anyLog = (await pool.query<{ job_id: string }>("SELECT job_id FROM encounter_log LIMIT 1")).rows[0]!;
    expect((await expectDbError(appRole, "DELETE FROM encounter_log WHERE job_id = $1", [anyLog.job_id]))?.code).toBe("42501");
    expect((await expectDbError(appRole, "UPDATE encounter_log_retention SET size_budget_bytes = 1024"))?.code).toBe("42501");
    // The owner: no rewrite, no delete, no truncate.
    expect((await expectDbError(pool, "UPDATE encounter_log_summary SET reason = 'retention' WHERE job_id = $1", [s.job_id]))?.message).toMatch(/immutable/);
    expect((await expectDbError(pool, "DELETE FROM encounter_log_summary WHERE job_id = $1", [s.job_id]))?.message).toMatch(/permanent results summary/);
    expect((await expectDbError(pool, "TRUNCATE encounter_log_summary"))?.message).toMatch(/cannot be truncated/);
    // Account removal: the caravan goes, and its summaries with it.
    const acct = (await pool.query<{ account_id: string }>("SELECT account_id FROM caravan WHERE id = $1", [s.caravan_id])).rows[0]!;
    await pool.query("DELETE FROM account WHERE id = $1", [acct.account_id]);
    expect((await pool.query("SELECT 1 FROM encounter_log_summary WHERE caravan_id = $1", [s.caravan_id])).rowCount).toBe(0);
  });
});

describe("PHASE-2 §36 × chunk 30: compaction and account erasure compose, in either order", () => {
  const TOMB_ACCOUNT = "00000000-0000-4000-8000-0000000000d0";
  const TOMB_CARAVAN = "00000000-0000-4000-8000-0000000000d1";
  const erase = async (p: Player) => {
    const res = await call(p, "POST", "/me/account/delete", { confirm: DELETE_CONFIRM_PHRASE, password: "correct horse battery" });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { counts: Record<string, number> };
  };
  /** A finished real fight: the defender, the party owner who struck, and the job. */
  async function aFight(): Promise<{ d: Player; o: Player; jobId: string; url: string }> {
    const d = await makeDefender();
    const jobId = await commitFirstEncounter(d);
    // (The sweep test above left one queued job with no trip input; a drain parks it. Only this fight matters here.)
    expect((await worker()).filter((x) => x.kind === "completed" && x.job.id === jobId)).toHaveLength(1);
    const ownerId = ((await getJob(pool, jobId))!.input as EncounterJobInput).partyOwnerAccountId;
    const o = owners.find((x) => x.accountId === ownerId)!;
    expect(o).toBeDefined();
    return { d, o, jobId, url: `/me/encounters/${encodeURIComponent(jobId)}/replay` };
  }

  it("compacted, then the DEFENDER erases their account: the summary is kept for the party's owner, re-pointed to the tombstone like the log would be", async () => {
    const { d, o, jobId, url } = await aFight();
    expect(await withTinyBudget(() => pruneEncounterLogs(appRole, d.caravanId))).toBe(1);
    const before = (await findEncounterLogSummary(pool, jobId))!;
    expect(before.defender_account_id).toBe(d.accountId);
    const { counts } = await erase(d);
    expect(counts["fightsDefendedKept"]).toBe(1);
    const after = (await findEncounterLogSummary(pool, jobId))!;
    expect(after).toMatchObject({ caravan_id: TOMB_CARAVAN, defender_account_id: TOMB_ACCOUNT, party_owner_account_id: o.accountId, reason: before.reason, log_sha256: before.log_sha256 });
    expect(after.summary).toEqual(before.summary);
    expect(JSON.stringify(after)).not.toContain(d.accountId);
    expect(JSON.stringify(after)).not.toContain(d.caravanId);
    // The owner still reads the archived fight.
    expect((await call(o, "GET", url)).json()).toMatchObject({ viewer: "party_owner", renderable: false, compacted: { reason: "size_budget" } });
  });

  it("compacted, then the PARTY OWNER erases their account: the defender keeps the summary; the owner side becomes the tombstone", async () => {
    const { d, o, jobId, url } = await aFight();
    expect(await withTinyBudget(() => pruneEncounterLogs(appRole, d.caravanId))).toBe(1);
    await erase(o);
    owners.splice(owners.indexOf(o), 1);
    const after = (await findEncounterLogSummary(pool, jobId))!;
    expect(after).toMatchObject({ caravan_id: d.caravanId, defender_account_id: d.accountId, party_owner_account_id: TOMB_ACCOUNT });
    expect((await call(d, "GET", url)).json()).toMatchObject({ viewer: "caravan", renderable: false, compacted: { reason: "size_budget" } });
    // Outside an erasure the same rewrite is still refused, even to the owner.
    expect((await expectDbError(pool, "UPDATE encounter_log_summary SET party_owner_account_id = $2 WHERE job_id = $1", [jobId, d.accountId]))?.message).toMatch(/immutable/);
  });

  it("erased, then compacted: the summary is born from the anonymized log, with the tombstone's ids", async () => {
    const { d, o, jobId, url } = await aFight();
    await erase(d);
    const log = (await pool.query<{ caravan_id: string; defender_account_id: string }>("SELECT caravan_id, defender_account_id FROM encounter_log WHERE job_id = $1", [jobId])).rows[0]!;
    expect(log).toEqual({ caravan_id: TOMB_CARAVAN, defender_account_id: TOMB_ACCOUNT });
    expect(await withTinyBudget(() => sweepEncounterLogRetention(appRole, 500))).toBeGreaterThanOrEqual(1);
    const s = (await findEncounterLogSummary(pool, jobId))!;
    expect(s).toMatchObject({ caravan_id: TOMB_CARAVAN, defender_account_id: TOMB_ACCOUNT, party_owner_account_id: o.accountId });
    expect(JSON.stringify(s)).not.toContain(d.accountId);
    expect((await call(o, "GET", url)).json()).toMatchObject({ viewer: "party_owner", renderable: false, compacted: { reason: "size_budget" } });
  });
});

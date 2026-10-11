/**
 * Chunk 13 — the trip loop against the REAL resolver (DEFAULT_HANDLERS, ENCOUNTER_RESOLUTION_WIRED),
 * the stored replay (encounter_log, QA-15 S2), the content stamp (S3), the replay API for both
 * participants, the outcome events (kind, depth, loot, the party version that fought) and the
 * loot curve. The planned-outcome trip tests (trip.test.ts) keep the double; this file runs the
 * same loop — start, search, choose, arrange, commit, resolve, settle, push or bank or overrun —
 * with every fight decided by @caravan/resolver.
 */
import { RING_SEGMENTS, entryBand, toBattlefield, type Formation, type PartyConfig } from "@caravan/circle";
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import { ABILITY_ARCHETYPES, REPLAY_FORMAT_VERSION, RESOLVER_VERSION, readReplay, replaySeal, type ReplayLog, type ReplayRow } from "@caravan/resolver";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { coinForEncounter } from "../src/economy/coin.js";
import { DEFAULT_HANDLERS, makeEncounterResolutionHandler, type EncounterJobInput } from "../src/jobs/handlers/encounterResolution.js";
import { getJob, leaseNextJob, markJobFailed } from "../src/jobs/queue.js";
import { drain, runOnce, verifyJobReplay } from "../src/jobs/worker.js";
import type { LedgerEventRow } from "../src/ledger/events.js";
import { encounterLogRetention, pruneEncounterLogs, retentionMatchesTunables } from "../src/replay/store.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { PARTY_LOOT_FULL_MAX, partyLoot, partyLootShare } from "../src/trip/loot.js";
import { productionEncounterResolver, resolverInputFromJob } from "../src/trip/outcome.js";
import { ContentHashMismatchError, RESOLUTION_CONTENT_HASH, resolutionContentHash, resolveWithResolver } from "../src/trip/resolverAdapter.js";
import { CONTENT } from "@caravan/content";
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
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("r"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: [] };
}

async function giveUnits(p: Player, n: number, typeId: string, mergeLevel: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
  p.units.push(...ids);
  return ids;
}

function call(p: Player | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: p ? { authorization: `Bearer ${p.token}` } : {} };
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

/** A defender with a packed manifest: strong (four level-5 posts, 20 segments) or weak (one level-1 post, no fence). */
async function makeDefender(strength: "strong" | "weak" = "strong"): Promise<Player> {
  const p = await registerPlayer();
  if (strength === "strong") {
    await giveUnits(p, 2, "desert.dust_rider", 5);
    await giveUnits(p, 2, "desert.well_digger", 5);
  } else await giveUnits(p, 1, "desert.dust_rider", 1);
  await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
  const loadout = strength === "strong" ? { units: p.units, traps: ["trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } } : { units: p.units, traps: [], fence: { tierId: "fence.brush_pile", count: 0 } };
  const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, loadout);
  expect(res.statusCode, res.body).toBe(201);
  return p;
}

interface ManifestJson {
  units: { ref: string; hp: number }[];
  traps: { ref: string; spent: boolean }[];
  fences: { ref: string; hp: number }[];
}

async function survivors(d: Player): Promise<ManifestJson> {
  return (await call(d, "GET", `/caravans/${d.caravanId}/manifest`)).json().manifest.survivors;
}

/** Posts on guard around the inside of the ring, fences across the north face, traps on the approach. */
function arrangement(m: ManifestJson): Formation {
  const postCells = [{ x: 15, y: 13 }, { x: 13, y: 15 }, { x: 17, y: 15 }, { x: 15, y: 17 }];
  const trapCells = [{ x: 15, y: 9 }, { x: 9, y: 15 }];
  return {
    v: 2,
    fences: m.fences.filter((f) => f.hp > 0).map((f, k) => ({ ref: f.ref, segment: k % RING_SEGMENTS.length })),
    traps: m.traps.filter((t) => !t.spent).map((t, k) => ({ ref: t.ref, cell: trapCells[k]! })),
    posts: m.units.filter((u) => u.hp > 0).map((u, k) => ({ ref: u.ref, cell: postCells[k]!, stance: "hold" as const })),
  };
}

const worker = () => drain(pool, { workerId: "real", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 });

async function fight(d: Player, n: number, commitVia?: FastifyInstance): Promise<{ jobId: string; ownerId: string }> {
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/search`);
  expect(s.statusCode, s.body).toBe(201);
  const live = (s.json().menu.candidates as { candidateId: string; owner: { authored: boolean } }[]).find((c) => !c.owner.authored)!;
  expect(live, "a live (player-owned) candidate").toBeDefined();
  expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/choose`, { candidateId: live.candidateId })).statusCode).toBe(200);
  const f = await call(d, "PUT", `/caravans/${d.caravanId}/encounters/${n}/formation`, arrangement(await survivors(d)));
  expect(f.statusCode, f.body).toBe(200);
  const c = commitVia
    ? await commitVia.inject({ method: "POST", url: `/me/caravans/${d.caravanId}/trip/encounters/${n}/commit`, headers: { authorization: `Bearer ${d.token}` } })
    : await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/${n}/commit`);
  expect([200, 202]).toContain(c.statusCode);
  const jobId = c.json().jobId as string;
  // The menu never names the owner's account (chunk 14); the job input does.
  return { jobId, ownerId: ((await getJob(pool, jobId))!.input as EncounterJobInput).partyOwnerAccountId };
}

async function eventsByCause(jobId: string): Promise<LedgerEventRow[]> {
  return (await pool.query<LedgerEventRow>("SELECT * FROM ledger_event WHERE causation_id = $1 ORDER BY causation_seq", [jobId])).rows;
}

async function storedLog(jobId: string): Promise<{ log: ReplayLog; row: Record<string, unknown> }> {
  const r = await pool.query("SELECT * FROM encounter_log WHERE job_id = $1", [jobId]);
  const row = r.rows[0] as Record<string, unknown> & { log: Buffer };
  return { log: JSON.parse(gunzipSync(row.log).toString("utf8")) as ReplayLog, row };
}

/**
 * As the OWNER role, with encounter_log's user triggers off for one statement, in one transaction
 * (the owner can always do this — exactly why the server never runs as the owner). Tests use it to
 * forge or backdate rows the app role cannot write.
 */
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

/** Replace a stored log's body as the owner, re-gzipped, with a matching log_sha256 (a forger recomputes it). */
async function forgeStoredLog(jobId: string, text: string): Promise<void> {
  const body = gzipSync(Buffer.from(text, "utf8"));
  await ownerUnguarded("UPDATE encounter_log SET log = $2, raw_bytes = $3, stored_bytes = $4, log_sha256 = $5 WHERE job_id = $1", [jobId, body, Buffer.byteLength(text), body.length, createHash("sha256").update(text).digest("hex")]);
}

const resealLog = (log: ReplayLog): ReplayLog => {
  const body = { ...log, count: log.events.length };
  return { ...body, check: replaySeal(body) };
};

let owners: Player[] = [];
beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
  owners = [];
  for (let i = 0; i < 12; i++) owners.push(await makeOwner(950 + i * 10));
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("PARTIAL_LOOT_CURVE (pure)", () => {
  it("full on an overrun, nothing on a stalemate, full × depth^1.5 on a wipe — integer, monotone, never above full", () => {
    expect(partyLoot("caravan_overrun", FIXED_ONE, 400)).toBe(400);
    expect(partyLoot("stalemate", 900, 400)).toBe(0);
    expect(partyLoot("stalemate", FIXED_ONE, 400)).toBe(0);
    expect(partyLoot("caravan_held", FIXED_ONE, 400)).toBe(400);
    expect(partyLoot("caravan_held", 0, 400)).toBe(0);
    expect(partyLoot("caravan_held", 512, 400)).toBe(141); // 400 × 0.5^1.5 = 141.4
    expect(partyLoot("caravan_held", 256, 400)).toBe(50); // 400 × 0.125
    // QA-13 N6: the product stays exact up to PARTY_LOOT_FULL_MAX; above it is refused, never rounded.
    expect(partyLoot("caravan_held", FIXED_ONE, PARTY_LOOT_FULL_MAX)).toBe(PARTY_LOOT_FULL_MAX);
    expect(() => partyLoot("caravan_held", 512, PARTY_LOOT_FULL_MAX + 1)).toThrow(RangeError);
    expect(partyLootShare("caravan_held", 512)).toBe(362);
    let prev = -1;
    for (let d = 0; d <= FIXED_ONE; d++) {
      const l = partyLoot("caravan_held", d, coinForEncounter(5, 0));
      expect(Number.isSafeInteger(l)).toBe(true);
      expect(l).toBeGreaterThanOrEqual(prev);
      expect(l).toBeLessThanOrEqual(coinForEncounter(5, 0));
      prev = l;
    }
    expect(TUNABLES.STALEMATE_LOOT_SHARE).toBe(0);
    expect(TUNABLES.FULL_CLEAR_LOOT_SHARE).toBe(FIXED_ONE);
  });
});

/**
 * Ride one trip with the real resolver: every encounter is checked end to end (stored log,
 * events, replay determinism, the fold); push while held, bank after the 4th, stop on an overrun.
 */
async function runTrip(d: Player): Promise<string[]> {
  expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`)).statusCode).toBe(201);
  const seen: string[] = [];
  for (let n = 1; n <= 4; n++) {
    const before = await survivors(d);
    const { jobId, ownerId } = await fight(d, n);
    const job0 = await getJob(pool, jobId);
    const input = job0!.input as EncounterJobInput;
    expect(input.contentHash).toBe(RESOLUTION_CONTENT_HASH);
    expect(input.survivors).toBeDefined();
    expect(await worker()).toHaveLength(1);
    const job = (await getJob(pool, jobId))!;
    expect(job.status, job.last_error ?? "").toBe("completed");
    const outcome = (job.result as { outcome: { kind: string; depth: number; endTick: number; loot: number; units: { ref: string; hp: number }[] } }).outcome;
    seen.push(outcome.kind);

    // The stored replay: resolver version, format, sizes, snapshot hashes; decodes to the same outcome.
    const { log, row } = await storedLog(jobId);
    expect(row).toMatchObject({ resolver_version: RESOLVER_VERSION, log_format: REPLAY_FORMAT_VERSION, encoding: "gzip", caravan_id: d.caravanId, defender_account_id: d.accountId, party_owner_account_id: ownerId, content_hash: RESOLUTION_CONTENT_HASH });
    expect(row.stored_bytes as number).toBeLessThan(TUNABLES.LOG_SIZE_BUDGET_BYTES);
    const replay = readReplay(log);
    expect(log.outcome).toMatchObject({ kind: outcome.kind, depth: outcome.depth, endTick: outcome.endTick });
    const last = replay.frame(log.ticks - 1);
    for (const u of outcome.units) {
      const label = log.units.find((l) => l.ref === u.ref && l.side === "defender")!;
      expect(last.units[label.u]!.hp, u.ref).toBe(u.hp);
    }
    expect(outcome.loot).toBe(partyLoot(outcome.kind as never, outcome.depth, coinForEncounter(n, 0)));
    expect((job.result as { replay: { sha256: string } }).replay.sha256).toBe(row.log_sha256);
    expect(JSON.stringify(job.result)).not.toContain('"events"'); // the log itself is not in job.result

    // The events: kind, depth, endTick, loot, and the party version that fought (chunk 09 QA N3).
    const evs = await eventsByCause(jobId);
    const served = evs.find((e) => e.event_type === "party_served_as_encounter")!;
    const resolved = evs.find((e) => e.event_type === "encounter_resolved")!;
    expect(served.account_id).toBe(ownerId);
    for (const e of [served, resolved]) {
      expect(e.payload).toMatchObject({ partyId: input.party.partyId, partyHash: input.party.hash, partySavedAt: input.party.savedAt });
      expect(e.payload["outcome"]).toMatchObject({ kind: outcome.kind, depth: outcome.depth, endTick: outcome.endTick, loot: outcome.loot });
    }
    // Determinism: the job's handler, re-run on its stored input, writes the same events.
    expect((await verifyJobReplay(pool, DEFAULT_HANDLERS, jobId)).ok).toBe(true);
    // Re-run the adapter directly: the same log, byte for byte.
    expect(JSON.stringify(resolveWithResolver(resolverInputFromJob(job.input)).log)).toBe(JSON.stringify(log));

    // Settle: the manifest carries exactly the replay's attrition forward; HP never rises.
    const statusRes = await call(d, "GET", `/me/caravans/${d.caravanId}/trip`);
    expect(statusRes.statusCode, statusRes.body).toBe(200);
    const status = statusRes.json();
    if (outcome.kind === "caravan_overrun") {
      // The trip is over: the manifest closed, the caravan is back in town (chunk 19 applies the losses).
      const overrun = await pool.query("SELECT end_reason FROM trip WHERE id = $1", [input.tripId]);
      expect(overrun.rows[0].end_reason).toBe("overrun");
      break;
    }
    const after = await survivors(d);
    for (const u of after.units) expect(u.hp).toBeLessThanOrEqual(before.units.find((b) => b.ref === u.ref)!.hp);
    for (const u of outcome.units) expect(after.units.find((a) => a.ref === u.ref)!.hp).toBe(u.hp);
    expect(status.trip.phase).toBe("decide");
    if (n === 4) {
      expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/bank`, { tripId: status.trip.id, encounterIndex: n })).statusCode).toBe(200);
      break;
    }
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/push`, { tripId: status.trip.id, encounterIndex: n })).statusCode).toBe(200);
  }
  process.stdout.write(`real-resolver trip outcomes: ${seen.join(" → ")}\n`);
  return seen;
}

describe("the trip loop with the real resolver", () => {
  it("a strong circle: every encounter resolves, settles and is replayable, attrition carries forward through pushes, until it banks or falls", async () => {
    // Which parties are served depends on matchmaking's seeded draw over the whole database, so
    // the exact chain is not pinned here; the strong circle survives at least its first fight and pushes on.
    const seen = await runTrip(await makeDefender("strong"));
    expect(seen[0]).not.toBe("caravan_overrun");
    expect(seen.length).toBeGreaterThan(1);
  });

  it("a weak circle: the real resolver overruns it and the trip ends there", async () => {
    const seen = await runTrip(await makeDefender("weak"));
    expect(seen[seen.length - 1]).toBe("caravan_overrun");
  });
});

describe("GET /me/encounters/:jobId/replay", () => {
  let d: Player;
  let owner: Player;
  let jobId: string;
  beforeAll(async () => {
    d = await makeDefender();
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`)).statusCode).toBe(201);
    const f = await fight(d, 1);
    jobId = f.jobId;
    owner = owners.find((o) => o.accountId === f.ownerId)!;
    expect(owner).toBeDefined();
  });

  it("is 409 to a participant while the encounter is still resolving, 404 to anyone else", async () => {
    expect((await call(d, "GET", `/me/encounters/${jobId}/replay`)).statusCode).toBe(409);
    const stranger = await registerPlayer();
    expect((await call(stranger, "GET", `/me/encounters/${jobId}/replay`)).statusCode).toBe(404);
    await worker();
  });

  it("serves the caravan's player and the party's owner the same stored log, labelled, with the outcome and the resolver version", async () => {
    const mine = await call(d, "GET", `/me/encounters/${jobId}/replay`);
    expect(mine.statusCode, mine.body).toBe(200);
    const theirs = await call(owner, "GET", `/me/encounters/${encodeURIComponent(jobId)}/replay`);
    expect(theirs.statusCode, theirs.body).toBe(200);
    const a = mine.json();
    const b = theirs.json();
    expect(a.viewer).toBe("caravan");
    expect(b.viewer).toBe("party_owner");
    expect(JSON.stringify(a.log)).toBe(JSON.stringify(b.log));
    expect(a).toMatchObject({ resolverVersion: RESOLVER_VERSION, currentResolverVersion: RESOLVER_VERSION, logFormat: REPLAY_FORMAT_VERSION, renderable: true, reason: null, encounterIndex: 1 });
    expect(a.outcome).toMatchObject({ kind: a.log.outcome.kind, depth: a.log.outcome.depth, loot: expect.any(Number) });
    // QA-13 N5: numbers, not English — where depth is measured from and the owner's share of full loot.
    expect(a.depth).toEqual({ scale: 1024, measuredFrom: "ring_line", lootCurve: "depth_pow_1_5", value: a.log.outcome.depth, lootShare: partyLootShare(a.log.outcome.kind, a.log.outcome.depth) });
    expect(a).not.toHaveProperty("depthExplained");
    expect(a.labels.units.every((u: { displayName: string }) => typeof u.displayName === "string" && u.displayName.length > 0)).toBe(true);
    expect(a.labels.fences.length).toBe(a.log.fences.length);
    // The client plays it with the resolver package's reader alone.
    const replay = readReplay(b.log);
    expect(replay.frame(b.log.ticks - 1).units.length).toBe(b.log.units.length);
    // Nothing account-shaped about the other side is exposed.
    expect(JSON.stringify(b)).not.toContain(d.accountId);
    expect(JSON.stringify(a)).not.toContain(owner.accountId);
  });

  it("404 for a stranger, a malformed id, an unknown job; 401 without a token", async () => {
    const stranger = await registerPlayer();
    expect((await call(stranger, "GET", `/me/encounters/${jobId}/replay`)).statusCode).toBe(404);
    expect((await call(d, "GET", `/me/encounters/nonsense/replay`)).statusCode).toBe(404);
    expect((await call(d, "GET", `/me/encounters/encounter:00000000-0000-0000-0000-000000000000:1/replay`)).statusCode).toBe(404);
    expect((await call(null, "GET", `/me/encounters/${jobId}/replay`)).statusCode).toBe(401);
  });

  it("the party owner editing their party afterwards changes nothing the replay shows", async () => {
    const before = (await call(owner, "GET", `/me/encounters/${jobId}/replay`)).json();
    const edited: PartyConfig = { v: 1, units: owner.units.slice(0, 2).map((ref, i) => ({ ref, stance: "core" as const, edge: "south" as const, cell: entryBand("south")[i]! })), siege: [] };
    expect((await call(owner, "PUT", "/me/party", edited)).statusCode).toBe(200);
    const after = (await call(owner, "GET", `/me/encounters/${jobId}/replay`)).json();
    expect(JSON.stringify(after.log)).toBe(JSON.stringify(before.log));
    expect(after.party).toEqual(before.party);
  });

  it("N3: the response is gzip-compressed when the client accepts it, and decodes to the same body", async () => {
    const plain = await call(d, "GET", `/me/encounters/${jobId}/replay`);
    const gz = await app.inject({ method: "GET", url: `/me/encounters/${jobId}/replay`, headers: { authorization: `Bearer ${d.token}`, "accept-encoding": "gzip" } });
    expect(gz.statusCode).toBe(200);
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString("utf8"))).toEqual(plain.json());
  });

  it("S3: every re-sealed edit the review made — header, labels, outcome, every row class — is renderable: false (sha256 ≠ the job's), and the original reads again", async () => {
    const { log, row } = await storedLog(jobId);
    const original = gunzipSync(row.log as Buffer).toString("utf8");
    const rows = () => log.events.map((r) => [...r]) as (number | string)[][];
    const firstRow = (code: string, ok: (r: (number | string)[]) => boolean = () => true) => log.events.findIndex((r) => r[1] === code && ok(r as (number | string)[]));
    const withRows = (edit: (r: (number | string)[][]) => void) => {
      const r = rows();
      edit(r);
      return { ...log, events: r as ReplayRow[] };
    };
    const other = log.units.find((u) => u.typeId !== log.units[0]!.typeId) ?? log.units[0]!;
    const edits: [string, () => ReplayLog][] = [
      ["unit typeId", () => ({ ...log, units: log.units.map((u, i) => (i === 0 ? { ...u, typeId: other.typeId === u.typeId ? "desert.other" : other.typeId } : u)) })],
      ["level + maxHp", () => ({ ...log, units: log.units.map((u, i) => (i === 0 ? { ...u, level: 5, maxHp: u.maxHp * 10 } : u)) })],
      ["defender relabelled attacker", () => ({ ...log, units: log.units.map((u) => (u.side === "defender" ? { ...u, side: "attacker" as const } : u)) })],
      ["trap moved 3 cells", () => ({ ...log, traps: log.traps.map((t, i) => (i === 0 ? { ...t, x: t.x + 3072 } : t)) })],
      ["outcome.deepestUnit", () => ({ ...log, outcome: { ...log.outcome, deepestUnit: (log.outcome.deepestUnit + 1) % log.units.length } })],
      ["resolverVersion", () => ({ ...log, resolverVersion: 1 })],
      ["tickRate", () => ({ ...log, tickRate: 40 })],
      ["hit damage ×100", () => withRows((r) => { const k = firstRow("x"); if (k >= 0) (r[k]![4] as number) *= 100; else r[0]![3] = (r[0]![3] as number) + 1; })],
      ["hit credited to another attacker", () => withRows((r) => { const k = firstRow("x"); if (k >= 0) r[k]![2] = ((r[k]![2] as number) + 1) % log.units.length; else r[0]![4] = (r[0]![4] as number) + 1; })],
      ["tg retarget", () => withRows((r) => { const k = firstRow("tg", (x) => x[3] === 1); if (k >= 0) r[k]![4] = ((r[k]![4] as number) + 1) % log.units.length; else r[0]![3] = (r[0]![3] as number) + 2; })],
      ["fence-hit damage ×100", () => withRows((r) => { const k = firstRow("fh"); if (k >= 0) (r[k]![4] as number) *= 100; else r[0]![4] = (r[0]![4] as number) + 2; })],
      ["trap damage ×100", () => withRows((r) => { const k = firstRow("tf"); if (k >= 0) (r[k]![4] as number) *= 100; else r[0]![3] = (r[0]![3] as number) + 3; })],
      ["ab archetype index", () => withRows((r) => { const k = firstRow("ab"); if (k >= 0) r[k]![3] = ((r[k]![3] as number) + 1) % ABILITY_ARCHETYPES.length; else r[0]![4] = (r[0]![4] as number) + 3; })],
    ];
    try {
      for (const [label, make] of edits) {
        const forged = JSON.stringify(resealLog(make()));
        expect(forged, label).not.toBe(original);
        await forgeStoredLog(jobId, forged);
        const res = await call(d, "GET", `/me/encounters/${jobId}/replay`);
        expect(res.statusCode, label).toBe(200);
        expect(res.json(), label).toMatchObject({ renderable: false, labels: null });
        expect(res.json().reason, label).toMatch(/sha256 .* does not match/);
      }
      // N1: a body that will not even decompress is a verdict, not a 500.
      await ownerUnguarded("UPDATE encounter_log SET log = $2, stored_bytes = 3 WHERE job_id = $1", [jobId, Buffer.from([1, 2, 3])]);
      const broken = await call(d, "GET", `/me/encounters/${jobId}/replay`);
      expect(broken.statusCode).toBe(200);
      expect(broken.json()).toMatchObject({ renderable: false, log: null });
      expect(broken.json().reason).toMatch(/cannot be decoded/);
    } finally {
      await forgeStoredLog(jobId, original);
    }
    expect((await call(d, "GET", `/me/encounters/${jobId}/replay`)).json()).toMatchObject({ renderable: true, reason: null });
  });

  it("a log in a format this server cannot read is renderable: false with the reason; a pruned one is 410; a parked job is 409 resolution_unavailable", async () => {
    const { log, row } = await storedLog(jobId);
    // A resolved job whose recorded log is an old format: its own job, result naming that log's sha256.
    const job = (await getJob(pool, jobId))!;
    const oldId = jobId.replace(/:1$/, ":7");
    const oldText = JSON.stringify({ ...log, v: 99, resolverVersion: 6 });
    const oldSha = createHash("sha256").update(oldText).digest("hex");
    const body = gzipSync(Buffer.from(oldText));
    await pool.query(
      `INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts, status, attempts, result, completed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 3, 'completed', 1, $6::jsonb, now())`,
      [oldId, job.kind, job.account_id, job.caravan_id, JSON.stringify(job.input), JSON.stringify({ ...(job.result as object), replay: { store: "encounter_log", jobId: oldId, logFormat: 99, sha256: oldSha, rawBytes: oldText.length } })],
    );
    await ownerUnguarded(
      `INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log, raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash)
       VALUES ($1, $2, $3, $4, 6, 99, 'gzip', $5, $6, $7, $8, $9, $10, $11, $12)`,
      [oldId, row.caravan_id, row.defender_account_id, row.party_owner_account_id, body, oldText.length, body.length, oldSha, row.formation_sha256, row.survivors_sha256, row.party_sha256, row.content_hash],
    );
    const old = (await call(d, "GET", `/me/encounters/${oldId}/replay`)).json();
    expect(old).toMatchObject({ renderable: false, logFormat: 99, resolverVersion: 6 });
    expect(old.reason).toMatch(/not readable/);
    // Pruned: the row gone (as the owner, guards off — the app role cannot delete a fresh replay).
    await ownerUnguarded("DELETE FROM encounter_log WHERE job_id = $1", [oldId]);
    const gone = await call(d, "GET", `/me/encounters/${oldId}/replay`);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toBe("replay_expired");
    // N2: a parked encounter answers a distinct code, so the client stops polling.
    const parkedId = jobId.replace(/:1$/, ":8");
    await pool.query(`INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts, status, attempts, last_error) VALUES ($1, $2, $3, $4, $5::jsonb, 3, 'parked', 3, 'x')`, [parkedId, job.kind, job.account_id, job.caravan_id, JSON.stringify(job.input)]);
    const parked = await call(d, "GET", `/me/encounters/${parkedId}/replay`);
    expect(parked.statusCode).toBe(409);
    expect(parked.json().error).toBe("resolution_unavailable");
  });

  it("S1: a fight resolved by a resolver that writes no tick log (the test double) is renderable: false with an honest reason — never 410 'past retention'", async () => {
    const job = (await getJob(pool, jobId))!;
    const noLogId = jobId.replace(/:1$/, ":9");
    await pool.query(
      `INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts, status, attempts, result, completed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 3, 'completed', 1, $6::jsonb, now())`,
      [noLogId, job.kind, job.account_id, job.caravan_id, JSON.stringify(job.input), JSON.stringify({ ...(job.result as object), resolver: "test-double", replay: null })],
    );
    const res = await call(d, "GET", `/me/encounters/${noLogId}/replay`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ renderable: false, log: null, outcome: expect.any(Object) });
    expect(res.json().reason).toMatch(/no tick log was recorded .* 'test-double'/);
  });
});

describe("encounter_log guards, retention and the content stamp", () => {
  const anyRow = async () => (await pool.query<{ job_id: string; caravan_id: string; defender_account_id: string; party_owner_account_id: string }>("SELECT job_id, caravan_id, defender_account_id, party_owner_account_id FROM encounter_log ORDER BY created_at LIMIT 1")).rows[0]!;

  it("S4: as the app role a stored log can be neither rewritten, nor deleted, nor inserted — DELETE + forged INSERT is refused", async () => {
    const r = await anyRow();
    const upd = await expectDbError(appRole, "UPDATE encounter_log SET raw_bytes = raw_bytes + 1 WHERE job_id = $1", [r.job_id]);
    expect(upd?.code).toBe("42501");
    const del = await expectDbError(appRole, "DELETE FROM encounter_log WHERE job_id = $1", [r.job_id]);
    expect(del?.code).toBe("42501");
    const forged = await expectDbError(
      appRole,
      `INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log, raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash)
       VALUES ($1, $2, $3, $4, 1, 2, 'gzip', '\\x00'::bytea, 1, 1, $5, 'x', 'x', 'x', 'x')`,
      [r.job_id, r.caravan_id, r.defender_account_id, r.party_owner_account_id, "0".repeat(64)],
    );
    expect(forged?.code).toBe("42501");
    // The QA's forge.sql in one transaction: refused at the DELETE, nothing changes.
    const client = await appRole.connect();
    try {
      await client.query("BEGIN");
      const e = await client.query("DELETE FROM encounter_log WHERE job_id = $1", [r.job_id]).then(() => null, (err: Error & { code?: string }) => err);
      expect(e?.code).toBe("42501");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect((await pool.query("SELECT 1 FROM encounter_log WHERE job_id = $1", [r.job_id])).rowCount).toBe(1);
    // The retention row is read-only for the app too.
    expect((await expectDbError(appRole, "UPDATE encounter_log_retention SET days = 0"))?.code).toBe("42501");
    expect((await expectDbError(appRole, "DELETE FROM encounter_log_retention"))?.code).toBe("42501");
  });

  it("S4: even the owner cannot delete a replay inside the retention window or insert one for a job that is not being completed", async () => {
    const r = await anyRow();
    const del = await expectDbError(pool, "DELETE FROM encounter_log WHERE job_id = $1", [r.job_id]);
    expect(del?.message).toMatch(/retention window/);
    const ins = await expectDbError(
      pool,
      `INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log, raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash)
       SELECT $1, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log, raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash FROM encounter_log WHERE job_id = $2`,
      [r.job_id.replace(/:\d+$/, ":42"), r.job_id],
    );
    expect(ins?.message).toMatch(/no such resolution job/);
  });

  it("S4: encounter_log_write — only with the job's live lease, only with the job's own caravan / accounts / version / stamp, only once; a row planted before completion makes the completion FAIL, never stand in for the real log", async () => {
    const d = await makeDefender();
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`)).statusCode).toBe(201);
    const { jobId: id } = await fight(d, 1);
    const job = (await getJob(pool, id))!;
    const input = job.input as EncounterJobInput;
    const write = (o: Partial<Record<"worker" | "attempts" | "caravan" | "defender" | "owner" | "version" | "hash", unknown>> = {}) =>
      expectDbError(appRole, "SELECT encounter_log_write($1, $2, $3, $4, $5, $6, $7, 2, 'gzip', '\\x00'::bytea, 1, $8, 'x', 'x', 'x', $9)", [
        id, o.worker ?? "probe", o.attempts ?? 1, o.caravan ?? input.defenderCaravanId, o.defender ?? input.defenderAccountId, o.owner ?? input.partyOwnerAccountId, o.version ?? RESOLVER_VERSION, "0".repeat(64), o.hash ?? input.contentHash,
      ]);
    // Queued: nobody holds a lease.
    expect((await write())?.message).toMatch(/live lease/);
    const leased = (await leaseNextJob(appRole, "probe", 60_000))!;
    expect(leased.id).toBe(id);
    expect((await write({ worker: "someone-else" }))?.message).toMatch(/live lease/);
    expect((await write({ attempts: 2 }))?.message).toMatch(/live lease/);
    const other = await registerPlayer();
    expect((await write({ caravan: other.caravanId }))?.message).toMatch(/caravan and account ids/);
    expect((await write({ defender: other.accountId }))?.message).toMatch(/caravan and account ids/);
    expect((await write({ owner: other.accountId }))?.message).toMatch(/caravan and account ids/);
    expect((await write({ version: 1 }))?.message).toMatch(/resolver_version/);
    expect((await write({ hash: "f".repeat(64) }))?.message).toMatch(/content_hash/);
    // A consistent forgery by a caller holding the lease goes in once…
    expect(await write()).toBeNull();
    expect((await write())?.code).toBe("23505");
    await markJobFailed(appRole, id, leased.attempts, "probe gave up", { workerId: "probe", backoffMs: 0 });
    // …and then the real worker's completion fails on it (no ON CONFLICT DO NOTHING): the job never completes over a planted log.
    const outcome = await runOnce(pool, { workerId: "real", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.error : "").toMatch(/duplicate key|encounter_log_pkey/);
    expect((await getJob(pool, id))!.status).not.toBe("completed");
    // Park it so later drains in this file see an empty queue.
    await drain(pool, { workerId: "real", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 });
    expect((await getJob(pool, id))!.status).toBe("parked");
  });

  it("LOG_RETENTION: older than 30 days AND outside the caravan's newest 50 is pruned; either window alone keeps it — on the database clock, by the app role, through encounter_log_prune only", async () => {
    expect(retentionMatchesTunables(await encounterLogRetention(pool))).toBe(true);
    expect(await encounterLogRetention(pool)).toEqual({ days: TUNABLES.LOG_RETENTION_DAYS, minPerCaravan: TUNABLES.LOG_RETENTION_MIN_PER_CARAVAN });
    const d = await registerPlayer();
    const mk = async (k: number, ageDays: number) => {
      const id = `encounter:00000000-0000-4000-8000-${String(k).padStart(12, "0")}:1`;
      await pool.query("INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts) VALUES ($1, 'encounter_resolution', $2, $3, $4::jsonb, 3)", [id, d.accountId, d.caravanId, JSON.stringify({ resolverVersion: RESOLVER_VERSION })]);
      // Backdated rows can only be made by the owner with the guards off (the insert guard stamps now()).
      await ownerUnguarded(
        `INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log, raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash, created_at)
         VALUES ($1, $2, $3, $3, $4, 2, 'gzip', '\\x00'::bytea, 1, 1, 'x', 'x', 'x', 'x', 'x', now() - make_interval(days => $5::int))`,
        [id, d.caravanId, d.accountId, RESOLVER_VERSION, ageDays],
      );
      return id;
    };
    // 52 logs, all 40+ days old except the newest two (1 day old).
    const ids: string[] = [];
    for (let k = 0; k < 50; k++) ids.push(await mk(k, 40 + k));
    ids.push(await mk(50, 1));
    ids.push(await mk(51, 1));
    const count = async () => Number((await pool.query("SELECT count(*) FROM encounter_log WHERE caravan_id = $1", [d.caravanId])).rows[0].count);
    // The delete guard holds even for the owner: an old row among the newest 50 stays.
    expect((await expectDbError(pool, "DELETE FROM encounter_log WHERE job_id = $1", [ids[10]]))?.message).toMatch(/newest 50/);
    expect(await pruneEncounterLogs(appRole, d.caravanId)).toBe(2); // the two oldest fall outside the newest 50
    expect(await count()).toBe(50);
    expect(await pruneEncounterLogs(appRole, d.caravanId)).toBe(0); // the newest 50 stay however old
  });

  it("D3: the content stamp hashes stats only — a description-only edit leaves it unchanged, a stat edit changes it", () => {
    expect(resolutionContentHash()).toBe(RESOLUTION_CONTENT_HASH);
    const u0 = CONTENT.units[0]!;
    const copy = { ...CONTENT, units: [{ ...u0, displayName: "Renamed", flavor: "Reworded", ability: { ...u0.ability, description: "A new description." } }, ...CONTENT.units.slice(1)] };
    expect(resolutionContentHash(copy as typeof CONTENT)).toBe(RESOLUTION_CONTENT_HASH);
    const stat = { ...CONTENT, units: [{ ...u0, hp: u0.hp + 1 }, ...CONTENT.units.slice(1)] };
    expect(resolutionContentHash(stat as typeof CONTENT)).not.toBe(RESOLUTION_CONTENT_HASH);
  });

  it("S3: a job stamped with other content is refused by the adapter (retryable, not parked as a bad fight)", async () => {
    const r = await pool.query<{ id: string }>("SELECT id FROM resolution_job WHERE status = 'completed' AND input ? 'survivors' LIMIT 1");
    const job = (await getJob(pool, r.rows[0]!.id))!;
    const input = { ...(job.input as Record<string, unknown>), contentHash: "0".repeat(64) };
    expect(() => resolveWithResolver(resolverInputFromJob(input))).toThrow(ContentHashMismatchError);
    const handler = makeEncounterResolutionHandler(productionEncounterResolver);
    expect(() => handler({ id: job.id, kind: job.kind, accountId: job.account_id, caravanId: job.caravan_id, input: input as never })).toThrow(ContentHashMismatchError);
    const { contentHash: _drop, ...unstamped } = input;
    expect(() => resolveWithResolver(resolverInputFromJob(unstamped))).toThrow(/none stamped/);
    // The real stamp resolves, and the battlefield is built from the job's own snapshots.
    const ok = resolverInputFromJob(job.input as Record<string, unknown>);
    expect(toBattlefield(ok.survivors, ok.formation).posts.length).toBe(ok.formation.posts.length);
  });
});

/**
 * QA-13 S1: a running server resolves encounters itself — the in-process worker (jobs/inProcessWorker.ts)
 * with the REAL resolver, no `drain` call from the test. index.ts builds the app with `encounterWorker: true`.
 */
describe("S1: the server's in-process worker resolves committed encounters with the real resolver", () => {
  const until = async (jobId: string, ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const job = (await getJob(pool, jobId))!;
      if (job.status === "completed" || job.status === "parked" || Date.now() > deadline) return job;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("a commit is kicked straight to the worker (poll interval far away) and the replay is renderable", async () => {
    const live = await buildApp({ db: appRole, encounterWorker: { pollMs: 600_000 } });
    await live.ready();
    try {
      expect(live.encounterWorker?.name).toBe("resolver");
      const d = await makeDefender();
      expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`)).statusCode).toBe(201);
      const { jobId } = await fight(d, 1, live);
      const job = await until(jobId, 15_000);
      expect(job.status, job.last_error ?? "").toBe("completed");
      expect((job.result as { resolver: string }).resolver).toBe("resolver");
      const replay = await live.inject({ method: "GET", url: `/me/encounters/${jobId}/replay`, headers: { authorization: `Bearer ${d.token}` } });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ renderable: true, reason: null, resolverVersion: RESOLVER_VERSION });
    } finally {
      await live.close();
    }
  });

  it("a job committed elsewhere (no kick) is picked up by the poll", async () => {
    const live = await buildApp({ db: appRole, encounterWorker: { pollMs: 100 } });
    await live.ready();
    try {
      const d = await makeDefender();
      expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`)).statusCode).toBe(201);
      const { jobId } = await fight(d, 1); // committed through the worker-less app
      const job = await until(jobId, 15_000);
      expect(job.status, job.last_error ?? "").toBe("completed");
    } finally {
      await live.close();
    }
    // Closed: the loop is stopped (nothing left running against the pool).
  });

  it("is off unless asked for (tests drain by hand)", async () => {
    expect(app.encounterWorker).toBeNull();
  });
});

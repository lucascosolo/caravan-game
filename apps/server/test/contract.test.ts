/**
 * THE CLIENT–SERVER CONTRACT (chunk 08 QA D4). Every route the web client reads is called
 * here on a real seeded account, through the real app and the server's own DB role, and
 * each response body is written to `apps/web/src/test/contract/<name>.json`. The web suite
 * (`src/test/contract/contract.test.ts`) runs every file through the guard the client
 * uses for that route (`src/api/shapes.ts`) and fails on any rejection — so a server
 * change that drifts from what the client accepts fails `pnpm test`, as chunk 08's menu
 * drift (QA B1) should have. This test also runs the same guards in-process on the live
 * bodies, so the failure does not depend on which package's tests run first.
 *
 * Deterministic output: every `DEFAULT gen_random_uuid()` column draws from a sequence for
 * the duration of this file (restored after), so the seeded draws — the matchmaking menu,
 * the refugee offers — see the same ids every run; the JS clock is frozen (server routes
 * read `Date.now()`); arrays of objects are put in a content order; every id, hash and ISO
 * timestamp is renamed per file in order of first appearance; epoch-ms instants become
 * FIXED + 60 s × their rank in the file (their ORDER is the fact a client can rely on; the
 * distance to the database's own `now()` jitters by milliseconds). A rerun rewrites the
 * files byte-identically unless the server's answer changed — except the store and
 * cosmetics files, whose weekly rotation follows the real week: their CONTENT moves with the
 * calendar, their SHAPE (which the client's guards check) does not.
 */
import { entryBand, type PartyConfig } from "@caravan/circle";
import { readReplay, replaySeal, type ReplayLog } from "@caravan/resolver";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import { appendCoinCredits } from "../src/economy/coin.js";
import { appendEvents } from "../src/ledger/ledger.js";
import { DEFAULT_HANDLERS } from "../src/jobs/handlers/encounterResolution.js";
import { drain } from "../src/jobs/worker.js";
import { COMPACTED_OVER_BUDGET_REASON, NO_LOG_REASON } from "../src/routes/replay.js";
import { pruneEncounterLogs } from "../src/replay/store.js";
import { TUNABLES } from "@caravan/content";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { TRIP_CAP_REGEN_MS, TRIPS_PER_HOUR_CAP } from "../src/trip/cap.js";
import { appRolePool, testPool, truncateAll, seasonCaravan, servedNameOf } from "./helpers.js";
import { doubleHandlers } from "../src/dev/tripDouble.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../web/src/test/contract");

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: string[];
}

// ── normalisation ─────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{32}$|^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TOKEN_KEYS = new Set(["token"]);
let FROZEN_MS = 0;
const FIXED_MS = 1_790_000_000_000;
/** Durations measured against the database's clock: the value jitters by a few ms run to run. */
const JITTER_KEYS = /InMs$/;
/** Ledger sequence numbers depend on how many events earlier test files wrote to the shared database. */
const SEQ_KEYS = /^(seq|[a-z]+Seq)$/;

function collectSeqs(v: unknown, key: string, out: Set<number>): Set<number> {
  if (typeof v === "number" && SEQ_KEYS.test(key)) out.add(v);
  else if (Array.isArray(v)) for (const x of v) collectSeqs(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collectSeqs(x, k, out);
  return out;
}

/** Is this number an epoch-ms instant (the frozen clock ± a few years)? */
const isEpochMs = (v: number): boolean => Number.isInteger(v) && Math.abs(v - FROZEN_MS) < 5 * 365 * 86_400_000;

function blankIds(v: unknown): unknown {
  if (typeof v === "string") return UUID.test(v) || HEX.test(v) ? "<id>" : ISO.test(v) ? "<ts>" : v;
  if (Array.isArray(v)) return v.map(blankIds);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blankIds(x)]));
  return v;
}

/**
 * Chunk 22: a replay body's `log` and `labels` are positional — `units[i].u === i`, rows refer
 * to units, fences and traps by index, and the checksum covers the rows — so they keep the
 * server's order (and stay readable by `readReplay` after the renaming below).
 */
const KEEP_ORDER_KEYS = new Set(["log", "labels"]);

/** Arrays of objects carrying random ids are re-ordered by their content with the ids blanked, so the order is stable. */
function orderArrays(v: unknown, key = ""): unknown {
  if (KEEP_ORDER_KEYS.has(key)) return v;
  if (Array.isArray(v)) {
    const items = v.map((x) => orderArrays(x));
    if (items.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const hasRandomId = items.some((x) => Object.values(x as object).some((y) => typeof y === "string" && UUID.test(y)));
      if (hasRandomId) return [...items].sort((a, b) => (JSON.stringify(blankIds(a)) < JSON.stringify(blankIds(b)) ? -1 : JSON.stringify(blankIds(a)) > JSON.stringify(blankIds(b)) ? 1 : 0));
    }
    return items;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, orderArrays(x, k)]));
  return v;
}

function collectEpochs(v: unknown, out: Set<number>): Set<number> {
  if (typeof v === "number" && isEpochMs(v)) out.add(v);
  else if (Array.isArray(v)) for (const x of v) collectEpochs(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectEpochs(x, out);
  return out;
}

function normalise(body: unknown): unknown {
  const epochs = [...collectEpochs(body, new Set())].sort((a, b) => a - b);
  const rank = new Map(epochs.map((v, i) => [v, FIXED_MS + i * 60_000]));
  const seqs = [...collectSeqs(body, "", new Set())].sort((a, b) => a - b);
  const seqRank = new Map(seqs.map((v, i) => [v, i + 1]));
  const uuids = new Map<string, string>();
  const hexes = new Map<string, string>();
  const isos = new Map<string, string>();
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      if (TOKEN_KEYS.has(key)) return "<token>";
      if (UUID.test(v)) {
        if (!uuids.has(v)) uuids.set(v, `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`);
        return uuids.get(v)!;
      }
      if (HEX.test(v)) {
        if (!hexes.has(v)) hexes.set(v, String(hexes.size + 1).padStart(v.length, "0").replace(/^0/, "a"));
        return hexes.get(v)!;
      }
      if (ISO.test(v)) {
        if (!isos.has(v)) isos.set(v, new Date(Date.UTC(2026, 9, 11, 12, 0, isos.size)).toISOString());
        return isos.get(v)!;
      }
      // Ids embedded in text (an issue message, a causation id).
      return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => {
        if (!uuids.has(m)) uuids.set(m, `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`);
        return uuids.get(m)!;
      });
    }
    if (typeof v === "number" && SEQ_KEYS.test(key) && seqRank.has(v)) return seqRank.get(v)!;
    if (typeof v === "number") return isEpochMs(v) ? rank.get(v)! : JITTER_KEYS.test(key) && v > 0 ? 1_000 : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return resealReplay(walk(orderArrays(body), ""));
}

/**
 * QA-13 S3: LOG_FORMAT v2's seal covers the labels (refs are uuids), so a renamed log is re-sealed —
 * exactly what a forger would do; the web plays the fixture with readReplay, and the server's own
 * sha256 check (not exercised by a fixture) is what tells a forged log from the stored one.
 */
function resealReplay(body: unknown): unknown {
  const log = (body as { log?: unknown } | null)?.log as (ReplayLog & Record<string, unknown>) | null | undefined;
  if (log && typeof log === "object" && log.format === "caravan-replay") return { ...(body as object), log: { ...log, check: replaySeal(log) } };
  return body;
}

/**
 * Chunk 29: an inbox item's key embeds a window index or an instant and its version is a
 * ledger seq or an instant — values that move with the calendar and with earlier test files.
 * They are renamed by position (the key keeps its category prefix) so a rerun is byte-identical.
 */
function stableInbox(body: unknown): unknown {
  const b = body as { items: { key: string; version: number }[] };
  return { ...b, items: b.items.map((it, i) => ({ ...it, key: `${it.key.split(":")[0]}:${i + 1}`, version: i + 1 })) };
}

// ── the recorded routes ───────────────────────────────────────────────────────────────

const recorded = new Map<string, { route: string; status: number; body: unknown }>();

async function record(name: string, route: string, res: LightMyRequestResponse, status: number): Promise<unknown> {
  expect(res.statusCode, `${route}: ${res.body}`).toBe(status);
  const body = res.json();
  recorded.set(name, { route, status, body });
  return body;
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

async function register(username: string): Promise<Player & { auth: LightMyRequestResponse }> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username, password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: [], auth: res };
}

async function giveUnits(p: Player, typeIds: readonly string[], mergeLevel = 1): Promise<string[]> {
  const ids: string[] = [];
  for (const unitTypeId of typeIds) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId, mergeLevel })).id);
  p.units.push(...ids);
  return ids;
}

const EDGES = ["north", "east", "south", "west"] as const;
function partyOf(units: readonly string[]): PartyConfig {
  const stances = ["nearest", "traps", "core"] as const;
  return { v: 1, units: units.map((ref, i) => ({ ref, stance: stances[i % 3]!, edge: EDGES[i % 4]!, cell: entryBand(EDGES[i % 4]!)[3 + i]! })), siege: ["siege.battering_wagon"] };
}

/** Columns whose `gen_random_uuid()` default this file swaps for a sequence (restored in afterAll). */
let uuidColumns: { table: string; column: string }[] = [];

beforeAll(async () => {
  FROZEN_MS = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_MS });
  await truncateAll(pool);
  // Test database only (owner role): deterministic ids for this file's rows.
  await pool.query("DROP SEQUENCE IF EXISTS contract_uuid_seq CASCADE");
  await pool.query("CREATE SEQUENCE contract_uuid_seq");
  await pool.query("GRANT USAGE ON SEQUENCE contract_uuid_seq TO caravan_app");
  await pool.query("CREATE OR REPLACE FUNCTION contract_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(nextval('contract_uuid_seq')), 12, '0'))::uuid $$");
  uuidColumns = (
    await pool.query<{ table: string; column: string }>(
      "SELECT table_name AS table, column_name AS column FROM information_schema.columns WHERE table_schema = 'public' AND column_default = 'gen_random_uuid()'",
    )
  ).rows;
  for (const c of uuidColumns) await pool.query(`ALTER TABLE "${c.table}" ALTER COLUMN "${c.column}" SET DEFAULT contract_uuid()`);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
});

afterAll(async () => {
  vi.useRealTimers();
  for (const c of uuidColumns) await pool.query(`ALTER TABLE "${c.table}" ALTER COLUMN "${c.column}" SET DEFAULT gen_random_uuid()`);
  await pool.query("DROP FUNCTION IF EXISTS contract_uuid()");
  await pool.query("DROP SEQUENCE IF EXISTS contract_uuid_seq");
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("client–server contract (chunk 08 QA D4)", () => {
  it("records every client-consumed route on a real account", async () => {
    // Three standing parties exactly: the draw's membership cannot vary run to run.
    const owners: Player[] = [];
    for (const name of ["contract_owner_a", "contract_owner_b", "contract_owner_c"]) {
      const o = await register(name);
      const ids = await giveUnits(o, ["desert.dust_rider", "desert.well_digger"]);
      const res = await call(o, "PUT", "/me/party", partyOf(ids));
      if (owners.length === 0) await record("party-put", "PUT /me/party", res, 200);
      else expect(res.statusCode).toBe(200);
      owners.push(o);
    }
    await record("party", "GET /me/party", await call(owners[0]!, "GET", "/me/party"), 200);
    await record("party-feed", "GET /me/party/feed", await call(owners[0]!, "GET", "/me/party/feed"), 200);

    const p = await register("contract_player");
    recorded.set("auth", { route: "POST /auth/register", status: 201, body: p.auth.json() });
    await record("auth-login", "POST /auth/login", await app.inject({ method: "POST", url: "/auth/login", payload: { username: "contract_player", password: "correct horse battery" } }), 200);
    const riders = await giveUnits(p, ["desert.dust_rider", "desert.dust_rider", "desert.dust_rider"]);

    await record("me", "GET /me", await call(p, "GET", "/me"), 200);
    // Chunk 24: the first-session guide (a fresh account starts at the first screen).
    await record("onboarding", "GET /me/onboarding", await call(p, "GET", "/me/onboarding"), 200);
    await record("onboarding-advance", "POST /me/onboarding/advance", await call(p, "POST", "/me/onboarding/advance", { step: "roster" }), 200);
    await record("onboarding-skip", "POST /me/onboarding/skip", await call(p, "POST", "/me/onboarding/skip"), 200);
    const unlocks = (await record("unlocks", "GET /me/unlocks", await call(p, "GET", "/me/unlocks"), 200)) as { webs: { pool: string; nodes: { id: string; reached: boolean; prerequisitesMet: boolean; cost: number }[] }[] };
    await record("progression", "GET /me/progression", await call(p, "GET", "/me/progression"), 200);

    // A spend needs points, which only a ladder rung grants: the fixture writes that event.
    const living = unlocks.webs.find((w) => w.pool === "living")!;
    const next = living.nodes.find((n) => !n.reached && n.prerequisitesMet)!;
    await withTransaction(pool, (c) =>
      appendEvents(c, `test:contract:grant:${p.accountId}`, [{ type: "unlock_points_granted", accountId: p.accountId, caravanId: p.caravanId, payload: { pool: "living", points: next.cost, rung: 20 } }]),
    );
    await record("unlocks-spend", "POST /me/unlocks/spend", await call(p, "POST", "/me/unlocks/spend", { pool: "living", nodeId: next.id, caravanId: p.caravanId }), 201);

    // Town: economy, merge preview, refugees, recruit, store, cosmetics.
    await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:contract:coin:${p.accountId}`, accountId: p.accountId, credits: [{ amount: 1_000, reason: "test_setup" }] }));
    await record("economy", "GET /me/economy", await call(p, "GET", "/me/economy"), 200);
    await record("merge-preview", "POST /me/caravans/:id/merge/preview", await call(p, "POST", `/me/caravans/${p.caravanId}/merge/preview`, { instanceIds: riders.slice(0, 2) }), 200);
    await record("refugees", "GET /me/caravans/:id/refugees", await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`), 200);
    await record("recruit", "GET /me/caravans/:id/recruit", await call(p, "GET", `/me/caravans/${p.caravanId}/recruit`), 200);
    const store = (await record("store", "GET /me/store", await call(p, "GET", "/me/store"), 200)) as { week: { index: number }; offers: { tier: number; contentsHash: string }[] };
    await record("cosmetics", "GET /me/cosmetics", await call(p, "GET", "/me/cosmetics"), 200);

    // The trail: pack, ride out (chunk 15's start), search, read, choose, arrange, commit.
    // Chunk 23 QA S4: a merged veteran rides too, so the de-merge it takes for dying shows a
    // real level change (3 → 2 on the bank, 2 → 1 on the overrun), not just the level-1 floor.
    const [veteran] = await giveUnits(p, ["desert.dust_rider"], 3);
    const posted = [...riders.slice(0, 2), veteran!];
    // N10 (final play-test review): nothing packed yet is an empty state, 200.
    await record("manifest-empty", "GET /caravans/:id/manifest (nothing packed)", await call(p, "GET", `/caravans/${p.caravanId}/manifest`), 200);
    await record("manifest-pack", "POST /caravans/:id/manifest", await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: posted, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } }), 201);
    await record("manifest", "GET /caravans/:id/manifest", await call(p, "GET", `/caravans/${p.caravanId}/manifest`), 200);
    const tripUrl = `/me/caravans/${p.caravanId}/trip`;
    await record("trip-status-packed", "GET /me/caravans/:id/trip", await call(p, "GET", tripUrl), 200);
    await seasonCaravan(pool, p.caravanId); // r2 S2: after recording the in-town status, so the trip started next is the caravan's second and serves the contract owners (live parties)
    const started = (await record("trip-start", "POST /me/caravans/:id/trip/start", await call(p, "POST", `${tripUrl}/start`), 201)) as { tripId: string };
    // N10: before the first search the candidates read is an empty state, 200.
    await record("candidates-empty", "GET /me/caravans/:id/encounters/:n/candidates (not searched yet)", await call(p, "GET", `/me/caravans/${p.caravanId}/encounters/1/candidates`), 200);
    const search = (await record("search", "POST /me/caravans/:id/encounters/:n/search", await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/1/search`), 201)) as { menu: { candidates: { candidateId: string; owner: { displayName: string } }[] } };
    await record("candidates", "GET /me/caravans/:id/encounters/:n/candidates", await call(p, "GET", `/me/caravans/${p.caravanId}/encounters/1/candidates`), 200);
    const first = [...search.menu.candidates].sort((a, b) => (a.owner.displayName < b.owner.displayName ? -1 : 1))[0]!;
    await record("choose", "POST /me/caravans/:id/encounters/:n/choose", await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/1/choose`, { candidateId: first.candidateId }), 200);
    const ordered = [...posted].sort();
    const formation = {
      v: 2,
      fences: [{ ref: "f0", segment: 0 }],
      traps: [{ ref: "t0", cell: { x: 14, y: 12 } }],
      posts: ordered.map((ref, i) => ({ ref, cell: { x: 13 + i * 5, y: 13 }, stance: i === 0 ? "hold" : "guard" })),
    };
    await record("formation-put", "PUT /caravans/:id/encounters/:n/formation", await call(p, "PUT", `/caravans/${p.caravanId}/encounters/1/formation`, formation), 200);
    await record("formation", "GET /caravans/:id/encounters/:n/formation", await call(p, "GET", `/caravans/${p.caravanId}/encounters/1/formation`), 200);
    await record("formation-commit", "POST /caravans/:id/encounters/:n/formation/commit", await call(p, "POST", `/caravans/${p.caravanId}/encounters/1/formation/commit`), 200);

    // Chunk 23: the trip loop's routes as the trip client reads them, resolved by chunk 15's
    // deterministic double (encounter 1: held, every post takes 150, the trap fires, the fence
    // breaks; encounter 2: held, but the veteran dies — chunk 23 QA S1/S2/S4: a death the caravan
    // survives, so the preview, the bank and the banked ending all carry a de-merge).
    const resolve = (plans: Parameters<typeof doubleHandlers>[0], fallback?: Parameters<typeof doubleHandlers>[1]) =>
      drain(appRole, { workerId: "contract", handlers: doubleHandlers(plans, fallback), retryBackoffMs: () => 0 });
    await record("trip-commit", "POST /me/caravans/:id/trip/encounters/:n/commit", await call(p, "POST", `${tripUrl}/encounters/1/commit`), 202);
    await record("trip-status-resolving", "GET /me/caravans/:id/trip", await call(p, "GET", tripUrl), 200);
    await resolve({ 1: { kind: "caravan_held", unitDamage: 150, spendTraps: 1, fenceDamage: 1_000_000 } });
    await record("trip-status-decide", "GET /me/caravans/:id/trip", await call(p, "GET", tripUrl), 200);
    await record("trip-preview", "GET /me/caravans/:id/trip/preview", await call(p, "GET", `${tripUrl}/preview`), 200);
    await record("trip-push", "POST /me/caravans/:id/trip/push", await call(p, "POST", `${tripUrl}/push`, { tripId: started.tripId, encounterIndex: 1 }), 200);

    // Encounter 2 (a fourth party stands now: the first opponent is a recent one and is not served again).
    const d = await register("contract_owner_d");
    expect((await call(d, "PUT", "/me/party", partyOf(await giveUnits(d, ["desert.dust_rider", "desert.well_digger"])))).statusCode).toBe(200);
    const s2 = (await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/2/search`)).json() as { menu: { candidates: { candidateId: string; owner: { displayName: string } }[] } };
    const c2 = [...s2.menu.candidates].sort((a, b) => (a.owner.displayName < b.owner.displayName ? -1 : 1))[0]!;
    expect((await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/2/choose`, { candidateId: c2.candidateId })).statusCode).toBe(200);
    const formation2 = { v: 2, fences: [{ ref: "f1", segment: 1 }], traps: [], posts: formation.posts };
    expect((await call(p, "PUT", `/caravans/${p.caravanId}/encounters/2/formation`, formation2)).statusCode).toBe(200);
    expect((await call(p, "POST", `${tripUrl}/encounters/2/commit`)).statusCode).toBe(202);
    await resolve({ 2: { kind: "caravan_held", unitDamage: 150, kill: [veteran!] } });
    await record("trip-preview-2", "GET /me/caravans/:id/trip/preview", await call(p, "GET", `${tripUrl}/preview`), 200);
    await record("trip-bank", "POST /me/caravans/:id/trip/bank", await call(p, "POST", `${tripUrl}/bank`, { tripId: started.tripId, encounterIndex: 2 }), 200);
    const banked = (await record("trip-status-banked", "GET /me/caravans/:id/trip", await call(p, "GET", tripUrl), 200)) as { trip: { encounters: { result: { jobId: string } | null }[] } };
    const doubleJobId = banked.trip.encounters[0]!.result!.jobId;

    // A second trip that is overrun at its first encounter (a fifth party: two are recent opponents now).
    const e = await register("contract_owner_e");
    expect((await call(e, "PUT", "/me/party", partyOf(await giveUnits(e, ["desert.dust_rider", "desert.well_digger"])))).statusCode).toBe(200);
    expect((await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: posted, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } })).statusCode).toBe(201);
    expect((await call(p, "POST", `${tripUrl}/start`)).statusCode).toBe(201);
    const s3r = await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/1/search`);
    expect(s3r.statusCode, s3r.body).toBe(201);
    const s3 = s3r.json() as { menu: { candidates: { candidateId: string; owner: { displayName: string } }[] } };
    const c3 = [...s3.menu.candidates].sort((a, b) => (a.owner.displayName < b.owner.displayName ? -1 : 1))[0]!;
    expect((await call(p, "POST", `/me/caravans/${p.caravanId}/encounters/1/choose`, { candidateId: c3.candidateId })).statusCode).toBe(200);
    expect((await call(p, "PUT", `/caravans/${p.caravanId}/encounters/1/formation`, formation)).statusCode).toBe(200);
    expect((await call(p, "POST", `${tripUrl}/encounters/1/commit`)).statusCode).toBe(202);
    // The veteran (level 2 since the bank) dies in the fight the caravan falls in: de-merged to 1, not destroyed.
    await resolve({ 1: { kind: "caravan_overrun", unitDamage: 400, kill: [veteran!] } });
    await record("trip-status-overrun", "GET /me/caravans/:id/trip", await call(p, "GET", tripUrl), 200);

    // The cap: one more use spent (fixture: the owner role moves the stored timestamp forward
    // as a third start would), then the start refusal the client reads `cap` / `retryAfterSeconds` from.
    await pool.query("UPDATE trip_cap SET tat_ms = $2 WHERE account_id = $1", [p.accountId, FROZEN_MS + TRIPS_PER_HOUR_CAP * TRIP_CAP_REGEN_MS]);
    // Chunk 19: units standing when the caravan fell are destroyed, so pack what survives.
    const left = (await pool.query<{ id: string }>("SELECT id FROM unit_instance WHERE caravan_id = $1 ORDER BY id LIMIT 1", [p.caravanId])).rows.map((r) => r.id);
    expect(left.length, "the overrun left at least one unit (the one that died in the fight is de-merged, not destroyed)").toBeGreaterThan(0);
    expect((await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: left, traps: [], fence: null })).statusCode).toBe(201);
    await record("trip-start-refused", "POST /me/caravans/:id/trip/start", await call(p, "POST", `${tripUrl}/start`), 409);

    // The storefront's writes (chunk 20 web screens), recorded LAST so the rows they insert do
    // not shift the sequence-drawn ids (and so the seeds) of the trail fixtures above: buy
    // tier 1, buy it again (the 200 replay), the purchase list, then equip and unequip the
    // first cosmetic the purchase granted.
    const tier1 = store.offers.find((o) => o.tier === 1)!;
    const buy = { tier: 1, weekIndex: store.week.index, contentsHash: tier1.contentsHash };
    const bought = (await record("store-purchase", "POST /me/store/purchase", await call(p, "POST", "/me/store/purchase", buy), 201)) as { cosmeticsGranted: string[] };
    await record("store-purchase-replay", "POST /me/store/purchase (repeat)", await call(p, "POST", "/me/store/purchase", buy), 200);
    await record("store-purchases", "GET /me/store/purchases", await call(p, "GET", "/me/store/purchases"), 200);
    await record("cosmetics-owned", "GET /me/cosmetics (after a purchase)", await call(p, "GET", "/me/cosmetics"), 200);
    const granted = bought.cosmeticsGranted[0]!;
    const equipped = (await record("cosmetics-equip", "POST /me/cosmetics/equip", await call(p, "POST", "/me/cosmetics/equip", { cosmeticId: granted }), 200)) as { slot: string };
    await record("cosmetics-unequip", "POST /me/cosmetics/unequip", await call(p, "POST", "/me/cosmetics/unequip", { slot: equipped.slot }), 200);

    // Chunk 22: the replay route, recorded after the storefront for the same reason. A fight
    // the test double resolved has no log: 200, renderable false, no log, said why.
    const noLog = (await record("replay-no-log", "GET /me/encounters/:jobId/replay (double, no log)", await call(p, "GET", `/me/encounters/${encodeURIComponent(doubleJobId)}/replay`), 200)) as Record<string, unknown>;
    expect(noLog).toMatchObject({ viewer: "caravan", renderable: false, reason: NO_LOG_REASON, log: null, stored: null });
    // A fight the REAL resolver fought (a fresh caravan, its first encounter): what the replay
    // player plays, for the caravan's player and for the party's owner.
    // r2 N16: parties ride under their caravans' names.
    const byName = new Map<string, Player>();
    for (const [u, pl] of [...owners.map((o, i) => [`contract_owner_${"abc"[i]}`, o] as const), ["contract_owner_d", d] as const, ["contract_owner_e", e] as const]) byName.set(await servedNameOf(pool, u), pl);
    const v = await register("contract_viewer");
    await seasonCaravan(pool, v.caravanId); // r2 S2: not its first trip, so the contract owners are served
    const diggers = await giveUnits(v, ["desert.well_digger", "desert.well_digger"]);
    expect((await call(v, "POST", `/caravans/${v.caravanId}/manifest`, { units: diggers, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } })).statusCode).toBe(201);
    const vTrip = `/me/caravans/${v.caravanId}/trip`;
    expect((await call(v, "POST", `${vTrip}/start`)).statusCode).toBe(201);
    const sv = (await call(v, "POST", `/me/caravans/${v.caravanId}/encounters/1/search`)).json() as { menu: { candidates: { candidateId: string; owner: { displayName: string } }[] } };
    const cv = [...sv.menu.candidates].sort((a, b) => (a.owner.displayName < b.owner.displayName ? -1 : 1))[0]!;
    const fought = byName.get(cv.owner.displayName)!;
    expect(fought, cv.owner.displayName).toBeDefined();
    expect((await call(v, "POST", `/me/caravans/${v.caravanId}/encounters/1/choose`, { candidateId: cv.candidateId })).statusCode).toBe(200);
    const vPosts = [...diggers].sort().map((ref, i) => ({ ref, cell: { x: 13 + i * 5, y: 13 }, stance: i === 0 ? "hold" : "guard" }));
    const vFormation = { v: 2, fences: [0, 1, 2, 3, 4, 5].map((segment) => ({ ref: `f${segment}`, segment })), traps: [{ ref: "t0", cell: { x: 14, y: 12 } }], posts: vPosts };
    expect((await call(v, "PUT", `/caravans/${v.caravanId}/encounters/1/formation`, vFormation)).statusCode).toBe(200);
    const commit = (await call(v, "POST", `${vTrip}/encounters/1/commit`)).json() as { jobId: string };
    const replayUrl = `/me/encounters/${encodeURIComponent(commit.jobId)}/replay`;
    expect((await call(v, "GET", replayUrl)).statusCode).toBe(409);
    expect(await drain(appRole, { workerId: "contract-real", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 })).toHaveLength(1);
    // Chunk 22 QA S8: the trip loop folds the outcome in on the next read, so the replay's `settled` (ledger) is filled.
    expect((await call(v, "GET", vTrip)).statusCode).toBe(200);
    const mine =(await record("replay", "GET /me/encounters/:jobId/replay", await call(v, "GET", replayUrl), 200)) as { viewer: string; renderable: boolean; log: unknown };
    const theirs = (await record("replay-owner", "GET /me/encounters/:jobId/replay (party owner)", await call(fought, "GET", replayUrl), 200)) as { viewer: string; log: unknown };
    expect(mine).toMatchObject({ viewer: "caravan", renderable: true });
    expect(theirs.viewer).toBe("party_owner");
    // The recorded (renamed) log is still a valid replay: the web suite plays it.
    expect(() => readReplay((normalise(mine) as { log: unknown }).log)).not.toThrow();
    // Chunk 22 QA D1 / S8 / N10: siege and stance labels from the job's snapshots; the settled
    // itemization from the ledger, per viewer; the owner's body carries no trip id or stored block.
    const mineBody = mine as unknown as { labels: { siege: { typeId: string }[]; units: { side: string; stance: string | null }[] }; settled: { applied: boolean; reputation: unknown[] } };
    expect(mineBody.labels.siege.map((s) => s.typeId)).toEqual(["siege.battering_wagon"]);
    expect(mineBody.labels.units.every((u) => u.stance !== null)).toBe(true);
    expect(mineBody.settled.applied).toBe(true);
    expect(mineBody.settled.reputation.length).toBeGreaterThan(0);
    const theirsBody = theirs as unknown as Record<string, unknown> & { outcome: Record<string, unknown>; settled: { coin: { reason: string }[] } };
    expect(theirsBody).toMatchObject({ tripId: null, stored: null });
    expect("units" in theirsBody.outcome).toBe(false);
    expect(JSON.stringify(theirsBody.settled)).not.toContain(v.accountId);
    // D2: the caravan's fights within retention, newest first — the real-resolver one (a log) and the player's double-resolved ones (no log).
    const recent = (await record("encounters", "GET /me/encounters", await call(v, "GET", "/me/encounters"), 200)) as { encounters: { jobId: string; replay: string }[] };
    expect(recent.encounters).toEqual([expect.objectContaining({ jobId: commit.jobId, replay: "log" })]);
    const history = (await record("encounters-history", "GET /me/encounters (three fights, two trips)", await call(p, "GET", "/me/encounters"), 200)) as { encounters: { encounterIndex: number; replay: string }[] };
    expect(history.encounters.map((x) => [x.encounterIndex, x.replay])).toEqual([[1, "no_log"], [2, "no_log"], [1, "no_log"]]);

    // Chunk 15 QA D3 (+ N2), recorded LAST so its rows shift no earlier fixture's ids: a trip
    // whose second encounter cannot be resolved (the double's outcome is refused, so the job
    // parks) is VOIDED — banked as of encounter 1 (its Coin + the delivery, its merged unit's
    // death de-merged 2 → 1), nothing of encounter 2 applied, the trip-cap use kept spent. Its
    // preview before the first survival omits `bankNow` and `harderThanThisEncounter` (N2).
    const w = await register("contract_voider");
    await seasonCaravan(pool, w.caravanId); // r2 S2: not its first trip
    const [wVet] = await giveUnits(w, ["desert.dust_rider"], 2);
    const wRiders = await giveUnits(w, ["desert.dust_rider", "desert.dust_rider"]);
    const wUnits = [wVet!, ...wRiders];
    expect((await call(w, "POST", `/caravans/${w.caravanId}/manifest`, { units: wUnits, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } })).statusCode).toBe(201);
    const wTrip = `/me/caravans/${w.caravanId}/trip`;
    const wStartRes = await call(w, "POST", `${wTrip}/start`);
    expect(wStartRes.statusCode, wStartRes.body).toBe(201);
    const wStarted = wStartRes.json() as { tripId: string };
    const wPreview0 = (await record("trip-preview-start", "GET /me/caravans/:id/trip/preview (before the first survival)", await call(w, "GET", `${wTrip}/preview`), 200)) as Record<string, unknown> & {
      nextEncounter: { difficulty: Record<string, unknown> };
    };
    expect(wPreview0).toMatchObject({ encountersSurvived: 0, decisionOpen: false });
    expect("bankNow" in wPreview0).toBe(false);
    expect("harderThanThisEncounter" in wPreview0.nextEncounter.difficulty).toBe(false);
    const wPosts = [...wUnits].sort().map((ref, i) => ({ ref, cell: { x: 13 + i * 5, y: 13 }, stance: i === 0 ? "hold" : "guard" }));
    const wFight = async (n: number, wFormation: unknown): Promise<void> => {
      const sr = await call(w, "POST", `/me/caravans/${w.caravanId}/encounters/${n}/search`);
      expect(sr.statusCode, sr.body).toBe(201);
      const menu = sr.json() as { menu: { candidates: { candidateId: string; owner: { displayName: string } }[] } };
      const pick = [...menu.menu.candidates].sort((a, b) => (a.owner.displayName < b.owner.displayName ? -1 : 1))[0]!;
      expect((await call(w, "POST", `/me/caravans/${w.caravanId}/encounters/${n}/choose`, { candidateId: pick.candidateId })).statusCode).toBe(200);
      const put = await call(w, "PUT", `/caravans/${w.caravanId}/encounters/${n}/formation`, wFormation);
      expect(put.statusCode, put.body).toBe(200);
      const commit = await call(w, "POST", `${wTrip}/encounters/${n}/commit`);
      expect(commit.statusCode, commit.body).toBe(202);
    };
    await wFight(1, { v: 2, fences: [{ ref: "f0", segment: 0 }], traps: [{ ref: "t0", cell: { x: 14, y: 12 } }], posts: wPosts });
    await resolve({ 1: { kind: "caravan_held", unitDamage: 100, spendTraps: 1, kill: [wVet!] } });
    expect((await call(w, "POST", `${wTrip}/push`, { tripId: wStarted.tripId, encounterIndex: 1 })).statusCode).toBe(200);
    await wFight(2, { v: 2, fences: [{ ref: "f1", segment: 1 }], traps: [], posts: wPosts.filter((x) => x.ref !== wVet) });
    // An outcome that heals a unit is refused by the server (not retryable): the job parks.
    await resolve({ 2: { kind: "caravan_held", tamper: (o) => ({ ...o, units: o.units.map((u) => ({ ...u, hp: u.hp + 1 })) }) } });
    const voided = (await record("trip-status-voided", "GET /me/caravans/:id/trip (voided)", await call(w, "GET", wTrip), 200)) as {
      caravan: { state: string };
      trip: { endReason: string; phase: string; encounters: unknown[]; ending: Record<string, unknown> & { restored: { deMerged: unknown[] } } };
    };
    expect(voided.caravan.state).toBe("in_town");
    expect(voided.trip).toMatchObject({ endReason: "voided", phase: "ended" });
    expect(voided.trip.encounters).toHaveLength(1);
    expect(voided.trip.ending).toMatchObject({ kind: "voided", voidedEncounter: 2, encountersSurvived: 1 });
    expect(voided.trip.ending["credited"]).toBeGreaterThan(0);
    expect(voided.trip.ending.restored.deMerged).toEqual([{ ref: wVet, typeId: "desert.dust_rider", fromLevel: 2, toLevel: 1, diedAtEncounter: 1 }]);

    // Chunk 29: the inbox, recorded last for the same reason. The real-resolver fight above
    // struck `fought`'s party: its owner's inbox holds that strike batch (with the replay link).
    const ownerInbox = (await record("inbox", "GET /me/inbox", await call(fought, "GET", "/me/inbox"), 200)) as { items: { key: string; version: number; category: string; unread: boolean; detail: { strikes: { jobId: string }[] } }[]; unreadCount: number };
    expect(ownerInbox.items[0]).toMatchObject({ category: "party_strike", unread: true });
    expect(ownerInbox.items[0]!.detail.strikes.map((x) => x.jobId)).toContain(commit.jobId);
    expect(JSON.stringify(ownerInbox)).not.toContain(v.accountId);
    await record("inbox-unread", "GET /me/inbox/unread", await call(fought, "GET", "/me/inbox/unread"), 200);
    // Chunk 29 QA S4: one batch's lines on demand (the route an older batch's "Show the fights" calls).
    const strikesBody = (await record("inbox-strikes", "GET /me/inbox/strikes/:window", await call(fought, "GET", `/me/inbox/strikes/${ownerInbox.items[0]!.key.split(":")[1]}`), 200)) as { strikes: { jobId: string }[] };
    expect(strikesBody.strikes.map((x) => x.jobId)).toContain(commit.jobId);
    // QA S1: "Mark all read" sends the key and version of every unread item on screen.
    const shown = ownerInbox.items.filter((i) => i.unread).map((i) => ({ key: i.key, version: i.version }));
    await record("inbox-read", "POST /me/inbox/read", await call(fought, "POST", "/me/inbox/read", { marks: shown }), 200);
    // Every other category, on the player's own account two hours on (the frozen clock moves;
    // sessions expire by the database's clock): the trip cap is full again, the refugee drip
    // owes a free menu, and the balance is near the storage cap.
    await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:contract:inbox-mine:${p.accountId}`, accountId: p.accountId, credits: [{ amount: 48_000, reason: "test_setup" }] }));
    await pool.query("UPDATE trip_cap SET tat_ms = $2 WHERE account_id = $1", [p.accountId, FROZEN_MS + TRIPS_PER_HOUR_CAP * TRIP_CAP_REGEN_MS + 1]);
    vi.setSystemTime(FROZEN_MS + 2 * 3_600_000);
    const prefs = (await record(
      "inbox-preferences",
      "PUT /me/inbox/preferences",
      await call(p, "PUT", "/me/inbox/preferences", { preferences: { refugees_arrived: true, trip_cap_refilled: true, mine_near_cap: true, packs_rotated: true } }),
      200,
    )) as { items: { category: string }[] };
    expect(prefs.items.map((i) => i.category)).toEqual(expect.arrayContaining(["mine_near_cap", "refugees_arrived", "trip_cap_refilled"]));
    vi.setSystemTime(FROZEN_MS);
    for (const name of ["inbox", "inbox-read", "inbox-preferences"]) recorded.get(name)!.body = stableInbox(recorded.get(name)!.body);
    recorded.get("inbox-strikes")!.body = { ...(recorded.get("inbox-strikes")!.body as object), window: 1 };

    // Chunk 30: the account lifecycle — a guest's first launch, a reload, the Account screen, linking, devices, export, deletion.
    const guestRes = await app.inject({ method: "POST", url: "/auth/guest", payload: { region: "desert" } });
    const guestBody = (await record("auth-guest", "POST /auth/guest", guestRes, 201)) as { token: string };
    const guestCookie = String(([] as unknown[]).concat(guestRes.headers["set-cookie"])[0]).split(";")[0]!;
    await record("auth-resume", "POST /auth/resume", await app.inject({ method: "POST", url: "/auth/resume", payload: {}, headers: { cookie: guestCookie } }), 200);
    const g: Player = { token: guestBody.token, accountId: "", caravanId: "", units: [] };
    await record("account-guest", "GET /me/account", await call(g, "GET", "/me/account"), 200);
    await record("account-link", "POST /me/account/link", await call(g, "POST", "/me/account/link", { username: "contract_guest", password: "correct horse battery" }), 200);
    await record("account", "GET /me/account", await call(g, "GET", "/me/account"), 200);
    await record("devices", "GET /me/devices", await call(g, "GET", "/me/devices"), 200);
    await record("devices-revoke-others", "POST /me/devices/revoke-others", await call(g, "POST", "/me/devices/revoke-others"), 200);
    await record("export", "GET /me/export", await call(g, "GET", "/me/export"), 200);
    await record("account-delete", "POST /me/account/delete", await call(g, "POST", "/me/account/delete", { confirm: "delete my account", password: "correct horse battery" }), 200);

    // PHASE-2 §36, recorded last: the same real-resolver fight after its log was COMPACTED to its
    // results summary. The owner lowers the size budget for one prune of that caravan (the only way
    // to make a minutes-old log compactable without waiting 30 days), then restores it.
    await pool.query("UPDATE encounter_log_retention SET size_budget_bytes = 1024");
    try {
      expect(await pruneEncounterLogs(appRole, v.caravanId)).toBe(1);
    } finally {
      await pool.query("UPDATE encounter_log_retention SET size_budget_bytes = $1", [TUNABLES.LOG_SIZE_BUDGET_BYTES]);
    }
    const compacted = (await record("replay-compacted", "GET /me/encounters/:jobId/replay (log compacted, PHASE-2 §36)", await call(v, "GET", replayUrl), 200)) as Record<string, unknown>;
    expect(compacted).toMatchObject({ viewer: "caravan", renderable: false, reason: COMPACTED_OVER_BUDGET_REASON, log: null, outcome: (mine as unknown as { outcome: unknown }).outcome, compacted: { reason: "size_budget" } });

    // Write the fixtures (only when they changed, so a rerun leaves the tree clean).
    mkdirSync(OUT, { recursive: true });
    for (const [name, r] of recorded) {
      const file = path.join(OUT, `${name}.json`);
      const text = `${JSON.stringify({ route: r.route, status: r.status, body: normalise(r.body) }, null, 2)}\n`;
      if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
    }
    expect(recorded.size).toBeGreaterThanOrEqual(20);
  });

  it("every recorded body passes the client's own guard for its route (the web suite checks the written files too)", async () => {
    // Imported at run time so the server's typecheck never compiles the web package.
    const modPath = path.resolve(here, "../../web/src/test/contract/routes.ts");
    const { CONTRACT_GUARDS, checkContract } = (await import(/* @vite-ignore */ modPath)) as {
      CONTRACT_GUARDS: Record<string, unknown>;
      checkContract: (name: string, body: unknown) => string | null;
    };
    const failures: string[] = [];
    for (const [name, r] of recorded) {
      if (!(name in CONTRACT_GUARDS)) failures.push(`${name}: no entry in CONTRACT_GUARDS`);
      const why = checkContract(name, normalise(r.body));
      if (why) failures.push(`${name} (${r.route}): ${why}`);
    }
    expect(failures).toEqual([]);
  });
});

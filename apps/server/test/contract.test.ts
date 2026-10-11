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
import { createTrip } from "../src/matchmaking/trips.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { appRolePool, testPool, truncateAll } from "./helpers.js";

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

/** Arrays of objects carrying random ids are re-ordered by their content with the ids blanked, so the order is stable. */
function orderArrays(v: unknown): unknown {
  if (Array.isArray(v)) {
    const items = v.map(orderArrays);
    if (items.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const hasRandomId = items.some((x) => Object.values(x as object).some((y) => typeof y === "string" && UUID.test(y)));
      if (hasRandomId) return [...items].sort((a, b) => (JSON.stringify(blankIds(a)) < JSON.stringify(blankIds(b)) ? -1 : JSON.stringify(blankIds(a)) > JSON.stringify(blankIds(b)) ? 1 : 0));
    }
    return items;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, orderArrays(x)]));
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
  return walk(orderArrays(body), "");
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

async function giveUnits(p: Player, typeIds: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const unitTypeId of typeIds) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId, mergeLevel: 1 })).id);
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

    // The trail: pack, open the trip, search, read, choose, arrange, commit.
    const posted = riders.slice(0, 2);
    await record("manifest-pack", "POST /caravans/:id/manifest", await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: posted, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } }), 201);
    await record("manifest", "GET /caravans/:id/manifest", await call(p, "GET", `/caravans/${p.caravanId}/manifest`), 200);
    await withTransaction(pool, (c) => createTrip(c, p.caravanId));
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

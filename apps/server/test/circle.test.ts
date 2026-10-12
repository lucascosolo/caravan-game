/**
 * Chunk 07 server-side: the manifest/formation lifetimes, every validation rule enforced
 * at the HTTP boundary, the access seam, carry-forward through the database, and the
 * lock guards holding against the server's own role.
 */
import { TUNABLES } from "@caravan/content";
import { RING_ANCHORS, RING_SEGMENTS, formationFromJson, serializeFormation, type Formation } from "@caravan/circle";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { isUnlocked, unlockedTypeIds } from "../src/circle/access.js";
import { applyOutcome, battlefieldForEncounter, closeManifest, formationHash } from "../src/circle/service.js";
import { withTransaction } from "../src/db/pool.js";
import { createTrip } from "../src/matchmaking/trips.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique, commitFormationInTown } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: Record<string, string>;
}

async function registerPlayer(region = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("p"), password: "correct horse battery", region } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: {} };
}

async function giveUnit(p: Player, key: string, typeId: string, mergeLevel = 1): Promise<string> {
  const row = await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel });
  p.units[key] = row.id;
  return row.id;
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  // Chunk 15 QA N4: the raw commit route is trip-only now; chunk 07's model tests commit through the service.
  return commitFormationInTown(appRole, p.caravanId, method, url).then((r) => (r as unknown as LightMyRequestResponse | null) ?? app.inject(opts));
}

const STARTER_PACK = (p: Player) => ({
  units: [p.units["rider"], p.units["digger"]],
  traps: ["trap.spike_pit", "trap.spike_pit"],
  fence: { tierId: "fence.brush_pile", count: 10 },
});

/** Fences on `count` consecutive ring positions from `first`; traps and posts on inner cells. */
function arrangement(manifest: { units: { ref: string; hp: number }[]; traps: { ref: string; spent: boolean }[]; fences: { ref: string; hp: number }[] }, first = 0): Formation {
  const corner = RING_ANCHORS[0]!; // the north-west wagon anchor; inner cells start one in
  const cells: { x: number; y: number }[] = [];
  for (let y = corner.y + 1; y < corner.y + 4; y++) for (let x = corner.x + 1; x < corner.x + 8; x++) cells.push({ x, y });
  let i = 0;
  return {
    v: 2,
    fences: manifest.fences.filter((f) => f.hp > 0).map((f, k) => ({ ref: f.ref, segment: (first + k) % RING_SEGMENTS.length })),
    traps: manifest.traps.filter((t) => !t.spent).map((t) => ({ ref: t.ref, cell: cells[i++]! })),
    posts: manifest.units.filter((u) => u.hp > 0).map((u) => ({ ref: u.ref, cell: cells[i++]!, stance: "guard" as const })),
  };
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

describe("access seam (chunk 05's hasAccess behind chunk 07's isUnlocked)", () => {
  it("a fresh caravan has exactly the starting nodes, with living units scoped to the caravan's region", async () => {
    const desert = await registerPlayer("desert");
    const owner = { accountId: desert.accountId, caravanId: desert.caravanId, regionId: "desert" as const };
    expect([...(await unlockedTypeIds(pool, owner))].sort()).toEqual(["desert.dust_rider", "desert.well_digger", "fence.brush_pile", "siege.battering_wagon", "trap.spike_pit"]);
    expect(await isUnlocked(pool, owner, "desert.vaquero")).toBe(false);
    expect(await isUnlocked(pool, owner, "mountain.grizzly")).toBe(false);
    expect(await isUnlocked(pool, owner, "trap.powder_keg")).toBe(false);
    expect(await isUnlocked(pool, owner, "nobody.has_this")).toBe(false);
    const mountain = await registerPlayer("mountain");
    expect(await isUnlocked(pool, { accountId: mountain.accountId, caravanId: mountain.caravanId, regionId: "mountain" }, "mountain.grizzly")).toBe(true);
    expect(TUNABLES.STARTING_NODES.living).toBe(2);
  });
});

describe("packing and locking the manifest", () => {
  let p: Player;
  beforeAll(async () => {
    p = await registerPlayer();
    await giveUnit(p, "rider", "desert.dust_rider");
    await giveUnit(p, "digger", "desert.well_digger", 2);
    await giveUnit(p, "vaquero", "desert.vaquero");
  });

  it("refuses a type the access seam says is locked — even for a unit the caravan owns", async () => {
    const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { ...STARTER_PACK(p), units: [p.units["rider"], p.units["vaquero"]] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_manifest");
    expect(res.json().issues).toEqual([{ code: "type_locked", message: "living-unit type 'desert.vaquero' is not unlocked", subject: "desert.vaquero" }]);
  });

  it("refuses an unlocked-by-nobody trap type and a locked fence tier, by hand-crafted request", async () => {
    const trap = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { ...STARTER_PACK(p), traps: ["trap.powder_keg"] });
    expect(trap.statusCode).toBe(400);
    expect(trap.json().issues.map((i: { code: string }) => i.code)).toEqual(["type_locked"]);
    const fence = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { ...STARTER_PACK(p), fence: { tierId: "fence.stacked_stone", count: 1 } });
    expect(fence.statusCode).toBe(400);
    expect(fence.json().issues.map((i: { code: string }) => i.code)).toEqual(["type_locked"]);
  });

  it("enforces the slot caps and the material budget server-side", async () => {
    const many = Array.from({ length: TUNABLES.DEPLOYMENT_SLOT_CAP + 1 }, () => p.units["rider"]!);
    const units = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { ...STARTER_PACK(p), units: many });
    expect(units.statusCode).toBe(400);
    expect(units.json().issues.map((i: { code: string }) => i.code)).toContain("slot_cap_units");
    const traps = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { ...STARTER_PACK(p), traps: Array(TUNABLES.TRAP_SLOT_CAP + 1).fill("trap.spike_pit") });
    expect(traps.json().issues.map((i: { code: string }) => i.code)).toEqual(["slot_cap_traps"]);
    const fence = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { ...STARTER_PACK(p), fence: { tierId: "fence.brush_pile", count: TUNABLES.PERIMETER_SEGMENTS } });
    expect(fence.json().issues.map((i: { code: string }) => i.code)).toEqual(["fence_budget"]);
  });

  it("refuses a unit instance that is not in this caravan's roster", async () => {
    const other = await registerPlayer();
    const foreign = await giveUnit(other, "rider", "desert.dust_rider");
    const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { ...STARTER_PACK(p), units: [foreign] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_unit");
  });

  it("packs a legal loadout, locks it, and refuses a second one while the first is open", async () => {
    const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, STARTER_PACK(p));
    expect(res.statusCode).toBe(201);
    const m = res.json().manifest;
    expect(m.caravanId).toBe(p.caravanId);
    expect(m.encountersResolved).toBe(0);
    expect(m.packed).toEqual(m.survivors);
    expect(m.packed.units.map((u: { ref: string }) => u.ref).sort()).toEqual([p.units["rider"], p.units["digger"]].sort());
    expect(m.packed.traps).toHaveLength(2);
    expect(m.packed.fences).toHaveLength(10);
    expect(m.summary).toEqual({ unitsAlive: 2, unitsDead: 0, trapsUnspent: 2, trapsSpent: 0, fencesIntact: 10, fencesDestroyed: 0 });

    const again = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, STARTER_PACK(p));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("manifest_open");

    const get = await call(p, "GET", `/caravans/${p.caravanId}/manifest`);
    expect(get.statusCode).toBe(200);
    expect(get.json().manifest.id).toBe(m.id);
  });

  it("has no route that edits a manifest, and the database refuses to change `packed`", async () => {
    const m = (await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest;
    // DELETE is the unpack of a manifest that never rode out (final play-test review N9), tested below.
    for (const method of ["PUT", "PATCH"] as const) {
      const res = await app.inject({ method, url: `/caravans/${p.caravanId}/manifest`, headers: { authorization: `Bearer ${p.token}` }, payload: {} });
      expect(res.statusCode, method).toBe(404);
    }
    const asApp = await expectDbError(appRole, `UPDATE wagon_manifest SET packed = jsonb_set(packed, '{traps}', packed->'traps' || '[{"ref":"t9","typeId":"trap.spike_pit","spent":false}]'::jsonb) WHERE id = $1`, [m.id]);
    expect(asApp?.message).toMatch(/locked for the whole trip/);
    // survivors: nothing can be added either.
    const added = await expectDbError(appRole, `UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{traps}', survivors->'traps' || '[{"ref":"t9","typeId":"trap.spike_pit","spent":false}]'::jsonb) WHERE id = $1`, [m.id]);
    expect(added?.message).toMatch(/cannot be added or removed/);
    const del = await expectDbError(appRole, `DELETE FROM wagon_manifest WHERE id = $1`, [m.id]);
    expect(del?.message).toMatch(/trip history/);
  });

  it("N9: a caravan packed but not ridden out can be unpacked — the manifest closes unused, nothing is written to the ledger, the units are back on the roster; once it rode out, it cannot", async () => {
    const q = await registerPlayer();
    await giveUnit(q, "rider", "desert.dust_rider");
    await giveUnit(q, "digger", "desert.well_digger");
    const packed = await call(q, "POST", `/caravans/${q.caravanId}/manifest`, STARTER_PACK(q));
    expect(packed.statusCode).toBe(201);
    const ledgerBefore = (await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_event WHERE account_id = $1", [q.accountId])).rows[0]!.n;
    const unpack = await app.inject({ method: "DELETE", url: `/caravans/${q.caravanId}/manifest`, headers: { authorization: `Bearer ${q.token}` } });
    expect(unpack.statusCode).toBe(200);
    expect(unpack.json().unpacked.manifestId).toBe(packed.json().manifest.id);
    expect((await call(q, "GET", `/caravans/${q.caravanId}/manifest`)).json().manifest).toBeNull();
    expect((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_event WHERE account_id = $1", [q.accountId])).rows[0]!.n).toBe(ledgerBefore);
    const closed = await pool.query<{ closed_at: Date | null }>("SELECT closed_at FROM wagon_manifest WHERE id = $1", [packed.json().manifest.id]);
    expect(closed.rows[0]!.closed_at).not.toBeNull();
    // Nothing packed now: a second unpack is a 404; packing again works.
    expect((await app.inject({ method: "DELETE", url: `/caravans/${q.caravanId}/manifest`, headers: { authorization: `Bearer ${q.token}` } })).statusCode).toBe(404);
    const again = await call(q, "POST", `/caravans/${q.caravanId}/manifest`, STARTER_PACK(q));
    expect(again.statusCode).toBe(201);
    // Once it rode out (a trip row names the manifest), unpacking is refused.
    await withTransaction(pool, (c) => createTrip(c, q.caravanId));
    const refused = await app.inject({ method: "DELETE", url: `/caravans/${q.caravanId}/manifest`, headers: { authorization: `Bearer ${q.token}` } });
    expect(refused.statusCode).toBe(409);
    // Another account cannot unpack it.
    const other = await registerPlayer();
    expect((await app.inject({ method: "DELETE", url: `/caravans/${q.caravanId}/manifest`, headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(404);
  });

  it("another account's caravan is a 404 for every route", async () => {
    const other = await registerPlayer();
    for (const [method, url] of [
      ["GET", `/caravans/${p.caravanId}/manifest`],
      ["POST", `/caravans/${p.caravanId}/manifest`],
      ["PUT", `/caravans/${p.caravanId}/encounters/1/formation`],
      ["GET", `/caravans/${p.caravanId}/encounters/1/formation`],
      ["POST", `/caravans/${p.caravanId}/encounters/1/formation/commit`],
    ] as const) {
      const res = await call(other, method, url, {});
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error).toBe("no_caravan");
    }
    expect((await app.inject({ method: "GET", url: `/caravans/${p.caravanId}/manifest` })).statusCode).toBe(401);
  });
});

describe("arranging the formation per encounter, and carry-forward", () => {
  let p: Player;
  let manifestId: string;
  const url = (n: number, suffix = "") => `/caravans/${p.caravanId}/encounters/${n}/formation${suffix}`;

  beforeAll(async () => {
    p = await registerPlayer();
    await giveUnit(p, "rider", "desert.dust_rider");
    await giveUnit(p, "digger", "desert.well_digger", 2);
    const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, STARTER_PACK(p));
    expect(res.statusCode).toBe(201);
    manifestId = res.json().manifest.id;
  });

  async function survivors() {
    return (await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest.survivors;
  }

  it("rejects malformed and illegal formations with the full issue list", async () => {
    const malformed = await call(p, "PUT", url(1), { v: 2, fences: [], traps: [], posts: [], elevation: [] });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("malformed_formation");
    expect(malformed.json().message).toMatch(/unknown key 'elevation'/);

    const f = arrangement(await survivors());
    const bad: Formation = {
      ...f,
      traps: [{ ref: "t0", cell: RING_SEGMENTS[5]!.cell }, { ref: "t1", cell: f.posts[0]!.cell }],
      posts: [f.posts[0]!],
    };
    const res = await call(p, "PUT", url(1), bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_formation");
    expect(res.json().issues.map((i: { code: string }) => i.code).sort()).toEqual(["cell_occupied", "cell_reserved", "unit_not_posted"]);
    expect((await call(p, "GET", url(1))).statusCode).toBe(404);
  });

  it("only the next encounter can be arranged", async () => {
    const f = arrangement(await survivors());
    expect((await call(p, "PUT", url(2), f)).json().error).toBe("wrong_encounter");
    expect((await call(p, "PUT", url(0), f)).json().error).toBe("bad_encounter");
    expect((await call(p, "POST", url(1, "/commit"))).json().error).toBe("no_draft");
  });

  it("a gapped formation is legal, can be re-arranged freely, and is frozen once committed", async () => {
    const s = await survivors();
    const first = await call(p, "PUT", url(1), arrangement(s, 0));
    expect(first.statusCode).toBe(200);
    expect(first.json().formation.gaps).toHaveLength(TUNABLES.PERIMETER_SEGMENTS - 10);
    expect(first.json().formation.committedAt).toBeNull();

    // Re-arranged: the gap moves. Stored draft changes, hash changes.
    const second = await call(p, "PUT", url(1), arrangement(s, 16));
    expect(second.statusCode).toBe(200);
    expect(second.json().formation.hash).not.toBe(first.json().formation.hash);
    expect(second.json().formation.gaps[0]).toBe(0);
    expect((await call(p, "GET", url(1))).json().formation.hash).toBe(second.json().formation.hash);

    // Commit freezes it; the stored snapshot is the canonical serialization.
    const commit = await call(p, "POST", url(1, "/commit"));
    expect(commit.statusCode).toBe(200);
    expect(commit.json().formation.committedAt).not.toBeNull();
    const canonical = serializeFormation(arrangement(s, 16));
    expect(commit.json().formation.hash).toBe(formationHash(canonical));
    // jsonb normalizes key order on storage; the canonical re-serialization of what comes
    // back is byte-identical to what went in, and the stored hash is of that text.
    const stored = await pool.query<{ formation: unknown; formation_hash: string }>("SELECT formation, formation_hash FROM wagon_formation WHERE manifest_id = $1 AND encounter_index = 1", [manifestId]);
    expect(serializeFormation(formationFromJson(stored.rows[0]!.formation))).toBe(canonical);
    expect(stored.rows[0]!.formation_hash).toBe(formationHash(canonical));

    // Idempotent commit; no further edits.
    expect((await call(p, "POST", url(1, "/commit"))).json().formation.hash).toBe(commit.json().formation.hash);
    const edit = await call(p, "PUT", url(1), arrangement(s, 3));
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("formation_committed");
    const dbEdit = await expectDbError(appRole, `UPDATE wagon_formation SET formation = '{"v":2,"fences":[],"traps":[],"posts":[]}'::jsonb, formation_hash = repeat('0', 64) WHERE manifest_id = $1 AND encounter_index = 1`, [manifestId]);
    expect(dbEdit?.message).toMatch(/committed and frozen/);
    const dbDel = await expectDbError(appRole, `DELETE FROM wagon_formation WHERE manifest_id = $1 AND encounter_index = 1`, [manifestId]);
    expect(dbDel?.message).toMatch(/history/);

    // The resolver's view is derivable from what was stored, flat and integer-only.
    const battlefield = await battlefieldForEncounter(appRole, manifestId, 1);
    expect(battlefield.fences).toHaveLength(10);
    expect(battlefield.posts).toHaveLength(2);
    expect(Object.keys(battlefield).sort()).toEqual(["anchors", "core", "entries", "fences", "grid", "pathConnectivity", "posts", "traps", "v"]);
  });

  it("carries attrition forward: a trap spent at encounter 1 is still spent at encounters 2 and 3, a dead unit stays dead, a broken segment stays broken", async () => {
    const before = await survivors();
    const rider = before.units.find((u: { typeId: string }) => u.typeId === "desert.dust_rider");
    // Encounter 1 resolves: t0 fired, the rider died, f0 destroyed, f1 chipped to 17.
    await withTransaction(appRole, (client) =>
      applyOutcome(client, manifestId, 1, { units: [{ ref: rider.ref, hp: 0 }], spentTraps: ["t0"], fences: [{ ref: "f0", hp: 0 }, { ref: "f1", hp: 17 }] }),
    );
    const m2 = (await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest;
    expect(m2.encountersResolved).toBe(1);
    expect(m2.packed.traps[0].spent).toBe(false); // what was packed never changes
    expect(m2.survivors.traps[0].spent).toBe(true);
    expect(m2.summary).toEqual({ unitsAlive: 1, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 9, fencesDestroyed: 1 });
    expect(m2.survivors.fences.find((f: { ref: string }) => f.ref === "f1").hp).toBe(17);

    // Encounter 2: the encounter-1 arrangement is no longer legal — every carried-forward loss bites.
    const stale = arrangement(before, 16);
    const res = await call(p, "PUT", url(2), stale);
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { code: string }) => i.code).sort()).toEqual(["fence_destroyed", "trap_spent", "unit_dead"]);
    // Arranged from what survives, it is legal; the chipped segment keeps its 17 hp into the fight.
    const fresh = arrangement(m2.survivors, 16);
    expect(fresh.traps.map((t) => t.ref)).toEqual(["t1"]);
    expect(fresh.fences).toHaveLength(9);
    expect((await call(p, "PUT", url(2), fresh)).statusCode).toBe(200);
    expect((await call(p, "POST", url(2, "/commit"))).statusCode).toBe(200);
    const bf = await battlefieldForEncounter(appRole, manifestId, 2);
    expect(bf.fences.find((f) => f.ref === "f1")!.hp).toBe(17);
    expect(bf.posts).toHaveLength(1);

    // Encounter 2 resolves with nothing fired. Encounter 3: t0 is STILL spent.
    await withTransaction(appRole, (client) => applyOutcome(client, manifestId, 2, { units: [], spentTraps: [], fences: [] }));
    const m3 = (await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest;
    expect(m3.encountersResolved).toBe(2);
    expect(m3.survivors.traps[0].spent).toBe(true);
    const relay = await call(p, "PUT", url(3), { ...arrangement(m3.survivors), traps: [{ ref: "t0", cell: { x: 21, y: 12 } }, { ref: "t1", cell: { x: 22, y: 12 } }] });
    expect(relay.statusCode).toBe(400);
    expect(relay.json().issues.map((i: { code: string }) => i.code)).toEqual(["trap_spent"]);
  });

  it("nothing heals, repairs or re-arms mid-trip: the service refuses it and so does the database", async () => {
    // An outcome needs a committed formation for exactly the next encounter.
    await expect(withTransaction(appRole, (client) => applyOutcome(client, manifestId, 3, { units: [], spentTraps: [], fences: [] }))).rejects.toThrow(/committed/);
    const m3 = (await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest;
    expect((await call(p, "PUT", url(3), arrangement(m3.survivors, 8))).statusCode).toBe(200);
    expect((await call(p, "POST", url(3, "/commit"))).statusCode).toBe(200);
    await expect(withTransaction(appRole, (client) => applyOutcome(client, manifestId, 2, { units: [], spentTraps: [], fences: [] }))).rejects.toThrow(/encounter 3, not 2/);
    await expect(
      withTransaction(appRole, (client) => applyOutcome(client, manifestId, 3, { units: [], spentTraps: [], fences: [{ ref: "f1", hp: 300 }] })),
    ).rejects.toThrow(/no repair/);
    const digger = m3.survivors.units.find((u: { hp: number }) => u.hp > 0);
    await expect(
      withTransaction(appRole, (client) => applyOutcome(client, manifestId, 3, { units: [{ ref: digger.ref, hp: digger.hp + 1 }], spentTraps: [], fences: [] })),
    ).rejects.toThrow(/no healing/);
    // Nothing above moved the manifest.
    expect((await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest.encountersResolved).toBe(2);

    const heal = await expectDbError(appRole, `UPDATE wagon_manifest SET survivors = packed WHERE id = $1`, [manifestId]);
    expect(heal?.message).toMatch(/hp may not rise|does not re-arm/);
    const rearm = await expectDbError(
      appRole,
      `UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{traps,0,spent}', 'false'::jsonb) WHERE id = $1`,
      [manifestId],
    );
    expect(rearm?.message).toMatch(/does not re-arm/);
    const rewind = await expectDbError(appRole, `UPDATE wagon_manifest SET encounters_resolved = 0 WHERE id = $1`, [manifestId]);
    expect(rewind?.message).toMatch(/never decreases/);
    const swap = await expectDbError(
      appRole,
      `UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,0,typeId}', '"desert.vaquero"'::jsonb) WHERE id = $1`,
      [manifestId],
    );
    expect(swap?.message).toMatch(/identity is immutable/);
  });

  it("closing the manifest ends the trip: frozen thereafter, and the caravan can pack again", async () => {
    await withTransaction(appRole, (client) => closeManifest(client, manifestId));
    expect((await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().manifest).toBeNull();
    const frozen = await expectDbError(appRole, `UPDATE wagon_manifest SET survivors = packed WHERE id = $1`, [manifestId]);
    expect(frozen?.message).toMatch(/closed and frozen/);
    const again = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, STARTER_PACK(p));
    expect(again.statusCode).toBe(201);
    expect(again.json().manifest.id).not.toBe(manifestId);
  });
});

describe("split and shape", () => {
  it("manifest and formation tables are caravan-level: keyed by caravan, no account column", async () => {
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('wagon_manifest', 'wagon_formation') ORDER BY 1, 2`,
    );
    const names = cols.rows.map((r) => `${r.table_name}.${r.column_name}`);
    expect(names).toContain("wagon_manifest.caravan_id");
    expect(names.filter((n) => /account/.test(n))).toEqual([]);
    expect(names.filter((n) => /elevation|terrain|scenery|layout/.test(n))).toEqual([]);
  });

  it("the app role cannot disable the lock guards", async () => {
    const err = await expectDbError(appRole, "ALTER TABLE wagon_manifest DISABLE TRIGGER wagon_manifest_guard_update");
    expect(err?.code).toBe("42501");
    const trunc = await expectDbError(pool, "TRUNCATE wagon_manifest CASCADE");
    expect(trunc?.message).toMatch(/TRUNCATE is refused/);
    const truncF = await expectDbError(pool, "TRUNCATE wagon_formation");
    expect(truncF?.message).toMatch(/TRUNCATE is refused/);
  });
});

/**
 * Chunk 22 QA S9 — guardrail 1 for the replay, against the LEDGER (PHASE-2 §22: "diff the
 * renderer's displayed outcome against the ledger for 100 replays").
 *
 * More than 100 encounters are fought by the REAL resolver (DEFAULT_HANDLERS) through the trip
 * loop's own routes — strong and weak circles, caravans in several Reputation bands, against the
 * authored cold-start parties of those bands and against live players' parties. For every one:
 *
 *   - GET /me/encounters/:jobId/replay is 200 and renderable, and `readReplay` accepts its log
 *     (the same reader the client runs — the client draws what it returns, nothing else);
 *   - the log's ending (kind, depth, endTick) — what the player shows at the end of the scrub —
 *     equals the `encounter_resolved` LEDGER EVENT's outcome, the immutable job result, the body's
 *     `outcome` and the trip loop's settled row: four records written by the server, none of them
 *     the log's own copy;
 *   - the body's `settled` itemization equals the progression / Coin events the ledger holds for
 *     that job, for the caravan's player and (for a live owner) for the party's owner;
 *   - the party owner's body tells the same ending, with no trip id, stored block or attrition.
 */
import { RING_SEGMENTS, entryBand, type Formation, type PartyConfig } from "@caravan/circle";
import { readReplay } from "@caravan/resolver";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_HANDLERS, type EncounterJobInput } from "../src/jobs/handlers/encounterResolution.js";
import { getJob } from "../src/jobs/queue.js";
import { drain } from "../src/jobs/worker.js";
import { bandCentre } from "../src/matchmaking/band.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { appRolePool, testPool, truncateAll, unique, seasonCaravan } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: string[];
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

async function registerPlayer(): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("rl"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  await seasonCaravan(pool, body.caravan.id); // r2 S2: the trips a test starts are not the caravan's first
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: [] };
}

async function giveUnits(p: Player, n: number, typeId: string, mergeLevel: number): Promise<void> {
  for (let i = 0; i < n; i++) p.units.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
}

const EDGES = ["north", "east", "south", "west"] as const;
async function makeOwner(siegeRep: number, k: number): Promise<Player> {
  const p = await registerPlayer();
  await giveUnits(p, 2 + (k % 2), k % 2 === 0 ? "desert.dust_rider" : "desert.well_digger", 1 + (k % 3));
  const stances = ["nearest", "traps", "core"] as const;
  const party: PartyConfig = { v: 1, units: p.units.map((ref, i) => ({ ref, stance: stances[(i + k) % 3]!, edge: EDGES[(i + k) % 4]!, cell: entryBand(EDGES[(i + k) % 4]!)[2 + i]! })), siege: k % 2 === 0 ? ["siege.battering_wagon"] : [] };
  const res = await call(p, "PUT", "/me/party", party);
  expect(res.statusCode, res.body).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [p.accountId, siegeRep]);
  return p;
}

/** A defender in Reputation band `band`: strong (four level-4 posts, 20 segments, two traps) or weak (one level-1 post, nothing else). */
async function makeDefender(strong: boolean, band: number): Promise<Player> {
  const p = await registerPlayer();
  if (strong) {
    await giveUnits(p, 2, "desert.dust_rider", 4);
    await giveUnits(p, 2, "desert.well_digger", 4);
  } else await giveUnits(p, 1, "desert.dust_rider", 1);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId, bandCentre(band)]);
  const loadout = strong ? { units: p.units, traps: ["trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 11 } } : { units: p.units, traps: [], fence: { tierId: "fence.brush_pile", count: 0 } };
  const res = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, loadout);
  expect(res.statusCode, res.body).toBe(201);
  return p;
}

interface ManifestJson {
  units: { ref: string; hp: number }[];
  traps: { ref: string; spent: boolean }[];
  fences: { ref: string; hp: number }[];
}

function arrangement(m: ManifestJson, variant: number): Formation {
  const postCells = [{ x: 15, y: 13 }, { x: 13, y: 15 }, { x: 17, y: 15 }, { x: 15, y: 17 }];
  const trapCells = [{ x: 15, y: 9 }, { x: 9, y: 15 }];
  const stances = ["hold", "guard", "reserve"] as const;
  return {
    v: 3,
    fences: m.fences.filter((f) => f.hp > 0).map((f, k) => ({ ref: f.ref, segment: (k + variant * 3) % RING_SEGMENTS.length })),
    traps: m.traps.filter((t) => !t.spent).map((t, k) => ({ ref: t.ref, cell: trapCells[k]! })),
    posts: m.units.filter((u) => u.hp > 0).map((u, k) => ({ ref: u.ref, cell: postCells[k]!, stance: stances[(k + variant) % 3]! })),
  };
}

interface Outcome {
  kind: string;
  depth: number;
  endTick: number;
}
const ending = (o: Outcome): Outcome => ({ kind: o.kind, depth: o.depth, endTick: o.endTick });

let owners: Player[] = [];
/** Each defender's fights, in the order fought (the D2 listing is checked against it). */
const history: { def: Player; jobs: string[] }[] = [];
beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
  await seedAuthoredParties(pool);
  owners = [];
  for (let k = 0; k < 6; k++) owners.push(await makeOwner(bandCentre(k % 4) - 40 + k * 7, k));
}, 120_000);

afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("guardrail 1, chunk 22: every replay ends as the ledger recorded it (100+ real-resolver fights)", () => {
  it(
    "fights ≥ 100 encounters and checks each replay's ending and settled itemization against the ledger",
    async () => {
      const seen = { fights: 0, held: 0, overrun: 0, stalemate: 0, authored: 0, live: 0, bands: new Set<number>(), strong: 0, weak: 0, ownerViews: 0, ownerOverruns: 0 };
      let d = 0;
      while (seen.fights < 104) {
        const strong = d % 3 !== 2;
        const band = [0, 1, 3, 5][d % 4]!;
        const def = await makeDefender(strong, band);
        seen.bands.add(band);
        const tripUrl = `/me/caravans/${def.caravanId}/trip`;
        const start = await call(def, "POST", `${tripUrl}/start`);
        expect(start.statusCode, start.body).toBe(201);
        const tripId = (start.json() as { tripId: string }).tripId;
        const fought: string[] = [];
        history.push({ def, jobs: fought });
        for (let n = 1; n <= 3; n++) {
          const s = await call(def, "POST", `/me/caravans/${def.caravanId}/encounters/${n}/search`);
          expect(s.statusCode, s.body).toBe(201);
          const cands = s.json().menu.candidates as { candidateId: string; owner: { authored: boolean } }[];
          const wantAuthored = (d + n) % 2 === 0;
          const pick = cands.find((c) => c.owner.authored === wantAuthored) ?? cands[0]!;
          expect((await call(def, "POST", `/me/caravans/${def.caravanId}/encounters/${n}/choose`, { candidateId: pick.candidateId })).statusCode).toBe(200);
          const m = (await call(def, "GET", `/caravans/${def.caravanId}/manifest`)).json().manifest.survivors as ManifestJson;
          const f = await call(def, "PUT", `/caravans/${def.caravanId}/encounters/${n}/formation`, arrangement(m, d + n));
          expect(f.statusCode, f.body).toBe(200);
          const c = await call(def, "POST", `${tripUrl}/encounters/${n}/commit`);
          expect([200, 202], c.body).toContain(c.statusCode);
          const jobId = c.json().jobId as string;
          fought.push(jobId);
          const ran = await drain(appRole, { workerId: "replay-ledger", handlers: DEFAULT_HANDLERS, retryBackoffMs: () => 0 });
          expect(ran.map((r) => r.kind)).toEqual(["completed"]);
          // The trip loop folds the outcome in on the next read (the in-process worker does it in the completion; tests drain by hand).
          const status = await call(def, "GET", tripUrl);
          expect(status.statusCode).toBe(200);

          const job = (await getJob(pool, jobId))!;
          const input = job.input as EncounterJobInput;
          const resolved = (await pool.query<{ payload: { outcome: Outcome } }>("SELECT payload FROM ledger_event WHERE causation_id = $1 AND event_type = 'encounter_resolved'", [jobId])).rows;
          expect(resolved, "one encounter_resolved event per fight").toHaveLength(1);
          const ledgerEnding = ending(resolved[0]!.payload.outcome);
          const jobEnding = ending((job.result as { outcome: Outcome }).outcome);
          const settledRow = (await pool.query<{ outcome_kind: string; depth_fp: number }>("SELECT outcome_kind, depth_fp FROM trip_encounter WHERE job_id = $1", [jobId])).rows[0]!;

          const res = await call(def, "GET", `/me/encounters/${encodeURIComponent(jobId)}/replay`);
          expect(res.statusCode, res.body).toBe(200);
          const body = res.json() as { renderable: boolean; reason: string | null; outcome: Outcome; log: unknown; settled: { applied: boolean; reputation: { pool: string; delta: number }[]; ladder: { pool: string; pointsDelta: number }[] } };
          expect(body.renderable, body.reason ?? "").toBe(true);
          const shown = ending(readReplay(body.log).log.outcome);
          expect(shown, jobId).toEqual(ledgerEnding);
          expect(jobEnding).toEqual(ledgerEnding);
          expect(ending(body.outcome)).toEqual(ledgerEnding);
          expect({ kind: settledRow.outcome_kind, depth: settledRow.depth_fp }).toEqual({ kind: ledgerEnding.kind, depth: ledgerEnding.depth });

          // The settled itemization is exactly the ledger's progression events for this job, on the caravan's side.
          const prog = (await pool.query<{ event_type: string; payload: { pool: string; delta?: number; pointsDelta?: number } }>(
            "SELECT event_type::text AS event_type, payload FROM ledger_event WHERE causation_id = $1 AND account_id = $2 ORDER BY seq",
            [`progression:${jobId}`, def.accountId],
          )).rows;
          expect(body.settled.applied).toBe(true);
          expect(body.settled.reputation).toEqual(prog.filter((e) => e.event_type === "reputation_changed").map((e) => ({ pool: e.payload.pool, delta: e.payload.delta })));
          expect(body.settled.ladder.map((l) => ({ pool: l.pool, pointsDelta: l.pointsDelta }))).toEqual(prog.filter((e) => e.event_type === "ladder_progress_gained").map((e) => ({ pool: e.payload.pool, pointsDelta: e.payload.pointsDelta })));

          // An overrun's losses: the Coin lost and the units destroyed and de-merged, as the trip's overrun events recorded them.
          if (ledgerEnding.kind === "caravan_overrun") {
            const losses = (await pool.query<{ event_type: string }>("SELECT event_type::text AS event_type FROM ledger_event WHERE causation_id = $1 AND account_id = $2", [`trip:${tripId}:overrun`, def.accountId])).rows;
            const b = body as unknown as { opponent: { authored: boolean } | null; settled: { coinLost: { recipientAuthored: boolean; transferred: number } | null; destroyed: unknown[]; deMerged: unknown[]; trip: { ended: boolean } } };
            expect(b.settled.coinLost).not.toBeNull();
            // Final play-test review N7: an authored outfit keeps nothing, and the body says so.
            const authoredParty = !owners.some((o) => o.accountId === input.partyOwnerAccountId);
            expect(b.opponent).toEqual({ authored: authoredParty });
            expect(b.settled.coinLost!.recipientAuthored).toBe(authoredParty);
            if (authoredParty) expect(b.settled.coinLost!.transferred).toBe(0);
            expect(b.settled.destroyed).toHaveLength(losses.filter((e) => e.event_type === "unit_lost_on_wipe").length);
            expect(b.settled.deMerged.length).toBeLessThanOrEqual(losses.filter((e) => e.event_type === "unit_demerged_on_death").length);
            expect(b.settled.trip.ended).toBe(true);
          }

          // The party owner (a live player) sees the same ending, from the other side, with the owner's own ledger rows.
          const owner = owners.find((o) => o.accountId === input.partyOwnerAccountId);
          if (owner) {
            seen.live += 1;
            const r2 = await call(owner, "GET", `/me/encounters/${encodeURIComponent(jobId)}/replay`);
            expect(r2.statusCode, r2.body).toBe(200);
            const b2 = r2.json() as { viewer: string; tripId: unknown; stored: unknown; outcome: Outcome & Record<string, unknown>; log: unknown; settled: { reputation: { pool: string }[]; deMerged: unknown[]; destroyed: unknown[] } };
            expect(b2.viewer).toBe("party_owner");
            expect(b2).toMatchObject({ tripId: null, stored: null, opponent: null });
            expect("units" in b2.outcome).toBe(false);
            expect(ending(readReplay(b2.log).log.outcome)).toEqual(ledgerEnding);
            expect(b2.settled.reputation.every((r) => r.pool === "siege")).toBe(true);
            expect(b2.settled.deMerged).toEqual([]);
            expect(b2.settled.destroyed).toEqual([]);
            // Final play-test review r3 N5: the owner's end card total is the results feed's (the inbox's) for the same fight.
            const s2 = (b2 as unknown as { settled: { coin: { amount: number }[]; coinEarned: number; coinTransferred: number } }).settled;
            const feed = (await call(owner, "GET", "/me/party/feed?limit=100")).json() as { entries: { jobId: string; coinEarned: number; coinTransferred: number }[] };
            const entry = feed.entries.find((e) => e.jobId === jobId);
            expect(entry, "the fight is in the owner's results feed").toBeDefined();
            expect({ coinEarned: s2.coinEarned, coinTransferred: s2.coinTransferred }).toEqual({ coinEarned: entry!.coinEarned, coinTransferred: entry!.coinTransferred });
            expect(s2.coinEarned).toBe(s2.coin.reduce((n, c) => n + c.amount, 0));
            if (ledgerEnding.kind === "caravan_overrun") seen.ownerOverruns += 1;
            seen.ownerViews += 1;
          } else seen.authored += 1;

          seen.fights += 1;
          if (strong) seen.strong += 1;
          else seen.weak += 1;
          if (ledgerEnding.kind === "caravan_held") seen.held += 1;
          else if (ledgerEnding.kind === "stalemate") seen.stalemate += 1;
          else seen.overrun += 1;
          if (ledgerEnding.kind === "caravan_overrun" || n === 3) break;
          const push = await call(def, "POST", `${tripUrl}/push`, { tripId, encounterIndex: n });
          expect(push.statusCode, push.body).toBe(200);
        }
        d += 1;
      }
      // The mix this run covered (printed so a reviewer can see it; asserted loosely so balance tuning cannot break the check).
      console.log(`replay-ledger: ${JSON.stringify({ ...seen, bands: [...seen.bands] })}`);
      expect(seen.fights).toBeGreaterThanOrEqual(100);
      expect(seen.authored).toBeGreaterThan(0);
      expect(seen.live).toBeGreaterThan(0);
      expect(seen.strong).toBeGreaterThan(0);
      expect(seen.weak).toBeGreaterThan(0);
      expect(seen.bands.size).toBeGreaterThanOrEqual(3);
      expect(seen.held + seen.stalemate).toBeGreaterThan(0);
      expect(seen.overrun).toBeGreaterThan(0);
    },
    600_000,
  );
});

describe("D2: GET /me/encounters lists the caravan's fights within retention, newest first", () => {
  it("lists a defender's fights newest first (each playable), none of anyone else's, and follows the retention rule", async () => {
    const withTwo = history.find((h) => h.jobs.length >= 2)!;
    expect(withTwo, "a defender who fought at least twice").toBeDefined();
    const list = (await call(withTwo.def, "GET", "/me/encounters")).json() as { encounters: { jobId: string; replay: string }[]; retention: { days: number; minPerCaravan: number } };
    expect(list.encounters.map((e) => e.jobId)).toEqual([...withTwo.jobs].reverse());
    expect(list.encounters.every((e) => e.replay === "log")).toBe(true);
    expect(list.retention).toEqual({ days: 30, minPerCaravan: 50 });
    // A party owner's own caravan fought nothing: their list is empty (their strikes are in the Party feed and the inbox).
    expect(((await call(owners[0]!, "GET", "/me/encounters")).json() as { encounters: unknown[] }).encounters).toEqual([]);
    // The rule: kept while among the caravan's newest N OR younger than the window. As the owner role (the app role can
    // write neither table), shrink N to 1 and age the defender's older fight past the window: it leaves the list.
    const oldest = withTwo.jobs[0]!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE trip_encounter DISABLE TRIGGER USER");
      await client.query("UPDATE trip_encounter SET settled_at = now() - interval '40 days' WHERE job_id = $1", [oldest]);
      await client.query("ALTER TABLE trip_encounter ENABLE TRIGGER USER");
      await client.query("UPDATE encounter_log_retention SET min_per_caravan = 1");
      await client.query("COMMIT");
      const after = (await call(withTwo.def, "GET", "/me/encounters")).json() as { encounters: { jobId: string }[] };
      expect(after.encounters.map((e) => e.jobId)).not.toContain(oldest);
      expect(after.encounters[0]!.jobId).toBe(withTwo.jobs.at(-1));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("UPDATE encounter_log_retention SET min_per_caravan = 50");
      client.release();
    }
  });
});

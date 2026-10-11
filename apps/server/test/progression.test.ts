/**
 * Chunk 04 — ladders and Reputation against the database: permanence through every
 * outcome including a full wipe, exactly-once grants under replay and under concurrency,
 * rebuild-from-zero == live, the scope split, the read endpoints, and the absence of any
 * path that spends Reputation.
 */
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueSession } from "../src/auth/sessions.js";
import { withTransaction } from "../src/db/pool.js";
import type { Pool } from "../src/db/types.js";
import { canonicalJson, eventIdentity, type Json } from "../src/ledger/events.js";
import { listEventsByCausation } from "../src/ledger/ledger.js";
import { verifyProjection } from "../src/ledger/projection.js";
import {
  applyEncounterOutcome,
  ENCOUNTER_OUTCOME_KINDS,
  LADDER_CAP,
  pointsToRung,
  progressionCausationId,
  totalUnlockPointsAtCap,
  type EncounterOutcomeKind,
  type EncounterProgressionInput,
} from "../src/progression/index.js";
import { getAccountPoolProgress, getCaravanPoolProgress } from "../src/repo/poolProgress.js";
import { registerAccount } from "../src/services/onboarding.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let app: FastifyInstance;
let defender: { accountId: string; caravanId: string };
let owner: { accountId: string; caravanId: string };
let causationN = 0;

async function register(prefix: string) {
  const { account, caravan } = await registerAccount(pool, { username: unique(prefix), password: "password123", regionId: "desert" });
  return { accountId: account.id, caravanId: caravan.id };
}

function encounter(outcome: EncounterOutcomeKind, caravanPools: Pool[] = ["living", "trap"], partyPools: Pool[] = ["living", "siege"]): EncounterProgressionInput {
  return {
    outcome,
    caravan: { accountId: defender.accountId, caravanId: defender.caravanId, poolsUsed: caravanPools },
    party: { ownerAccountId: owner.accountId, poolsUsed: partyPools },
  };
}

async function apply(input: EncounterProgressionInput, causationId = progressionCausationId(`encounter:test:${++causationN}`)) {
  return withTransaction(pool, (c) => applyEncounterOutcome(c, causationId, input));
}

interface Snapshot {
  living: { level: number; granted: number; rep: number; points: number };
  trap: { level: number; granted: number; rep: number; points: number };
  siege: { level: number; granted: number; rep: number; points: number };
}
async function snapshot(): Promise<Snapshot> {
  const living = (await getCaravanPoolProgress(pool, defender.caravanId))!;
  const trap = (await getAccountPoolProgress(pool, defender.accountId, "trap"))!;
  const siege = (await getAccountPoolProgress(pool, owner.accountId, "siege"))!;
  const pick = (r: typeof living) => ({ level: r.ladder_level, granted: r.unlock_points_granted, rep: r.reputation, points: r.ladder_points });
  return { living: pick(living), trap: pick(trap), siege: pick(siege) };
}

beforeAll(async () => {
  await truncateAll(pool);
  defender = await register("def");
  owner = await register("own");
  app = await buildApp({ db: pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("applying outcomes", () => {
  it("a held encounter moves both sides' ratings and ladders on the right rows, and nothing else", async () => {
    const before = await snapshot();
    const r = await apply(encounter("caravan_held"));
    expect(r.created).toBe(true);
    const after = await snapshot();
    expect(after.living.rep).toBe(before.living.rep + TUNABLES.REPUTATION_CARAVAN_HELD);
    expect(after.trap.rep).toBe(TUNABLES.REPUTATION_START); // trap Reputation never moves (QA D1)
    expect(after.siege.rep).toBe(before.siege.rep + TUNABLES.REPUTATION_LOSS_ATTACKER);
    expect(after.living.points).toBe(before.living.points + TUNABLES.LADDER_GAIN_DEFENSE_HELD);
    expect(after.trap.points).toBe(before.trap.points + TUNABLES.LADDER_GAIN_DEFENSE_HELD);
    expect(after.siege.points).toBe(before.siege.points + TUNABLES.LADDER_GAIN_LOSS);
    // the owner's own caravan (passive side) is untouched: its living row did not move
    const ownerLiving = (await getCaravanPoolProgress(pool, owner.caravanId))!;
    expect(ownerLiving.reputation).toBe(TUNABLES.REPUTATION_START);
    expect(ownerLiving.ladder_points).toBe(0);
    // the defender's siege row (not fielded by a caravan) is untouched
    const defSiege = (await getAccountPoolProgress(pool, defender.accountId, "siege"))!;
    expect(defSiege.reputation).toBe(TUNABLES.REPUTATION_START);
    expect(defSiege.ladder_points).toBe(0);
  });

  it("the first rung is crossed exactly once and pays exactly one unlock point", async () => {
    // living is at 25 points after the test above; rung 1 needs 100
    const before = await snapshot();
    let crossings = 0;
    while ((await snapshot()).living.level === before.living.level) {
      const r = await apply(encounter("caravan_held", ["living"], []));
      crossings += r.events.filter((e) => e.event_type === "unlock_points_granted" && e.payload["pool"] === "living").length;
    }
    const after = await snapshot();
    expect(after.living.level).toBe(before.living.level + 1);
    expect(after.living.granted).toBe(before.living.granted + 1);
    expect(crossings).toBe(1);
    expect(after.living.points).toBeGreaterThanOrEqual(pointsToRung(after.living.level));
  });

  it("replaying the same causation id appends nothing and returns the committed events (no double grant)", async () => {
    const id = progressionCausationId("encounter:replay:1");
    const first = await apply(encounter("caravan_overrun"), id);
    const mid = await snapshot();
    const second = await apply(encounter("caravan_overrun"), id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.events.map(eventIdentity)).toEqual(first.events.map(eventIdentity));
    expect(await snapshot()).toEqual(mid);
    expect((await listEventsByCausation(pool, id)).length).toBe(first.events.length);
  });

  it("the same outcome applied to the same state twice yields byte-identical event identities (determinism)", async () => {
    // Two separate defender/owner pairs in the same fresh state, same outcome: same events modulo ids.
    const d1 = await register("det1");
    const o1 = await register("det1o");
    const d2 = await register("det2");
    const o2 = await register("det2o");
    const run = async (d: typeof d1, o: typeof o1, tag: string) =>
      (
        await withTransaction(pool, (c) =>
          applyEncounterOutcome(c, progressionCausationId(`encounter:det:${tag}`), {
            outcome: "stalemate",
            caravan: { accountId: d.accountId, caravanId: d.caravanId, poolsUsed: ["living", "trap"] },
            party: { ownerAccountId: o.accountId, poolsUsed: ["siege"] },
          }),
        )
      ).events.map((e) => {
        const { inputHash, ...payload } = e.payload; // the input digest names the accounts; everything derived must match
        expect(typeof inputHash).toBe("string");
        return { type: e.event_type, seq: e.causation_seq, payload, scope: e.caravan_id ? "caravan" : "account" };
      });
    const a = await run(d1, o1, "a");
    const b = await run(d2, o2, "b");
    expect(canonicalJson(a as unknown as Json)).toBe(canonicalJson(b as unknown as Json));
  });
});

describe("permanence", () => {
  it("ladder levels and granted points never decrease across every outcome type, including a full wipe streak", async () => {
    let prev = await snapshot();
    const sequence: EncounterOutcomeKind[] = [];
    for (let i = 0; i < 60; i++) sequence.push(ENCOUNTER_OUTCOME_KINDS[(i * 7) % 3]!);
    for (let i = 0; i < 40; i++) sequence.push("caravan_overrun"); // the trip collapses, over and over
    for (const outcome of sequence) {
      await apply(encounter(outcome));
      const cur = await snapshot();
      for (const k of ["living", "trap", "siege"] as const) {
        expect(cur[k].level).toBeGreaterThanOrEqual(prev[k].level);
        expect(cur[k].granted).toBeGreaterThanOrEqual(prev[k].granted);
        expect(cur[k].points).toBeGreaterThanOrEqual(prev[k].points);
        expect(cur[k].rep).toBeGreaterThanOrEqual(TUNABLES.REPUTATION_FLOOR);
      }
      prev = cur;
    }
    // the wipe streak still EARNED ladder (losses earn), while Reputation fell
    expect(prev.living.points).toBeGreaterThan(0);
    expect(prev.living.rep).toBeLessThan(TUNABLES.REPUTATION_START);
  });

  it("the ledger never carries a negative ladder or unlock delta, and every grant names its rung", async () => {
    const rows = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM ledger_event WHERE event_type IN ('ladder_progress_gained','unlock_points_granted') AND causation_id LIKE 'progression:%'",
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const { payload } of rows.rows) {
      if ("pointsDelta" in payload) {
        expect(payload["pointsDelta"]).toBeGreaterThan(0);
        expect(payload["levelsGained"]).toBeGreaterThanOrEqual(0);
      } else {
        expect(payload["points"]).toBeGreaterThan(0);
        expect(Number.isInteger(payload["rung"])).toBe(true);
      }
    }
  });

  it("the storage layer refuses a second grant for the same rung (unique index backstop)", async () => {
    const dup = await expectDbError(
      pool,
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload)
       VALUES ('unlock_points_granted', $1, $2, 'test:dup-grant', 0, '{"pool":"living","points":1,"rung":1}')`,
      [defender.accountId, defender.caravanId],
    );
    expect(dup?.code).toBe("23505");
    expect(dup?.message).toContain("ledger_event_unlock_grant_once_per_rung");
    const dupTrap = await expectDbError(
      pool,
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload)
       VALUES ('unlock_points_granted', $1, NULL, 'test:dup-grant-trap', 0, '{"pool":"trap","points":1,"rung":1}')`,
      [defender.accountId],
    );
    expect(dupTrap?.code).toBe("23505");
  });

  it("a full climb to cap grants exactly 30 points per pool, then stops", async () => {
    const d = await register("cap");
    const o = await register("capo");
    const input: EncounterProgressionInput = {
      outcome: "caravan_overrun",
      caravan: { accountId: d.accountId, caravanId: d.caravanId, poolsUsed: ["living", "trap"] },
      party: { ownerAccountId: o.accountId, poolsUsed: ["siege"] },
    };
    let n = 0;
    for (;;) {
      const living = (await getCaravanPoolProgress(pool, d.caravanId))!;
      const siege = (await getAccountPoolProgress(pool, o.accountId, "siege"))!;
      if (living.ladder_level >= LADDER_CAP && siege.ladder_level >= LADDER_CAP) break;
      await withTransaction(pool, (c) => applyEncounterOutcome(c, progressionCausationId(`encounter:cap:${++n}`), input));
      expect(n).toBeLessThan(2000);
    }
    const living = (await getCaravanPoolProgress(pool, d.caravanId))!;
    const trap = (await getAccountPoolProgress(pool, d.accountId, "trap"))!;
    const siege = (await getAccountPoolProgress(pool, o.accountId, "siege"))!;
    expect(living.unlock_points_granted).toBe(totalUnlockPointsAtCap());
    expect(trap.unlock_points_granted).toBe(totalUnlockPointsAtCap());
    expect(siege.unlock_points_granted).toBe(totalUnlockPointsAtCap());
    expect(living.ladder_level).toBe(LADDER_CAP);
    // past the cap: a further encounter still moves Reputation but writes no ladder/grant event.
    // The caravan's living rating sat on the floor long ago, so (N1) only the winning siege rating is written.
    const r = await withTransaction(pool, (c) => applyEncounterOutcome(c, progressionCausationId("encounter:cap:post"), input));
    expect(r.events.map((e) => [e.event_type, e.payload["pool"]])).toEqual([["reputation_changed", "siege"]]);
    expect((await getCaravanPoolProgress(pool, d.caravanId))!.reputation).toBe(TUNABLES.REPUTATION_FLOOR);
    const grants = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ledger_event WHERE event_type = 'unlock_points_granted' AND caravan_id = $1",
      [d.caravanId],
    );
    expect(Number(grants.rows[0]!.n)).toBe(LADDER_CAP);
  });
});

describe("concurrency", () => {
  it("two resolutions racing to cross the same rung grant it once", async () => {
    const d = await register("race");
    const o1 = await register("race1");
    const o2 = await register("race2");
    // put the defender's living ladder one gain short of rung 1 (needs 100; held pays 25 → 75 after three)
    for (let i = 0; i < 3; i++) {
      await withTransaction(pool, (c) =>
        applyEncounterOutcome(c, progressionCausationId(`encounter:race:pre:${i}`), {
          outcome: "caravan_held",
          caravan: { accountId: d.accountId, caravanId: d.caravanId, poolsUsed: ["living"] },
          party: { ownerAccountId: o1.accountId, poolsUsed: [] },
        }),
      );
    }
    expect((await getCaravanPoolProgress(pool, d.caravanId))!.ladder_points).toBe(75);
    const race = (ownerId: string, tag: string) =>
      withTransaction(pool, async (c) => {
        const r = await applyEncounterOutcome(c, progressionCausationId(`encounter:race:${tag}`), {
          outcome: "caravan_held",
          caravan: { accountId: d.accountId, caravanId: d.caravanId, poolsUsed: ["living"] },
          party: { ownerAccountId: ownerId, poolsUsed: [] },
        });
        await new Promise((res) => setTimeout(res, 30)); // hold the lock so the other one really waits
        return r;
      });
    const [a, b] = await Promise.all([race(o1.accountId, "a"), race(o2.accountId, "b")]);
    const grants = [...a.events, ...b.events].filter((e) => e.event_type === "unlock_points_granted");
    expect(grants.length).toBe(1);
    const living = (await getCaravanPoolProgress(pool, d.caravanId))!;
    expect(living.ladder_level).toBe(1);
    expect(living.unlock_points_granted).toBe(1);
    expect(living.ladder_points).toBe(125);
  });
});

describe("rebuild from zero equals live", () => {
  it("every account touched above verifies", async () => {
    const accounts = await pool.query<{ id: string }>("SELECT id FROM account");
    expect(accounts.rowCount).toBeGreaterThan(4);
    for (const { id } of accounts.rows) {
      const v = await verifyProjection(pool, id);
      expect(v.ok, `account ${id}`).toBe(true);
    }
  });
});

describe("scope split", () => {
  it("every progression event landed on the right side: living with the caravan, trap/siege without", async () => {
    const rows = await pool.query<{ caravan_id: string | null; account_id: string; payload: { pool: Pool } }>(
      "SELECT caravan_id, account_id, payload FROM ledger_event WHERE causation_id LIKE 'progression:%'",
    );
    expect(rows.rowCount).toBeGreaterThan(50);
    for (const r of rows.rows) {
      if (r.payload.pool === "living") expect(r.caravan_id).not.toBeNull();
      else expect(r.caravan_id).toBeNull();
    }
  });

  it("refuses a caravan that does not belong to the account named", async () => {
    await expect(
      withTransaction(pool, (c) =>
        applyEncounterOutcome(c, progressionCausationId("encounter:wrong-owner"), {
          outcome: "caravan_held",
          caravan: { accountId: owner.accountId, caravanId: defender.caravanId, poolsUsed: ["living"] },
          party: { ownerAccountId: defender.accountId, poolsUsed: [] },
        }),
      ),
    ).rejects.toThrow(/does not belong/);
  });
});

describe("Reputation has no spend path", () => {
  it("no route mutates progression; the only Reputation writer is an outcome, and no SQL debits it as a cost", () => {
    const routes = app.printRoutes({ commonPrefix: false });
    for (const line of routes.split("\n")) {
      if (/progression|reputation|ladder/i.test(line)) expect(line).toMatch(/\(GET(, HEAD)?\)/);
    }
    const src = join(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(src);
    const writers = files.filter((f) => /SET\s+reputation|reputation\s*-=|spendReputation|debitReputation/i.test(readFileSync(f, "utf8")));
    expect(writers).toEqual([]);
    // the only modules that produce reputation_changed drafts: progression/outcome.ts (fight outcomes) and
    // matchmaking/authored.ts (chunk 25: the authored set places a SYSTEM account's siege rating through the
    // ledger so rebuild == live; it is a content seed, never a spend or a player-facing path)
    const producers = files.filter((f) => /type:\s*"reputation_changed"/.test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length));
    expect(producers.sort()).toEqual(["/matchmaking/authored.ts", "/progression/outcome.ts"]);
  });

  it("every reputation_changed event in the ledger was caused by an encounter outcome", async () => {
    const rows = await pool.query<{ reason: string; causation_id: string }>(
      "SELECT payload->>'reason' AS reason, causation_id FROM ledger_event WHERE event_type = 'reputation_changed' AND causation_id LIKE 'progression:%'",
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const r of rows.rows) expect(ENCOUNTER_OUTCOME_KINDS).toContain(r.reason);
  });
});

describe("read endpoints", () => {
  it("GET /me/progression shows every pool with the next rung's cost and grant visible", async () => {
    const { token } = await issueSession(pool, defender.accountId);
    const res = await app.inject({ method: "GET", url: "/me/progression", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pools: { pool: Pool; scope: string; caravanId: string | null; ladder: { level: number; nextRungAt: number | null; nextRungUnlockPoints: number | null; cap: number }; unlockPoints: { granted: number; spent: number; available: number }; reputation: number }[] };
    expect(body.pools.map((p) => p.pool).sort()).toEqual(["living", "siege", "trap"]);
    const living = body.pools.find((p) => p.pool === "living")!;
    expect(living.scope).toBe("caravan");
    expect(living.caravanId).toBe(defender.caravanId);
    expect(living.ladder.cap).toBe(LADDER_CAP);
    expect(living.ladder.nextRungAt).toBe(pointsToRung(living.ladder.level + 1));
    expect(living.ladder.nextRungUnlockPoints).toBeGreaterThan(0);
    expect(living.unlockPoints.available).toBe(living.unlockPoints.granted - living.unlockPoints.spent);
    const trap = body.pools.find((p) => p.pool === "trap")!;
    expect(trap.scope).toBe("account");
    expect(trap.caravanId).toBeNull();
    expect((await app.inject({ method: "GET", url: "/me/progression" })).statusCode).toBe(401);
  });

  it("GET /me/progression/events pages the player's own progression history, filterable by pool", async () => {
    const { token } = await issueSession(pool, owner.accountId);
    const headers = { authorization: `Bearer ${token}` };
    const res = await app.inject({ method: "GET", url: "/me/progression/events?pool=siege&limit=500", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: { type: string; payload: { pool: string } }[]; nextAfter: number };
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events) {
      expect(e.payload.pool).toBe("siege");
      expect(["reputation_changed", "ladder_progress_gained", "unlock_points_granted"]).toContain(e.type);
    }
    // the owner never sees the defender's events
    const all = await app.inject({ method: "GET", url: "/me/progression/events?limit=500", headers });
    for (const e of (all.json() as { events: { payload: { pool: string } }[] }).events) expect(e.payload.pool).toBe("siege");
  });

  it("GET /progression/rules publishes the whole curve and every per-outcome number", async () => {
    const res = await app.inject({ method: "GET", url: "/progression/rules" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ladder: { rungs: { rung: number; pointsRequired: number; unlockPoints: number }[]; totalUnlockPointsAtCap: number }; reputation: { floor: number; start: number; matchmakingRating: { caravan: string; party: string } } };
    expect(body.ladder.rungs).toHaveLength(LADDER_CAP);
    expect(body.ladder.rungs[0]).toEqual({ rung: 1, pointsRequired: 100, unlockPoints: 1 });
    expect(body.ladder.rungs[19]).toEqual({ rung: 20, pointsRequired: 8944, unlockPoints: 2 });
    expect(body.ladder.totalUnlockPointsAtCap).toBe(30);
    expect(body.reputation.floor).toBe(TUNABLES.REPUTATION_FLOOR);
    expect(body.reputation.start).toBe(TUNABLES.REPUTATION_START);
    expect(body.reputation.matchmakingRating).toEqual({ caravan: "living", party: "siege" });
  });
});

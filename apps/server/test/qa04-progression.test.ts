/**
 * Chunk 04 QA round 1 regressions (roadmap/qa/04-punchlist.md). Each describe block is one
 * reproduction from the QA probe script, turned into a test that pins the fix:
 *
 *   S1/S2/S8  crafted ledger events cannot lower, skip or overshoot permanent progress,
 *             as the owner AND as the app role; the grant-once index covers every grant
 *   S3        the same causation id with a different input is refused, not answered
 *   N2        applyEncounterOutcome refuses to run outside an explicit transaction
 *   P4        two caravans of one account: living progress per caravan, trap shared
 *   P5        one party served to 12 caravans at once crosses a siege rung exactly once
 *   S4/S5     the history endpoint: malformed queries are 400s; filters apply before the
 *             limit; hasMore is reported; nothing from another account leaks in
 *   N1/D1     a rating on the floor writes no zero-delta events; trap Reputation never moves
 *   S8        the ladder cap in migration 003 equals TUNABLES.LADDER_RUNGS_PER_POOL
 *   N7        a living progress row without a caravan id is a loud error
 */
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueSession } from "../src/auth/sessions.js";
import { loadMigrations } from "../src/db/migrate.js";
import { withTransaction } from "../src/db/pool.js";
import type { Pool, PoolProgressRow } from "../src/db/types.js";
import { verifyProjection } from "../src/ledger/projection.js";
import {
  applyEncounterOutcome,
  LADDER_CAP,
  ProgressionCausationMismatch,
  progressionCausationId,
  toPoolProgressView,
  type EncounterOutcomeKind,
  type EncounterProgressionInput,
} from "../src/progression/index.js";
import { createCaravanPoolProgress, getAccountPoolProgress, getCaravanPoolProgress } from "../src/repo/poolProgress.js";
import { registerAccount } from "../src/services/onboarding.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
const appDb = appRolePool();
let app: FastifyInstance;
let causationN = 0;
const cid = (tag = "qa04") => progressionCausationId(`${tag}:${++causationN}`);

interface Player {
  accountId: string;
  caravanId: string;
}
async function register(prefix: string): Promise<Player> {
  const { account, caravan } = await registerAccount(pool, { username: unique(prefix), password: "password123", regionId: "desert" });
  return { accountId: account.id, caravanId: caravan.id };
}
function encounter(outcome: EncounterOutcomeKind, caravan: Player, owner: Player, caravanPools: Pool[] = ["living", "trap"], partyPools: Pool[] = ["siege"]): EncounterProgressionInput {
  return {
    outcome,
    caravan: { accountId: caravan.accountId, caravanId: caravan.caravanId, poolsUsed: caravanPools },
    party: { ownerAccountId: owner.accountId, poolsUsed: partyPools },
  };
}
const apply = (input: EncounterProgressionInput, causationId = cid()) =>
  withTransaction(pool, (c) => applyEncounterOutcome(c, causationId, input));

const INSERT = `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload)
                VALUES ($1, $2, $3, $4, 0, $5::jsonb)`;

beforeAll(async () => {
  await truncateAll(pool);
  app = await buildApp({ db: pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await appDb.end();
});

describe("S1/S2/S8: crafted ledger events cannot move permanent progress the wrong way", () => {
  let d: Player;
  beforeAll(async () => {
    d = await register("craft");
  });

  for (const role of ["owner", "app"] as const) {
    const db = () => (role === "owner" ? pool : appDb);
    const craft = (type: string, caravanId: string | null, payload: object) =>
      expectDbError(db(), INSERT, [type, d.accountId, caravanId, `qa04:craft:${role}:${++causationN}`, JSON.stringify(payload)]);

    it(`${role} role: a negative pointsDelta or levelsGained is refused and nothing moves`, async () => {
      const before = (await getCaravanPoolProgress(pool, d.caravanId))!;
      const negPts = await craft("ladder_progress_gained", d.caravanId, { pool: "living", pointsDelta: -50, levelsGained: 0 });
      expect(negPts?.code).toBe("23514");
      expect(negPts?.message).toContain("ledger_event_ladder_progress_nonneg");
      const negLvl = await craft("ladder_progress_gained", d.caravanId, { pool: "living", pointsDelta: 0, levelsGained: -1 });
      expect(negLvl?.code).toBe("23514");
      for (const bad of [{ pool: "living", pointsDelta: "5", levelsGained: 0 }, { pool: "living", pointsDelta: 1.5, levelsGained: 0 }, { pool: "living", levelsGained: 0 }, { pool: "living", pointsDelta: 1 }]) {
        expect((await craft("ladder_progress_gained", d.caravanId, bad))?.code).toBe("23514");
      }
      const after = (await getCaravanPoolProgress(pool, d.caravanId))!;
      expect(after.ladder_points).toBe(before.ladder_points);
      expect(after.ladder_level).toBe(before.ladder_level);
    });

    it(`${role} role: a grant must carry a positive integer points and an integer rung in 1..cap`, async () => {
      const g0 = (await getAccountPoolProgress(pool, d.accountId, "trap"))!.unlock_points_granted;
      for (const bad of [
        { pool: "trap", points: -1, rung: 7 },
        { pool: "trap", points: 0, rung: 7 },
        { pool: "trap", points: 5 }, // no rung: outside the old index predicate (S2)
        { pool: "trap", points: 1, rung: "3" },
        { pool: "trap", points: 1, rung: 0 },
        { pool: "trap", points: 1, rung: LADDER_CAP + 1 },
        { pool: "trap", points: 1, rung: 2.5 },
      ]) {
        const err = await craft("unlock_points_granted", null, bad);
        expect(err?.code, JSON.stringify(bad)).toBe("23514");
        expect(err?.message).toContain("ledger_event_unlock_grant_shape");
      }
      expect((await getAccountPoolProgress(pool, d.accountId, "trap"))!.unlock_points_granted).toBe(g0);
    });

    it(`${role} role: the grant-once index covers every grant — a second grant for a rung is a unique violation`, async () => {
      const rung = role === "owner" ? 3 : 4;
      expect(await craft("unlock_points_granted", null, { pool: "trap", points: 1, rung })).toBeNull();
      const dup = await craft("unlock_points_granted", null, { pool: "trap", points: 1, rung });
      expect(dup?.code).toBe("23505");
      expect(dup?.message).toContain("ledger_event_unlock_grant_once_per_rung");
    });

    it(`${role} role: levelsGained is capped per event and ladder_level is capped in the row`, async () => {
      const fresh = await register(`cap_${role}`);
      const craftFresh = (payload: object) =>
        expectDbError(db(), INSERT, ["ladder_progress_gained", fresh.accountId, null, `qa04:cap:${role}:${++causationN}`, JSON.stringify(payload)]);
      expect((await craftFresh({ pool: "siege", pointsDelta: 0, levelsGained: LADDER_CAP + 1 }))?.code).toBe("23514");
      expect(await craftFresh({ pool: "siege", pointsDelta: 0, levelsGained: LADDER_CAP })).toBeNull();
      const over = await craftFresh({ pool: "siege", pointsDelta: 0, levelsGained: 1 });
      expect(over?.code).toBe("23514");
      expect(over?.message).toContain("pool_progress_ladder_level_cap");
      expect((await getAccountPoolProgress(pool, fresh.accountId, "siege"))!.ladder_level).toBe(LADDER_CAP);
      expect((await verifyProjection(pool, fresh.accountId)).ok).toBe(true);
    });
  }

  it("a direct UPDATE cannot lower ladder_points either, as the app role", async () => {
    await apply(encounter("caravan_held", d, await register("crafto")));
    const err = await expectDbError(appDb, "UPDATE pool_progress SET ladder_points = ladder_points - 1 WHERE caravan_id = $1", [d.caravanId]);
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("ladder_points is cumulative");
    expect((await verifyProjection(pool, d.accountId)).ok).toBe(true);
  });

  it("S8: the cap written into migration 003 and the live constraints equal TUNABLES.LADDER_RUNGS_PER_POOL", async () => {
    const m003 = loadMigrations().find((m) => m.id === 3);
    expect(m003).toBeDefined();
    const caps = [...m003!.up.matchAll(/BETWEEN\s+[01]\s+AND\s+(\d+)|ladder_level\s*<=\s*(\d+)/g)].map((m) => Number(m[1] ?? m[2]));
    expect(caps).toHaveLength(3);
    for (const c of caps) expect(c).toBe(TUNABLES.LADDER_RUNGS_PER_POOL);
    const live = await pool.query<{ conname: string; def: string }>(
      "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('ledger_event_ladder_progress_nonneg', 'ledger_event_unlock_grant_shape', 'pool_progress_ladder_level_cap') ORDER BY conname",
    );
    expect(live.rows.map((r) => r.conname)).toEqual(["ledger_event_ladder_progress_nonneg", "ledger_event_unlock_grant_shape", "pool_progress_ladder_level_cap"]);
    for (const r of live.rows) {
      // every bound in these definitions is 0, 1 or the cap; the largest literal is the cap
      const literals = (r.def.match(/\d+/g) ?? []).map(Number);
      expect(Math.max(...literals), r.def).toBe(TUNABLES.LADDER_RUNGS_PER_POOL);
    }
    expect(LADDER_CAP).toBe(TUNABLES.LADDER_RUNGS_PER_POOL);
  });
});

describe("S3: a causation id is bound to one input", () => {
  it("the same causation id with a different input is refused; the same input is answered idempotently", async () => {
    const d = await register("s3d");
    const o = await register("s3o");
    const id = cid("s3");
    const first = await apply(encounter("caravan_held", d, o), id);
    expect(first.created).toBe(true);
    for (const e of first.events) expect(typeof e.payload["inputHash"]).toBe("string");
    await expect(apply(encounter("caravan_overrun", d, o, ["living"], []), id)).rejects.toBeInstanceOf(ProgressionCausationMismatch);
    await expect(apply(encounter("caravan_held", d, o, ["living"], ["siege"]), id)).rejects.toThrow(/different encounter input/);
    const d2 = await register("s3d2");
    await expect(apply(encounter("caravan_held", d2, o), id)).rejects.toBeInstanceOf(ProgressionCausationMismatch);
    // pool order does not change the input's identity
    const again = await apply(encounter("caravan_held", d, o, ["trap", "living"], ["siege"]), id);
    expect(again.created).toBe(false);
    expect(again.events.map((e) => e.seq)).toEqual(first.events.map((e) => e.seq));
    expect((await verifyProjection(pool, d.accountId)).ok).toBe(true);
  });
});

describe("N2: applyEncounterOutcome refuses to run outside a transaction", () => {
  it("throws on an autocommit client and writes nothing", async () => {
    const d = await register("n2d");
    const o = await register("n2o");
    const client = await pool.connect();
    const id = cid("n2");
    try {
      await expect(applyEncounterOutcome(client, id, encounter("caravan_held", d, o))).rejects.toThrow(/explicit transaction/);
    } finally {
      client.release();
    }
    expect((await pool.query("SELECT 1 FROM ledger_event WHERE causation_id = $1", [id])).rowCount).toBe(0);
    expect((await getCaravanPoolProgress(pool, d.caravanId))!.ladder_points).toBe(0);
    // inside BEGIN … COMMIT, the same call works, even before anything has been written in it
    const r = await apply(encounter("caravan_held", d, o), id);
    expect(r.created).toBe(true);
  });
});

describe("P4: two caravans of one account", () => {
  it("living progress and grants land per caravan; trap progress is shared on the account; rebuild == live", async () => {
    const d = await register("p4");
    const o = await register("p4o");
    // v1 refuses a second caravan at the app layer; the schema supports it (GUARDRAILS §5), so insert directly.
    const car2 = (await pool.query<{ id: string }>("INSERT INTO caravan (account_id, region_id, name) VALUES ($1, 'desert', 'second') RETURNING id", [d.accountId])).rows[0]!.id;
    await createCaravanPoolProgress(pool, car2);
    const second: Player = { accountId: d.accountId, caravanId: car2 };
    const grants = { c1: 0, c2: 0, trap: 0 };
    for (let i = 0; i < 8; i++) {
      for (const r of [await apply(encounter("caravan_held", d, o)), await apply(encounter("caravan_held", second, o))]) {
        for (const e of r.events) {
          if (e.event_type !== "unlock_points_granted") continue;
          if (e.payload["pool"] === "trap") grants.trap++;
          else if (e.payload["pool"] === "living") e.caravan_id === car2 ? grants.c2++ : grants.c1++;
        }
      }
    }
    const l1 = (await getCaravanPoolProgress(pool, d.caravanId))!;
    const l2 = (await getCaravanPoolProgress(pool, car2))!;
    const trap = (await getAccountPoolProgress(pool, d.accountId, "trap"))!;
    expect(l1.ladder_points).toBe(8 * TUNABLES.LADDER_GAIN_DEFENSE_HELD);
    expect(l2.ladder_points).toBe(8 * TUNABLES.LADDER_GAIN_DEFENSE_HELD);
    expect(trap.ladder_points).toBe(16 * TUNABLES.LADDER_GAIN_DEFENSE_HELD);
    // 200 living points stand on rung 1 (100; rung 2 is 282); 400 trap points on rung 2 (282; rung 3 is 519)
    expect([l1.ladder_level, l1.unlock_points_granted, grants.c1]).toEqual([1, 1, 1]);
    expect([l2.ladder_level, l2.unlock_points_granted, grants.c2]).toEqual([1, 1, 1]);
    expect([trap.ladder_level, trap.unlock_points_granted, grants.trap]).toEqual([2, 2, 2]);
    expect(trap.reputation).toBe(TUNABLES.REPUTATION_START);
    expect((await verifyProjection(pool, d.accountId)).ok).toBe(true);
    expect((await verifyProjection(pool, o.accountId)).ok).toBe(true);
  });
});

describe("P5: one standing party served to 12 caravans at once", () => {
  it("crosses the owner's siege rung exactly once and the projection stays exact", async () => {
    const o = await register("p5o");
    const defenders = await Promise.all(Array.from({ length: 12 }, (_, i) => register(`p5d${i}`)));
    // bring the owner's siege ladder to 90 points: nine losses of LADDER_GAIN_LOSS (10); rung 1 is 100
    for (let i = 0; i < 9; i++) await apply(encounter("caravan_held", defenders[0]!, o, [], ["siege"]));
    expect((await getAccountPoolProgress(pool, o.accountId, "siege"))!.ladder_points).toBe(90);
    const results = await Promise.all(
      defenders.map((d) =>
        withTransaction(pool, async (c) => {
          const r = await applyEncounterOutcome(c, cid("p5"), encounter("caravan_held", d, o, ["living"], ["siege"]));
          await new Promise((res) => setTimeout(res, 5)); // hold the lock so the others really queue
          return r;
        }),
      ),
    );
    const siegeGrants = results.flatMap((r) => r.events).filter((e) => e.event_type === "unlock_points_granted" && e.payload["pool"] === "siege");
    expect(siegeGrants).toHaveLength(1);
    expect(siegeGrants[0]!.payload["rung"]).toBe(1);
    const siege = (await getAccountPoolProgress(pool, o.accountId, "siege"))!;
    expect(siege.ladder_points).toBe(90 + 12 * TUNABLES.LADDER_GAIN_LOSS);
    expect(siege.ladder_level).toBe(1);
    expect(siege.unlock_points_granted).toBe(1);
    expect((await verifyProjection(pool, o.accountId)).ok).toBe(true);
  });
});

describe("S4/S5: GET /me/progression/events", () => {
  let d: Player;
  let o: Player;
  let headers: { authorization: string };
  beforeAll(async () => {
    d = await register("http");
    o = await register("httpo");
    for (let i = 0; i < 3; i++) await apply(encounter("caravan_held", d, o));
    headers = { authorization: `Bearer ${(await issueSession(pool, d.accountId)).token}` };
  });

  it.each(["after=abc", "limit=-1", "limit=0", "limit=1.5", "limit=abc", "after=1e308", "after=-5", "pool=bogus", "pool[]=x", "after=1.5", "limit=99999", "bogus=1"])(
    "a malformed query (?%s) is a 400, not a default and not a 500",
    async (q) => {
      const res = await app.inject({ method: "GET", url: `/me/progression/events?${q}`, headers });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_request" });
    },
  );

  it("well-formed queries succeed, with defaults applied", async () => {
    for (const q of ["", "?after=0", "?limit=1", "?limit=500", "?pool=living", `?after=${Number.MAX_SAFE_INTEGER}`]) {
      const res = await app.inject({ method: "GET", url: `/me/progression/events${q}`, headers });
      expect(res.statusCode, q).toBe(200);
      expect(res.json()).toMatchObject({ hasMore: expect.any(Boolean), nextAfter: expect.any(Number) });
    }
    expect((await app.inject({ method: "GET", url: "/me/progression/events" })).statusCode).toBe(401);
  });

  it("filters in SQL before the limit, reports hasMore, and never leaks another account's rows", async () => {
    // bury the owner's progression rows under non-progression events, then page with a tiny limit
    await pool.query(
      `INSERT INTO ledger_event (event_type, account_id, causation_id, causation_seq, payload)
       SELECT 'coin_earned', $1, 'qa04:coin:' || g, 0, '{"amount":1,"reason":"x"}' FROM generate_series(1, 3) g`,
      [o.accountId],
    );
    await apply(encounter("caravan_overrun", d, o));
    const oh = { authorization: `Bearer ${(await issueSession(pool, o.accountId)).token}` };
    const lastCoin = (await pool.query<{ m: number }>("SELECT max(seq) AS m FROM ledger_event WHERE account_id = $1 AND event_type = 'coin_earned'", [o.accountId])).rows[0]!.m;
    // past the cursor sit the 3 coin rows and then the overrun's two owner-side progression events
    const page = (await app.inject({ method: "GET", url: `/me/progression/events?limit=1&after=${lastCoin - 3}`, headers: oh })).json() as { events: { seq: number; type: string }[]; nextAfter: number; hasMore: boolean };
    expect(page.events).toHaveLength(1); // the coin rows between the cursor and the progression rows did not eat the page
    expect(page.events[0]!.seq).toBeGreaterThan(lastCoin);
    expect(page.hasMore).toBe(true);
    expect(page.nextAfter).toBe(page.events[0]!.seq);
    const tail = (await app.inject({ method: "GET", url: `/me/progression/events?limit=1&after=${page.nextAfter}`, headers: oh })).json() as typeof page;
    expect(tail.events).toHaveLength(1);
    expect(tail.hasMore).toBe(false);
    // walk every page: exactly the owner's progression events, in seq order, hasMore false only on the last
    const seen: number[] = [];
    let after = 0;
    for (let i = 0; i < 100; i++) {
      const p = (await app.inject({ method: "GET", url: `/me/progression/events?limit=2&after=${after}`, headers: oh })).json() as typeof page;
      for (const e of p.events) {
        expect(["reputation_changed", "ladder_progress_gained", "unlock_points_granted"]).toContain(e.type);
        seen.push(e.seq);
      }
      if (!p.hasMore) {
        expect(p.events.length).toBeLessThanOrEqual(2);
        break;
      }
      expect(p.events).toHaveLength(2);
      after = p.nextAfter;
    }
    const expected = await pool.query<{ seq: number }>(
      "SELECT seq FROM ledger_event WHERE account_id = $1 AND event_type IN ('reputation_changed','ladder_progress_gained','unlock_points_granted') ORDER BY seq",
      [o.accountId],
    );
    expect(seen).toEqual(expected.rows.map((r) => r.seq));
    // the pool filter is in SQL too: a page is never empty while matching history continues
    const siegeOnly = (await app.inject({ method: "GET", url: "/me/progression/events?pool=siege&limit=1", headers: oh })).json() as typeof page;
    expect(siegeOnly.events).toHaveLength(1);
    expect(siegeOnly.hasMore).toBe(true);
    // cross-account: every seq in the defender's feed belongs to the defender
    const mine = (await app.inject({ method: "GET", url: "/me/progression/events?limit=500", headers })).json() as typeof page;
    const foreign = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_event WHERE seq = ANY($1::bigint[]) AND account_id <> $2", [mine.events.map((e) => e.seq), d.accountId]);
    expect(foreign.rows[0]!.n).toBe("0");
  });

  it("GET /progression/rules names both gap floors and says which ratings move", async () => {
    const rules = (await app.inject({ method: "GET", url: "/progression/rules" })).json() as { reputation: { gapScaling: Record<string, number>; moves: Record<string, string>; matchmakingRating: Record<string, string>; zeroDeltaWritesEvent: boolean } };
    expect(rules.reputation.gapScaling["multMinLoss"]).toBe(TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS);
    expect(rules.reputation.gapScaling["multMinWin"]).toBe(TUNABLES.REPUTATION_GAP_MULT_MIN);
    expect(rules.reputation.matchmakingRating).toEqual({ caravan: "living", party: "siege" });
    expect(rules.reputation.moves["trap"]).toMatch(/never/);
    expect(rules.reputation.zeroDeltaWritesEvent).toBe(false);
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(rules))).toBe(false); // public, and names nobody
  });
});

describe("N1/D1: a rating on the floor is silent; trap Reputation never moves", () => {
  it("400 overruns write one floored event and no zero-delta events; trap stays at the start", async () => {
    const d = await register("floor");
    const o = await register("flooro");
    let last: Awaited<ReturnType<typeof apply>> | undefined;
    for (let i = 0; i < 400; i++) last = await apply(encounter("caravan_overrun", d, o, ["living", "trap"], []));
    expect(last!.events.filter((e) => e.event_type === "reputation_changed").map((e) => e.payload["pool"])).toEqual(["siege"]);
    const living = (await getCaravanPoolProgress(pool, d.caravanId))!;
    expect(living.reputation).toBe(TUNABLES.REPUTATION_FLOOR);
    const reps = await pool.query<{ delta: number; floored: boolean }>(
      "SELECT (payload->>'delta')::int AS delta, (payload->>'floored')::boolean AS floored FROM ledger_event WHERE event_type = 'reputation_changed' AND caravan_id = $1 ORDER BY seq",
      [d.caravanId],
    );
    expect(reps.rows.length).toBeGreaterThan(5);
    expect(reps.rows.length).toBeLessThan(400);
    for (const r of reps.rows) expect(r.delta).not.toBe(0);
    expect(reps.rows.filter((r) => r.floored)).toHaveLength(1);
    expect(reps.rows.at(-1)!.floored).toBe(true);
    const trap = (await getAccountPoolProgress(pool, d.accountId, "trap"))!;
    expect(trap.reputation).toBe(TUNABLES.REPUTATION_START);
    expect(trap.ladder_points).toBe(400 * TUNABLES.LADDER_GAIN_LOSS); // the trap ladder still earned
    const trapReps = await pool.query("SELECT 1 FROM ledger_event WHERE event_type = 'reputation_changed' AND payload->>'pool' = 'trap'");
    expect(trapReps.rowCount).toBe(0);
    expect((await verifyProjection(pool, d.accountId)).ok).toBe(true);
    expect((await verifyProjection(pool, o.accountId)).ok).toBe(true);
  });
});

describe("N7: the read model re-asserts the split", () => {
  it("throws on a living row with no caravan id rather than showing it as account-level", () => {
    const row: PoolProgressRow = {
      id: "r",
      pool: "living",
      account_id: "a",
      caravan_id: null,
      reputation: 1000,
      ladder_level: 0,
      ladder_points: 0,
      unlock_points_granted: 0,
      unlock_points_spent: 0,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    expect(() => toPoolProgressView(row)).toThrow(/no caravan id/);
    expect(() => toPoolProgressView({ ...row, pool: "trap", account_id: null })).toThrow(/no account id/);
    expect(toPoolProgressView({ ...row, caravan_id: "c", account_id: null }).scope).toBe("caravan");
  });
});

/**
 * Concurrency, driven for real against Postgres with several workers at once:
 *   - one standing party served into many encounters simultaneously;
 *   - many resolutions for one account (two caravans) at the same time;
 *   - short leases + slow handlers so leases expire while work is in flight: every stale
 *     worker loses cleanly (QA-02 B1), nothing commits twice, and the operator path
 *     re-queues the parked jobs under a lease that fits.
 * In every case: no job commits more than once, balances equal the sum of the log, and
 * the party template is byte-identical afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/pool.js";
import { PLACEHOLDER_HANDLERS, enqueueEncounterResolution } from "../src/jobs/handlers/encounterResolution.js";
import { countJobsByStatus, enqueueJob, getJob, requeueParkedJob } from "../src/jobs/queue.js";
import { drain, type HandlerRegistry, type RunOutcome } from "../src/jobs/worker.js";
import { canonicalJson, type Json } from "../src/ledger/events.js";
import { listEventsByCausation, listEventsForAccount } from "../src/ledger/ledger.js";
import { readLiveProjection, verifyProjection } from "../src/ledger/projection.js";
import { registerAccount } from "../src/services/onboarding.js";
import { testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const handlers: HandlerRegistry = {
  ...PLACEHOLDER_HANDLERS,
  test_coin: (job) => ({
    events: [
      { type: "coin_earned", accountId: job.accountId, payload: { amount: job.input["amount"] as number, reason: "test" } },
      { type: "ladder_progress_gained", accountId: job.accountId, caravanId: job.caravanId, payload: { pool: "living", pointsDelta: 1, levelsGained: 0 } },
      { type: "ladder_progress_gained", accountId: job.accountId, payload: { pool: "trap", pointsDelta: 2, levelsGained: 0 } },
    ],
    result: { ok: true },
  }),
};

async function partyBytes(accountId: string): Promise<string> {
  const res = await pool.query<{ j: string }>("SELECT row_to_json(sp)::text AS j FROM standing_party sp WHERE account_id = $1", [accountId]);
  return res.rows[0]!.j;
}

async function runWorkers(n: number, extra: Partial<Parameters<typeof drain>[1]> = {}): Promise<RunOutcome[]> {
  const all = await Promise.all(Array.from({ length: n }, (_, i) => drain(pool, { workerId: `w${i}`, handlers, retryBackoffMs: () => 0, ...extra })));
  return all.flat();
}

beforeAll(() => truncateAll(pool));
afterAll(() => pool.end());

describe("one standing party served into many concurrent encounters", () => {
  const N = 12;
  let ownerId: string;
  let defenders: { accountId: string; caravanId: string }[];
  let before: string;

  beforeAll(async () => {
    const o = await registerAccount(pool, { username: unique("owner"), password: "password123", regionId: "mountain" });
    ownerId = o.account.id;
    defenders = [];
    for (let i = 0; i < N; i++) {
      const d = await registerAccount(pool, { username: unique(`d${i}`), password: "password123", regionId: "desert" });
      defenders.push({ accountId: d.account.id, caravanId: d.caravan.id });
    }
    before = await partyBytes(ownerId);
  });

  it("every encounter resolves once against a byte-identical snapshot and the party is never mutated", async () => {
    // Enqueue all N concurrently (each in its own transaction), then run 4 workers at once.
    await Promise.all(
      defenders.map((d, i) =>
        withTransaction(pool, (c) =>
          enqueueEncounterResolution(c, {
            tripId: `fan-${i}`,
            encounterIndex: 0,
            defenderAccountId: d.accountId,
            defenderCaravanId: d.caravanId,
            partyOwnerAccountId: ownerId,
            formation: { fences: [{ x: 0, y: 0 }], traps: [], posts: [] },
          }),
        ),
      ),
    );
    const outcomes = await runWorkers(4);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(Array(N).fill("completed"));
    expect(await countJobsByStatus(pool)).toMatchObject({ queued: 0, leased: 0, parked: 0 });

    const snapshots = new Set<string>();
    const outcomesSeen = new Set<string>();
    for (let i = 0; i < N; i++) {
      const job = (await getJob(pool, `encounter:fan-${i}:0`))!;
      expect(job.status).toBe("completed");
      snapshots.add(canonicalJson(job.input["party"] as Json));
      const events = await listEventsByCausation(pool, job.id);
      expect(events.length).toBe(2);
      expect(canonicalJson(events[0]!.payload["party"] as Json)).toBe(canonicalJson(job.input["party"] as Json));
      outcomesSeen.add(canonicalJson(events[0]!.payload["outcome"] as Json));
    }
    expect(snapshots.size).toBe(1); // all N read the same template
    expect(outcomesSeen.size).toBe(1); // and resolved identically
    expect(await partyBytes(ownerId)).toBe(before); // the template itself is untouched
    const feed = await listEventsForAccount(pool, ownerId, { limit: 500 });
    expect(feed.filter((e) => e.event_type === "party_served_as_encounter").length).toBe(N);
    expect(feed.every((e) => e.caravan_id === null)).toBe(true); // nothing caravan-scoped leaked onto the owner
    for (const d of defenders) expect((await verifyProjection(pool, d.accountId)).ok).toBe(true);
    expect((await verifyProjection(pool, ownerId)).ok).toBe(true);
  });
});

describe("many resolutions for one account at once", () => {
  const JOBS = 40;
  const WORKERS = 6;
  let accountId: string;
  let caravanA: string;
  let caravanB: string;

  beforeAll(async () => {
    const a = await registerAccount(pool, { username: unique("busy"), password: "password123", regionId: "desert" });
    accountId = a.account.id;
    caravanA = a.caravan.id;
    // The schema supports a second caravan (chunk 01); insert it directly to get two
    // trips for one account racing each other.
    const b = await pool.query<{ id: string }>("INSERT INTO caravan (account_id, region_id, name) VALUES ($1, 'badlands', 'B') RETURNING id", [accountId]);
    caravanB = b.rows[0]!.id;
    await pool.query("INSERT INTO pool_progress (pool, caravan_id, reputation) VALUES ('living', $1, 1000)", [caravanB]);
  });

  it("balances equal the sum of the log; no job commits twice; both caravans' ladders are right", async () => {
    let expectedCoin = 0;
    for (let i = 0; i < JOBS; i++) {
      const amount = 1 + (i % 7);
      expectedCoin += amount;
      await enqueueJob(pool, { id: `busy:${i}`, kind: "test_coin", accountId, caravanId: i % 2 === 0 ? caravanA : caravanB, input: { amount } });
    }
    const outcomes = await runWorkers(WORKERS);
    expect(outcomes.filter((o) => o.kind === "completed").length).toBe(JOBS);
    expect(outcomes.filter((o) => o.kind === "failed").length).toBe(0);

    const live = await readLiveProjection(pool, accountId);
    expect(live.coinBalance).toBe(expectedCoin);
    expect(live.caravanPools[caravanA]!.ladderPoints).toBe(JOBS / 2);
    expect(live.caravanPools[caravanB]!.ladderPoints).toBe(JOBS / 2);
    expect(live.accountPools.trap.ladderPoints).toBe(JOBS * 2);
    for (let i = 0; i < JOBS; i++) expect((await listEventsByCausation(pool, `busy:${i}`)).length).toBe(3);
    const v = await verifyProjection(pool, accountId);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.eventsFolded).toBe(JOBS * 3);
  });

  it("within one account, events commit in seq order (the append lock holds)", async () => {
    const events = await listEventsForAccount(pool, accountId, { limit: 500 });
    // Every job's three events are contiguous in seq: no other job's event interleaves.
    for (let i = 0; i < events.length; i += 3) {
      const trio = events.slice(i, i + 3);
      expect(new Set(trio.map((e) => e.causation_id)).size).toBe(1);
      expect(trio.map((e) => e.causation_seq)).toEqual([0, 1, 2]);
    }
  });
});

describe("lease expiry under load (QA-02 B1)", () => {
  const JOBS = 24;
  let accountId: string;
  let caravanId: string;
  const slowHandler = async (job: { id: string }) => {
    await sleep(20 + (Number(job.id.split(":")[1]) % 3) * 10);
  };

  beforeAll(async () => {
    const a = await registerAccount(pool, { username: unique("steal"), password: "password123", regionId: "desert" });
    accountId = a.account.id;
    caravanId = a.caravan.id;
  });

  it("with 5ms leases and 20-40ms handlers every attempt loses cleanly: nothing commits, jobs park with 'lease expired'", async () => {
    for (let i = 0; i < JOBS; i++) {
      await enqueueJob(pool, { id: `steal:${i}`, kind: "test_coin", accountId, caravanId, input: { amount: 3 }, maxAttempts: 4 });
    }
    const outcomes = await runWorkers(5, { visibilityTimeoutMs: 5, beforeComplete: slowHandler });
    expect(outcomes.filter((o) => o.kind === "completed").length).toBe(0);
    expect(outcomes.filter((o) => o.kind === "failed").length).toBe(0);
    expect(outcomes.filter((o) => o.kind === "superseded").length).toBeGreaterThan(0); // the scenario actually happened
    expect(await countJobsByStatus(pool)).toMatchObject({ queued: 0, leased: 0, parked: JOBS }); // completed counts earlier describes' jobs
    for (let i = 0; i < JOBS; i++) {
      const job = (await getJob(pool, `steal:${i}`))!;
      expect(job.last_error).toBe("lease expired");
      expect((await listEventsByCausation(pool, job.id)).length).toBe(0);
    }
    expect((await readLiveProjection(pool, accountId)).coinBalance).toBe(0);
  });

  it("re-queued by the operator under a lease that fits the handler, every job commits exactly once", async () => {
    for (let i = 0; i < JOBS; i++) expect((await requeueParkedJob(pool, `steal:${i}`))?.status).toBe("queued");
    const outcomes = await runWorkers(5, { visibilityTimeoutMs: 5_000, beforeComplete: slowHandler });
    expect(outcomes.filter((o) => o.kind === "completed").length).toBe(JOBS);
    expect(outcomes.filter((o) => o.kind !== "completed").length).toBe(0);
    expect(await countJobsByStatus(pool)).toMatchObject({ queued: 0, leased: 0, parked: 0 });
    expect((await readLiveProjection(pool, accountId)).coinBalance).toBe(JOBS * 3);
    for (let i = 0; i < JOBS; i++) expect((await listEventsByCausation(pool, `steal:${i}`)).length).toBe(3);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });
});

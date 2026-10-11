/**
 * The job queue: deterministic ids, idempotent enqueue, lease/complete/retry/park, the
 * attempt fence, snapshot immutability, and replay determinism. No background ticking.
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/pool.js";
import type { ResolutionJobRow } from "../src/db/types.js";
import { DEFAULT_HANDLERS, PLACEHOLDER_HANDLERS, enqueueEncounterResolution } from "../src/jobs/handlers/encounterResolution.js";
import { JobInputConflictError, countJobsByStatus, encounterJobId, enqueueJob, getJob, leaseNextJob, lockJobForCompletion } from "../src/jobs/queue.js";
import { snapshotStandingParty } from "../src/jobs/snapshots.js";
import { JOB_MAX_ATTEMPTS } from "../src/jobs/tunables.js";
import { drain, dryRunJob, runOnce, verifyJobReplay, type HandlerRegistry } from "../src/jobs/worker.js";
import { canonicalJson, type Json } from "../src/ledger/events.js";
import { listEventsByCausation, listEventsForAccount } from "../src/ledger/ledger.js";
import { readLiveProjection, verifyProjection } from "../src/ledger/projection.js";
import { registerAccount } from "../src/services/onboarding.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let defender: { accountId: string; caravanId: string };
let owner: { accountId: string; caravanId: string };

/** A test job kind that moves balances, so projections can be checked. */
const TEST_COIN_KIND = "test_coin";
const handlers: HandlerRegistry = {
  ...PLACEHOLDER_HANDLERS,
  [TEST_COIN_KIND]: (job) => {
    const amount = job.input["amount"] as number;
    return {
      events: [
        { type: "coin_earned", accountId: job.accountId, payload: { amount, reason: "test" } },
        { type: "reputation_changed", accountId: job.accountId, caravanId: job.caravanId, payload: { pool: "living", delta: 1, reason: "test" } },
      ],
      result: { credited: amount },
    };
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Retry immediately: these tests drive retries by hand (the backoff itself is tested in qa02-regressions). */
const retryBackoffMs = () => 0;

async function enqueueEncounter(tripId: string, encounterIndex = 0, formation: Record<string, Json> = { fences: [{ x: 1, y: 2 }], traps: [], posts: [] }) {
  // Chunk 14 QA S1: the enqueue takes the pre-taken party snapshot; bypassing matchmaking, this test takes its own.
  return withTransaction(pool, async (c) =>
    enqueueEncounterResolution(c, {
      tripId,
      encounterIndex,
      defenderAccountId: defender.accountId,
      defenderCaravanId: defender.caravanId,
      partyOwnerAccountId: owner.accountId,
      formation,
      party: await snapshotStandingParty(c, owner.accountId),
    }),
  );
}

beforeAll(async () => {
  await truncateAll(pool);
  const d = await registerAccount(pool, { username: unique("def"), password: "password123", regionId: "desert" });
  const o = await registerAccount(pool, { username: unique("own"), password: "password123", regionId: "badlands" });
  defender = { accountId: d.account.id, caravanId: d.caravan.id };
  owner = { accountId: o.account.id, caravanId: o.caravan.id };
});
afterAll(() => pool.end());

describe("deterministic ids and idempotent enqueue", () => {
  it("derives the job id from trip + encounter identity, never from randomness", () => {
    expect(encounterJobId("trip-a", 3)).toBe("encounter:trip-a:3");
    expect(encounterJobId("trip-a", 3)).toBe(encounterJobId("trip-a", 3));
    expect(() => encounterJobId("trip-a", -1)).toThrow(RangeError);
    expect(() => encounterJobId("", 0)).toThrow(RangeError);
  });

  it("enqueueing the same encounter twice returns the first job and appends nothing", async () => {
    const a = await enqueueEncounter("trip-dup");
    // The owner edits their party in between: a retry of the same commit is still a no-op.
    await pool.query("UPDATE standing_party SET updated_at = now() + interval '1 minute' WHERE account_id = $1", [owner.accountId]);
    const b = await enqueueEncounter("trip-dup");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.input).toEqual(a.job.input); // the first snapshot stands
    expect((await listEventsByCausation(pool, `enqueue:${a.job.id}`)).length).toBe(1);
  });

  it("re-committing the same encounter with a DIFFERENT formation is a conflict, not a silent no-op (QA-02 S4)", async () => {
    const a = await enqueueEncounter("trip-conflict");
    await expect(enqueueEncounter("trip-conflict", 0, { fences: [{ x: 9, y: 9 }], traps: [], posts: [] })).rejects.toBeInstanceOf(JobInputConflictError);
    expect((await getJob(pool, a.job.id))!.input).toEqual(a.job.input);
    expect((await listEventsByCausation(pool, `enqueue:${a.job.id}`)).length).toBe(1);
    // The generic queue applies the same rule to any job id.
    await enqueueJob(pool, { id: "test:conflict", kind: TEST_COIN_KIND, accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION, amount: 1 } });
    expect((await enqueueJob(pool, { id: "test:conflict", kind: TEST_COIN_KIND, accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION, amount: 1 } })).created).toBe(false);
    await expect(enqueueJob(pool, { id: "test:conflict", kind: TEST_COIN_KIND, accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION, amount: 2 } })).rejects.toBeInstanceOf(JobInputConflictError);
  });

  it("the job input carries both snapshots and the resolver version", async () => {
    const { job } = await enqueueEncounter("trip-shape");
    expect(job.input).toMatchObject({
      tripId: "trip-shape",
      encounterIndex: 0,
      defenderAccountId: defender.accountId,
      defenderCaravanId: defender.caravanId,
      partyOwnerAccountId: owner.accountId,
      formation: { fences: [{ x: 1, y: 2 }], traps: [], posts: [] },
      party: { ownerAccountId: owner.accountId },
      resolverVersion: RESOLVER_VERSION,
    });
    expect(typeof (job.input["party"] as { savedAt: string }).savedAt).toBe("string");
    const committed = await listEventsByCausation(pool, `enqueue:${job.id}`);
    expect(committed[0]).toMatchObject({ event_type: "formation_committed", account_id: defender.accountId, caravan_id: defender.caravanId });
  });
});

describe("lease, complete, retry, park", () => {
  beforeAll(() => drain(pool, { workerId: "setup", handlers, retryBackoffMs })); // clear what the enqueue tests left queued

  it("runOnce resolves one job and commits its events under the job id with the resolver version", async () => {
    const { job } = await enqueueEncounter("trip-run");
    const outcome = await runOnce(pool, { workerId: "w1", handlers, retryBackoffMs });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.eventCount).toBe(2);
    const done = (await getJob(pool, job.id))!;
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(1);
    expect(done.result).toMatchObject({ resolverVersion: RESOLVER_VERSION });
    const events = await listEventsByCausation(pool, job.id);
    expect(events.map((e) => [e.event_type, e.causation_seq, e.resolver_version])).toEqual([
      ["encounter_resolved", 0, RESOLVER_VERSION],
      ["party_served_as_encounter", 1, RESOLVER_VERSION],
    ]);
    // Defender side is caravan-scoped; the owner's feed entry is account-scoped.
    expect(events[0]).toMatchObject({ account_id: defender.accountId, caravan_id: defender.caravanId });
    expect(events[1]).toMatchObject({ account_id: owner.accountId, caravan_id: null });
    expect(events[0]!.payload["formation"]).toEqual(job.input["formation"]);
    expect(events[0]!.payload["party"]).toEqual(job.input["party"]);
  });

  it("an idle queue returns idle; drain stops on its own", async () => {
    expect(await runOnce(pool, { workerId: "w1", handlers, retryBackoffMs })).toEqual({ kind: "idle" });
    expect(await drain(pool, { workerId: "w1", handlers, retryBackoffMs })).toEqual([]);
  });

  it("replaying a completed job commits nothing new", async () => {
    const { job } = await enqueueEncounter("trip-replay");
    await drain(pool, { workerId: "w1", handlers, retryBackoffMs });
    const before = await listEventsByCausation(pool, job.id);
    expect(before.length).toBe(2);
    // A second worker pass: nothing to lease.
    expect(await drain(pool, { workerId: "w2", handlers, retryBackoffMs })).toEqual([]);
    // Forcing the completion path by hand, even with the winning worker's own fence: refused.
    await withTransaction(pool, async (c) => {
      expect(await lockJobForCompletion(c, job.id, { workerId: "w1", attempts: 1 })).toBeNull();
    });
    // Forcing the ledger by hand under the same causation id: the unique key refuses it.
    const dup = await expectDbError(
      pool,
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, resolver_version, payload)
       VALUES ('encounter_resolved', $1, $2, $3, 0, 0, '{}')`,
      [defender.accountId, defender.caravanId, job.id],
    );
    expect(dup?.code).toBe("23505");
    expect(await listEventsByCausation(pool, job.id)).toEqual(before);
    expect((await getJob(pool, job.id))!.attempts).toBe(1);
  });

  it("a failure after a partial append rolls back everything, then the retry commits exactly once", async () => {
    const { job } = await enqueueJob(pool, {
      id: "test:partial",
      kind: TEST_COIN_KIND,
      accountId: defender.accountId,
      caravanId: defender.caravanId,
      input: { resolverVersion: RESOLVER_VERSION, amount: 17 },
    });
    const coinBefore = (await readLiveProjection(pool, defender.accountId)).coinBalance;
    let crashes = 0;
    const opts = {
      workerId: "crashy",
      handlers,
      retryBackoffMs,
      afterAppend: async (j: ResolutionJobRow, client: import("pg").PoolClient) => {
        // Events are in the transaction at this point...
        expect((await client.query("SELECT count(*)::int AS n FROM ledger_event WHERE causation_id = $1", [j.id])).rows[0].n).toBe(2);
        if (crashes++ === 0) throw new Error("simulated crash after partial commit");
      },
    };
    const first = await runOnce(pool, opts);
    expect(first.kind).toBe("failed");
    // ...and gone after the rollback. Coin did not move.
    expect((await listEventsByCausation(pool, job.id)).length).toBe(0);
    expect((await readLiveProjection(pool, defender.accountId)).coinBalance).toBe(coinBefore);
    const mid = (await getJob(pool, job.id))!;
    expect(mid.status).toBe("queued");
    expect(mid.attempts).toBe(1);
    expect(mid.last_error).toContain("simulated crash");

    const second = await runOnce(pool, opts);
    expect(second.kind).toBe("completed");
    expect((await listEventsByCausation(pool, job.id)).length).toBe(2);
    expect((await readLiveProjection(pool, defender.accountId)).coinBalance).toBe(coinBefore + 17);
    const done = (await getJob(pool, job.id))!;
    expect(done).toMatchObject({ status: "completed", attempts: 2, last_error: null });
    expect((await verifyProjection(pool, defender.accountId)).ok).toBe(true);
    // Third pass: nothing.
    expect(await runOnce(pool, opts)).toEqual({ kind: "idle" });
  });

  it("a handler that keeps failing is parked after JOB_MAX_ATTEMPTS with no events", async () => {
    const boom: HandlerRegistry = {
      ...handlers,
      boom: () => {
        throw new Error("always fails");
      },
    };
    const { job } = await enqueueJob(pool, { id: "test:boom", kind: "boom", accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION } });
    const outcomes = await drain(pool, { workerId: "w1", handlers: boom, retryBackoffMs });
    expect(outcomes.map((o) => o.kind)).toEqual(Array(JOB_MAX_ATTEMPTS).fill("failed"));
    const parked = (await getJob(pool, job.id))!;
    expect(parked).toMatchObject({ status: "parked", attempts: JOB_MAX_ATTEMPTS, last_error: "Error: always fails" });
    expect((await listEventsByCausation(pool, job.id)).length).toBe(0);
    expect(await leaseNextJob(pool, "w1")).toBeNull();
  });

  it("an unknown job kind fails and parks rather than committing anything", async () => {
    await enqueueJob(pool, { id: "test:unknown", kind: "no_such_kind", accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION } });
    const outcomes = await drain(pool, { workerId: "w1", handlers, retryBackoffMs });
    expect(outcomes.every((o) => o.kind === "failed")).toBe(true);
    expect((await getJob(pool, "test:unknown"))!.status).toBe("parked");
  });

  it("an expired lease can be re-leased, and the stale worker's completion is refused", async () => {
    const { job } = await enqueueJob(pool, { id: "test:fence", kind: TEST_COIN_KIND, accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION, amount: 5 } });
    const coinBefore = (await readLiveProjection(pool, defender.accountId)).coinBalance;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Slow worker: 1ms lease, then blocks until the fast worker has finished.
    const slow = runOnce(pool, { workerId: "slow", handlers, retryBackoffMs, visibilityTimeoutMs: 1, beforeComplete: () => gate });
    await sleep(30);
    const fast = await runOnce(pool, { workerId: "fast", handlers, retryBackoffMs });
    expect(fast.kind).toBe("completed");
    release();
    const slowOutcome = await slow;
    expect(slowOutcome).toEqual({ kind: "superseded", jobId: job.id });
    const done = (await getJob(pool, job.id))!;
    expect(done).toMatchObject({ status: "completed", attempts: 2, leased_by: "fast" });
    expect((await listEventsByCausation(pool, job.id)).length).toBe(2);
    expect((await readLiveProjection(pool, defender.accountId)).coinBalance).toBe(coinBefore + 5);
  });

  it("a lease that would exceed max_attempts parks the job instead", async () => {
    await enqueueJob(pool, { id: "test:expire-park", kind: TEST_COIN_KIND, accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION, amount: 1 }, maxAttempts: 1 });
    const never = new Promise<void>(() => undefined);
    void runOnce(pool, { workerId: "stuck", handlers, retryBackoffMs, visibilityTimeoutMs: 1, beforeComplete: () => never });
    await sleep(30);
    expect(await leaseNextJob(pool, "w2")).toBeNull();
    expect((await getJob(pool, "test:expire-park"))!.status).toBe("parked");
  });

  it("job status counts add up", async () => {
    const counts = await countJobsByStatus(pool);
    expect(counts.leased).toBe(0);
    expect(counts.queued).toBe(0);
    expect(counts.parked).toBe(3);
    expect(counts.completed).toBeGreaterThanOrEqual(4);
  });
});

describe("history is frozen", () => {
  it("a completed job and its input are immutable; rows leave only with the account", async () => {
    const job = (await getJob(pool, encounterJobId("trip-run", 0)))!;
    for (const sql of [
      "UPDATE resolution_job SET input = '{}' WHERE id = $1",
      "UPDATE resolution_job SET result = '{}' WHERE id = $1",
      "UPDATE resolution_job SET status = 'queued', result = NULL, completed_at = NULL WHERE id = $1",
      "UPDATE resolution_job SET caravan_id = gen_random_uuid() WHERE id = $1",
      "DELETE FROM resolution_job WHERE id = $1",
    ]) {
      const err = await expectDbError(pool, sql, [job.id]);
      expect(err?.code, sql).toBe("23514");
    }
    const queued = await enqueueJob(pool, { id: "test:immutable-input", kind: TEST_COIN_KIND, accountId: defender.accountId, caravanId: defender.caravanId, input: { resolverVersion: RESOLVER_VERSION, amount: 1 } });
    expect((await expectDbError(pool, "UPDATE resolution_job SET input = '{\"amount\": 2}' WHERE id = $1", [queued.job.id]))?.code).toBe("23514");
    expect((await expectDbError(pool, "UPDATE resolution_job SET attempts = 0 WHERE id = $1", [job.id]))?.code).toBe("23514");
  });

  it("the owner editing their party mid-resolution does not change what was resolved", async () => {
    await drain(pool, { workerId: "setup", handlers, retryBackoffMs });
    const { job } = await enqueueEncounter("trip-edit");
    const servedSavedAt = (job.input["party"] as { savedAt: string }).savedAt;
    const outcome = await runOnce(pool, {
      workerId: "w1",
      handlers,
      beforeComplete: async () => {
        // The owner saves their party while the fight is in flight.
        await pool.query("UPDATE standing_party SET updated_at = now() + interval '1 hour' WHERE account_id = $1", [owner.accountId]);
      },
    });
    expect(outcome.kind).toBe("completed");
    const live = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM standing_party WHERE account_id = $1", [owner.accountId]);
    expect(live.rows[0]!.updated_at.toISOString()).not.toBe(servedSavedAt);
    const [resolved, served] = await listEventsByCausation(pool, job.id);
    expect((resolved!.payload["party"] as { savedAt: string }).savedAt).toBe(servedSavedAt);
    expect(served!.payload["partySavedAt"]).toBe(servedSavedAt);
    expect((await getJob(pool, job.id))!.input).toEqual(job.input);
  });

  it("the defender mutating their formation object after committing does not reach the job", async () => {
    const formation: Record<string, Json> = { fences: [{ x: 1, y: 1 }], traps: [], posts: [] };
    const { job } = await enqueueEncounter("trip-alias", 0, formation);
    (formation["fences"] as Json[]).push({ x: 5, y: 5 });
    expect((await getJob(pool, job.id))!.input["formation"]).toEqual({ fences: [{ x: 1, y: 1 }], traps: [], posts: [] });
  });

  it("a formation with a non-integer number is refused at enqueue", async () => {
    await expect(enqueueEncounter("trip-float", 0, { fences: [{ x: 1.5 }], traps: [], posts: [] })).rejects.toThrow(/integers/);
    expect(await getJob(pool, encounterJobId("trip-float", 0))).toBeNull();
  });
});

describe("determinism", () => {
  it("re-running a completed job's handler reproduces its committed event stream, 100 times over", async () => {
    const job = (await getJob(pool, encounterJobId("trip-run", 0)))!;
    const check = await verifyJobReplay(pool, handlers, job.id);
    expect(check.ok, JSON.stringify(check)).toBe(true);
    const first = canonicalJson(dryRunJob(handlers, job) as unknown as Json);
    for (let i = 0; i < 100; i++) expect(canonicalJson(dryRunJob(handlers, job) as unknown as Json)).toBe(first);
  });

  it("the handler has no access to anything but its input", () => {
    for (const handler of [DEFAULT_HANDLERS.encounter_resolution, PLACEHOLDER_HANDLERS.encounter_resolution]) {
      const src = handler.toString();
      for (const banned of ["Date", "Math.random", "process.", "query(", "fetch("]) expect(src.includes(banned), banned).toBe(false);
    }
  });

  it("every ledger event this suite wrote carries a deterministic causation id", async () => {
    for (const id of [defender.accountId, owner.accountId]) {
      const events = await listEventsForAccount(pool, id, { limit: 500 });
      expect(events.length).toBeGreaterThan(0);
      // starting_roster:<caravan id>: the caravan's creation grant (chunk 24 QA D1), deterministic too.
      for (const e of events) expect(e.causation_id).toMatch(/^(encounter:|enqueue:encounter:|test:|starting_roster:)/);
    }
  });
});

/**
 * Chunk 02 QA round 1 regressions (roadmap/qa/02-punchlist.md). Each describe block is one
 * reproduction from the QA probe, turned into an assertion that the hole is closed:
 *   B1  completion fence: stale / never-leased / parked jobs cannot be completed; version skew fails
 *   S1  the app role cannot write projected columns; the projection trigger still can
 *   S2  an event or job cannot name another account's caravan
 *   S3  pool payloads are type-checked; a bad ledger is a mismatch, never a crash
 *   S4  re-enqueue with a different input is a conflict (covered in jobs.test.ts too)
 *   S5  lock order: coinCreditDraft asserts, lockAccountsForAppend is deadlock-free
 *   S6  the worker clamps handler credits to the cap and replay still verifies
 *   S7  TRUNCATE guards, insert-only snapshots, snapshot cross-check
 *   S8  GET /me/ledger validates its query and reports hasMore
 *   S9  the production encounter handler parks rather than resolving with no resolver
 *   N1  causation_seq contiguity    N3  retry backoff    B1c  requeueParkedJob
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueSession } from "../src/auth/sessions.js";
import { withTransaction } from "../src/db/pool.js";
import { DEFAULT_HANDLERS, ENCOUNTER_RESOLUTION_WIRED, PLACEHOLDER_HANDLERS, enqueueEncounterResolution } from "../src/jobs/handlers/encounterResolution.js";
import { snapshotStandingParty } from "../src/jobs/snapshots.js";
import {
  JobInputConflictError,
  enqueueJob,
  getJob,
  leaseNextJob,
  lockJobForCompletion,
  markJobCompleted,
  markJobFailed,
  markJobParked,
  requeueParkedJob,
  retryBackoffMs,
} from "../src/jobs/queue.js";
import { JOB_RETRY_BACKOFF_BASE_MS, JOB_RETRY_BACKOFF_MAX_MS } from "../src/jobs/tunables.js";
import { assertResolverVersionMatches, drain, runOnce, verifyJobReplay, type HandlerRegistry } from "../src/jobs/worker.js";
import { coinCreditDraft } from "../src/ledger/coin.js";
import { appendEvents, isAccountAppendLockHeld, listEventsByCausation, lockAccountsForAppend } from "../src/ledger/ledger.js";
import { maybeSnapshot, readLiveProjection, verifyProjection } from "../src/ledger/projection.js";
import { rebuildAll } from "../src/ledger/rebuild.js";
import { registerAccount } from "../src/services/onboarding.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const owner = testPool();
const app = appRolePool();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noBackoff = () => 0;

type Acct = { accountId: string; caravanId: string };
let A: Acct, B: Acct, C: Acct, D: Acct;

const handlers: HandlerRegistry = {
  ...PLACEHOLDER_HANDLERS,
  coin: (job) => ({
    events: [{ type: "coin_earned", accountId: job.accountId, payload: { amount: job.input["amount"] as number, reason: "probe" } }],
    result: { ok: true },
  }),
  /** Credits two accounts in one job: the defender and a second account named in the input. */
  two_coin: (job) => ({
    events: [
      { type: "coin_earned", accountId: job.accountId, payload: { amount: job.input["amount"] as number, reason: "two" } },
      { type: "coin_earned", accountId: job.input["other"] as string, payload: { amount: job.input["amount"] as number, reason: "two" } },
    ],
    result: { ok: true },
  }),
};

async function register(prefix: string): Promise<Acct> {
  const r = await registerAccount(app, { username: unique(prefix), password: "password123", regionId: "desert" });
  return { accountId: r.account.id, caravanId: r.caravan.id };
}
async function balance(accountId: string): Promise<number> {
  return (await readLiveProjection(app, accountId)).coinBalance;
}
async function cap(accountId: string): Promise<{ balance: number; cap: number }> {
  const r = (await app.query<{ coin_balance: number; coin_storage_cap: number }>("SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1", [accountId])).rows[0]!;
  return { balance: r.coin_balance, cap: r.coin_storage_cap };
}
const coinJob = (id: string, acct: Acct, amount: number, extra: { maxAttempts?: number } = {}) =>
  enqueueJob(app, { id, kind: "coin", accountId: acct.accountId, caravanId: acct.caravanId, input: { amount, resolverVersion: RESOLVER_VERSION }, ...extra });

beforeAll(async () => {
  await truncateAll(owner);
  [A, B, C, D] = await Promise.all([register("a"), register("b"), register("c"), register("d")]);
});
afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("B1: completion is fenced on the lease", () => {
  it("a never-leased (queued) job cannot be completed by anyone holding its id", async () => {
    const { job } = await coinJob("b1:queued", A, 7);
    await withTransaction(app, async (c) => {
      expect(await lockJobForCompletion(c, job.id, { workerId: "anyone", attempts: 0 })).toBeNull();
      await expect(markJobCompleted(c, job.id, { ok: true }, { workerId: "anyone", attempts: 0 })).rejects.toThrow(/fence/);
    });
    expect((await getJob(app, job.id))!.status).toBe("queued");
    // Leave the queue empty for the lease-by-hand tests below.
    expect((await drain(app, { workerId: "w", handlers, retryBackoffMs: noBackoff })).map((o) => o.kind)).toEqual(["completed"]);
  });

  it("a stale worker (its lease expired and was re-leased) loses; the fresh lease commits; then nothing else can", async () => {
    const { job } = await coinJob("b1:stale", B, 2);
    const before = await balance(B.accountId);
    const stale = (await leaseNextJob(app, "stale", 1))!;
    await sleep(10);
    const fresh = (await leaseNextJob(app, "fresh", 60_000))!;
    expect([stale.attempts, fresh.attempts]).toEqual([1, 2]);
    const commit = (who: string, attempts: number) =>
      withTransaction(app, async (c) => {
        const row = await lockJobForCompletion(c, job.id, { workerId: who, attempts });
        if (!row) return "superseded";
        await appendEvents(c, row.id, [{ type: "coin_earned", accountId: B.accountId, payload: { amount: 2, reason: who } }]);
        await markJobCompleted(c, row.id, { by: who }, { workerId: who, attempts });
        return "committed";
      });
    expect(await commit("stale", 1)).toBe("superseded");
    expect(await commit("fresh", 2)).toBe("committed");
    expect(await commit("fresh", 2)).toBe("superseded"); // already completed: even the winner cannot commit twice
    const done = (await getJob(app, job.id))!;
    expect(done).toMatchObject({ status: "completed", leased_by: "fresh", attempts: 2 });
    expect((await listEventsByCausation(app, job.id)).map((e) => e.payload["reason"])).toEqual(["fresh"]);
    expect(await balance(B.accountId)).toBe(before + 2);
  });

  it("a lease that expires while its worker is still running loses cleanly, even if nobody re-leased it", async () => {
    const { job } = await coinJob("b1:expired", B, 3);
    const before = await balance(B.accountId);
    const leased = (await leaseNextJob(app, "slow", 1))!;
    await sleep(10);
    const result = await withTransaction(app, async (c) => lockJobForCompletion(c, job.id, { workerId: "slow", attempts: leased.attempts }));
    expect(result).toBeNull();
    // Still leased-but-expired: the next lease takes it and commits.
    expect(await runOnce(app, { workerId: "next", handlers, retryBackoffMs: noBackoff })).toMatchObject({ kind: "completed" });
    expect(await balance(B.accountId)).toBe(before + 3);
  });

  it("a parked job is terminal for workers: the stale lease cannot complete it, and it cannot jump to completed", async () => {
    await coinJob("b1:parked", A, 1, { maxAttempts: 1 });
    const leased = (await leaseNextJob(app, "w1", 1))!;
    await sleep(10);
    expect(await leaseNextJob(app, "w2", 1000)).toBeNull(); // second lease parks it
    expect((await getJob(app, "b1:parked"))!.status).toBe("parked");
    const before = await balance(A.accountId);
    await withTransaction(app, async (c) => {
      expect(await lockJobForCompletion(c, leased.id, { workerId: "w1", attempts: leased.attempts })).toBeNull();
    });
    const direct = await expectDbError(owner, "UPDATE resolution_job SET status = 'completed', result = '{}', completed_at = now() WHERE id = $1", ["b1:parked"]);
    expect(direct?.code).toBe("23514");
    expect(direct?.message).toContain("parked");
    expect(await balance(A.accountId)).toBe(before);
    expect((await listEventsByCausation(app, "b1:parked")).length).toBe(0);
  });

  it("B1c: requeueParkedJob is the only way out of parked, and the job then completes once", async () => {
    expect(await requeueParkedJob(app, "b1:queued")).toBeNull(); // not parked
    const requeued = (await requeueParkedJob(app, "b1:parked"))!;
    expect(requeued).toMatchObject({ status: "queued", attempts: 2, max_attempts: 2 + 3, leased_by: null });
    const outcomes = await drain(app, { workerId: "op", handlers, retryBackoffMs: noBackoff });
    expect(outcomes.filter((o) => o.kind === "completed").map((o) => (o.kind === "completed" ? o.job.id : ""))).toContain("b1:parked");
    expect((await listEventsByCausation(app, "b1:parked")).length).toBe(1);
  });

  it("B1a / R2-S2: a job enqueued for another resolver version is never leased by this worker; a worker on that version takes it", async () => {
    await withTransaction(app, async (c) =>
      enqueueEncounterResolution(c, { tripId: "skew", encounterIndex: 0, defenderAccountId: C.accountId, defenderCaravanId: C.caravanId, partyOwnerAccountId: D.accountId, formation: { fences: [], traps: [], posts: [] }, party: await snapshotStandingParty(c, D.accountId) }),
    );
    // Only the owner can forge this (input is immutable to the app role and the guard trigger); simulate a deploy skew.
    await owner.query("ALTER TABLE resolution_job DISABLE TRIGGER resolution_job_guard");
    await owner.query("UPDATE resolution_job SET input = jsonb_set(input, '{resolverVersion}', '99') WHERE id = 'encounter:skew:0'");
    await owner.query("ALTER TABLE resolution_job ENABLE TRIGGER resolution_job_guard");
    // Round 1 failed it three times and parked it; round 2 (R2-S2) makes it invisible to a
    // worker on another version: no attempt burned, nothing parked during a rolling deploy.
    await drain(app, { workerId: "skewed", handlers, retryBackoffMs: noBackoff });
    const job = (await getJob(app, "encounter:skew:0"))!;
    expect(job).toMatchObject({ status: "queued", attempts: 0, leased_by: null, last_error: null });
    expect((await listEventsByCausation(app, job.id)).length).toBe(0);
    // A worker that does run v99 leases it at once.
    const v99 = (await leaseNextJob(app, "v99-worker", 60_000, 99))!;
    expect(v99).toMatchObject({ id: "encounter:skew:0", attempts: 1, leased_by: "v99-worker" });
    // (No v99 handler here: park it so it does not sit leased for the rest of the file.)
    expect(await markJobParked(app, v99.id, v99.attempts, "test: no v99 resolver in this suite", { workerId: "v99-worker" })).not.toBeNull();
    // Defense in depth: were a mismatched job to reach a worker anyway, the check still fires.
    expect(() => assertResolverVersionMatches(job)).toThrow(new RegExp(`resolver version mismatch.*v99.*v${RESOLVER_VERSION}`));
  });
});

describe("S9: no resolver, no resolution", () => {
  it.skipIf(ENCOUNTER_RESOLUTION_WIRED)("the production handler parks the encounter with a clear last_error instead of writing a placeholder outcome", async () => {
    await withTransaction(app, async (c) =>
      enqueueEncounterResolution(c, { tripId: "s9", encounterIndex: 0, defenderAccountId: C.accountId, defenderCaravanId: C.caravanId, partyOwnerAccountId: D.accountId, formation: { fences: [], traps: [], posts: [] }, party: await snapshotStandingParty(c, D.accountId) }),
    );
    const outcomes = await drain(app, { workerId: "prod", handlers: DEFAULT_HANDLERS, retryBackoffMs: noBackoff });
    expect(outcomes.map((o) => o.kind)).toEqual(["parked"]);
    const job = (await getJob(app, "encounter:s9:0"))!;
    expect(job).toMatchObject({ status: "parked", attempts: 1 });
    expect(job.last_error).toMatch(new RegExp(`no resolver.*RESOLVER_VERSION ${RESOLVER_VERSION}`));
    expect((await listEventsByCausation(app, job.id)).length).toBe(0);
    // The same job resolves under the explicitly-registered placeholder (tests only).
    expect(await requeueParkedJob(app, job.id)).not.toBeNull();
    expect((await drain(app, { workerId: "test", handlers, retryBackoffMs: noBackoff })).map((o) => o.kind)).toEqual(["completed"]);
  });
});

describe("S4: re-committing a different formation is a conflict", () => {
  it("throws JobInputConflictError and leaves the first commit untouched", async () => {
    const first = await withTransaction(app, async (c) =>
      enqueueEncounterResolution(c, { tripId: "s4", encounterIndex: 0, defenderAccountId: C.accountId, defenderCaravanId: C.caravanId, partyOwnerAccountId: D.accountId, formation: { fences: [], traps: [], posts: [] }, party: await snapshotStandingParty(c, D.accountId) }),
    );
    await expect(
      withTransaction(app, async (c) =>
        enqueueEncounterResolution(c, { tripId: "s4", encounterIndex: 0, defenderAccountId: C.accountId, defenderCaravanId: C.caravanId, partyOwnerAccountId: D.accountId, formation: { fences: [{ x: 9 }], traps: [], posts: [] }, party: await snapshotStandingParty(c, D.accountId) }),
      ),
    ).rejects.toBeInstanceOf(JobInputConflictError);
    expect((await getJob(app, first.job.id))!.input).toEqual(first.job.input);
    expect((await listEventsByCausation(app, `enqueue:${first.job.id}`)).length).toBe(1);
  });
});

describe("S5: one lock order for the ledger", () => {
  it("coinCreditDraft refuses to run without the account lock, with a message that names the fix", async () => {
    await expect(
      withTransaction(app, (c) => coinCreditDraft(c, { type: "coin_earned", accountId: A.accountId, amount: 1, reason: "x" })),
    ).rejects.toThrow(/lockAccountsForAppend/);
  });

  it("the mirror-image two-account transactions that used to deadlock both commit", async () => {
    const t = (first: string, second: string, tag: string) =>
      withTransaction(app, async (c) => {
        await lockAccountsForAppend(c, [first, second]);
        expect(await isAccountAppendLockHeld(c, first)).toBe(true);
        expect(await isAccountAppendLockHeld(c, second)).toBe(true);
        const d = await coinCreditDraft(c, { type: "coin_earned", accountId: first, amount: 1, reason: tag });
        await sleep(100);
        return appendEvents(c, `s5:${tag}`, [d, { type: "coin_earned", accountId: second, payload: { amount: 1, reason: tag } }]);
      });
    const [x, y] = await Promise.all([t(A.accountId, B.accountId, "x"), t(B.accountId, A.accountId, "y")]);
    expect(x.length + y.length).toBe(4);
    expect((await verifyProjection(app, A.accountId)).ok).toBe(true);
    expect((await verifyProjection(app, B.accountId)).ok).toBe(true);
  });

  it("two workers resolving mirror-image two-account jobs at once never deadlock", async () => {
    await enqueueJob(app, { id: "s5:ab", kind: "two_coin", accountId: A.accountId, caravanId: A.caravanId, input: { amount: 1, other: B.accountId, resolverVersion: RESOLVER_VERSION } });
    await enqueueJob(app, { id: "s5:ba", kind: "two_coin", accountId: B.accountId, caravanId: B.caravanId, input: { amount: 1, other: A.accountId, resolverVersion: RESOLVER_VERSION } });
    const outcomes = (await Promise.all([0, 1].map((i) => drain(app, { workerId: `s5w${i}`, handlers, retryBackoffMs: noBackoff })))).flat();
    expect(outcomes.filter((o) => o.kind !== "completed")).toEqual([]);
    for (const id of ["s5:ab", "s5:ba"]) {
      expect((await getJob(app, id))!.status).toBe("completed");
      expect((await listEventsByCausation(app, id)).length).toBe(2);
    }
  });

  it("two credits racing at 99% of the cap both clamp; the balance lands exactly on the cap", async () => {
    const { balance: bal, cap: capv } = await cap(C.accountId);
    const fill = Math.floor(capv * 0.99) - bal;
    await withTransaction(app, async (c) => {
      await lockAccountsForAppend(c, [C.accountId]);
      return appendEvents(c, "s5:fill", [await coinCreditDraft(c, { type: "coin_earned", accountId: C.accountId, amount: fill, reason: "fill" })]);
    });
    const credit = (id: string) =>
      withTransaction(app, async (c) => {
        await lockAccountsForAppend(c, [C.accountId]);
        return appendEvents(c, id, [await coinCreditDraft(c, { type: "coin_earned", accountId: C.accountId, amount: Math.ceil(capv * 0.05), reason: "race" })]);
      });
    const [x, y] = await Promise.all([credit("s5:c1"), credit("s5:c2")]);
    const applied = [x[0]!.payload["amount"], y[0]!.payload["amount"]] as number[];
    expect(applied.reduce((a, b) => a + b, 0)).toBe(capv - Math.floor(capv * 0.99));
    expect((await cap(C.accountId)).balance).toBe(capv);
    expect((await verifyProjection(app, C.accountId)).ok).toBe(true);
  });
});

describe("S6: the worker clamps handler credits to the cap", () => {
  it("an over-cap credit from a pure handler commits clamped, records the overflow, and still verifies on replay", async () => {
    const { cap: capv } = await cap(C.accountId); // C is at cap after the S5 race
    const { job } = await enqueueJob(app, { id: "s6:over", kind: "coin", accountId: C.accountId, caravanId: C.caravanId, input: { amount: capv, resolverVersion: RESOLVER_VERSION } });
    const outcome = await runOnce(app, { workerId: "w", handlers, retryBackoffMs: noBackoff });
    expect(outcome.kind).toBe("completed");
    const [ev] = await listEventsByCausation(app, job.id);
    expect(ev!.payload).toMatchObject({ amount: 0, overflowDiscarded: capv, reason: "probe" });
    expect((await cap(C.accountId)).balance).toBe(capv);
    const replay = await verifyJobReplay(app, handlers, job.id);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    expect((await verifyProjection(app, C.accountId)).ok).toBe(true);
  });

  it("a batch with two credits to one account consumes the room in order", async () => {
    const acct = await register("room");
    const { cap: capv } = await cap(acct.accountId);
    const { job } = await enqueueJob(app, { id: "s6:two", kind: "two_coin", accountId: acct.accountId, caravanId: acct.caravanId, input: { amount: capv - 10, other: acct.accountId, resolverVersion: RESOLVER_VERSION } });
    expect((await runOnce(app, { workerId: "w", handlers, retryBackoffMs: noBackoff })).kind).toBe("completed");
    const evs = await listEventsByCausation(app, job.id);
    expect(evs.map((e) => [e.payload["amount"], e.payload["overflowDiscarded"] ?? 0])).toEqual([
      [capv - 10, 0],
      [10, capv - 20],
    ]);
    expect((await cap(acct.accountId)).balance).toBe(capv);
    expect((await verifyJobReplay(app, handlers, job.id)).ok).toBe(true);
  });
});

describe("N3: failed attempts back off exponentially", () => {
  it("retryBackoffMs doubles from the base and caps", () => {
    expect(retryBackoffMs(1)).toBe(JOB_RETRY_BACKOFF_BASE_MS);
    expect(retryBackoffMs(2)).toBe(JOB_RETRY_BACKOFF_BASE_MS * 2);
    expect(retryBackoffMs(3)).toBe(JOB_RETRY_BACKOFF_BASE_MS * 4);
    expect(retryBackoffMs(60)).toBe(JOB_RETRY_BACKOFF_MAX_MS);
  });

  it("a failed job is not ready again until next_attempt_at, and failure is fenced on the worker too", async () => {
    const { job } = await coinJob("n3:slow", A, 1);
    const leased = (await leaseNextJob(app, "w1", 60_000))!;
    expect(await markJobFailed(app, job.id, leased.attempts, "boom", { workerId: "someone-else" })).toBeNull();
    const failed = (await markJobFailed(app, job.id, leased.attempts, "boom", { workerId: "w1", backoffMs: 400 }))!;
    expect(failed.status).toBe("queued");
    expect(failed.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 200);
    expect(await leaseNextJob(app, "w2", 60_000)).toBeNull(); // backing off, not at the head of the queue
    await sleep(450);
    expect((await leaseNextJob(app, "w2", 60_000))?.id).toBe(job.id);
    await withTransaction(app, async (c) => {
      const row = (await lockJobForCompletion(c, job.id, { workerId: "w2", attempts: 2 }))!;
      await appendEvents(c, row.id, [{ type: "coin_earned", accountId: A.accountId, payload: { amount: 1, reason: "n3" } }]);
      await markJobCompleted(c, row.id, { ok: true }, { workerId: "w2", attempts: 2 });
    });
    expect((await getJob(app, job.id))!.status).toBe("completed");
  });
});

describe("S1: projected columns are written only by the ledger", () => {
  it("the app role cannot UPDATE coin_balance or the pool_progress numbers, but every other column still works", async () => {
    for (const sql of [
      "UPDATE account SET coin_balance = coin_balance + 100 WHERE id = $1",
      "UPDATE pool_progress SET ladder_level = ladder_level + 1 WHERE account_id = $1 AND pool = 'trap'",
      "UPDATE pool_progress SET unlock_points_granted = unlock_points_granted + 5 WHERE account_id = $1 AND pool = 'trap'",
      "UPDATE pool_progress SET reputation = reputation + 1 WHERE account_id = $1 AND pool = 'siege'",
      "UPDATE pool_progress SET ladder_points = 0 WHERE account_id = $1 AND pool = 'siege'",
      "UPDATE pool_progress SET unlock_points_spent = 0 WHERE account_id = $1 AND pool = 'siege'",
    ]) {
      expect((await expectDbError(app, sql, [A.accountId]))?.code, sql).toBe("42501");
    }
    expect(await expectDbError(app, "UPDATE account SET password_hash = password_hash WHERE id = $1", [A.accountId])).toBeNull();
    expect(await expectDbError(app, "UPDATE pool_progress SET updated_at = now() WHERE account_id = $1 AND pool = 'trap'", [A.accountId])).toBeNull();
    expect((await verifyProjection(app, A.accountId)).ok).toBe(true);
  });

  it("appending an event as the app role still moves the projection (SECURITY DEFINER trigger)", async () => {
    const before = await readLiveProjection(app, A.accountId);
    await withTransaction(app, (c) =>
      appendEvents(c, "s1:via-ledger", [
        { type: "coin_earned", accountId: A.accountId, payload: { amount: 5, reason: "s1" } },
        { type: "reputation_changed", accountId: A.accountId, payload: { pool: "trap", delta: 2, reason: "s1" } },
      ]),
    );
    const after = await readLiveProjection(app, A.accountId);
    expect(after.coinBalance).toBe(before.coinBalance + 5);
    expect(after.accountPools.trap.reputation).toBe(before.accountPools.trap.reputation + 2);
  });
});

describe("S2: a caravan id must belong to the event's account", () => {
  const insert = (sql: string, params: unknown[]) => expectDbError(app, sql, params);
  it("ledger events and jobs naming another account's caravan are refused", async () => {
    expect(
      (await insert("INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ('reputation_changed',$1,$2,'s2:x',0,'{\"pool\":\"living\",\"delta\":4,\"reason\":\"x\"}')", [A.accountId, B.caravanId]))?.code,
    ).toBe("23503");
    expect((await insert("INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ('trip_started',$1,$2,'s2:y',0,'{}')", [A.accountId, B.caravanId]))?.code).toBe("23503");
    expect((await insert("INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts) VALUES ('s2:job','coin',$1,$2,'{\"amount\":1,\"resolverVersion\":0}',3)", [A.accountId, B.caravanId]))?.code).toBe("23503");
    const rep = await app.query<{ reputation: number }>("SELECT reputation FROM pool_progress WHERE caravan_id = $1", [B.caravanId]);
    expect(rep.rows[0]!.reputation).toBe((await readLiveProjection(app, B.accountId)).caravanPools[B.caravanId]!.reputation);
    expect((await verifyProjection(app, B.accountId)).ok).toBe(true);
  });
});

describe("S3: pool payloads are type-checked at the storage layer", () => {
  const pool = (type: string, payload: string, caravan = true) =>
    expectDbError(
      app,
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ($1, $2, $3, $4, 0, $5::jsonb)`,
      [type, A.accountId, caravan ? A.caravanId : null, `s3:${type}:${payload}`, payload],
    );
  it("a string, fractional or missing number is a CHECK violation", async () => {
    expect((await pool("reputation_changed", '{"pool":"living","delta":"3"}'))?.code).toBe("23514");
    expect((await pool("reputation_changed", '{"pool":"living","delta":1.5}'))?.code).toBe("23514");
    expect((await pool("reputation_changed", '{"pool":"living"}'))?.code).toBe("23514");
    expect((await pool("ladder_progress_gained", '{"pool":"living","pointsDelta":1}'))?.code).toBe("23514");
    expect((await pool("ladder_progress_gained", '{"pool":"living","pointsDelta":"1","levelsGained":0}'))?.code).toBe("23514");
    expect((await pool("unlock_points_granted", '{"pool":"living","points":"2"}'))?.code).toBe("23514");
    expect((await pool("unlock_node_purchased", '{"pool":"siege","nodeId":"x","cost":null}', false))?.code).toBe("23514");
    expect(await pool("reputation_changed", '{"pool":"living","delta":-3,"reason":"ok"}')).toBeNull();
    expect((await verifyProjection(app, A.accountId)).ok).toBe(true);
  });

  it("a malformed ledger (forced past the CHECK by the owner) is a mismatch, not a crash, and the sweep continues", async () => {
    const bad = await register("bad");
    await owner.query("ALTER TABLE ledger_event DROP CONSTRAINT ledger_event_pool_payload_integers");
    try {
      await owner.query(
        "INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload) VALUES ('reputation_changed',$1,$2,'s3:forced',0,'{\"pool\":\"living\",\"delta\":\"3\"}')",
        [bad.accountId, bad.caravanId],
      );
      const v = await verifyProjection(app, bad.accountId);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/delta/);
      const all = await rebuildAll(app, [bad.accountId, A.accountId]);
      expect(all).toEqual({ checked: 2, mismatches: [bad.accountId] });
    } finally {
      await owner.query("DELETE FROM account WHERE id = $1", [bad.accountId]);
      await owner.query(`ALTER TABLE ledger_event ADD CONSTRAINT ledger_event_pool_payload_integers CHECK (
        CASE event_type
          WHEN 'reputation_changed'     THEN jsonb_is_integer(payload->'delta')
          WHEN 'ladder_progress_gained' THEN jsonb_is_integer(payload->'pointsDelta') AND jsonb_is_integer(payload->'levelsGained')
          WHEN 'unlock_points_granted'  THEN jsonb_is_integer(payload->'points')
          WHEN 'unlock_node_purchased'  THEN jsonb_is_integer(payload->'cost')
          ELSE true
        END)`);
    }
  });
});

describe("S7 + N1: nothing in the ledger can be truncated, snapshots are insert-only, causes are contiguous", () => {
  const tx = async (db: typeof owner, sql: string) => {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql);
      return null;
    } catch (e) {
      return e as Error & { code?: string };
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  };

  it("TRUNCATE is refused for the owner (trigger) and the app role (privilege) on every ledger table", async () => {
    for (const t of ["ledger_event", "resolution_job", "ledger_snapshot"]) {
      expect((await tx(owner, `TRUNCATE ${t}`))?.code, `owner ${t}`).toBe("23514");
      expect((await tx(app, `TRUNCATE ${t}`))?.code, `app ${t}`).toBe("42501");
    }
    expect((await tx(app, "ALTER TABLE ledger_event DISABLE TRIGGER ledger_event_guard_update"))?.code).toBe("42501");
  });

  it("ledger_snapshot rows cannot be updated or deleted while the account exists", async () => {
    const seq = await maybeSnapshot(app, A.accountId, 1);
    expect(seq).not.toBeNull();
    expect((await expectDbError(owner, "UPDATE ledger_snapshot SET state = '{}' WHERE account_id = $1", [A.accountId]))?.code).toBe("23514");
    expect((await expectDbError(owner, "DELETE FROM ledger_snapshot WHERE account_id = $1", [A.accountId]))?.code).toBe("23514");
    expect((await verifyProjection(app, A.accountId)).snapshot).toMatchObject({ throughSeq: seq, ok: true });
  });

  it("a snapshot that disagrees with the log is a verification failure", async () => {
    const acct = await register("snap");
    await withTransaction(app, (c) => appendEvents(c, "s7:one", [{ type: "coin_earned", accountId: acct.accountId, payload: { amount: 9, reason: "x" } }]));
    const seq = (await maybeSnapshot(app, acct.accountId, 1))!;
    expect((await verifyProjection(app, acct.accountId)).ok).toBe(true);
    // A later, wrong checkpoint (insert-only, so this is the only way to plant one).
    await app.query("INSERT INTO ledger_snapshot (account_id, through_seq, state) VALUES ($1, $2, $3::jsonb)", [
      acct.accountId,
      seq + 1,
      JSON.stringify({ coinBalance: 999, accountPools: {}, caravanPools: {} }),
    ]);
    const v = await verifyProjection(app, acct.accountId);
    expect(v.ok).toBe(false);
    expect(v.snapshot).toMatchObject({ throughSeq: seq + 1, ok: false });
    expect((await rebuildAll(app, [acct.accountId])).mismatches).toEqual([acct.accountId]);
    await owner.query("DELETE FROM account WHERE id = $1", [acct.accountId]);
  });

  it("causation_seq must be contiguous from 0, in insert order", async () => {
    const ins = (causation: string, seqs: number[]) =>
      expectDbError(
        app,
        `INSERT INTO ledger_event (event_type, account_id, causation_id, causation_seq, payload) VALUES ${seqs.map((n) => `('coin_earned', $1, $2, ${n}, '{"amount":0,"reason":"n1"}')`).join(",")}`,
        [A.accountId, causation],
      );
    expect((await ins("n1:gap", [5]))?.code).toBe("23514");
    expect((await ins("n1:ooo", [1, 0]))?.code).toBe("23514");
    expect(await ins("n1:ok", [0, 1, 2])).toBeNull();
    expect((await ins("n1:ok", [4]))?.code).toBe("23514");
    expect(await ins("n1:ok", [3])).toBeNull();
  });
});

describe("S8: GET /me/ledger validates its query", () => {
  let fastify: FastifyInstance;
  let headers: { authorization: string };
  beforeAll(async () => {
    fastify = await buildApp({ db: app });
    const { token } = await issueSession(app, A.accountId);
    headers = { authorization: `Bearer ${token}` };
  });
  afterAll(() => fastify.close());

  it("malformed cursors and page sizes are 400s, never 500s", async () => {
    for (const qs of ["?limit=1.5", "?after=1.5", "?after=abc", "?limit=0", "?limit=-1", "?limit=1e9", "?limit=abc", "?after=1&after=2", "?limit=2&after=-5", "?after=99999999999999999999"]) {
      const r = await fastify.inject({ method: "GET", url: `/me/ledger${qs}`, headers });
      expect(r.statusCode, qs).toBe(400);
    }
    const r = await fastify.inject({ method: "GET", url: "/me/ledger?after=&limit=", headers });
    expect([200, 400]).toContain(r.statusCode);
    // Unknown query keys are dropped by the schema (Fastify's removeAdditional), not an error.
    expect((await fastify.inject({ method: "GET", url: "/me/ledger?nope=1", headers })).statusCode).toBe(200);
  });

  it("pages are contiguous, hasMore is exact, and the caller sees only their own events", async () => {
    const all = (await fastify.inject({ method: "GET", url: "/me/ledger?limit=500", headers })).json();
    expect(all.hasMore).toBe(false);
    expect(all.events.every((e: { accountId: string }) => e.accountId === A.accountId)).toBe(true);
    const seqs: number[] = [];
    let after = 0;
    for (;;) {
      const page = (await fastify.inject({ method: "GET", url: `/me/ledger?limit=3&after=${after}`, headers })).json();
      seqs.push(...page.events.map((e: { seq: number }) => e.seq));
      if (!page.hasMore) {
        expect(page.events.length).toBeLessThanOrEqual(3);
        break;
      }
      expect(page.events.length).toBe(3);
      after = page.nextAfter;
    }
    expect(seqs).toEqual(all.events.map((e: { seq: number }) => e.seq));
  });
});

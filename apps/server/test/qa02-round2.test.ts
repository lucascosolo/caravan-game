/**
 * Chunk 02 QA round 2 regressions (roadmap/qa/02-punchlist.md, "Round 2"), each a
 * reproduction from the reviewer's fence probe (qa02b/fence.probe.ts) turned into an
 * assertion that the hole is closed:
 *   R2-S1  input.resolverVersion is required and must be an integer JSON number
 *   R2-S2  a worker leases only jobs enqueued for its own resolver version
 *   R2-S3  status / lease / attempts move only through the owner's SECURITY DEFINER
 *          writers; the app role cannot UPDATE them; requeue is audited
 *   R2-S4  the guard trigger permits only what the fence permits (owner connection)
 *   R2-N1  park-on-exhaustion records no worker
 *   R2-N2  the lease reads clock_timestamp(), not the transaction's now()
 *   R2-N3  a result exists only on a completed row
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyRoles } from "../src/db/migrate.js";
import { withTransaction } from "../src/db/pool.js";
import type { ResolutionJobRow } from "../src/db/types.js";
import {
  DEFAULT_REQUEUED_BY,
  enqueueJob,
  getJob,
  leaseNextJob,
  lockJobForCompletion,
  markJobCompleted,
  markJobFailed,
  markJobParked,
  requeueParkedJob,
} from "../src/jobs/queue.js";
import { JOB_MAX_ATTEMPTS } from "../src/jobs/tunables.js";
import { assertResolverVersionMatches, drain, runOnce, type HandlerRegistry } from "../src/jobs/worker.js";
import type { JsonObject } from "../src/ledger/events.js";
import { appendEvents, listEventsByCausation, lockCaravanForResolution } from "../src/ledger/ledger.js";
import { registerAccount } from "../src/services/onboarding.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const owner = testPool();
const app = appRolePool();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noBackoff = () => 0;
const CHECK_VIOLATION = "23514";
const PERMISSION_DENIED = "42501";
const OTHER_VERSION = RESOLVER_VERSION + 99;

type Acct = { accountId: string; caravanId: string };
let A: Acct, B: Acct;

const handlers: HandlerRegistry = {
  coin: (job) => ({
    events: [{ type: "coin_earned", accountId: job.accountId, payload: { amount: job.input["amount"] as number, reason: "r2" } }],
    result: { ok: true },
  }),
};

const coinJob = (id: string, acct: Acct, amount: number, extra: { maxAttempts?: number } = {}, input: Record<string, unknown> = {}) =>
  enqueueJob(app, { id, kind: "coin", accountId: acct.accountId, caravanId: acct.caravanId, input: { amount, resolverVersion: RESOLVER_VERSION, ...input }, ...extra });
const events = async (id: string) => (await listEventsByCausation(app, id)).length;
const raw = (sql: string, params: unknown[] = []) => expectDbError(owner, sql, params);
const asApp = (sql: string, params: unknown[] = []) => expectDbError(app, sql, params);
const worker = (workerId: string) => runOnce(app, { workerId, handlers, retryBackoffMs: noBackoff });

/** Complete a leased job by hand, as the worker would, under the fence. */
async function completeByHand(id: string, who: string, attempts: number, acct: Acct): Promise<void> {
  await withTransaction(app, async (c) => {
    await lockCaravanForResolution(c, acct.caravanId);
    const row = await lockJobForCompletion(c, id, { workerId: who, attempts });
    expect(row, `${who}@${attempts} should hold the fence on ${id}`).not.toBeNull();
    await appendEvents(c, id, [{ type: "coin_earned", accountId: acct.accountId, payload: { amount: 1, reason: who } }]);
    await markJobCompleted(c, id, { by: who }, { workerId: who, attempts });
  });
}

/** Lease with a tiny window, let it expire, and let the next lease park it (attempts exhausted). */
async function parkByExhaustion(id: string, maxAttempts = 1): Promise<ResolutionJobRow> {
  for (let i = 0; i < maxAttempts; i++) {
    const l = (await leaseNextJob(app, "ran-it", 10))!;
    expect(l.id).toBe(id);
    await sleep(30);
  }
  expect(await leaseNextJob(app, "never-ran-it", 10_000)).toBeNull();
  const row = (await getJob(app, id))!;
  expect(row.status).toBe("parked");
  return row;
}

beforeAll(async () => {
  // The migrations suite recreates every table with the owner's default (table-level)
  // grants; the privilege assertions below need db/roles.sql as deployed, whatever ran first.
  await applyRoles(owner);
  await truncateAll(owner);
  const reg = async (p: string): Promise<Acct> => {
    const r = await registerAccount(app, { username: unique(p), password: "password123", regionId: "desert" });
    return { accountId: r.account.id, caravanId: r.caravan.id };
  };
  [A, B] = await Promise.all([reg("a"), reg("b")]);
});
// Every test leases "the next job", and earlier tests deliberately leave failed jobs behind
// with a 1 s retry backoff. Under CPU load that backoff elapses mid-file and the wrong job
// is leased (seen ~1 in 3 full runs). Each test starts from an empty queue instead.
beforeEach(async () => {
  // Rows are permanent while their account exists, so park the leftovers out of the lease
  // window instead of deleting them: a queued job only becomes leasable at next_attempt_at.
  await owner.query("UPDATE resolution_job SET next_attempt_at = now() + interval '1 day' WHERE status = 'queued'");
});
afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("R2-S1: every job says which resolver version it is for", () => {
  it("enqueue without resolverVersion, or with a null / string / fractional / out-of-range one, is refused by the schema", async () => {
    const bad: Array<[string, unknown]> = [["missing", "MISSING"], ["null", null], ["string", "0"], ["negative", -1], ["too-big", 2 ** 31]];
    for (const [label, rv] of bad) {
      const input = (rv === "MISSING" ? { amount: 1 } : { amount: 1, resolverVersion: rv }) as JsonObject;
      const err = await enqueueJob(app, { id: `s1:${label}`, kind: "coin", accountId: A.accountId, caravanId: A.caravanId, input }).then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
      expect(err?.code, label).toBe(CHECK_VIOLATION);
      expect(err?.message, label).toContain("resolution_job_input_has_resolver_version");
      expect(await getJob(app, `s1:${label}`), label).toBeNull();
    }
    // A fractional version never reaches SQL: canonical JSON refuses non-integer numbers
    // in any job input. The CHECK's own jsonb_is_integer covers a row written by hand.
    await expect(enqueueJob(app, { id: "s1:fraction", kind: "coin", accountId: A.accountId, caravanId: A.caravanId, input: { amount: 1, resolverVersion: 0.5 } })).rejects.toThrow(/integers/);
    expect(await getJob(app, "s1:fraction")).toBeNull();
    const byHand = await raw("INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts) VALUES ('s1:fraction', 'coin', $1, $2, '{\"amount\":1,\"resolverVersion\":0.5}', 3)", [A.accountId, A.caravanId]);
    expect(byHand?.code).toBe(CHECK_VIOLATION);
    expect(byHand?.message).toContain("resolution_job_input_has_resolver_version");
    // The real enqueue path stamps the version, so it is unaffected.
    expect((await coinJob("s1:ok", A, 1)).job.input["resolverVersion"]).toBe(RESOLVER_VERSION);
    expect(await worker("w")).toMatchObject({ kind: "completed", job: { id: "s1:ok" } });
  });

  it("the worker's own check no longer treats a missing version as a match (was lenient)", () => {
    const mk = (rv: unknown): ResolutionJobRow =>
      ({ id: "x", kind: "coin", account_id: A.accountId, caravan_id: A.caravanId, input: rv === "MISSING" ? { amount: 1 } : { amount: 1, resolverVersion: rv } }) as unknown as ResolutionJobRow;
    for (const rv of ["MISSING", null, "0", String(RESOLVER_VERSION), 0.5, RESOLVER_VERSION + 1]) {
      expect(() => assertResolverVersionMatches(mk(rv)), JSON.stringify(rv)).toThrow(/resolver version mismatch/);
    }
    expect(() => assertResolverVersionMatches(mk(RESOLVER_VERSION))).not.toThrow();
  });
});

describe("R2-S2: a worker leases only jobs for its own resolver version", () => {
  it("a job for another version is invisible to this worker: never leased, no attempt burned, never parked; a worker on that version takes it", async () => {
    await coinJob("s2:skew", A, 1, {}, { resolverVersion: OTHER_VERSION });
    expect(await leaseNextJob(app, "here", 60_000)).toBeNull();
    expect(await worker("here")).toEqual({ kind: "idle" });
    expect((await getJob(app, "s2:skew"))!).toMatchObject({ status: "queued", attempts: 0, leased_by: null, last_error: null });

    const leased = (await leaseNextJob(app, "there", 20, OTHER_VERSION))!;
    expect(leased).toMatchObject({ id: "s2:skew", attempts: 1, leased_by: "there" });
    // Its expired lease is still not this worker's to re-lease...
    await sleep(40);
    expect(await leaseNextJob(app, "here", 60_000)).toBeNull();
    expect((await getJob(app, "s2:skew"))!).toMatchObject({ status: "leased", attempts: 1, leased_by: "there" });
    // ...but a second worker on the right version re-leases it as usual.
    const again = (await leaseNextJob(app, "there2", 60_000, OTHER_VERSION))!;
    expect(again).toMatchObject({ id: "s2:skew", attempts: 2, leased_by: "there2" });
    expect(await markJobParked(app, "s2:skew", 2, "test: parked to clear the queue", { workerId: "there2" })).not.toBeNull();
    expect(await events("s2:skew")).toBe(0);
  });

  it("a skewed job ahead in the queue does not block current-version jobs behind it", async () => {
    await coinJob("s2:skew2", A, 1, {}, { resolverVersion: OTHER_VERSION });
    await coinJob("s2:ok", A, 1);
    expect(await worker("here")).toMatchObject({ kind: "completed", job: { id: "s2:ok" } });
    expect(await worker("here")).toEqual({ kind: "idle" });
    expect((await getJob(app, "s2:skew2"))!).toMatchObject({ status: "queued", attempts: 0 });
    const l = (await leaseNextJob(app, "v", 60_000, OTHER_VERSION))!;
    expect(await markJobParked(app, "s2:skew2", l.attempts, "test: parked to clear the queue", { workerId: "v" })).not.toBeNull();
  });

  it("leaseNextJob refuses a non-integer version rather than leasing nothing silently", async () => {
    await expect(leaseNextJob(app, "w", 60_000, 1.5)).rejects.toThrow(RangeError);
  });
});

describe("R2-S3: job state moves only through the owner's writers", () => {
  it("the app role cannot UPDATE status, the lease, attempts or the requeue audit, but can still write the other columns and drive the writers", async () => {
    await coinJob("s3:cols", A, 1);
    for (const set of ["status = 'parked'", "status = 'completed', result = '{}', completed_at = now()", "leased_by = 'forged'", "attempts = 0", "lease_expires_at = now()", "requeued_at = now()", "requeued_by = 'forged'", "requeue_count = 9"]) {
      const err = await asApp(`UPDATE resolution_job SET ${set} WHERE id = 's3:cols'`);
      expect(err?.code, set).toBe(PERMISSION_DENIED);
    }
    expect(await asApp("UPDATE resolution_job SET last_error = 'annotated' WHERE id = 's3:cols'")).toBeNull();
    expect((await getJob(app, "s3:cols"))!).toMatchObject({ status: "queued", attempts: 0, last_error: "annotated" });
    expect(await worker("w")).toMatchObject({ kind: "completed", job: { id: "s3:cols", status: "completed", attempts: 1, last_error: null } });
  });

  it("a parked job cannot be re-queued by a raw UPDATE from the app role; requeueParkedJob is audited and hands a racing pair exactly one row", async () => {
    await coinJob("s3:park", A, 1, { maxAttempts: 1 });
    const parked = await parkByExhaustion("s3:park");
    expect(parked).toMatchObject({ attempts: 2, requeue_count: 0, requeued_at: null, requeued_by: null });
    expect((await asApp("UPDATE resolution_job SET status = 'queued', max_attempts = 9 WHERE id = 's3:park'"))?.code).toBe(PERMISSION_DENIED);
    expect((await getJob(app, "s3:park"))!.status).toBe("parked");

    const race = await Promise.all([requeueParkedJob(app, "s3:park", { requeuedBy: "ops:alice" }), requeueParkedJob(app, "s3:park", { requeuedBy: "ops:bob" })]);
    const won = race.filter((r): r is ResolutionJobRow => r !== null);
    expect(won.length).toBe(1);
    const first = won[0]!;
    expect(first).toMatchObject({ status: "queued", attempts: 2, max_attempts: 2 + JOB_MAX_ATTEMPTS, leased_by: null, lease_expires_at: null, requeue_count: 1 });
    expect(first.requeued_at).toBeInstanceOf(Date);
    expect(["ops:alice", "ops:bob"]).toContain(first.requeued_by);
    expect((await getJob(app, "s3:park"))!).toMatchObject({ requeue_count: 1, requeued_by: first.requeued_by });

    // Park it again (non-retryable this time) and requeue again: the record is the latest requeue, the count climbs.
    const l = (await leaseNextJob(app, "w3", 60_000))!;
    expect(l).toMatchObject({ id: "s3:park", attempts: 3 });
    expect(await markJobParked(app, "s3:park", l.attempts, "nope", { workerId: "w3" })).not.toBeNull();
    const second = (await requeueParkedJob(app, "s3:park", { extraAttempts: 1, requeuedBy: "ops:carol" }))!;
    expect(second).toMatchObject({ status: "queued", attempts: 3, max_attempts: 4, requeue_count: 2, requeued_by: "ops:carol" });
    expect(second.requeued_at!.getTime()).toBeGreaterThanOrEqual(first.requeued_at!.getTime());
    expect(await requeueParkedJob(app, "s3:park")).toBeNull(); // queued, not parked: nothing to do
    expect(await worker("w4")).toMatchObject({ kind: "completed", job: { id: "s3:park", requeue_count: 2, requeued_by: "ops:carol" } });
    expect(await events("s3:park")).toBe(1);
  });

  it("requeueParkedJob names a default operator and validates its arguments before touching the row", async () => {
    await coinJob("s3:args", B, 1, { maxAttempts: 1 });
    await parkByExhaustion("s3:args");
    await expect(requeueParkedJob(app, "s3:args", { extraAttempts: 0 })).rejects.toThrow(RangeError);
    await expect(requeueParkedJob(app, "s3:args", { extraAttempts: 1.5 })).rejects.toThrow(RangeError);
    await expect(requeueParkedJob(app, "s3:args", { requeuedBy: "" })).rejects.toThrow(RangeError);
    expect((await getJob(app, "s3:args"))!).toMatchObject({ status: "parked", requeue_count: 0 });
    expect((await requeueParkedJob(app, "s3:args"))!).toMatchObject({ status: "queued", requeue_count: 1, requeued_by: DEFAULT_REQUEUED_BY });
    expect(await worker("w")).toMatchObject({ kind: "completed", job: { id: "s3:args" } });
  });

  it("the writers are the table owner's SECURITY DEFINER functions with a pinned search_path, and the app role may execute them", async () => {
    const fns = (
      await owner.query<{ proname: string; fowner: string; secdef: boolean; config: string[] | null; app_can_exec: boolean }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS fowner, p.prosecdef AS secdef, p.proconfig AS config,
                has_function_privilege('caravan_app', p.oid, 'EXECUTE') AS app_can_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prorettype = 'resolution_job'::regtype
          ORDER BY p.proname`,
      )
    ).rows;
    expect(fns.map((f) => f.proname)).toEqual(["resolution_job_complete", "resolution_job_fail", "resolution_job_lease", "resolution_job_park", "resolution_job_park_other_version", "resolution_job_requeue"]);
    const tableOwner = (await owner.query<{ o: string }>("SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relname = 'resolution_job'")).rows[0]!.o;
    for (const f of fns) {
      expect(f.fowner, f.proname).toBe(tableOwner);
      expect(f.secdef, f.proname).toBe(true);
      expect(f.config?.[0], f.proname).toMatch(/^search_path=pg_catalog,\s*public,\s*pg_temp$/);
      expect(f.app_can_exec, f.proname).toBe(true);
    }
    // And the column privilege is exactly what roles.sql says.
    const cols = (
      await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'resolution_job' AND grantee = 'caravan_app' AND privilege_type = 'UPDATE'
          ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
    for (const locked of ["status", "leased_by", "attempts", "lease_expires_at", "requeued_at", "requeued_by", "requeue_count"]) expect(cols, locked).not.toContain(locked);
    expect(cols).toEqual(expect.arrayContaining(["last_error", "max_attempts", "next_attempt_at", "result", "completed_at"]));
  });
});

describe("R2-S4: the guard trigger permits only what the fence permits (owner connection, no privilege in the way)", () => {
  it("queued -> completed directly is refused", async () => {
    await coinJob("s4:direct", A, 1);
    const err = await raw("UPDATE resolution_job SET status = 'completed', result = '{}', completed_at = now() WHERE id = 's4:direct'");
    expect(err?.code).toBe(CHECK_VIOLATION);
    expect(err?.message).toMatch(/completed from leased/);
    expect(await worker("w")).toMatchObject({ kind: "completed", job: { id: "s4:direct" } });
  });

  it("a lease that is not a new attempt is refused: queued -> leased, a change of worker, an extended expiry", async () => {
    await coinJob("s4:lease", A, 1);
    const forged = await raw("UPDATE resolution_job SET status = 'leased', leased_by = 'forged', lease_expires_at = now() + interval '1 hour' WHERE id = 's4:lease'");
    expect(forged?.code).toBe(CHECK_VIOLATION);
    expect(forged?.message).toMatch(/new attempt/);
    const l = (await leaseNextJob(app, "w", 60_000))!;
    expect(l).toMatchObject({ id: "s4:lease", attempts: 1 });
    expect((await raw("UPDATE resolution_job SET leased_by = 'thief' WHERE id = 's4:lease'"))?.code).toBe(CHECK_VIOLATION);
    expect((await raw("UPDATE resolution_job SET lease_expires_at = now() + interval '10 years' WHERE id = 's4:lease'"))?.code).toBe(CHECK_VIOLATION);
    // The lease holder's own row may still be annotated.
    expect(await raw("UPDATE resolution_job SET last_error = 'note' WHERE id = 's4:lease'")).toBeNull();
    expect((await getJob(app, "s4:lease"))!).toMatchObject({ status: "leased", leased_by: "w", attempts: 1, last_error: "note" });
    await completeByHand("s4:lease", "w", 1, A);
    expect((await getJob(app, "s4:lease"))!).toMatchObject({ status: "completed", last_error: null });
  });

  it("completion must be by the lease holder at the leased attempt", async () => {
    await coinJob("s4:holder", A, 1);
    const l = (await leaseNextJob(app, "w", 60_000))!;
    expect(l.id).toBe("s4:holder");
    const done = "status = 'completed', result = '{}', completed_at = now()";
    expect((await raw(`UPDATE resolution_job SET ${done}, leased_by = 'other' WHERE id = 's4:holder'`))?.code).toBe(CHECK_VIOLATION);
    expect((await raw(`UPDATE resolution_job SET ${done}, attempts = attempts + 1 WHERE id = 's4:holder'`))?.code).toBe(CHECK_VIOLATION);
    expect((await getJob(app, "s4:holder"))!).toMatchObject({ status: "leased", leased_by: "w", attempts: 1 });
    await completeByHand("s4:holder", "w", 1, A);
  });

  it("a queued job must have budget: parked -> queued with the old budget, or queued at attempts >= max_attempts, is refused", async () => {
    await coinJob("s4:budget", A, 1, { maxAttempts: 1 });
    await parkByExhaustion("s4:budget");
    const flip = await raw("UPDATE resolution_job SET status = 'queued' WHERE id = 's4:budget'");
    expect(flip?.code).toBe(CHECK_VIOLATION);
    expect(flip?.message).toContain("resolution_job_queued_has_budget");
    expect((await getJob(app, "s4:budget"))!.status).toBe("parked");
    expect((await requeueParkedJob(app, "s4:budget"))!.status).toBe("queued");
    expect(await worker("w")).toMatchObject({ kind: "completed", job: { id: "s4:budget" } });

    await coinJob("s4:budget2", A, 1);
    expect((await raw("UPDATE resolution_job SET attempts = 3, max_attempts = 3 WHERE id = 's4:budget2'"))?.code).toBe(CHECK_VIOLATION);
    expect((await raw("UPDATE resolution_job SET max_attempts = 0 WHERE id = 's4:budget2'"))?.code).toBe(CHECK_VIOLATION);
    expect((await getJob(app, "s4:budget2"))!).toMatchObject({ status: "queued", attempts: 0, max_attempts: JOB_MAX_ATTEMPTS });
    expect(await worker("w")).toMatchObject({ kind: "completed", job: { id: "s4:budget2" } });
  });

  it("a queued job cannot be parked: parking is a verdict on a lease", async () => {
    await coinJob("s4:qpark", A, 1);
    const err = await raw("UPDATE resolution_job SET status = 'parked' WHERE id = 's4:qpark'");
    expect(err?.code).toBe(CHECK_VIOLATION);
    expect(err?.message).toMatch(/parked from leased/);
    expect(await worker("w")).toMatchObject({ kind: "completed", job: { id: "s4:qpark" } });
  });
});

describe("R2-N1: park-on-exhaustion records no worker", () => {
  it("an expired lease whose next lease would exceed max_attempts parks with leased_by NULL, and the worker that did run it still loses", async () => {
    await coinJob("n1", A, 1, { maxAttempts: 1 });
    const l = (await leaseNextJob(app, "ran-it", 10))!;
    expect(l.leased_by).toBe("ran-it");
    await sleep(30);
    expect(await leaseNextJob(app, "never-ran-it", 10_000)).toBeNull();
    expect((await getJob(app, "n1"))!).toMatchObject({ status: "parked", attempts: 2, leased_by: null, lease_expires_at: null, last_error: "lease expired" });
    expect(await markJobFailed(app, "n1", 1, "late", { workerId: "ran-it", backoffMs: 0 })).toBeNull();
    await withTransaction(app, async (c) => expect(await lockJobForCompletion(c, "n1", { workerId: "ran-it", attempts: 1 })).toBeNull());
    expect(await events("n1")).toBe(0);
  });
});

describe("R2-N2: the lease reads the wall clock, not the transaction's start", () => {
  it("a lease taken late in a transaction is ready by, and expires relative to, the moment it is taken", async () => {
    await coinJob("n2", A, 1);
    const l = (await leaseNextJob(app, "w", 60_000))!;
    expect(l.id).toBe("n2");
    expect((await markJobFailed(app, "n2", l.attempts, "retry me", { workerId: "w", backoffMs: 60 }))!.status).toBe("queued");
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      const t0 = (await c.query<{ t: Date }>("SELECT now() AS t")).rows[0]!.t; // pins the transaction's now()
      await sleep(120);
      // Under now(): not ready yet (next_attempt_at is 60 ms after t0) and, if leased, expiring
      // at exactly t0 + the window. Under clock_timestamp(): expiring >= 120 ms later than that.
      // The window is a full minute (not 50 ms) so completing by hand below cannot lose the
      // fence to a slow machine; the assertion measures the offset, not the window.
      const WINDOW_MS = 60_000;
      const row = (await leaseNextJob(c, "w2", WINDOW_MS))!;
      expect(row).toMatchObject({ id: "n2", attempts: 2, leased_by: "w2" });
      expect(row.lease_expires_at!.getTime()).toBeGreaterThan(t0.getTime() + WINDOW_MS + 100);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await completeByHand("n2", "w2", 2, A);
  });
});

describe("R2-N3: a result exists only on a completed row", () => {
  it("a result on a queued, leased or parked row is a CHECK violation (completed_shape alone allowed it)", async () => {
    await coinJob("n3", A, 1);
    const queued = await raw(`UPDATE resolution_job SET result = '{"forged": true}' WHERE id = 'n3'`);
    expect(queued?.code).toBe(CHECK_VIOLATION);
    expect(queued?.message).toContain("resolution_job_result_only_when_completed");
    const l = (await leaseNextJob(app, "w", 60_000))!;
    expect(l.id).toBe("n3");
    expect((await raw(`UPDATE resolution_job SET result = '{"forged": true}' WHERE id = 'n3'`))?.code).toBe(CHECK_VIOLATION);
    expect((await raw(`UPDATE resolution_job SET status = 'parked', lease_expires_at = NULL, result = '{"forged": true}' WHERE id = 'n3'`))?.code).toBe(CHECK_VIOLATION);
    expect((await getJob(app, "n3"))!).toMatchObject({ status: "leased", result: null });
    await completeByHand("n3", "w", 1, A);
    expect((await getJob(app, "n3"))!).toMatchObject({ status: "completed", result: { by: "w" } });
  });

  it("nothing in this file left a job in flight", async () => {
    const rows = (await owner.query<{ status: string; n: string }>("SELECT status, count(*)::text AS n FROM resolution_job GROUP BY status")).rows;
    const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    expect(counts["queued"] ?? 0).toBe(0);
    expect(counts["leased"] ?? 0).toBe(0);
    expect(await drain(app, { workerId: "sweep", handlers, retryBackoffMs: noBackoff })).toEqual([]);
  });
});

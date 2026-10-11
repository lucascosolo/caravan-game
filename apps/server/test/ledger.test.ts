/**
 * The ledger: append-only at the storage layer, scope-checked per GUARDRAILS §5, and the
 * live balances are projections that a rebuild-from-zero reproduces exactly.
 */
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import { coinCreditDraft, coinDebitDraft } from "../src/ledger/coin.js";
import { canonicalJson, validateDraft, type LedgerEventDraft } from "../src/ledger/events.js";
import { appendEvents, countEventsForAccount, listEventsByCausation, listEventsForAccount, lockAccountsForAppend } from "../src/ledger/ledger.js";
import { maybeSnapshot, projectionKey, readLiveProjection, rebuildProjection, verifyProjection } from "../src/ledger/projection.js";
import { rebuildAll } from "../src/ledger/rebuild.js";
import { getAccountPoolProgress, getCaravanPoolProgress } from "../src/repo/poolProgress.js";
import { registerAccount } from "../src/services/onboarding.js";
import { issueSession } from "../src/auth/sessions.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let accountId: string;
let caravanId: string;
let app: FastifyInstance;

beforeAll(async () => {
  await truncateAll(pool);
  const { account, caravan } = await registerAccount(pool, { username: unique("ledger"), password: "password123", regionId: "desert" });
  accountId = account.id;
  caravanId = caravan.id;
  app = await buildApp({ db: pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function append(causationId: string, drafts: LedgerEventDraft[]) {
  return withTransaction(pool, (c) => appendEvents(c, causationId, drafts));
}

describe("append-only enforcement", () => {
  it("accepts an append and refuses UPDATE and DELETE on it", async () => {
    const [row] = await append("test:append-only", [
      { type: "coin_earned", accountId, payload: { amount: 10, reason: "test" } },
    ]);
    const upd = await expectDbError(pool, "UPDATE ledger_event SET payload = '{}' WHERE seq = $1", [row!.seq]);
    expect(upd?.code).toBe("23514");
    expect(upd?.message).toContain("append-only");
    const upd2 = await expectDbError(pool, "UPDATE ledger_event SET occurred_at = now() WHERE seq = $1", [row!.seq]);
    expect(upd2?.code).toBe("23514");
    const del = await expectDbError(pool, "DELETE FROM ledger_event WHERE seq = $1", [row!.seq]);
    expect(del?.code).toBe("23514");
    expect(del?.message).toContain("append-only");
    const delAll = await expectDbError(pool, "DELETE FROM ledger_event");
    expect(delAll?.code).toBe("23514");
    const still = await pool.query("SELECT 1 FROM ledger_event WHERE seq = $1", [row!.seq]);
    expect(still.rowCount).toBe(1);
  });

  it("the same causation id cannot be appended twice (idempotency backstop)", async () => {
    await append("test:dup", [{ type: "coin_earned", accountId, payload: { amount: 1, reason: "a" } }]);
    await expect(append("test:dup", [{ type: "coin_earned", accountId, payload: { amount: 1, reason: "a" } }])).rejects.toMatchObject({
      code: "23505",
    });
    expect((await listEventsByCausation(pool, "test:dup")).length).toBe(1);
  });

  it("rows leave only by account cascade", async () => {
    const { account } = await registerAccount(pool, { username: unique("gone"), password: "password123", regionId: "desert" });
    await append("test:gone", [{ type: "coin_earned", accountId: account.id, payload: { amount: 5, reason: "x" } }]);
    await pool.query("DELETE FROM account WHERE id = $1", [account.id]);
    const left = await pool.query("SELECT 1 FROM ledger_event WHERE account_id = $1", [account.id]);
    expect(left.rowCount).toBe(0);
  });
});

describe("scope split is a CHECK, not a convention", () => {
  const direct = (type: string, caravan: string | null, payload: object, version: number | null = null) =>
    expectDbError(
      pool,
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, resolver_version, payload)
       VALUES ($1, $2, $3, $4, 0, $5, $6::jsonb)`,
      [type, accountId, caravan, `test:scope:${type}:${caravan ?? "null"}:${JSON.stringify(payload)}`, version, JSON.stringify(payload)],
    );

  it("living-pool progress must carry a caravan id; trap/siege must not", async () => {
    expect((await direct("ladder_progress_gained", null, { pool: "living", pointsDelta: 1, levelsGained: 0 }))?.code).toBe("23514");
    expect((await direct("ladder_progress_gained", caravanId, { pool: "trap", pointsDelta: 1, levelsGained: 0 }))?.code).toBe("23514");
    expect((await direct("unlock_points_granted", caravanId, { pool: "siege", points: 1, rung: 1 }))?.code).toBe("23514");
    expect((await direct("reputation_changed", null, { pool: "living", delta: 1, reason: "t" }))?.code).toBe("23514");
    expect((await direct("reputation_changed", null, { delta: 1, reason: "t" }))?.code).toBe("23514"); // no pool at all
  });

  it("coin and standing-party events are account-level; roster/trip events are caravan-level", async () => {
    expect((await direct("coin_earned", caravanId, { amount: 1, reason: "t" }))?.code).toBe("23514");
    expect((await direct("standing_party_saved", caravanId, {}))?.code).toBe("23514");
    expect((await direct("unit_acquired", null, { unitTypeId: "x" }))?.code).toBe("23514");
    expect((await direct("trip_started", null, {}))?.code).toBe("23514");
  });

  it("resolution events must carry a resolver version", async () => {
    expect((await direct("encounter_resolved", caravanId, {}))?.code).toBe("23514");
    expect((await direct("stop_resolved", caravanId, {}))?.code).toBe("23514");
    expect((await direct("party_served_as_encounter", null, {}))?.code).toBe("23514");
    expect(await direct("encounter_resolved", caravanId, { ok: true }, 0)).toBeNull();
  });

  it("coin events need a non-negative integer amount", async () => {
    expect((await direct("coin_earned", null, { reason: "t" }))?.code).toBe("23514");
    expect((await direct("coin_earned", null, { amount: -1, reason: "t" }))?.code).toBe("23514");
    expect((await direct("coin_earned", null, { amount: 1.5, reason: "t" }))?.code).toBe("23514");
    expect((await direct("coin_earned", null, { amount: "7", reason: "t" }))?.code).toBe("23514");
  });

  it("validateDraft rejects the same shapes before they reach the database", () => {
    expect(() => validateDraft({ type: "coin_earned", accountId, caravanId, payload: { amount: 1, reason: "t" } })).toThrow(/account-level/);
    expect(() => validateDraft({ type: "unit_merged", accountId, payload: {} })).toThrow(/caravan-level/);
    expect(() => validateDraft({ type: "reputation_changed", accountId, payload: { pool: "living", delta: 1 } })).toThrow(/caravan id/);
    expect(() => validateDraft({ type: "reputation_changed", accountId, caravanId, payload: { pool: "trap", delta: 1 } })).toThrow(/account-level/);
    expect(() => validateDraft({ type: "encounter_resolved", accountId, caravanId, payload: {} })).toThrow(/resolverVersion/);
    expect(() => validateDraft({ type: "coin_spent", accountId, payload: { amount: 0.5 } })).toThrow(/integer/);
    expect(() => validateDraft({ type: "unit_acquired", accountId, caravanId, payload: { x: 1.25 } })).toThrow(/integers/);
  });
});

describe("balances are projections of the log", () => {
  it("folds coin, reputation, ladder and unlock events into the live columns", async () => {
    const before = await readLiveProjection(pool, accountId);
    await withTransaction(pool, async (c) => {
      await lockAccountsForAppend(c, [accountId]);
      const credit = await coinCreditDraft(c, { type: "coin_earned", accountId, amount: 250, reason: "bank" });
      await appendEvents(c, "test:fold", [
        credit,
        coinDebitDraft({ accountId, amount: 40, reason: "merge" }),
        { type: "coin_purchased", accountId, payload: { amount: 100, reason: "pack" } },
        { type: "reputation_changed", accountId, caravanId, payload: { pool: "living", delta: 25, reason: "held" } },
        { type: "reputation_changed", accountId, payload: { pool: "trap", delta: -10, reason: "lost" } },
        { type: "ladder_progress_gained", accountId, payload: { pool: "siege", pointsDelta: 7, levelsGained: 0 } },
        { type: "ladder_progress_gained", accountId, payload: { pool: "siege", pointsDelta: 93, levelsGained: 1 } }, // cumulative: 7 + 93 = rung 1
        { type: "unlock_points_granted", accountId, payload: { pool: "siege", points: 2, rung: 1 } },
        { type: "unlock_node_purchased", accountId, payload: { pool: "siege", nodeId: "siege.ram", cost: 1 } },
        { type: "ladder_progress_gained", accountId, caravanId, payload: { pool: "living", pointsDelta: 3, levelsGained: 0 } },
        // Informational events: no balance effect.
        { type: "coin_lost_on_wipe", accountId, caravanId, payload: { amount: 999, reason: "overrun", tripId: "t1" } },
        { type: "unit_acquired", accountId, caravanId, payload: { unitTypeId: "placeholder.desert.scout" } },
      ]);
    });
    const after = await readLiveProjection(pool, accountId);
    expect(after.coinBalance).toBe(before.coinBalance + 250 - 40 + 100);
    expect(after.caravanPools[caravanId]!.reputation).toBe(before.caravanPools[caravanId]!.reputation + 25);
    expect(after.accountPools.trap.reputation).toBe(before.accountPools.trap.reputation - 10);
    expect(after.accountPools.siege).toEqual({
      reputation: TUNABLES.REPUTATION_START,
      ladderLevel: 1,
      ladderPoints: 100,
      unlockPointsGranted: 2,
      unlockPointsSpent: 1,
    });
    expect(after.caravanPools[caravanId]!.ladderPoints).toBe(3);
    // Same numbers in the raw rows chunk 01 defined.
    expect((await getAccountPoolProgress(pool, accountId, "siege"))!.ladder_level).toBe(1);
    expect((await getCaravanPoolProgress(pool, caravanId))!.ladder_points).toBe(3);
  });

  it("rebuild from zero equals the live projection", async () => {
    const v = await verifyProjection(pool, accountId);
    expect(v.ok, `live ${JSON.stringify(v.live)} vs rebuilt ${JSON.stringify(v.rebuilt)}`).toBe(true);
    expect(v.eventsFolded).toBe(await countEventsForAccount(pool, accountId));
    const all = await rebuildAll(pool);
    expect(all.mismatches).toEqual([]);
  });

  it("a credit is clamped to the storage cap and the event says so", async () => {
    const cap = (await pool.query<{ coin_storage_cap: number; coin_balance: number }>("SELECT coin_storage_cap, coin_balance FROM account WHERE id = $1", [accountId])).rows[0]!;
    const rows = await withTransaction(pool, async (c) => {
      await lockAccountsForAppend(c, [accountId]);
      const credit = await coinCreditDraft(c, { type: "coin_transferred_to_party_owner", accountId, amount: cap.coin_storage_cap * 2, reason: "wipe", extra: { fromAccountId: "x" } });
      return appendEvents(c, "test:clamp", [credit]);
    });
    const applied = cap.coin_storage_cap - cap.coin_balance;
    expect(rows[0]!.payload).toMatchObject({ amount: applied, overflowDiscarded: cap.coin_storage_cap * 2 - applied, fromAccountId: "x" });
    const now = await readLiveProjection(pool, accountId);
    expect(now.coinBalance).toBe(cap.coin_storage_cap);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("an overdraft is refused at commit and nothing in the batch lands", async () => {
    const n = await countEventsForAccount(pool, accountId);
    const bal = (await readLiveProjection(pool, accountId)).coinBalance;
    await expect(
      append("test:overdraft", [
        { type: "reputation_changed", accountId, payload: { pool: "trap", delta: 1, reason: "t" } },
        coinDebitDraft({ accountId, amount: bal + 1, reason: "too much" }),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await countEventsForAccount(pool, accountId)).toBe(n);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("the ledger refuses a ladder decrease even through an event (the payload CHECK, before the projection trigger)", async () => {
    const err = await expectDbError(
      pool,
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload)
       VALUES ('ladder_progress_gained', $1, NULL, 'test:ladder-down', 0, '{"pool":"siege","pointsDelta":0,"levelsGained":-1}')`,
      [accountId],
    );
    expect(err?.code).toBe("23514");
    expect(err?.message).toContain("ledger_event_ladder_progress_nonneg"); // migration 003; chunk 01's trigger is the backstop behind it
  });
});

describe("snapshots are a pure perf knob", () => {
  it("rebuilding from a checkpoint equals rebuilding from zero, before and after more events", async () => {
    const seq = await maybeSnapshot(pool, accountId, 3);
    expect(seq).not.toBeNull();
    const fromZero = await rebuildProjection(pool, accountId);
    const fromSnap = await rebuildProjection(pool, accountId, { fromSnapshot: true });
    expect(fromSnap.startedFromSnapshot).toBe(seq);
    expect(fromSnap.eventsFolded).toBe(0);
    expect(projectionKey(fromSnap.state)).toBe(projectionKey(fromZero.state));
    expect(projectionKey(fromSnap.state)).toBe(projectionKey(await readLiveProjection(pool, accountId)));

    await append("test:after-snap", [
      coinDebitDraft({ accountId, amount: 3, reason: "x" }),
      { type: "unlock_points_granted", accountId, caravanId, payload: { pool: "living", points: 4, rung: 1 } },
    ]);
    const z2 = await rebuildProjection(pool, accountId);
    const s2 = await rebuildProjection(pool, accountId, { fromSnapshot: true });
    expect(s2.eventsFolded).toBe(2);
    expect(projectionKey(s2.state)).toBe(projectionKey(z2.state));
    expect(projectionKey(s2.state)).toBe(projectionKey(await readLiveProjection(pool, accountId)));
    // Below the interval: no new checkpoint.
    expect(await maybeSnapshot(pool, accountId, 500)).toBeNull();
  });
});

describe("GET /me/ledger", () => {
  it("returns the caller's own events in seq order with a cursor", async () => {
    const { token } = await issueSession(pool, accountId);
    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({ method: "GET", url: "/me/ledger?limit=2", headers });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.events.length).toBe(2);
    expect(body.events[0].seq).toBeLessThan(body.events[1].seq);
    expect(body.events[0]).toMatchObject({ accountId, causationId: "test:append-only", causationSeq: 0, type: "coin_earned" });
    expect(body.hasMore).toBe(true);
    const rest = await app.inject({ method: "GET", url: `/me/ledger?after=${body.nextAfter}&limit=500`, headers });
    expect(rest.json().hasMore).toBe(false);
    const total = await listEventsForAccount(pool, accountId, { limit: 500 });
    expect(rest.json().events.length).toBe(total.length - 2);
    expect(canonicalJson(rest.json().events.map((e: { seq: number }) => e.seq))).toBe(canonicalJson(total.slice(2).map((e) => e.seq)));
    const anon = await app.inject({ method: "GET", url: "/me/ledger" });
    expect(anon.statusCode).toBe(401);
  });
});

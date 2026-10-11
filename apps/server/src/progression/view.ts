/**
 * Read models for the progression endpoints: what a player can see about each ladder and
 * rating, with the next rung's cost visible before they commit a trip to it
 * (GUARDRAILS §4 — legibility).
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import type { Pool, PoolProgressRow } from "../db/types.js";
import type { LedgerEventRow, LedgerEventType } from "../ledger/events.js";
import { listPoolProgressForAccount } from "../repo/poolProgress.js";
import { LADDER_CAP, LADDER_EARNING_POOLS, ladderGainFor, pointsToRung, totalUnlockPointsAtCap, unlockPointsForRung } from "./ladder.js";
import { reputationBaseDelta } from "./reputation.js";
import { ENCOUNTER_OUTCOME_KINDS } from "./outcome.js";

export interface PoolProgressView {
  pool: Pool;
  scope: "account" | "caravan";
  accountId: string | null;
  caravanId: string | null;
  /** The volatile rating. A number, never a balance. */
  reputation: number;
  ladder: {
    level: number;
    points: number;
    cap: number;
    capped: boolean;
    /** Cumulative points the next rung requires, or null at cap. */
    nextRungAt: number | null;
    pointsToNextRung: number | null;
    /** What the next rung will grant, or null at cap. */
    nextRungUnlockPoints: number | null;
  };
  unlockPoints: { granted: number; spent: number; available: number };
}

export function toPoolProgressView(row: PoolProgressRow): PoolProgressView {
  // The split is a CHECK on pool_progress; re-assert it here so a row that somehow
  // violates it is a loud error, not a living pool shown as account-level (QA N7).
  if (row.pool === "living" && row.caravan_id === null) throw new TypeError(`living-pool progress row ${row.id} has no caravan id`);
  if (row.pool !== "living" && row.account_id === null) throw new TypeError(`${row.pool}-pool progress row ${row.id} has no account id`);
  const capped = row.ladder_level >= LADDER_CAP;
  const next = capped ? null : row.ladder_level + 1;
  return {
    pool: row.pool,
    scope: row.pool === "living" ? "caravan" : "account",
    accountId: row.account_id,
    caravanId: row.caravan_id,
    reputation: row.reputation,
    ladder: {
      level: row.ladder_level,
      points: row.ladder_points,
      cap: LADDER_CAP,
      capped,
      nextRungAt: next === null ? null : pointsToRung(next),
      pointsToNextRung: next === null ? null : Math.max(0, pointsToRung(next) - row.ladder_points),
      nextRungUnlockPoints: next === null ? null : unlockPointsForRung(next),
    },
    unlockPoints: {
      granted: row.unlock_points_granted,
      spent: row.unlock_points_spent,
      available: row.unlock_points_granted - row.unlock_points_spent,
    },
  };
}

export async function listProgressionForAccount(db: Queryable, accountId: string): Promise<PoolProgressView[]> {
  const rows = await listPoolProgressForAccount(db, accountId);
  return rows.map(toPoolProgressView);
}

/** The ledger event types that are progression history. */
export const PROGRESSION_EVENT_TYPES: readonly LedgerEventType[] = ["reputation_changed", "ladder_progress_gained", "unlock_points_granted"];

export const PROGRESSION_EVENTS_LIMIT_DEFAULT = 100;
export const PROGRESSION_EVENTS_LIMIT_MAX = 500;

export interface ProgressionEventsPage {
  events: LedgerEventRow[];
  /** Cursor for the next page: the last returned seq, or the cursor passed in when the page is empty. */
  nextAfter: number;
  /** True when more matching events exist beyond this page. */
  hasMore: boolean;
}

/**
 * A page of the player's own progression history, oldest first, cursor on seq. The type
 * and pool filters are applied IN SQL, before the limit, so a page is never empty while
 * matching history continues (QA S5). Reads one row past the limit to report `hasMore`.
 */
export async function listProgressionEventsForAccount(
  db: Queryable,
  accountId: string,
  opts: { afterSeq?: number; limit?: number; pool?: Pool } = {},
): Promise<ProgressionEventsPage> {
  const afterSeq = opts.afterSeq ?? 0;
  const limit = Math.min(Math.max(opts.limit ?? PROGRESSION_EVENTS_LIMIT_DEFAULT, 1), PROGRESSION_EVENTS_LIMIT_MAX);
  const res = await db.query<LedgerEventRow>(
    `SELECT * FROM ledger_event
     WHERE account_id = $1 AND seq > $2
       AND event_type = ANY($3::ledger_event_type[])
       AND ($4::text IS NULL OR payload->>'pool' = $4)
     ORDER BY seq LIMIT $5`,
    [accountId, afterSeq, PROGRESSION_EVENT_TYPES, opts.pool ?? null, limit + 1],
  );
  const hasMore = res.rows.length > limit;
  const events = hasMore ? res.rows.slice(0, limit) : res.rows;
  return { events, nextAfter: events.at(-1)?.seq ?? afterSeq, hasMore };
}

/** The whole curve and every per-outcome number, so nothing about progression is hidden. */
export function progressionRules() {
  const rungs = [];
  for (let r = 1; r <= LADDER_CAP; r++) rungs.push({ rung: r, pointsRequired: pointsToRung(r), unlockPoints: unlockPointsForRung(r) });
  const ladderGains: Record<string, { caravan: number; party: number }> = {};
  const reputationBase: Record<string, { caravan: number; party: number }> = {};
  for (const outcome of ENCOUNTER_OUTCOME_KINDS) {
    ladderGains[outcome] = { caravan: ladderGainFor("caravan", outcome), party: ladderGainFor("party", outcome) };
    reputationBase[outcome] = { caravan: reputationBaseDelta("caravan", outcome), party: reputationBaseDelta("party", outcome) };
  }
  return {
    ladder: {
      cap: LADDER_CAP,
      rungs,
      totalUnlockPointsAtCap: totalUnlockPointsAtCap(),
      earningPools: LADDER_EARNING_POOLS,
      gainsByOutcome: ladderGains,
    },
    reputation: {
      start: TUNABLES.REPUTATION_START,
      floor: TUNABLES.REPUTATION_FLOOR,
      baseDeltaByOutcome: reputationBase,
      gapScaling: {
        divisor: TUNABLES.REPUTATION_GAP_DIVISOR,
        multMinWin: TUNABLES.REPUTATION_GAP_MULT_MIN,
        multMinLoss: TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS,
        multMax: TUNABLES.REPUTATION_GAP_MULT_MAX,
        fixedOne: FIXED_ONE,
      },
      /**
       * Which pool is each side's matchmaking rating (chunk 04 QA D1): a caravan is matched
       * by its living Reputation; a standing party by its owner's siege Reputation — the
       * account-level "offense Reputation, stored on the siege pool".
       */
      matchmakingRating: { caravan: "living", party: "siege" },
      /** Which ratings an encounter can move. trap never moves: nothing reads it (D1). */
      moves: { living: "caravan side, every encounter", siege: "party side, every encounter", trap: "never (no reader; stays at start)" },
      /** A change whose applied delta is 0 (already on the floor) writes no event (N1). */
      zeroDeltaWritesEvent: false,
    },
  };
}

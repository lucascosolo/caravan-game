/**
 * Read models for the progression endpoints: what a player can see about each ladder and
 * rating, with the next rung's cost visible before they commit a trip to it
 * (GUARDRAILS §4 — legibility).
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import type { Pool, PoolProgressRow } from "../db/types.js";
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
        multMin: TUNABLES.REPUTATION_GAP_MULT_MIN,
        multMax: TUNABLES.REPUTATION_GAP_MULT_MAX,
        fixedOne: FIXED_ONE,
      },
      matchmakingRating: { caravan: "living", party: "siege" },
    },
  };
}

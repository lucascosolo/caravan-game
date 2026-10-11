/**
 * Chunk 22 QA D2 — the caravan's player's "Recent fights": every encounter of the account's
 * caravans that the replay retention rule still keeps, newest first, so a fight can be opened
 * after the caravan has repacked (not only the current trip's).
 *
 * The rule is the database's own (`encounter_log_retention`, migration 016, pinned to
 * LOG_RETENTION_DAYS / LOG_RETENTION_MIN_PER_CARAVAN by a test): an encounter is listed while it
 * is among its caravan's newest `min_per_caravan` settled encounters OR settled within `days`.
 * The list is capped at `min_per_caravan` rows. Each row says whether its replay can be played:
 *   "log"     a stored log exists (the replay route answers 200);
 *   "no_log"  the fight was resolved without one (the dev/test double: 200, renderable false);
 *   "pruned"  a log existed and is gone (410).
 *
 * Only the caravan's side of the fight is listed (the account's own caravans); the party's owner
 * reaches theirs through the Party feed and the inbox. Nothing names the opposing account.
 */
import type { Queryable } from "../db/pool.js";
import type { EncounterOutcomeKind } from "../trip/outcome.js";

export interface RecentFightView {
  jobId: string;
  tripId: string;
  encounterIndex: number;
  outcome: EncounterOutcomeKind;
  /** DEPTH_METRIC, fixed-point 0..1024, as the trip loop settled it. */
  depth: number;
  settledAt: string;
  replay: "log" | "no_log" | "pruned";
}

export interface RecentFightsView {
  encounters: RecentFightView[];
  retention: { days: number; minPerCaravan: number };
}

export async function recentFights(db: Queryable, accountId: string): Promise<RecentFightsView> {
  const r = await db.query<{ days: number; min_per_caravan: number }>("SELECT days, min_per_caravan FROM encounter_log_retention WHERE singleton");
  const rule = r.rows[0];
  if (!rule) throw new Error("encounter_log_retention is empty");
  const res = await db.query<{ job_id: string; trip_id: string; encounter_index: number; outcome_kind: EncounterOutcomeKind; depth_fp: number; settled_at: Date; replay: RecentFightView["replay"] }>(
    `WITH mine AS (
       SELECT te.job_id, te.trip_id, te.encounter_index, te.outcome_kind, te.depth_fp, te.settled_at,
              row_number() OVER (PARTITION BY t.caravan_id ORDER BY te.settled_at DESC, te.job_id DESC) AS rn
         FROM trip_encounter te
         JOIN trip t ON t.id = te.trip_id
         JOIN caravan c ON c.id = t.caravan_id
        WHERE c.account_id = $1
     )
     SELECT m.job_id, m.trip_id::text AS trip_id, m.encounter_index, m.outcome_kind, m.depth_fp, m.settled_at,
            CASE WHEN l.job_id IS NOT NULL THEN 'log'
                 WHEN coalesce(j.result -> 'replay', 'null'::jsonb) = 'null'::jsonb THEN 'no_log'
                 ELSE 'pruned' END AS replay
       FROM mine m
       LEFT JOIN encounter_log l ON l.job_id = m.job_id
       LEFT JOIN resolution_job j ON j.id = m.job_id
      WHERE m.rn <= $2 OR m.settled_at >= now() - make_interval(days => $3)
      ORDER BY m.settled_at DESC, m.job_id DESC
      LIMIT $2`,
    [accountId, rule.min_per_caravan, rule.days],
  );
  return {
    encounters: res.rows.map((x) => ({
      jobId: x.job_id,
      tripId: x.trip_id,
      encounterIndex: x.encounter_index,
      outcome: x.outcome_kind,
      depth: x.depth_fp,
      settledAt: x.settled_at.toISOString(),
      replay: x.replay,
    })),
    retention: { days: rule.days, minPerCaravan: rule.min_per_caravan },
  };
}

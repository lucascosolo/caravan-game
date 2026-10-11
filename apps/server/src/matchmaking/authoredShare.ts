/**
 * Retire-by-ratio, second stage (chunk 25 / PHASE-2 §25): the authored share of the
 * encounters actually SERVED in a display band. Chunk 14's first stage caps how many
 * authored parties may join a single draw; this measures what the draws produced — the
 * chosen candidates in `encounter_candidates` — over a rolling window, and when authored
 * parties took more than AUTHORED_PARTY_MAX_SHARE_BP of the band's recent encounters, the
 * next draws in that band weight them down (band.ts `authoredAllowance`).
 *
 * Deterministic from stored state: the window is the most recent AUTHORED_SERVED_SHARE_WINDOW
 * chosen rows whose search CENTRE fell in the band, ordered by chosen_at, trip id and
 * encounter index (a total order), and the result is stored on the new menu row so a replay
 * reads the share the draw saw rather than re-measuring. Whole counts only.
 */
import type { Queryable } from "../db/pool.js";
import { AUTHORED_SERVED_SHARE_WINDOW, type AuthoredServedShare, type BandInfo } from "./band.js";

/** The band's served share right now: served (≤ window) and how many of those were authored. */
export async function authoredServedShare(db: Queryable, band: BandInfo, window: number = AUTHORED_SERVED_SHARE_WINDOW): Promise<AuthoredServedShare> {
  if (!Number.isInteger(window) || window < 1) throw new RangeError("window must be a positive integer");
  const res = await db.query<{ authored: boolean }>(
    `SELECT (c -> 'owner' ->> 'authored')::boolean AS authored
       FROM encounter_candidates ec
       CROSS JOIN LATERAL jsonb_array_elements(ec.candidates) c
      WHERE ec.chosen_at IS NOT NULL
        AND c ->> 'candidateId' = ec.chosen_candidate_id
        AND ec.centre >= $1 AND ec.centre <= $2
      ORDER BY ec.chosen_at DESC, ec.trip_id, ec.encounter_index DESC
      LIMIT $3`,
    [band.low, band.high, window],
  );
  let authored = 0;
  for (const r of res.rows) if (r.authored) authored++;
  return { band: band.index, window, served: res.rows.length, authored };
}

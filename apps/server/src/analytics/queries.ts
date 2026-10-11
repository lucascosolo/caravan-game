/**
 * Chunk 32: the dashboard's aggregate queries, derived from the ledger and the tables play
 * already writes (trip, trip_encounter, resolution_job, encounter_candidates, refugee_menu,
 * pack_purchase, pool_progress, standing_party) plus the client's screen-flow rows.
 *
 * READ-ONLY and ONE-WAY: nothing here writes, and nothing in play reads this module or its
 * tables (a test greps src/ for it). Analytics can never move an outcome, a menu or a price.
 *
 * BOUNDED: every query over an event-shaped table is bounded by a time window and reads
 * through a migration-018 index (ledger_event (event_type, occurred_at) / (account_id,
 * occurred_at), trip (ended_at), trip_encounter (settled_at), encounter_candidates
 * (band, chosen_at) (chunk 25's), refugee_menu (created_at), pack_purchase (purchased_at), account (created_at),
 * analytics_client_event (occurred_at) / (analytics_id, occurred_at)). The few "now" panels
 * (ladder levels, pool health, accounts near the cap) read state tables of one row per
 * account / party / caravan — O(players), never O(ledger). The plans are checked in under
 * apps/server/db/explain/analytics/ and asserted by test/telemetry-scale.test.ts.
 *
 * Every SQL string is exported so the scale test and the explain script run exactly what the
 * dashboard runs. Parameters: $1 = window start, $2 = window end (timestamptz), then extras.
 * Integers only in the results: rates are basis points computed in TS.
 */
import { TUNABLES } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import { BAND_SPAN } from "../matchmaking/band.js";
import { ANALYTICS_NEAR_CAP_PERCENT, ANALYTICS_NEAR_TICK_CAP_BP, ANALYTICS_SESSION_GAP_MS } from "./tunables.js";

/** n / d in basis points, floored; null when there is nothing to divide by. */
export function bp(n: number, d: number): number | null {
  return d === 0 ? null : Math.floor((n * 10_000) / d);
}

/** The band expression the matchmaker uses (band.ts bandOf), over a rating column. */
const bandExpr = (col: string, floorParam: string, spanParam: string): string => `GREATEST(0, floor((${col} - ${floorParam})::numeric / ${spanParam}))::int`;

// ── trips ────────────────────────────────────────────────────────────────────────────

export const TRIP_LENGTH_SQL = `SELECT t.end_reason, n.encounters, count(*)::int AS trips
  FROM trip t
  CROSS JOIN LATERAL (SELECT count(*)::int AS encounters FROM trip_encounter te WHERE te.trip_id = t.id) n
 WHERE t.ended_at >= $1 AND t.ended_at < $2 AND t.end_reason IS NOT NULL
 GROUP BY t.end_reason, n.encounters
 ORDER BY t.end_reason, n.encounters`;

export interface TripLengthRow {
  endReason: string;
  encounters: number;
  trips: number;
}

export const BANK_PUSH_SQL = `SELECT te.encounter_index AS idx, count(*)::int AS settled,
       count(*) FILTER (WHERE te.outcome_kind = 'caravan_held')::int AS held,
       count(*) FILTER (WHERE te.outcome_kind = 'caravan_overrun')::int AS overrun,
       count(*) FILTER (WHERE te.outcome_kind = 'stalemate')::int AS stalemate,
       count(*) FILTER (WHERE te.decision = 'pushed')::int AS pushed,
       count(*) FILTER (WHERE te.decision = 'banked')::int AS banked
  FROM trip_encounter te
 WHERE te.settled_at >= $1 AND te.settled_at < $2
 GROUP BY te.encounter_index
 ORDER BY te.encounter_index`;

export interface BankPushRow {
  encounterIndex: number;
  settled: number;
  held: number;
  overrun: number;
  stalemate: number;
  pushed: number;
  banked: number;
  /** Survived (held or stalemate) and not yet decided, or ended by a void. */
  undecided: number;
  /** pushed / (pushed + banked). */
  pushRateBp: number | null;
  overrunRateBp: number | null;
}

/** $3 = REPUTATION_FLOOR, $4 = BAND_SPAN. The band is the CARAVAN's (its living rating at search time). */
export const OVERRUN_BY_BAND_SQL = `SELECT ${bandExpr("ec.caravan_rating", "$3", "$4")} AS band, count(*)::int AS encounters,
       count(*) FILTER (WHERE te.outcome_kind = 'caravan_held')::int AS held,
       count(*) FILTER (WHERE te.outcome_kind = 'caravan_overrun')::int AS overrun,
       count(*) FILTER (WHERE te.outcome_kind = 'stalemate')::int AS stalemate
  FROM trip_encounter te
  CROSS JOIN LATERAL (SELECT caravan_rating FROM encounter_candidates
                       WHERE trip_id = te.trip_id AND encounter_index = te.encounter_index AND chosen_at IS NOT NULL LIMIT 1) ec
 WHERE te.settled_at >= $1 AND te.settled_at < $2
 GROUP BY 1
 ORDER BY 1`;

export interface OverrunBandRow {
  band: number;
  encounters: number;
  held: number;
  overrun: number;
  stalemate: number;
  overrunRateBp: number | null;
}

// ── what fought: from the resolution job each settled encounter folded in ─────────────

/**
 * The settled encounters of the window with the snapshot that fought (formation, survivors,
 * party) and its outcome. The job is reached by key through LATERAL … LIMIT 1 (as the
 * matchmaker's pool scan does), so the planner drives from trip_encounter (settled_at) and
 * never hash-joins a full scan of resolution_job. MATERIALIZED keeps the window scan on the
 * settled_at index (inlined, the DISTINCT below tempted the planner into a full walk of the
 * primary key to get its sort order for free).
 */
const ENC_CTE = `WITH enc AS MATERIALIZED (
  SELECT te.trip_id, te.encounter_index, te.outcome_kind, j.input, j.result,
         coalesce((SELECT a.is_system FROM account a WHERE a.id = (j.input ->> 'partyOwnerAccountId')::uuid), false) AS authored
    FROM trip_encounter te
    CROSS JOIN LATERAL (SELECT input, result FROM resolution_job WHERE id = te.job_id LIMIT 1) j
   WHERE te.settled_at >= $1 AND te.settled_at < $2
)`;

/** Posted (defending) unit types: a type counts once per encounter it was posted in; a win is a held encounter. */
export const DEFENDER_UNITS_SQL = `${ENC_CTE},
picks AS (
  SELECT DISTINCT e.trip_id, e.encounter_index, e.outcome_kind, u ->> 'typeId' AS type_id
    FROM enc e
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.input -> 'formation' -> 'posts', '[]'::jsonb)) p
    JOIN LATERAL jsonb_array_elements(coalesce(e.input -> 'survivors' -> 'units', '[]'::jsonb)) u ON u ->> 'ref' = p ->> 'ref'
)
SELECT type_id, count(*)::int AS appearances, count(*) FILTER (WHERE outcome_kind = 'caravan_held')::int AS wins
  FROM picks GROUP BY type_id ORDER BY appearances DESC, type_id`;

/** Raiding unit types in the parties served: once per encounter; a win is an overrun. `live` excludes authored (system) parties. */
export const ATTACKER_UNITS_SQL = `${ENC_CTE},
picks AS (
  SELECT DISTINCT e.trip_id, e.encounter_index, e.outcome_kind, e.authored, u ->> 'typeId' AS type_id
    FROM enc e
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.input -> 'party' -> 'composition' -> 'units', '[]'::jsonb)) u
)
SELECT type_id, count(*)::int AS appearances, count(*) FILTER (WHERE outcome_kind = 'caravan_overrun')::int AS wins,
       count(*) FILTER (WHERE NOT authored)::int AS live
  FROM picks GROUP BY type_id ORDER BY appearances DESC, type_id`;

export interface UnitRow {
  typeId: string;
  appearances: number;
  wins: number;
  /** appearances / encounters settled in the window. */
  pickRateBp: number | null;
  winRateBp: number | null;
  /** Attacker side only: appearances in live (player-owned) parties. */
  live?: number;
}

/** Traps laid: once per encounter; held = the circle held. */
export const TRAPS_SQL = `${ENC_CTE},
laid AS (
  SELECT DISTINCT e.trip_id, e.encounter_index, e.outcome_kind, s ->> 'typeId' AS type_id
    FROM enc e
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.input -> 'formation' -> 'traps', '[]'::jsonb)) t
    JOIN LATERAL jsonb_array_elements(coalesce(e.input -> 'survivors' -> 'traps', '[]'::jsonb)) s ON s ->> 'ref' = t ->> 'ref'
)
SELECT type_id, count(*)::int AS appearances, count(*) FILTER (WHERE outcome_kind = 'caravan_held')::int AS wins
  FROM laid GROUP BY type_id ORDER BY appearances DESC, type_id`;

/** Siege brought by the served parties: once per encounter; a win is an overrun. */
export const SIEGE_SQL = `${ENC_CTE},
brought AS (
  SELECT DISTINCT e.trip_id, e.encounter_index, e.outcome_kind, s ->> 'typeId' AS type_id
    FROM enc e
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.input -> 'party' -> 'composition' -> 'siege', '[]'::jsonb)) s
)
SELECT type_id, count(*)::int AS appearances, count(*) FILTER (WHERE outcome_kind = 'caravan_overrun')::int AS wins
  FROM brought GROUP BY type_id ORDER BY appearances DESC, type_id`;

/** Posts by defensive stance (each post counts); held = posts in held encounters. */
export const STANCES_SQL = `${ENC_CTE}
SELECT p ->> 'stance' AS stance, count(*)::int AS posts, count(*) FILTER (WHERE e.outcome_kind = 'caravan_held')::int AS held
  FROM enc e
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.input -> 'formation' -> 'posts', '[]'::jsonb)) p
 GROUP BY 1 ORDER BY 1`;

export interface StanceRow {
  stance: string;
  posts: number;
  held: number;
  heldRateBp: number | null;
}

/** How full the slots were: posted units, raiders, traps and fence segments per encounter. */
export const SLOTS_SQL = `${ENC_CTE},
sizes AS (
  SELECT e.outcome_kind,
         jsonb_array_length(coalesce(e.input -> 'formation' -> 'posts', '[]'::jsonb)) AS posted,
         jsonb_array_length(coalesce(e.input -> 'party' -> 'composition' -> 'units', '[]'::jsonb)) AS raiders,
         jsonb_array_length(coalesce(e.input -> 'formation' -> 'traps', '[]'::jsonb)) AS traps,
         jsonb_array_length(coalesce(e.input -> 'formation' -> 'fences', '[]'::jsonb)) AS fences
    FROM enc e
)
SELECT side, n, count(*)::int AS encounters, count(*) FILTER (WHERE outcome_kind = 'caravan_held')::int AS held
  FROM (SELECT 'posted' AS side, posted AS n, outcome_kind FROM sizes
        UNION ALL SELECT 'raiders', raiders, outcome_kind FROM sizes
        UNION ALL SELECT 'traps', traps, outcome_kind FROM sizes
        UNION ALL SELECT 'fences', fences, outcome_kind FROM sizes) x
 GROUP BY side, n ORDER BY side, n`;

export interface SlotRow {
  side: "posted" | "raiders" | "traps" | "fences";
  count: number;
  encounters: number;
  held: number;
  heldRateBp: number | null;
}

/** $3 = the tick cap, $4 = "near the cap" threshold in ticks. endTick from the stored outcome. */
export const TICK_CAP_SQL = `${ENC_CTE},
ends AS (SELECT e.outcome_kind, (e.result -> 'outcome' ->> 'endTick')::int AS end_tick FROM enc e WHERE jsonb_typeof(e.result -> 'outcome' -> 'endTick') = 'number')
SELECT outcome_kind, count(*)::int AS fights, count(*) FILTER (WHERE end_tick >= $4)::int AS near_cap,
       count(*) FILTER (WHERE end_tick >= $3)::int AS at_cap,
       coalesce(max(end_tick), 0)::int AS max_end_tick,
       coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY end_tick), 0)::int AS median_end_tick
  FROM ends GROUP BY outcome_kind ORDER BY outcome_kind`;

export interface TickRow {
  outcomeKind: string;
  fights: number;
  nearCap: number;
  atCap: number;
  maxEndTick: number;
  medianEndTick: number;
}

// ── the ledger ───────────────────────────────────────────────────────────────────────

/** Coin spent per reason (merge, refugee_reroll, mercenary_recruit, …). */
export const SPEND_BY_REASON_SQL = `SELECT e.payload ->> 'reason' AS reason, count(*)::int AS events, coalesce(sum((e.payload ->> 'amount')::bigint), 0)::bigint AS coin
  FROM ledger_event e
 WHERE e.event_type = 'coin_spent' AND e.occurred_at >= $1 AND e.occurred_at < $2
 GROUP BY 1 ORDER BY 1`;

export interface SpendRow {
  reason: string;
  events: number;
  coin: number;
}

/** Merge spend per UTC day. */
export const MERGE_BY_DAY_SQL = `SELECT to_char(date_trunc('day', e.occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS merges,
       coalesce(sum((e.payload ->> 'amount')::bigint), 0)::bigint AS coin
  FROM ledger_event e
 WHERE e.event_type = 'coin_spent' AND e.occurred_at >= $1 AND e.occurred_at < $2 AND e.payload ->> 'reason' = 'merge'
 GROUP BY 1 ORDER BY 1`;

/** Merges by the level produced. */
export const MERGE_BY_LEVEL_SQL = `SELECT (e.payload ->> 'toLevel')::int AS to_level, count(*)::int AS merges, coalesce(sum((e.payload ->> 'amount')::bigint), 0)::bigint AS coin
  FROM ledger_event e
 WHERE e.event_type = 'coin_spent' AND e.occurred_at >= $1 AND e.occurred_at < $2 AND e.payload ->> 'reason' = 'merge'
   AND jsonb_typeof(e.payload -> 'toLevel') = 'number'
 GROUP BY 1 ORDER BY 1`;

/** Every Coin credit by type and reason, with what the storage cap discarded. */
export const EARN_BY_SOURCE_SQL = `SELECT e.event_type::text AS type, e.payload ->> 'reason' AS reason, count(*)::int AS events,
       coalesce(sum((e.payload ->> 'amount')::bigint), 0)::bigint AS coin,
       coalesce(sum(CASE WHEN jsonb_typeof(e.payload -> 'overflowDiscarded') = 'number' THEN (e.payload ->> 'overflowDiscarded')::bigint ELSE 0 END), 0)::bigint AS discarded
  FROM ledger_event e
 WHERE e.event_type IN ('coin_earned', 'coin_transferred_to_party_owner', 'coin_purchased') AND e.occurred_at >= $1 AND e.occurred_at < $2
 GROUP BY 1, 2 ORDER BY 1, 2`;

export interface EarnRow {
  type: string;
  reason: string;
  events: number;
  coin: number;
  discarded: number;
}

/** $3 = percent of the cap. Accounts now at or near the storage cap (players only). */
export const NEAR_CAP_SQL = `SELECT count(*)::int AS accounts, count(*) FILTER (WHERE a.coin_balance * 100 >= a.coin_storage_cap * $1::bigint)::int AS near_cap,
       count(*) FILTER (WHERE a.coin_balance >= a.coin_storage_cap)::int AS at_cap
  FROM account a WHERE NOT a.is_system`;

/** Trip starts in the window, and how many took the account's LAST available trip-cap use. */
export const TRIP_CAP_SQL = `SELECT count(*)::int AS starts, count(DISTINCT e.account_id)::int AS accounts,
       count(*) FILTER (WHERE e.payload -> 'tripCap' ->> 'availableAfter' = '0')::int AS took_last_use
  FROM ledger_event e
 WHERE e.event_type = 'trip_started' AND e.occurred_at >= $1 AND e.occurred_at < $2`;

/**
 * Grind-wall probe. $1/$2 = the week's bounds. Active = started at least one trip that week.
 * Free earn = every Coin credit except a purchase (trickle, encounter and delivery Coin, party
 * wins and loot, overrun transfers), as credited. Deciles by free earn, lowest first.
 */
export const GRIND_WALL_SQL = `WITH active AS (
  SELECT DISTINCT e.account_id FROM ledger_event e
   WHERE e.event_type = 'trip_started' AND e.occurred_at >= $1 AND e.occurred_at < $2
), earn AS (
  SELECT a.account_id,
         coalesce(sum((e.payload ->> 'amount')::bigint) FILTER (WHERE e.event_type IN ('coin_earned', 'coin_transferred_to_party_owner')), 0)::bigint AS free,
         coalesce(sum((e.payload ->> 'amount')::bigint) FILTER (WHERE e.event_type = 'coin_purchased'), 0)::bigint AS paid
    FROM active a
    LEFT JOIN ledger_event e ON e.account_id = a.account_id AND e.occurred_at >= $1 AND e.occurred_at < $2
         AND e.event_type IN ('coin_earned', 'coin_transferred_to_party_owner', 'coin_purchased')
   GROUP BY a.account_id
), d AS (SELECT free, paid, ntile(10) OVER (ORDER BY free, account_id) AS decile FROM earn)
SELECT decile, count(*)::int AS players, min(free)::bigint AS min_free, max(free)::bigint AS max_free,
       (sum(free) / count(*))::bigint AS avg_free, (sum(paid) / count(*))::bigint AS avg_paid,
       count(*) FILTER (WHERE paid > 0)::int AS payers
  FROM d GROUP BY decile ORDER BY decile`;

export interface GrindDecileRow {
  decile: number;
  players: number;
  minFree: number;
  maxFree: number;
  avgFree: number;
  avgPaid: number;
  payers: number;
  /** WEEKLY_PAY_CEILING / avgFree, in basis points (10000 = the paid ceiling equals a week of free play). */
  ceilingToFreeBp: number | null;
}

/** Ladder levels now, per pool (players only). Not windowed: one row per pool per owner. */
export const LADDER_LEVELS_SQL = `SELECT pp.pool::text AS pool, pp.ladder_level AS level, count(*)::int AS owners
  FROM pool_progress pp
  LEFT JOIN caravan c ON c.id = pp.caravan_id
  JOIN account a ON a.id = coalesce(pp.account_id, c.account_id)
 WHERE NOT a.is_system
 GROUP BY 1, 2 ORDER BY 1, 2`;

export const LADDER_GAINED_SQL = `SELECT e.payload ->> 'pool' AS pool, count(*)::int AS events,
       coalesce(sum((e.payload ->> 'pointsDelta')::bigint), 0)::bigint AS points, coalesce(sum((e.payload ->> 'levelsGained')::bigint), 0)::bigint AS rungs
  FROM ledger_event e
 WHERE e.event_type = 'ladder_progress_gained' AND e.occurred_at >= $1 AND e.occurred_at < $2
 GROUP BY 1 ORDER BY 1`;

export const UNLOCKS_SQL = `SELECT e.payload ->> 'pool' AS pool, e.payload ->> 'nodeId' AS node_id, count(*)::int AS purchases,
       coalesce(sum((e.payload ->> 'cost')::bigint), 0)::bigint AS points
  FROM ledger_event e
 WHERE e.event_type = 'unlock_node_purchased' AND e.occurred_at >= $1 AND e.occurred_at < $2
 GROUP BY 1, 2 ORDER BY 1, purchases DESC, 2`;

// ── acquisition ──────────────────────────────────────────────────────────────────────

export const REFUGEE_BY_DAY_SQL = `SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       count(*) FILTER (WHERE r.origin = 'free')::int AS free_menus, count(*) FILTER (WHERE r.origin = 'reroll')::int AS rerolls,
       count(*) FILTER (WHERE r.claimed_type_id IS NOT NULL)::int AS claims, count(DISTINCT r.caravan_id)::int AS caravans
  FROM refugee_menu r
 WHERE r.created_at >= $1 AND r.created_at < $2
 GROUP BY 1 ORDER BY 1`;

// ── store ────────────────────────────────────────────────────────────────────────────

export const PACK_TIERS_SQL = `SELECT p.tier::int AS tier, count(*)::int AS reserved, count(*) FILTER (WHERE p.settled_at IS NOT NULL)::int AS settled,
       count(DISTINCT p.account_id) FILTER (WHERE p.settled_at IS NOT NULL)::int AS buyers,
       coalesce(sum(p.price_cents) FILTER (WHERE p.settled_at IS NOT NULL), 0)::bigint AS cents
  FROM pack_purchase p
 WHERE p.purchased_at >= $1 AND p.purchased_at < $2
 GROUP BY 1 ORDER BY 1`;

export const PACK_BUYERS_SQL = `SELECT count(DISTINCT p.account_id)::int AS buyers FROM pack_purchase p
 WHERE p.purchased_at >= $1 AND p.purchased_at < $2 AND p.settled_at IS NOT NULL`;

/** Distinct analytics ids that opened the storefront (screen 'packs') and anything at all. */
export const STORE_VIEWERS_SQL = `SELECT count(DISTINCT ce.analytics_id) FILTER (WHERE ce.screen = 'packs')::int AS store_viewers, count(DISTINCT ce.analytics_id)::int AS viewers
  FROM analytics_client_event ce
 WHERE ce.kind = 'screen' AND ce.occurred_at >= $1 AND ce.occurred_at < $2`;

// ── engagement (client screen flow; opted-out accounts' rows were deleted and are never written) ──

export const SCREENS_SQL = `SELECT ce.screen, count(*)::int AS views, count(DISTINCT ce.analytics_id)::int AS viewers
  FROM analytics_client_event ce
 WHERE ce.kind = 'screen' AND ce.occurred_at >= $1 AND ce.occurred_at < $2
 GROUP BY 1 ORDER BY views DESC, 1`;

export const CRASHES_SQL = `SELECT ce.error_name, ce.stack_hash, ce.screen, count(*)::int AS reports, count(DISTINCT ce.analytics_id)::int AS reporters
  FROM analytics_client_event ce
 WHERE ce.kind = 'crash' AND ce.occurred_at >= $1 AND ce.occurred_at < $2
 GROUP BY 1, 2, 3 ORDER BY reports DESC, 1, 2, 3 LIMIT 20`;

/**
 * Sessions: an analytics id's screen events split wherever the gap exceeds $3 ms. A session's
 * length is its last event minus its first (a one-screen session is 0). Bucketed in minutes.
 */
export const SESSIONS_SQL = `WITH ev AS (
  SELECT ce.analytics_id, ce.occurred_at,
         CASE WHEN lag(ce.occurred_at) OVER w IS NULL OR ce.occurred_at - lag(ce.occurred_at) OVER w > $3 * interval '1 millisecond' THEN 1 ELSE 0 END AS starts
    FROM analytics_client_event ce
   WHERE ce.kind = 'screen' AND ce.occurred_at >= $1 AND ce.occurred_at < $2
  WINDOW w AS (PARTITION BY ce.analytics_id ORDER BY ce.occurred_at, ce.id)
), numbered AS (
  SELECT analytics_id, occurred_at, sum(starts) OVER (PARTITION BY analytics_id ORDER BY occurred_at ROWS UNBOUNDED PRECEDING) AS sid FROM ev
), sessions AS (
  SELECT analytics_id, sid, floor(EXTRACT(EPOCH FROM (max(occurred_at) - min(occurred_at))) * 1000)::bigint AS ms, count(*)::int AS screens
    FROM numbered GROUP BY analytics_id, sid
)
SELECT count(*)::int AS sessions, count(DISTINCT analytics_id)::int AS players,
       coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY ms), 0)::bigint AS median_ms,
       coalesce(max(ms), 0)::bigint AS max_ms,
       count(*) FILTER (WHERE ms < 60000)::int AS under_1m,
       count(*) FILTER (WHERE ms >= 60000 AND ms < 300000)::int AS m1_5,
       count(*) FILTER (WHERE ms >= 300000 AND ms < 900000)::int AS m5_15,
       count(*) FILTER (WHERE ms >= 900000 AND ms < 1800000)::int AS m15_30,
       count(*) FILTER (WHERE ms >= 1800000 AND ms < 3600000)::int AS m30_60,
       count(*) FILTER (WHERE ms >= 3600000)::int AS over_60m,
       coalesce(sum(screens), 0)::bigint AS screens
  FROM sessions`;

/**
 * The account's own actions (not things done TO it, like a party strike or a trickle tick):
 * a return on day N means one of these, or a screen event, in [created + N d, created + N+1 d).
 */
export const ACTIVITY_EVENT_TYPES = ["trip_started", "formation_committed", "trip_banked", "standing_party_saved", "unit_merged", "unit_acquired", "coin_spent", "unlock_node_purchased"] as const;

/**
 * Day-1/7/30 return. $1/$2 = the cohort's creation window (ending now), $3 = activity types.
 * An account is eligible for day N once N+1 full days have passed since it was created.
 * Opted-out accounts are left out of the cohort.
 */
export const RETENTION_SQL = `WITH cohort AS (
  SELECT a.id, a.created_at FROM account a
   WHERE NOT a.is_system AND a.created_at >= $1 AND a.created_at < $2
     AND NOT EXISTS (SELECT 1 FROM account_analytics x WHERE x.account_id = a.id AND x.opted_out)
)
SELECT d.n AS day,
       count(*) FILTER (WHERE c.created_at + (d.n + 1) * interval '1 day' <= $2)::int AS eligible,
       count(*) FILTER (WHERE c.created_at + (d.n + 1) * interval '1 day' <= $2 AND (
         EXISTS (SELECT 1 FROM ledger_event e
                  WHERE e.account_id = c.id AND e.occurred_at >= c.created_at + d.n * interval '1 day'
                    AND e.occurred_at < c.created_at + (d.n + 1) * interval '1 day' AND e.event_type = ANY($3::ledger_event_type[]))
         OR EXISTS (SELECT 1 FROM account_analytics x JOIN analytics_client_event ce ON ce.analytics_id = x.analytics_id
                     WHERE x.account_id = c.id AND ce.occurred_at >= c.created_at + d.n * interval '1 day'
                       AND ce.occurred_at < c.created_at + (d.n + 1) * interval '1 day')))::int AS returned
  FROM cohort c CROSS JOIN (VALUES (1), (7), (30)) AS d(n)
 GROUP BY d.n ORDER BY d.n`;

// ── pool health ──────────────────────────────────────────────────────────────────────

/** $1 = REPUTATION_FLOOR, $2 = BAND_SPAN. Servable standing parties now, by the owner's siege-Reputation band. */
export const POOL_PARTIES_SQL = `SELECT ${bandExpr("pp.reputation", "$1", "$2")} AS band, a.is_system AS authored, count(*)::int AS parties
  FROM standing_party sp
  JOIN account a ON a.id = sp.account_id
  JOIN pool_progress pp ON pp.account_id = sp.account_id AND pp.pool = 'siege'
 WHERE sp.slot = 0 AND jsonb_array_length(sp.composition -> 'units') > 0
 GROUP BY 1, 2 ORDER BY 1, 2`;

/** $1 = REPUTATION_FLOOR, $2 = BAND_SPAN. Player caravans now, by living-Reputation band: the demand side. */
export const POOL_CARAVANS_SQL = `SELECT ${bandExpr("pp.reputation", "$1", "$2")} AS band, count(*)::int AS caravans
  FROM pool_progress pp
  JOIN caravan c ON c.id = pp.caravan_id
  JOIN account a ON a.id = c.account_id
 WHERE pp.pool = 'living' AND NOT a.is_system
 GROUP BY 1 ORDER BY 1`;

/**
 * Encounters served in the window by band (of the search centre, as stored) and how many were
 * authored. Walks the matchmaker's own `encounter_candidates_band_chosen_idx (band, chosen_at
 * DESC, …)` once per band — 0 … the highest band ever chosen (one backward index probe) — so
 * the window is an index range in every band and no second chosen_at index is needed.
 */
export const POOL_SERVED_SQL = `SELECT b.band, count(*)::int AS served, count(*) FILTER (WHERE (c -> 'owner' ->> 'authored')::boolean)::int AS authored
  FROM generate_series(0, coalesce((SELECT max(band) FROM encounter_candidates WHERE chosen_at IS NOT NULL), -1)) AS b(band)
  CROSS JOIN LATERAL (SELECT candidates, chosen_candidate_id FROM encounter_candidates
                       WHERE band = b.band AND chosen_at IS NOT NULL AND chosen_at >= $1 AND chosen_at < $2) ec
  CROSS JOIN LATERAL jsonb_array_elements(ec.candidates) c
 WHERE c ->> 'candidateId' = ec.chosen_candidate_id
 GROUP BY 1 ORDER BY 1`;

export type BandAlarm = "ok" | "empty" | "no_live" | "authored_over_share";

export interface PoolBandRow {
  band: number;
  low: number;
  high: number;
  liveParties: number;
  authoredParties: number;
  caravans: number;
  served: number;
  servedAuthored: number;
  /** Live share of the servable parties in the band, bp. */
  liveShareBp: number | null;
  servedAuthoredShareBp: number | null;
  alarm: BandAlarm;
}

// ── runners ──────────────────────────────────────────────────────────────────────────

export interface Window {
  from: Date;
  to: Date;
}

const w = (win: Window): [Date, Date] => [win.from, win.to];

export async function tripLength(db: Queryable, win: Window): Promise<TripLengthRow[]> {
  const res = await db.query<{ end_reason: string; encounters: number; trips: number }>(TRIP_LENGTH_SQL, w(win));
  return res.rows.map((r) => ({ endReason: r.end_reason, encounters: r.encounters, trips: r.trips }));
}

export async function bankVsPush(db: Queryable, win: Window): Promise<BankPushRow[]> {
  const res = await db.query<{ idx: number; settled: number; held: number; overrun: number; stalemate: number; pushed: number; banked: number }>(BANK_PUSH_SQL, w(win));
  return res.rows.map((r) => ({
    encounterIndex: r.idx,
    settled: r.settled,
    held: r.held,
    overrun: r.overrun,
    stalemate: r.stalemate,
    pushed: r.pushed,
    banked: r.banked,
    undecided: r.settled - r.overrun - r.pushed - r.banked,
    pushRateBp: bp(r.pushed, r.pushed + r.banked),
    overrunRateBp: bp(r.overrun, r.settled),
  }));
}

export async function overrunByBand(db: Queryable, win: Window): Promise<OverrunBandRow[]> {
  const res = await db.query<{ band: number; encounters: number; held: number; overrun: number; stalemate: number }>(OVERRUN_BY_BAND_SQL, [...w(win), TUNABLES.REPUTATION_FLOOR, BAND_SPAN]);
  return res.rows.map((r) => ({ ...r, overrunRateBp: bp(r.overrun, r.encounters) }));
}

async function typeRows(db: Queryable, sql: string, win: Window, settled: number, withLive = false): Promise<UnitRow[]> {
  const res = await db.query<{ type_id: string; appearances: number; wins: number; live?: number }>(sql, w(win));
  return res.rows.map((r) => ({
    typeId: r.type_id,
    appearances: r.appearances,
    wins: r.wins,
    pickRateBp: bp(r.appearances, settled),
    winRateBp: bp(r.wins, r.appearances),
    ...(withLive ? { live: r.live ?? 0 } : {}),
  }));
}

export const defenderUnits = (db: Queryable, win: Window, settled: number): Promise<UnitRow[]> => typeRows(db, DEFENDER_UNITS_SQL, win, settled);
export const attackerUnits = (db: Queryable, win: Window, settled: number): Promise<UnitRow[]> => typeRows(db, ATTACKER_UNITS_SQL, win, settled, true);
export const trapUsage = (db: Queryable, win: Window, settled: number): Promise<UnitRow[]> => typeRows(db, TRAPS_SQL, win, settled);
export const siegeUsage = (db: Queryable, win: Window, settled: number): Promise<UnitRow[]> => typeRows(db, SIEGE_SQL, win, settled);

export async function stances(db: Queryable, win: Window): Promise<StanceRow[]> {
  const res = await db.query<{ stance: string; posts: number; held: number }>(STANCES_SQL, w(win));
  return res.rows.map((r) => ({ ...r, heldRateBp: bp(r.held, r.posts) }));
}

export async function slots(db: Queryable, win: Window): Promise<SlotRow[]> {
  const res = await db.query<{ side: SlotRow["side"]; n: number; encounters: number; held: number }>(SLOTS_SQL, w(win));
  return res.rows.map((r) => ({ side: r.side, count: r.n, encounters: r.encounters, held: r.held, heldRateBp: bp(r.held, r.encounters) }));
}

/** The resolver's tick cap: BATTLE_LENGTH_CAP_SECONDS × TICK_RATE. */
export const TICK_CAP: number = TUNABLES.BATTLE_LENGTH_CAP_SECONDS * TUNABLES.TICK_RATE;
export const NEAR_TICK_CAP: number = Math.floor((TICK_CAP * ANALYTICS_NEAR_TICK_CAP_BP) / 10_000);

export async function tickCap(db: Queryable, win: Window): Promise<TickRow[]> {
  const res = await db.query<{ outcome_kind: string; fights: number; near_cap: number; at_cap: number; max_end_tick: number; median_end_tick: number }>(TICK_CAP_SQL, [...w(win), TICK_CAP, NEAR_TICK_CAP]);
  return res.rows.map((r) => ({ outcomeKind: r.outcome_kind, fights: r.fights, nearCap: r.near_cap, atCap: r.at_cap, maxEndTick: r.max_end_tick, medianEndTick: r.median_end_tick }));
}

export async function spendByReason(db: Queryable, win: Window): Promise<SpendRow[]> {
  return (await db.query<SpendRow>(SPEND_BY_REASON_SQL, w(win))).rows.map((r) => ({ reason: r.reason ?? "", events: r.events, coin: r.coin }));
}

export async function mergeByDay(db: Queryable, win: Window): Promise<{ day: string; merges: number; coin: number }[]> {
  return (await db.query<{ day: string; merges: number; coin: number }>(MERGE_BY_DAY_SQL, w(win))).rows;
}

export async function mergeByLevel(db: Queryable, win: Window): Promise<{ toLevel: number; merges: number; coin: number }[]> {
  return (await db.query<{ to_level: number; merges: number; coin: number }>(MERGE_BY_LEVEL_SQL, w(win))).rows.map((r) => ({ toLevel: r.to_level, merges: r.merges, coin: r.coin }));
}

export async function earnBySource(db: Queryable, win: Window): Promise<EarnRow[]> {
  return (await db.query<EarnRow>(EARN_BY_SOURCE_SQL, w(win))).rows.map((r) => ({ ...r, reason: r.reason ?? "" }));
}

export async function nearCap(db: Queryable): Promise<{ accounts: number; nearCap: number; atCap: number; nearCapPercent: number }> {
  const r = (await db.query<{ accounts: number; near_cap: number; at_cap: number }>(NEAR_CAP_SQL, [ANALYTICS_NEAR_CAP_PERCENT])).rows[0]!;
  return { accounts: r.accounts, nearCap: r.near_cap, atCap: r.at_cap, nearCapPercent: ANALYTICS_NEAR_CAP_PERCENT };
}

export async function tripCapUse(db: Queryable, win: Window): Promise<{ starts: number; accounts: number; tookLastUse: number; tookLastUseBp: number | null }> {
  const r = (await db.query<{ starts: number; accounts: number; took_last_use: number }>(TRIP_CAP_SQL, w(win))).rows[0]!;
  return { starts: r.starts, accounts: r.accounts, tookLastUse: r.took_last_use, tookLastUseBp: bp(r.took_last_use, r.starts) };
}

export async function grindWall(db: Queryable, week: Window): Promise<GrindDecileRow[]> {
  const res = await db.query<{ decile: number; players: number; min_free: number; max_free: number; avg_free: number; avg_paid: number; payers: number }>(GRIND_WALL_SQL, w(week));
  return res.rows.map((r) => ({
    decile: r.decile,
    players: r.players,
    minFree: r.min_free,
    maxFree: r.max_free,
    avgFree: r.avg_free,
    avgPaid: r.avg_paid,
    payers: r.payers,
    ceilingToFreeBp: bp(TUNABLES.WEEKLY_PAY_CEILING, r.avg_free),
  }));
}

export async function ladder(db: Queryable, win: Window): Promise<{ levels: { pool: string; level: number; owners: number }[]; gained: { pool: string; events: number; points: number; rungs: number }[] }> {
  const levels = (await db.query<{ pool: string; level: number; owners: number }>(LADDER_LEVELS_SQL)).rows;
  const gained = (await db.query<{ pool: string; events: number; points: number; rungs: number }>(LADDER_GAINED_SQL, w(win))).rows;
  return { levels, gained };
}

export async function unlockPurchases(db: Queryable, win: Window): Promise<{ pool: string; nodeId: string; purchases: number; points: number }[]> {
  return (await db.query<{ pool: string; node_id: string; purchases: number; points: number }>(UNLOCKS_SQL, w(win))).rows.map((r) => ({ pool: r.pool, nodeId: r.node_id, purchases: r.purchases, points: r.points }));
}

export async function refugeesByDay(db: Queryable, win: Window): Promise<{ day: string; freeMenus: number; rerolls: number; claims: number; caravans: number }[]> {
  return (await db.query<{ day: string; free_menus: number; rerolls: number; claims: number; caravans: number }>(REFUGEE_BY_DAY_SQL, w(win))).rows.map((r) => ({ day: r.day, freeMenus: r.free_menus, rerolls: r.rerolls, claims: r.claims, caravans: r.caravans }));
}

export interface PackFunnel {
  viewers: number;
  storeViewers: number;
  buyers: number;
  tiers: { tier: number; reserved: number; settled: number; buyers: number; cents: number }[];
}

export async function packFunnel(db: Queryable, win: Window): Promise<PackFunnel> {
  const v = (await db.query<{ store_viewers: number; viewers: number }>(STORE_VIEWERS_SQL, w(win))).rows[0]!;
  const b = (await db.query<{ buyers: number }>(PACK_BUYERS_SQL, w(win))).rows[0]!;
  const tiers = (await db.query<{ tier: number; reserved: number; settled: number; buyers: number; cents: number }>(PACK_TIERS_SQL, w(win))).rows;
  return { viewers: v.viewers, storeViewers: v.store_viewers, buyers: b.buyers, tiers };
}

export async function screens(db: Queryable, win: Window): Promise<{ screen: string; views: number; viewers: number }[]> {
  return (await db.query<{ screen: string; views: number; viewers: number }>(SCREENS_SQL, w(win))).rows;
}

export async function crashes(db: Queryable, win: Window): Promise<{ errorName: string; stackHash: string; screen: string; reports: number; reporters: number }[]> {
  return (await db.query<{ error_name: string; stack_hash: string; screen: string; reports: number; reporters: number }>(CRASHES_SQL, w(win))).rows.map((r) => ({ errorName: r.error_name, stackHash: r.stack_hash, screen: r.screen, reports: r.reports, reporters: r.reporters }));
}

export interface SessionStats {
  sessions: number;
  players: number;
  medianMs: number;
  maxMs: number;
  screens: number;
  gapMs: number;
  buckets: { label: string; sessions: number }[];
}

export async function sessionLength(db: Queryable, win: Window): Promise<SessionStats> {
  const r = (await db.query<{ sessions: number; players: number; median_ms: number; max_ms: number; under_1m: number; m1_5: number; m5_15: number; m15_30: number; m30_60: number; over_60m: number; screens: number }>(SESSIONS_SQL, [...w(win), ANALYTICS_SESSION_GAP_MS])).rows[0]!;
  return {
    sessions: r.sessions,
    players: r.players,
    medianMs: r.median_ms,
    maxMs: r.max_ms,
    screens: r.screens,
    gapMs: ANALYTICS_SESSION_GAP_MS,
    buckets: [
      { label: "<1m", sessions: r.under_1m },
      { label: "1–5m", sessions: r.m1_5 },
      { label: "5–15m", sessions: r.m5_15 },
      { label: "15–30m", sessions: r.m15_30 },
      { label: "30–60m", sessions: r.m30_60 },
      { label: "≥60m", sessions: r.over_60m },
    ],
  };
}

export async function retention(db: Queryable, cohort: Window): Promise<{ day: number; eligible: number; returned: number; rateBp: number | null }[]> {
  const res = await db.query<{ day: number; eligible: number; returned: number }>(RETENTION_SQL, [...w(cohort), [...ACTIVITY_EVENT_TYPES]]);
  return res.rows.map((r) => ({ ...r, rateBp: bp(r.returned, r.eligible) }));
}

export async function poolHealth(db: Queryable, win: Window): Promise<PoolBandRow[]> {
  const floorSpan = [TUNABLES.REPUTATION_FLOOR, BAND_SPAN];
  const parties = (await db.query<{ band: number; authored: boolean; parties: number }>(POOL_PARTIES_SQL, floorSpan)).rows;
  const caravans = (await db.query<{ band: number; caravans: number }>(POOL_CARAVANS_SQL, floorSpan)).rows;
  const served = (await db.query<{ band: number; served: number; authored: number }>(POOL_SERVED_SQL, w(win))).rows;
  const bands = new Set<number>([...parties.map((p) => p.band), ...caravans.map((c) => c.band), ...served.map((s) => s.band)]);
  const top = bands.size === 0 ? -1 : Math.max(...bands);
  const out: PoolBandRow[] = [];
  for (let band = 0; band <= top; band++) {
    const live = parties.find((p) => p.band === band && !p.authored)?.parties ?? 0;
    const authored = parties.find((p) => p.band === band && p.authored)?.parties ?? 0;
    const s = served.find((x) => x.band === band);
    const servedN = s?.served ?? 0;
    const servedA = s?.authored ?? 0;
    const servedShare = bp(servedA, servedN);
    let alarm: BandAlarm = "ok";
    if (live + authored < TUNABLES.CANDIDATES_PER_SEARCH) alarm = "empty";
    else if (live === 0) alarm = "no_live";
    else if (servedShare !== null && servedShare > TUNABLES.AUTHORED_PARTY_MAX_SHARE_BP) alarm = "authored_over_share";
    const low = TUNABLES.REPUTATION_FLOOR + band * BAND_SPAN;
    out.push({
      band,
      low,
      high: low + BAND_SPAN - 1,
      liveParties: live,
      authoredParties: authored,
      caravans: caravans.find((c) => c.band === band)?.caravans ?? 0,
      served: servedN,
      servedAuthored: servedA,
      liveShareBp: bp(live, live + authored),
      servedAuthoredShareBp: servedShare,
      alarm,
    });
  }
  return out;
}

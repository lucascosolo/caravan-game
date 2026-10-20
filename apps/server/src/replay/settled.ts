/**
 * Chunk 22 QA S8 / D3 — what ONE encounter settled, itemized for the replay summary, read from
 * the LEDGER EVENTS that encounter's resolution job caused and nothing else (never from the
 * stored log, which the retention job may compact — chunk 36):
 *
 *   progression:<jobId>          reputation_changed, ladder_progress_gained, unlock_points_granted
 *   transfer:<jobId>             the party owner's credits: party_loot (a held fight), the Coin
 *                                transfer and party_win (an overrun)
 *   trip:<tripId>:bank           the caravan's banked credit FOR THIS ENCOUNTER (encounter_survived,
 *                                payload.encounterIndex = n) — written when the trip banks or voids
 *   trip:<tripId>:overrun        coin_lost_on_wipe (payload.jobId), unit_lost_on_wipe (encounterIndex
 *                                n) and the de-merges of the units that died in THIS encounter
 *   trip:<tripId>:banked|voided  the de-merges (unit_demerged_on_death, payload.diedAtEncounter = n)
 *
 * Every event is the VIEWER's own (`account_id = viewer`): the caravan's player sees the caravan's
 * side, the party's owner theirs, and neither sees the other's account (GUARDRAILS §5 holds as the
 * ledger wrote it: living-pool rows carry the caravan, trap / siege rows the account). The owner's
 * party is a template and loses nothing, so the owner's de-merge and destroyed lists are always
 * empty — any event that said otherwise would be a bug elsewhere, and is not invented away here.
 *
 * The one thing the ledger does NOT hold yet is Coin the caravan earned but has not banked: it is
 * trip state (trip_encounter.coin_accrued) until a bank credits it. It is served as `trip.unbankedCoin`
 * beside the ledger items and named as such, never folded into them.
 */
import { getUnitType } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import { progressionCausationId } from "../progression/outcome.js";
import { transferCausationId } from "../trip/stakes.js";

export interface SettledCoin {
  /** The credit's reason as the ledger recorded it (encounter_survived, party_loot, caravan_overrun, party_win…). */
  readonly reason: string;
  /** Credited to the viewer's balance. */
  readonly amount: number;
  /** Over the storage cap, discarded at credit time (the clamp's `overflowDiscarded`). */
  readonly discarded: number;
}

export interface SettledEncounter {
  /** Always "ledger": nothing here is computed from the log. */
  readonly source: "ledger";
  /** Whether the trip loop has folded this outcome in yet (its trip_encounter row exists). False: nothing below has been written yet. */
  readonly applied: boolean;
  readonly coin: readonly SettledCoin[];
  /**
   * Final play-test review r3 N5: every Coin credited to the viewer for this encounter, summed
   * (the entries of `coin`) — the owner's end card and the inbox show the same total.
   */
  readonly coinEarned: number;
  /** Of `coinEarned`: an overrun caravan's unbanked Coin transferred to the party's owner (its own line on the card). */
  readonly coinTransferred: number;
  /** The caravan's unbanked Coin lost when it was overrun here, and where it went. */
  readonly coinLost: {
    readonly amount: number;
    readonly transferred: number;
    readonly destroyed: number;
    /** Final play-test review N7: the party was an authored outfit, which keeps nothing — the whole amount was lost to the trail, not taken by anyone. */
    readonly recipientAuthored: boolean;
  } | null;
  readonly reputation: readonly { readonly pool: string; readonly delta: number }[];
  readonly ladder: readonly { readonly pool: string; readonly pointsDelta: number; readonly levelBefore: number; readonly levelAfter: number }[];
  readonly unlockPoints: readonly { readonly pool: string; readonly points: number }[];
  /** Units that died in THIS encounter, de-merged one level when the trip ended (floored at 1). */
  readonly deMerged: readonly { readonly typeId: string; readonly displayName: string; readonly fromLevel: number; readonly toLevel: number }[];
  /** Units standing when the caravan fell here: destroyed. */
  readonly destroyed: readonly { readonly typeId: string; readonly displayName: string; readonly mergeLevel: number }[];
  /**
   * The caravan's trip, for what the ledger cannot say yet: `ended` false means the bank credit
   * and the de-merges have not been written (they are written when the trip ends). Null for the
   * party's owner.
   */
  readonly trip: { readonly ended: boolean; readonly endReason: string | null; readonly unbankedCoin: number | null } | null;
}

interface EventRow {
  event_type: string;
  causation_id: string;
  payload: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const unitName = (typeId: string): string => getUnitType(typeId)?.displayName ?? typeId;

/** The trip transition causations whose events can belong to one encounter (trip/service.ts `tripCausation`). */
function tripCauses(tripId: string): string[] {
  return [`trip:${tripId}:bank`, `trip:${tripId}:banked`, `trip:${tripId}:overrun`, `trip:${tripId}:voided`];
}

export async function settledForEncounter(
  db: Queryable,
  input: { jobId: string; tripId: string; encounterIndex: number; viewer: "caravan" | "party_owner"; accountId: string },
): Promise<SettledEncounter> {
  const own = [progressionCausationId(input.jobId), transferCausationId(input.jobId)];
  const causes = input.viewer === "caravan" ? [...own, ...tripCauses(input.tripId)] : own;
  const res = await db.query<EventRow>(
    "SELECT event_type::text AS event_type, causation_id, payload FROM ledger_event WHERE account_id = $1 AND causation_id = ANY($2::text[]) ORDER BY seq",
    [input.accountId, causes],
  );
  const n = input.encounterIndex;
  const coin: SettledCoin[] = [];
  let coinTransferred = 0;
  let coinLost: SettledEncounter["coinLost"] = null;
  const reputation: { pool: string; delta: number }[] = [];
  const ladder: { pool: string; pointsDelta: number; levelBefore: number; levelAfter: number }[] = [];
  const unlockPoints: { pool: string; points: number }[] = [];
  const deMerged: { typeId: string; displayName: string; fromLevel: number; toLevel: number }[] = [];
  const destroyed: { typeId: string; displayName: string; mergeLevel: number }[] = [];
  for (const e of res.rows) {
    const p = e.payload;
    const fromTrip = !own.includes(e.causation_id);
    switch (e.event_type) {
      case "reputation_changed":
        if (!fromTrip) reputation.push({ pool: str(p["pool"]), delta: num(p["delta"]) });
        break;
      case "ladder_progress_gained":
        if (!fromTrip) ladder.push({ pool: str(p["pool"]), pointsDelta: num(p["pointsDelta"]), levelBefore: num(p["levelBefore"]), levelAfter: num(p["levelAfter"]) });
        break;
      case "unlock_points_granted":
        if (!fromTrip) unlockPoints.push({ pool: str(p["pool"]), points: num(p["points"]) });
        break;
      case "coin_earned":
      case "coin_transferred_to_party_owner": {
        // A trip's bank credit names every survived encounter: keep only this one's (the delivery bonus belongs to the trip, not an encounter).
        if (fromTrip && !(str(p["reason"]) === "encounter_survived" && num(p["encounterIndex"]) === n)) break;
        coin.push({ reason: str(p["reason"]) || e.event_type, amount: num(p["amount"]), discarded: num(p["overflowDiscarded"]) });
        if (e.event_type === "coin_transferred_to_party_owner") coinTransferred += num(p["amount"]);
        break;
      }
      case "coin_lost_on_wipe":
        if (str(p["jobId"]) === input.jobId || num(p["encounterIndex"]) === n) coinLost = { amount: num(p["amount"]), transferred: num(p["transferred"]), destroyed: num(p["destroyed"]), recipientAuthored: p["recipientAuthored"] === true };
        break;
      case "unit_demerged_on_death":
        if (num(p["diedAtEncounter"]) === n) {
          const typeId = str(p["unitTypeId"]);
          deMerged.push({ typeId, displayName: unitName(typeId), fromLevel: num(p["fromLevel"]), toLevel: num(p["toLevel"]) });
        }
        break;
      case "unit_lost_on_wipe":
        if (num(p["encounterIndex"]) === n) {
          const typeId = str(p["unitTypeId"]);
          destroyed.push({ typeId, displayName: unitName(typeId), mergeLevel: num(p["mergeLevel"]) });
        }
        break;
      default:
        break;
    }
  }
  let trip: SettledEncounter["trip"] = null;
  if (input.viewer === "caravan") {
    const t = await db.query<{ ended_at: Date | null; end_reason: string | null; coin_accrued: number | null; banked: boolean }>(
      `SELECT t.ended_at, t.end_reason, te.coin_accrued,
              EXISTS (SELECT 1 FROM ledger_event WHERE causation_id = $3) AS banked
         FROM trip t LEFT JOIN trip_encounter te ON te.trip_id = t.id AND te.encounter_index = $2
        WHERE t.id = $1`,
      [input.tripId, n, `trip:${input.tripId}:bank`],
    );
    const r = t.rows[0];
    if (r) trip = { ended: r.ended_at !== null, endReason: r.end_reason, unbankedCoin: r.banked || r.ended_at !== null || r.coin_accrued === null ? null : r.coin_accrued };
  }
  const folded = await db.query<{ applied: boolean }>("SELECT EXISTS (SELECT 1 FROM trip_encounter WHERE job_id = $1) AS applied", [input.jobId]);
  const coinEarned = coin.reduce((n, c) => n + c.amount, 0);
  return { source: "ledger", applied: folded.rows[0]?.applied === true, coin, coinEarned, coinTransferred, coinLost, reputation, ladder, unlockPoints, deMerged, destroyed, trip };
}

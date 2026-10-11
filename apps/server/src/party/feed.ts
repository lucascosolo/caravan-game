/**
 * The results feed (chunk 09): where the owner's party was served, against whom, how deep
 * into the trip, how it did, and what it earned. The owner was never present — this feed
 * (and the replay, chunk 13) is the ONLY way they learn what their party did.
 *
 * Built from the ledger, nothing else: every `party_served_as_encounter` on the owner's
 * account (chunk 02's handler writes one per resolution, account-scoped, stamped with the
 * resolver version) joined with the other events the same resolution wrote on the owner
 * under the same causation id — `coin_earned` (chunk 16's party_win),
 * `coin_transferred_to_defender` (the unbanked Coin an overrun caravan lost, credited to
 * the party's owner — chunk 19), `reputation_changed` and `ladder_progress_gained` for the
 * siege pool (chunk 04's party side). The outcome payload is carried as chunk 13 writes it.
 * Newest first, cursor on seq.
 */
import type { Queryable } from "../db/pool.js";
import type { Json, LedgerEventRow } from "../ledger/events.js";

export interface PartyFeedEntry {
  seq: number;
  occurredAt: string;
  jobId: string | null;
  tripId: string | null;
  /** Which encounter of the defender's trip this was: how deep into the trail the party struck. */
  encounterIndex: number | null;
  defender: { accountId: string | null; username: string | null; caravanId: string | null; caravanName: string | null; regionId: string | null };
  /** The party version that fought (standing_party.updated_at at snapshot time). */
  partySavedAt: string | null;
  resolverVersion: number | null;
  /** Exactly as the resolution wrote it (chunk 13 defines the shape); `outcomeKind` is its `kind` when present. */
  outcome: Json | null;
  outcomeKind: string | null;
  /** Everything the resolution credited to the owner, summed. 0 when nothing was. */
  coinEarned: number;
  reputationDelta: number;
  ladderPointsGained: number;
}

export interface PartyFeedPage {
  entries: PartyFeedEntry[];
  /** Cursor for the next (older) page: pass as `before`. 0 when there is nothing older. */
  nextBefore: number;
  hasMore: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

export async function listPartyFeed(db: Queryable, accountId: string, opts: { before?: number; limit?: number } = {}): Promise<PartyFeedPage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before && opts.before > 0 ? opts.before : Number.MAX_SAFE_INTEGER;
  const page = await db.query<LedgerEventRow>(
    `SELECT * FROM ledger_event
     WHERE account_id = $1 AND event_type = 'party_served_as_encounter' AND seq < $2
     ORDER BY seq DESC LIMIT $3`,
    [accountId, before, limit + 1],
  );
  const hasMore = page.rows.length > limit;
  const served = hasMore ? page.rows.slice(0, limit) : page.rows;
  if (served.length === 0) return { entries: [], nextBefore: 0, hasMore: false };

  const causations = [...new Set(served.map((e) => e.causation_id))];
  const siblings = await db.query<LedgerEventRow>(
    `SELECT * FROM ledger_event WHERE account_id = $1 AND causation_id = ANY($2::text[]) ORDER BY seq`,
    [accountId, causations],
  );
  const byCause = new Map<string, LedgerEventRow[]>();
  for (const e of siblings.rows) {
    const list = byCause.get(e.causation_id) ?? [];
    list.push(e);
    byCause.set(e.causation_id, list);
  }

  const caravanIds = [...new Set(served.map((e) => str(e.payload["defenderCaravanId"])).filter((x): x is string => x !== null))];
  const caravans = caravanIds.length
    ? await db.query<{ id: string; name: string; region_id: string; account_id: string; username: string | null }>(
        `SELECT c.id, c.name, c.region_id, c.account_id, a.username
         FROM caravan c LEFT JOIN account a ON a.id = c.account_id
         WHERE c.id = ANY($1::uuid[])`,
        [caravanIds],
      )
    : { rows: [] };
  const caravanById = new Map(caravans.rows.map((c) => [c.id, c]));

  const entries = served.map((e): PartyFeedEntry => {
    const p = e.payload;
    const sibs = byCause.get(e.causation_id) ?? [];
    let coinEarned = 0;
    let reputationDelta = 0;
    let ladderPointsGained = 0;
    for (const s of sibs) {
      if (s.event_type === "coin_earned" || s.event_type === "coin_transferred_to_defender") coinEarned += int(s.payload["amount"]) ?? 0;
      else if (s.event_type === "reputation_changed" && s.payload["pool"] === "siege") reputationDelta += int(s.payload["delta"]) ?? 0;
      else if (s.event_type === "ladder_progress_gained" && s.payload["pool"] === "siege") ladderPointsGained += int(s.payload["pointsDelta"]) ?? 0;
    }
    const caravanId = str(p["defenderCaravanId"]);
    const c = caravanId ? caravanById.get(caravanId) : undefined;
    const outcome = p["outcome"] ?? null;
    const outcomeKind = outcome && typeof outcome === "object" && !Array.isArray(outcome) ? str((outcome as { [k: string]: Json })["kind"]) : null;
    return {
      seq: e.seq,
      occurredAt: e.occurred_at.toISOString(),
      jobId: str(p["jobId"]),
      tripId: str(p["tripId"]),
      encounterIndex: int(p["encounterIndex"]),
      defender: {
        accountId: str(p["defenderAccountId"]) ?? c?.account_id ?? null,
        username: c?.username ?? null,
        caravanId,
        caravanName: c?.name ?? null,
        regionId: c?.region_id ?? null,
      },
      partySavedAt: str(p["partySavedAt"]),
      resolverVersion: e.resolver_version,
      outcome,
      outcomeKind,
      coinEarned,
      reputationDelta,
      ladderPointsGained,
    };
  });
  return { entries, nextBefore: hasMore ? served.at(-1)!.seq : 0, hasMore };
}

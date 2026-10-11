/**
 * The results feed (chunk 09): where the owner's party was served, against whom, how deep
 * into the trip, how it did, and what it earned. The owner was never present — this feed
 * (and the replay, chunk 13) is the ONLY way they learn what their party did.
 *
 * Built from the ledger, nothing else: every `party_served_as_encounter` on the owner's
 * account (chunk 02's handler writes one per resolution, account-scoped, stamped with the
 * resolver version) joined with the other events the same resolution wrote on the owner
 * under the same causation id — `coin_earned` (chunk 16's party_win, paid on every overrun
 * by a player-owned party since chunk 19 QA D1),
 * `coin_transferred_to_party_owner` (the unbanked Coin an overrun caravan lost, credited to
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
  /**
   * Who the party struck: the username (a public handle) and the caravan. Never an account id
   * (chunk 19 QA S1, chunk 14 QA N4: account ids are not public).
   */
  defender: { username: string | null; caravanId: string | null; caravanName: string | null; regionId: string | null };
  /** The party version that fought (standing_party.updated_at at snapshot time). */
  partySavedAt: string | null;
  resolverVersion: number | null;
  /** Exactly as the resolution wrote it (chunk 13 defines the shape); `outcomeKind` is its `kind` when present. */
  outcome: Json | null;
  outcomeKind: string | null;
  /** Everything the resolution credited to the owner, summed (transfer + party win on an overrun; loot on a held fight). 0 when nothing was. */
  coinEarned: number;
  /** Of `coinEarned`: the overrun caravan's unbanked Coin transferred to the owner (chunk 19). */
  coinTransferred: number;
  /** Of `coinEarned`: the party-win credit (COIN_PER_PARTY_WIN, reason `party_win`; chunk 19 QA D1). */
  partyWinCoin: number;
  /** Of `coinEarned`: the depth-scaled loot of a HELD fight (reason `party_loot`; chunk 15 QA S4). Never paid with the two above. */
  lootCoin: number;
  /** What the owner's storage cap discarded from those credits (their `overflowDiscarded`, summed; chunk 19 QA S2). */
  coinDiscardedAtCap: number;
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
  const entries = await partyFeedEntries(db, accountId, served);
  return { entries, nextBefore: hasMore ? served.at(-1)!.seq : 0, hasMore };
}

/**
 * The feed's entries for already-read `party_served_as_encounter` rows of `accountId` (in the
 * order given). Exported for the inbox (chunk 29 QA S4): it picks its rows by time window in
 * one query and builds every line through this, so each line is exactly the feed's entry.
 * Two queries, however many rows.
 */
export async function partyFeedEntries(db: Queryable, accountId: string, served: readonly LedgerEventRow[]): Promise<PartyFeedEntry[]> {
  if (served.length === 0) return [];

  // A resolution's owner-side effects live under three causation ids: the job's own (what the
  // worker committed), `progression:<jobId>` (chunk 15's settle runs chunk 04's writer under
  // it) and `transfer:<jobId>` (chunk 19's overrun Coin transfer + party win, or chunk 15 QA
  // S4's loot for a held fight — never both: one batch per job). All three map back to the
  // served entry; nothing else is joined.
  const causeOf = new Map<string, string>();
  for (const e of served) {
    causeOf.set(e.causation_id, e.causation_id);
    causeOf.set(`progression:${e.causation_id}`, e.causation_id);
    causeOf.set(`transfer:${e.causation_id}`, e.causation_id);
  }
  const causations = [...causeOf.keys()];
  const siblings = await db.query<LedgerEventRow>(
    `SELECT * FROM ledger_event WHERE account_id = $1 AND causation_id = ANY($2::text[]) ORDER BY seq`,
    [accountId, causations],
  );
  const byCause = new Map<string, LedgerEventRow[]>();
  for (const e of siblings.rows) {
    const key = causeOf.get(e.causation_id)!;
    const list = byCause.get(key) ?? [];
    list.push(e);
    byCause.set(key, list);
  }

  const caravanIds = [...new Set(served.map((e) => str(e.payload["defenderCaravanId"])).filter((x): x is string => x !== null))];
  const caravans = caravanIds.length
    ? await db.query<{ id: string; name: string; region_id: string; username: string | null }>(
        `SELECT c.id, c.name, c.region_id, a.username
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
    let coinTransferred = 0;
    let partyWinCoin = 0;
    let lootCoin = 0;
    let coinDiscardedAtCap = 0;
    let reputationDelta = 0;
    let ladderPointsGained = 0;
    for (const s of sibs) {
      if (s.event_type === "coin_earned" || s.event_type === "coin_transferred_to_party_owner") {
        const amount = int(s.payload["amount"]) ?? 0;
        coinEarned += amount;
        coinDiscardedAtCap += int(s.payload["overflowDiscarded"]) ?? 0;
        if (s.event_type === "coin_transferred_to_party_owner") coinTransferred += amount;
        else if (s.payload["reason"] === "party_win") partyWinCoin += amount;
        else if (s.payload["reason"] === "party_loot") lootCoin += amount;
      }
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
      coinTransferred,
      partyWinCoin,
      lootCoin,
      coinDiscardedAtCap,
      reputationDelta,
      ladderPointsGained,
    };
  });
  return entries;
}

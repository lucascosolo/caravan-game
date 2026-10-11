/**
 * Row access for standing_party (migrations 001 + 006). The guarantees live in the
 * database triggers and in service.ts. There is deliberately no function here that
 * touches unit_instance: a party READS the roster and never writes it.
 */
import type { Queryable } from "../db/pool.js";
import type { StandingPartyRow } from "../db/types.js";

/** v1: every account has exactly one party, in slot 0 (TUNABLES.PARTIES_PER_ACCOUNT). */
export const PARTY_SLOT = 0;

export async function findStandingParty(db: Queryable, accountId: string, slot: number = PARTY_SLOT, forUpdate = false): Promise<StandingPartyRow | null> {
  const res = await db.query<StandingPartyRow>(
    `SELECT * FROM standing_party WHERE account_id = $1 AND slot = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [accountId, slot],
  );
  return res.rows[0] ?? null;
}

/** The only writer of `composition`. The trigger bumps updated_at iff the value changed. */
export async function updateStandingPartyComposition(db: Queryable, partyId: string, compositionJson: string): Promise<StandingPartyRow> {
  const res = await db.query<StandingPartyRow>(
    `UPDATE standing_party SET composition = $2::jsonb WHERE id = $1 RETURNING *`,
    [partyId, compositionJson],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`standing_party ${partyId} not found`);
  return row;
}

/** How many times this account has saved a party: the causation counter for the next save event. */
export async function countPartySaves(db: Queryable, accountId: string): Promise<number> {
  const res = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM ledger_event WHERE account_id = $1 AND event_type = 'standing_party_saved'",
    [accountId],
  );
  return Number(res.rows[0]!.n);
}

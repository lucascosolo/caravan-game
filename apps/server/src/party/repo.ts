/**
 * Row access for standing_party (migrations 001 + 008). The guarantees live in the
 * database triggers and in service.ts. There is deliberately no function here that
 * touches unit_instance: a party READS the roster and never writes it.
 */
import type { Queryable } from "../db/pool.js";
import type { StandingPartyRow } from "../db/types.js";

/** v1: every account has exactly one party, in slot 0 (TUNABLES.PARTIES_PER_ACCOUNT). */
export const PARTY_SLOT = 0;

/**
 * How the party row is read (chunk 09 QA N5):
 *   - "none"   a plain read (the owner's GET);
 *   - "share"  FOR SHARE — a snapshot in progress holds the row against an edit until it
 *              has also read the roster, so one snapshot never mixes an old config with a
 *              roster the edit was made against (and vice versa);
 *   - "update" FOR UPDATE — the edit path.
 */
export type PartyLock = "none" | "share" | "update";

const LOCK_SQL: Record<PartyLock, string> = { none: "", share: " FOR SHARE", update: " FOR UPDATE" };

export async function findStandingParty(db: Queryable, accountId: string, slot: number = PARTY_SLOT, lock: PartyLock = "none"): Promise<StandingPartyRow | null> {
  const res = await db.query<StandingPartyRow>(`SELECT * FROM standing_party WHERE account_id = $1 AND slot = $2${LOCK_SQL[lock]}`, [accountId, slot]);
  return res.rows[0] ?? null;
}

/**
 * The only writer of `composition`. The caller has already established that the value
 * differs from what is stored; `save_seq` advances by one with it (the trigger refuses any
 * other movement) and `updated_at` moves with the composition.
 */
export async function updateStandingPartyComposition(db: Queryable, partyId: string, compositionJson: string): Promise<StandingPartyRow> {
  const res = await db.query<StandingPartyRow>(`UPDATE standing_party SET composition = $2::jsonb, save_seq = save_seq + 1 WHERE id = $1 RETURNING *`, [partyId, compositionJson]);
  const row = res.rows[0];
  if (!row) throw new Error(`standing_party ${partyId} not found`);
  return row;
}

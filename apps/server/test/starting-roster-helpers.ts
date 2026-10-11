/**
 * Chunk 24 QA D1: every player caravan is granted TUNABLES.STARTING_ROSTER at creation. Tests
 * written before it that count "the roster this test built" leave the starting roster out
 * through these helpers; starting-roster.test.ts tests the grant itself.
 */
import type pg from "pg";
import { startingRosterCause } from "../src/acquisition/startingRoster.js";

/** The instance ids of a caravan's starting roster, read from its creation grant in the ledger. */
export async function startingRosterIds(db: pg.Pool | pg.PoolClient, caravanId: string): Promise<Set<string>> {
  const res = await db.query<{ id: string }>("SELECT payload ->> 'instanceId' AS id FROM ledger_event WHERE causation_id = $1 AND event_type = 'unit_acquired'", [startingRosterCause(caravanId)]);
  return new Set(res.rows.map((r) => r.id));
}

/** `rows` (a caravan's unit instances) minus its starting roster. */
export async function besidesStartingRoster<T extends { id: string }>(db: pg.Pool | pg.PoolClient, caravanId: string, rows: readonly T[]): Promise<T[]> {
  const start = await startingRosterIds(db, caravanId);
  return rows.filter((r) => !start.has(r.id));
}

/** Whether a ledger event is part of a caravan's starting-roster grant. */
export const isStartingRosterEvent = (e: { causation_id: string }): boolean => e.causation_id.startsWith("starting_roster:");

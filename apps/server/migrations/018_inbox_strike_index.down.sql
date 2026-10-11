DROP TRIGGER IF EXISTS inbox_read_guard_delete ON inbox_read;
DROP FUNCTION IF EXISTS inbox_read_guard_delete();
DROP INDEX IF EXISTS ledger_event_party_served_at_idx;

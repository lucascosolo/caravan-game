DROP FUNCTION IF EXISTS encounter_log_write(text, text, integer, uuid, uuid, uuid, integer, integer, text, bytea, integer, text, text, text, text, text);
DROP FUNCTION IF EXISTS encounter_log_prune(uuid);
DROP TRIGGER IF EXISTS encounter_log_guard_delete ON encounter_log;
DROP TRIGGER IF EXISTS encounter_log_guard_insert ON encounter_log;
DROP FUNCTION IF EXISTS encounter_log_guard_delete();
DROP FUNCTION IF EXISTS encounter_log_guard_insert();
DROP TABLE IF EXISTS encounter_log_retention;

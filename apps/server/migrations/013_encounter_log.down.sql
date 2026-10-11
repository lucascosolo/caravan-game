DROP TRIGGER IF EXISTS encounter_log_guard_truncate ON encounter_log;
DROP TRIGGER IF EXISTS encounter_log_guard_update ON encounter_log;
DROP TABLE IF EXISTS encounter_log;
DROP FUNCTION IF EXISTS encounter_log_guard_update();
DROP FUNCTION IF EXISTS encounter_log_guard_truncate();

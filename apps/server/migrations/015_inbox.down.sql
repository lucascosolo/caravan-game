DROP TABLE IF EXISTS inbox_preference;
DROP TRIGGER IF EXISTS inbox_read_forward_only ON inbox_read;
DROP TABLE IF EXISTS inbox_read;
DROP FUNCTION IF EXISTS inbox_read_forward_only();

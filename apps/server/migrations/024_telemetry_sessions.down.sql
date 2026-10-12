DELETE FROM analytics_client_event WHERE kind = 'heartbeat';
ALTER TABLE analytics_client_event DROP CONSTRAINT analytics_client_event_shape;
ALTER TABLE analytics_client_event ADD CONSTRAINT analytics_client_event_shape CHECK (
  (kind = 'screen' AND error_name IS NULL AND stack_hash IS NULL) OR
  (kind = 'crash' AND error_name IS NOT NULL AND stack_hash IS NOT NULL)
);
ALTER TABLE analytics_client_event DROP CONSTRAINT analytics_client_event_kind;
ALTER TABLE analytics_client_event ADD CONSTRAINT analytics_client_event_kind CHECK (kind IN ('screen', 'crash'));
DROP INDEX IF EXISTS analytics_client_event_batch_unique;
ALTER TABLE analytics_client_event
  DROP CONSTRAINT analytics_client_event_client_ids,
  DROP COLUMN client_idx,
  DROP COLUMN client_seq,
  DROP COLUMN client_session;

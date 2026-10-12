-- Chunk 32 QA fix round (D2): sessions from the server's own receipt times.
--
--   analytics_client_event.client_session / client_seq / client_idx
--       The client's per-page-load session id (a random int31, never stored client-side), the
--       batch's sequence number in it, and the event's index in the batch. A replayed POST
--       hits the unique index and stores nothing (ingest uses ON CONFLICT DO NOTHING). Rows
--       written before this migration carry NULLs (distinct under UNIQUE).
--   kind 'heartbeat'
--       Sent about once a minute while the page is visible, so a long stay on one screen reads
--       as the session it is. Same closed shape as a screen event.

ALTER TABLE analytics_client_event
  ADD COLUMN client_session bigint,
  ADD COLUMN client_seq     integer,
  ADD COLUMN client_idx     smallint,
  ADD CONSTRAINT analytics_client_event_client_ids CHECK (
    (client_session IS NULL AND client_seq IS NULL AND client_idx IS NULL) OR
    (client_session BETWEEN 1 AND 2147483647 AND client_seq >= 0 AND client_idx BETWEEN 0 AND 100)
  );
CREATE UNIQUE INDEX analytics_client_event_batch_unique ON analytics_client_event (analytics_id, client_session, client_seq, client_idx);

ALTER TABLE analytics_client_event DROP CONSTRAINT analytics_client_event_kind;
ALTER TABLE analytics_client_event ADD CONSTRAINT analytics_client_event_kind CHECK (kind IN ('screen', 'heartbeat', 'crash'));
ALTER TABLE analytics_client_event DROP CONSTRAINT analytics_client_event_shape;
ALTER TABLE analytics_client_event ADD CONSTRAINT analytics_client_event_shape CHECK (
  (kind IN ('screen', 'heartbeat') AND error_name IS NULL AND stack_hash IS NULL) OR
  (kind = 'crash' AND error_name IS NOT NULL AND stack_hash IS NOT NULL)
);

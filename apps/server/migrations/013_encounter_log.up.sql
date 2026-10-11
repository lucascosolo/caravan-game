-- Chunk 13: the stored replay of every resolved encounter.
--
--   encounter_log   One row per COMPLETED encounter-resolution job: the resolver's tick log
--                   (packages/resolver/src/replay.ts LOG_FORMAT), gzip-compressed, written in
--                   the SAME transaction as the job's completion and its ledger events. The
--                   log IS the replay — nothing is ever re-simulated for playback — so the row
--                   also names everything needed to check it against its inputs: the resolver
--                   version that produced it, the log format, and sha256s of the snapshots in
--                   the job's (immutable) input — formation, survivors, party — and of the
--                   content + tunables the adapter resolved them with (S3). The snapshots
--                   themselves live in resolution_job.input, which never changes, so a party
--                   owner editing their party afterwards cannot alter what a replay shows.
--
-- Immutable: rows are inserted once and never updated (trigger). Deletion is the retention
-- prune only (LOG_RETENTION: 30 days or the caravan's newest 50, whichever keeps more) — a
-- missing log is reported as "expired", never re-created. Caravan-level (GUARDRAILS §5):
-- keyed by job, carrying the caravan; both participants' accounts are recorded so the
-- replay route can answer each of them (the caravan's player and the party's owner).

CREATE TABLE encounter_log (
  job_id                  text        PRIMARY KEY REFERENCES resolution_job (id) ON DELETE CASCADE,
  caravan_id              uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  defender_account_id     uuid        NOT NULL,
  party_owner_account_id  uuid        NOT NULL,
  resolver_version        integer     NOT NULL,
  log_format              integer     NOT NULL,
  encoding                text        NOT NULL,
  log                     bytea       NOT NULL,
  -- Bytes of the uncompressed JSON and of the stored (compressed) form.
  raw_bytes               integer     NOT NULL,
  stored_bytes            integer     NOT NULL,
  -- sha256 (hex) of the uncompressed JSON log, and of the input snapshots it was resolved from.
  log_sha256              text        NOT NULL,
  formation_sha256        text        NOT NULL,
  survivors_sha256        text        NOT NULL,
  party_sha256            text        NOT NULL,
  content_hash            text        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounter_log_encoding_known CHECK (encoding IN ('gzip')),
  CONSTRAINT encounter_log_sizes CHECK (raw_bytes > 0 AND stored_bytes > 0 AND stored_bytes = octet_length(log)),
  CONSTRAINT encounter_log_versions CHECK (resolver_version >= 0 AND log_format >= 1)
);

CREATE INDEX encounter_log_caravan_recent ON encounter_log (caravan_id, created_at DESC, job_id DESC);
CREATE INDEX encounter_log_party_owner ON encounter_log (party_owner_account_id);

CREATE OR REPLACE FUNCTION encounter_log_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'encounter_log % is immutable: a replay is never rewritten', OLD.job_id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER encounter_log_guard_update BEFORE UPDATE ON encounter_log
  FOR EACH ROW EXECUTE FUNCTION encounter_log_guard_update();

-- No bulk wipe: retention deletes row by row (replay/store.ts pruneEncounterLogs).
CREATE OR REPLACE FUNCTION encounter_log_guard_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'encounter_log cannot be truncated: replays leave only through the retention prune' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER encounter_log_guard_truncate BEFORE TRUNCATE ON encounter_log
  FOR EACH STATEMENT EXECUTE FUNCTION encounter_log_guard_truncate();

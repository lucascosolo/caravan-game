-- Chunk 14: matchmaking & scouting — who attacks the caravan at each encounter.
--
--   account.is_system   PHASE-2 §25 seam: authored cold-start parties are owned by system
--                       accounts flagged non-player. Their parties are ORDINARY
--                       standing_party rows; nothing downstream of selection may read this
--                       flag (the resolver cannot tell, chunk 19 destroys rather than
--                       banks Coin lost to one). It exists so matchmaking can cap the
--                       authored share of a band (AUTHORED_PARTY_MAX_SHARE_BP).
--   trip                The minimal trip row chunk 15 will own: one per locked manifest, at
--                       most one open per caravan. CARAVAN-level (GUARDRAILS §5). Chunk 15
--                       adds state transitions and the trip cap; the seam is
--                       matchmaking/trips.ts (createTrip / endTrip).
--   encounter_candidates
--                       One row per SEARCH for one encounter of a trip, numbered by
--                       search_seq (1, 2, 3 …; a reroll is the next row). Carries the seed,
--                       the band centre, the exact eligible pool and the exclusions the draw
--                       ran over, and the CANDIDATES_PER_SEARCH candidates each with the
--                       party snapshot the player scouted — so any menu ever offered is
--                       replayable from stored state alone (GUARDRAILS §1). Choosing a
--                       candidate fills chosen_candidate_id / chosen_at on the menu it came
--                       from; at most one search per encounter may be chosen, the chosen
--                       row is frozen, and its snapshot is what the resolution job gets
--                       (byte-identical: what was scouted is what is fought, §4).
--
-- The wall clock enters only as searched_at_ms, which the reroll gate compares against; it
-- never touches what was offered. There is no Coin column anywhere here: the reroll is
-- free and time-gated by design (GUARDRAILS §2).

ALTER TABLE account ADD COLUMN is_system boolean NOT NULL DEFAULT false;

-- Chunk 14 QA S2: the pool scan is bounded in SQL to parties whose owner's siege
-- Reputation lies within ±REPUTATION_BAND_WIDTH_MAX of the band centre (plus every
-- authored party, the outside-band fallback); this index serves that range predicate.
CREATE INDEX pool_progress_pool_reputation_idx ON pool_progress (pool, reputation);

-- ---------------------------------------------------------------------------------
CREATE TABLE trip (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  caravan_id  uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  -- The trip-locked loadout (chunk 07). One trip per manifest.
  manifest_id uuid        NOT NULL REFERENCES wagon_manifest (id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when the trip ends (bank / overrun / stalemate-then-bank; chunk 15 decides).
  ended_at    timestamptz,
  CONSTRAINT trip_one_per_manifest UNIQUE (manifest_id)
);
CREATE INDEX trip_caravan_idx ON trip (caravan_id);
-- A caravan is on at most one trip.
CREATE UNIQUE INDEX trip_one_open_per_caravan ON trip (caravan_id) WHERE ended_at IS NULL;

CREATE FUNCTION trip_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.caravan_id <> OLD.caravan_id OR NEW.manifest_id <> OLD.manifest_id OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'trip identity is immutable (trip %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'trip % has ended and is frozen', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_guard_update BEFORE UPDATE ON trip FOR EACH ROW EXECUTE FUNCTION trip_guard_update();

-- A trip is history: it leaves only with its caravan (cascade).
CREATE FUNCTION trip_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM caravan WHERE id = OLD.caravan_id) THEN
    RAISE EXCEPTION 'trip % is history and may not be deleted while its caravan exists', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_guard_delete BEFORE DELETE ON trip FOR EACH ROW EXECUTE FUNCTION trip_guard_delete();
CREATE TRIGGER trip_guard_truncate BEFORE TRUNCATE ON trip FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- ---------------------------------------------------------------------------------
CREATE TABLE encounter_candidates (
  trip_id             uuid        NOT NULL REFERENCES trip (id) ON DELETE CASCADE,
  -- 1-based, the same index wagon_formation uses.
  encounter_index     integer     NOT NULL,
  -- 1, 2, 3 … per (trip, encounter). The current menu is the highest.
  search_seq          integer     NOT NULL,
  -- fnv1a32(`<caravan id>:<trip id>:<encounter index>:<search seq>`). Replay input.
  seed                bigint      NOT NULL,
  -- The caravan's living Reputation at search time, and the escalated band centre.
  caravan_rating      integer     NOT NULL,
  centre              integer     NOT NULL,
  -- The half-width the successful pass used (REPUTATION_BAND_WIDTH … _MAX).
  band_width_used     integer     NOT NULL,
  -- The parties the draw ran over, after exclusions: [{partyId, ownerAccountId, rating, authored}], sorted by party id. Replay input.
  pool                jsonb       NOT NULL,
  -- Party ids excluded (self, linked, recent) and party ids skipped because they no longer resolved. Replay input.
  excluded_party_ids  jsonb       NOT NULL,
  skipped_party_ids   jsonb       NOT NULL,
  -- Exactly CANDIDATES_PER_SEARCH candidates, each with the frozen party snapshot and its scout view. Replay output.
  candidates          jsonb       NOT NULL,
  searched_at_ms      bigint      NOT NULL,
  chosen_candidate_id text,
  chosen_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, encounter_index, search_seq),
  CONSTRAINT encounter_candidates_index_positive CHECK (encounter_index >= 1),
  CONSTRAINT encounter_candidates_seq_positive   CHECK (search_seq >= 1),
  CONSTRAINT encounter_candidates_seed_nonneg    CHECK (seed >= 0),
  CONSTRAINT encounter_candidates_width_positive CHECK (band_width_used > 0),
  CONSTRAINT encounter_candidates_pool_is_array  CHECK (jsonb_typeof(pool) = 'array'),
  CONSTRAINT encounter_candidates_excl_is_array  CHECK (jsonb_typeof(excluded_party_ids) = 'array'),
  CONSTRAINT encounter_candidates_skip_is_array  CHECK (jsonb_typeof(skipped_party_ids) = 'array'),
  CONSTRAINT encounter_candidates_cands_is_array CHECK (jsonb_typeof(candidates) = 'array'),
  CONSTRAINT encounter_candidates_searched_nonneg CHECK (searched_at_ms >= 0),
  -- Chosen: both columns or neither, and the id must name one of THIS menu's candidates.
  CONSTRAINT encounter_candidates_chosen_both CHECK ((chosen_candidate_id IS NULL) = (chosen_at IS NULL)),
  CONSTRAINT encounter_candidates_chosen_was_offered CHECK (
    chosen_candidate_id IS NULL OR candidates @> jsonb_build_array(jsonb_build_object('candidateId', chosen_candidate_id))
  )
);
-- One commitment per encounter.
CREATE UNIQUE INDEX encounter_candidates_one_chosen ON encounter_candidates (trip_id, encounter_index) WHERE chosen_at IS NOT NULL;

-- A menu is born unchosen; choosing is a separate step.
CREATE FUNCTION encounter_candidates_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.chosen_candidate_id IS NOT NULL OR NEW.chosen_at IS NOT NULL THEN
    RAISE EXCEPTION 'encounter_candidates rows are inserted unchosen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER encounter_candidates_guard_insert
  BEFORE INSERT ON encounter_candidates FOR EACH ROW EXECUTE FUNCTION encounter_candidates_guard_insert();

-- What was offered never changes (the replay input); the only legal update is choosing, once.
CREATE FUNCTION encounter_candidates_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.trip_id <> OLD.trip_id OR NEW.encounter_index <> OLD.encounter_index OR NEW.search_seq <> OLD.search_seq
     OR NEW.seed <> OLD.seed OR NEW.caravan_rating <> OLD.caravan_rating OR NEW.centre <> OLD.centre
     OR NEW.band_width_used <> OLD.band_width_used OR NEW.pool <> OLD.pool
     OR NEW.excluded_party_ids <> OLD.excluded_party_ids OR NEW.skipped_party_ids <> OLD.skipped_party_ids
     OR NEW.candidates <> OLD.candidates OR NEW.searched_at_ms <> OLD.searched_at_ms OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %, search %) is a stored menu and is immutable', OLD.trip_id, OLD.encounter_index, OLD.search_seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.chosen_at IS NOT NULL AND (NEW.chosen_at IS DISTINCT FROM OLD.chosen_at OR NEW.chosen_candidate_id IS DISTINCT FROM OLD.chosen_candidate_id) THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %): the chosen candidate is frozen', OLD.trip_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER encounter_candidates_guard_update
  BEFORE UPDATE ON encounter_candidates FOR EACH ROW EXECUTE FUNCTION encounter_candidates_guard_update();

CREATE FUNCTION encounter_candidates_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trip WHERE id = OLD.trip_id) THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %, search %) is history and may not be deleted while its trip exists', OLD.trip_id, OLD.encounter_index, OLD.search_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER encounter_candidates_guard_delete
  BEFORE DELETE ON encounter_candidates FOR EACH ROW EXECUTE FUNCTION encounter_candidates_guard_delete();
CREATE TRIGGER encounter_candidates_guard_truncate
  BEFORE TRUNCATE ON encounter_candidates FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

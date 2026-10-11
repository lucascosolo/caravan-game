-- Chunk 07: the wagon circle's two lifetimes, persisted.
--
--   wagon_manifest   what the caravan PACKED for a trip. `packed` is immutable from insert;
--                    `survivors` is the same shape and only ever moves DOWNWARD (hp down,
--                    spent trap stays spent, destroyed segment stays destroyed) — the
--                    trigger below refuses any other change, so nothing can resupply,
--                    repair or heal mid-trip, however it connects. One open manifest per
--                    caravan at a time.
--   wagon_formation  how the circle is ARRANGED for one encounter of that manifest. A draft
--                    may be re-saved freely; once committed_at is set the row is frozen —
--                    the stored `formation` is the canonical snapshot the resolver gets.
--
-- Both are CARAVAN-level (GUARDRAILS §5): keyed by caravan, no account column. There is
-- deliberately no persistent "layout" outside a manifest: a formation exists only for an
-- encounter of a trip (GUARDRAILS §0 — the town is never attacked and has no defences).
--
-- Chunk 15 adds the trip row; the manifest is the trip-locked loadout it will reference.
-- Until then `wagon_manifest` is the trip's only persistent identity.

CREATE TABLE wagon_manifest (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  caravan_id          uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  -- The loadout as packed in town: @caravan/circle Manifest, canonical JSON. IMMUTABLE.
  packed              jsonb       NOT NULL,
  -- The loadout as it survives so far: same shape, same refs, monotone attrition only.
  survivors           jsonb       NOT NULL,
  -- Encounters whose outcome has been folded into `survivors`. Never decreases.
  encounters_resolved integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Set when the trip ends (bank or overrun, chunk 15). A closed manifest is frozen.
  closed_at           timestamptz,
  CONSTRAINT wagon_manifest_packed_is_object    CHECK (jsonb_typeof(packed) = 'object'),
  CONSTRAINT wagon_manifest_survivors_is_object CHECK (jsonb_typeof(survivors) = 'object'),
  CONSTRAINT wagon_manifest_encounters_nonneg   CHECK (encounters_resolved >= 0)
);
CREATE INDEX wagon_manifest_caravan_idx ON wagon_manifest (caravan_id);
-- One open manifest per caravan: a caravan is on at most one trip.
CREATE UNIQUE INDEX wagon_manifest_one_open_per_caravan ON wagon_manifest (caravan_id) WHERE closed_at IS NULL;

-- At insert, nothing has happened yet: survivors == packed.
CREATE FUNCTION wagon_manifest_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.survivors <> NEW.packed THEN
    RAISE EXCEPTION 'wagon_manifest.survivors must equal packed at insert (nothing has happened yet)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.encounters_resolved <> 0 THEN
    RAISE EXCEPTION 'wagon_manifest.encounters_resolved starts at 0' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER wagon_manifest_guard_insert
  BEFORE INSERT ON wagon_manifest FOR EACH ROW EXECUTE FUNCTION wagon_manifest_guard_insert();

-- The lock: packed is immutable; survivors may only lose; a closed manifest is frozen.
CREATE FUNCTION wagon_manifest_guard_update() RETURNS trigger AS $$
DECLARE
  n jsonb;
  o jsonb;
  kind text;
BEGIN
  IF NEW.packed <> OLD.packed THEN
    RAISE EXCEPTION 'wagon_manifest.packed is locked for the whole trip (manifest %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.caravan_id <> OLD.caravan_id OR NEW.created_at <> OLD.created_at OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'wagon_manifest identity is immutable (manifest %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    IF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.survivors <> OLD.survivors
       OR NEW.encounters_resolved <> OLD.encounters_resolved THEN
      RAISE EXCEPTION 'wagon_manifest % is closed and frozen', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.encounters_resolved < OLD.encounters_resolved THEN
    RAISE EXCEPTION 'wagon_manifest.encounters_resolved never decreases (% -> %)', OLD.encounters_resolved, NEW.encounters_resolved
      USING ERRCODE = 'check_violation';
  END IF;
  -- QA N5: outcomes are folded in one encounter at a time; the counter cannot jump.
  IF NEW.encounters_resolved > OLD.encounters_resolved + 1 THEN
    RAISE EXCEPTION 'wagon_manifest.encounters_resolved advances by exactly one per outcome (% -> %)', OLD.encounters_resolved, NEW.encounters_resolved
      USING ERRCODE = 'check_violation';
  END IF;

  -- QA S6: the document's shape is frozen. Everything outside the three entry arrays (the
  -- version `v` and any other top-level key) must be byte-for-byte what it was.
  IF (NEW.survivors - 'units' - 'traps' - 'fences') <> (OLD.survivors - 'units' - 'traps' - 'fences') THEN
    RAISE EXCEPTION 'wagon_manifest.survivors: top-level keys other than units/traps/fences are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  -- survivors: the same set of refs as before (nothing added, nothing removed), each entry's
  -- identity and key set unchanged, every state field well-typed and moving only downward.
  FOREACH kind IN ARRAY ARRAY['units', 'traps', 'fences'] LOOP
    IF jsonb_typeof(NEW.survivors -> kind) <> 'array' OR jsonb_typeof(OLD.survivors -> kind) <> 'array' THEN
      RAISE EXCEPTION 'wagon_manifest.survivors.% must be an array', kind USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_array_length(NEW.survivors -> kind) <> jsonb_array_length(OLD.survivors -> kind) THEN
      RAISE EXCEPTION 'wagon_manifest.survivors.%: entries cannot be added or removed mid-trip', kind
        USING ERRCODE = 'check_violation';
    END IF;
    -- QA S6: refs are distinct (a duplicated entry could otherwise stand in for a removed one).
    IF (SELECT count(DISTINCT e ->> 'ref') FROM jsonb_array_elements(NEW.survivors -> kind) e) <> jsonb_array_length(NEW.survivors -> kind) THEN
      RAISE EXCEPTION 'wagon_manifest.survivors.%: refs must be distinct', kind USING ERRCODE = 'check_violation';
    END IF;
    FOR n IN SELECT e FROM jsonb_array_elements(NEW.survivors -> kind) e LOOP
      IF jsonb_typeof(n) <> 'object' THEN
        RAISE EXCEPTION 'wagon_manifest.survivors.%: entries must be objects', kind USING ERRCODE = 'check_violation';
      END IF;
      SELECT e INTO o FROM jsonb_array_elements(OLD.survivors -> kind) e WHERE e ->> 'ref' = n ->> 'ref';
      IF o IS NULL THEN
        RAISE EXCEPTION 'wagon_manifest.survivors.%: ref % was not packed', kind, n ->> 'ref'
          USING ERRCODE = 'check_violation';
      END IF;
      -- QA S6: the entry's key set is immutable — no key added (a `heal` field), none removed (`hp`).
      IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(n) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o) k) THEN
        RAISE EXCEPTION 'wagon_manifest.survivors.%: entry % keys are immutable', kind, n ->> 'ref' USING ERRCODE = 'check_violation';
      END IF;
      IF kind = 'units' OR kind = 'fences' THEN
        -- QA S6: hp is a non-negative integer no greater than maxHp (null, a fraction, a string,
        -- a negative or an overflow is refused here, not just by the service).
        IF jsonb_typeof(n -> 'hp') <> 'number' OR (n ->> 'hp')::numeric <> trunc((n ->> 'hp')::numeric)
           OR (n ->> 'hp')::numeric < 0 OR (n ->> 'hp')::numeric > (n ->> 'maxHp')::numeric THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.%: entry % hp must be an integer in 0..maxHp, got %', kind, n ->> 'ref', n -> 'hp'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF kind = 'units' THEN
        IF n ->> 'typeId' IS DISTINCT FROM o ->> 'typeId' OR n ->> 'mergeLevel' IS DISTINCT FROM o ->> 'mergeLevel'
           OR n ->> 'maxHp' IS DISTINCT FROM o ->> 'maxHp' THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.units: unit % identity is immutable', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
        IF (n ->> 'hp')::numeric > (o ->> 'hp')::numeric THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.units: unit % hp may not rise (% -> %); there is no healing mid-trip',
            n ->> 'ref', o ->> 'hp', n ->> 'hp' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF kind = 'traps' THEN
        IF n ->> 'typeId' IS DISTINCT FROM o ->> 'typeId' THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.traps: trap % identity is immutable', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
        IF jsonb_typeof(n -> 'spent') <> 'boolean' THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.traps: trap % spent must be a boolean', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
        IF (o ->> 'spent')::boolean AND NOT (n ->> 'spent')::boolean THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.traps: trap % does not re-arm mid-trip', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF n ->> 'tierId' IS DISTINCT FROM o ->> 'tierId' OR n ->> 'maxHp' IS DISTINCT FROM o ->> 'maxHp' THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.fences: segment % identity is immutable', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
        IF (n ->> 'hp')::numeric > (o ->> 'hp')::numeric THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.fences: segment % hp may not rise (% -> %); there is no repair mid-trip',
            n ->> 'ref', o ->> 'hp', n ->> 'hp' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER wagon_manifest_guard_update
  BEFORE UPDATE ON wagon_manifest FOR EACH ROW EXECUTE FUNCTION wagon_manifest_guard_update();

-- A manifest is trip history: it may only vanish with its caravan (cascade).
CREATE FUNCTION wagon_manifest_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM caravan WHERE id = OLD.caravan_id) THEN
    RAISE EXCEPTION 'wagon_manifest % is trip history and may not be deleted while its caravan exists', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER wagon_manifest_guard_delete
  BEFORE DELETE ON wagon_manifest FOR EACH ROW EXECUTE FUNCTION wagon_manifest_guard_delete();
CREATE TRIGGER wagon_manifest_guard_truncate
  BEFORE TRUNCATE ON wagon_manifest FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- ---------------------------------------------------------------------------------
CREATE TABLE wagon_formation (
  manifest_id     uuid        NOT NULL REFERENCES wagon_manifest (id) ON DELETE CASCADE,
  -- 1-based: the encounter this arrangement is for. Only encounters_resolved + 1 may be
  -- drafted or committed (service-enforced); earlier ones are history.
  encounter_index integer     NOT NULL,
  -- @caravan/circle Formation in canonical form (serializeFormation), validated against
  -- `survivors` at save time and again at commit.
  formation       jsonb       NOT NULL,
  -- sha256 of the canonical serialization; what byte-compares across stores and replays.
  formation_hash  text        NOT NULL,
  -- QA S7: the manifest's `survivors` EXACTLY as they stood when this formation was
  -- committed — the HP, spent flags and segment states the resolver fought with. Together
  -- with `formation` this makes the resolver's input for the encounter byte-reproducible
  -- after later encounters have moved `survivors` on. NULL on a draft, set at commit,
  -- frozen with the row.
  survivors_snapshot jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  committed_at    timestamptz,
  PRIMARY KEY (manifest_id, encounter_index),
  CONSTRAINT wagon_formation_index_positive     CHECK (encounter_index >= 1),
  CONSTRAINT wagon_formation_is_object          CHECK (jsonb_typeof(formation) = 'object'),
  CONSTRAINT wagon_formation_hash_shape         CHECK (formation_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wagon_formation_snapshot_is_object CHECK (survivors_snapshot IS NULL OR jsonb_typeof(survivors_snapshot) = 'object'),
  -- A snapshot exists exactly when the row is committed.
  CONSTRAINT wagon_formation_snapshot_iff_committed CHECK ((committed_at IS NULL) = (survivors_snapshot IS NULL))
);

-- QA N5: a formation is born a draft. Committing is a separate step the update guard
-- checks against the manifest; a row cannot be inserted already committed (or with a
-- snapshot, which the CHECK above ties to committed_at).
CREATE FUNCTION wagon_formation_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.committed_at IS NOT NULL OR NEW.survivors_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'wagon_formation rows are inserted as drafts (committed_at and survivors_snapshot must be NULL)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER wagon_formation_guard_insert
  BEFORE INSERT ON wagon_formation FOR EACH ROW EXECUTE FUNCTION wagon_formation_guard_insert();

-- Drafts are free to change; a committed formation is what was resolved and never changes.
-- Committing requires the snapshot to equal the manifest's current survivors and the
-- encounter to be the next unresolved one of an open manifest.
CREATE FUNCTION wagon_formation_guard_update() RETURNS trigger AS $$
DECLARE
  m wagon_manifest%ROWTYPE;
BEGIN
  IF NEW.manifest_id <> OLD.manifest_id OR NEW.encounter_index <> OLD.encounter_index THEN
    RAISE EXCEPTION 'wagon_formation identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.committed_at IS NOT NULL THEN
    IF NEW.formation <> OLD.formation OR NEW.formation_hash <> OLD.formation_hash
       OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
       OR NEW.survivors_snapshot IS DISTINCT FROM OLD.survivors_snapshot THEN
      RAISE EXCEPTION 'wagon_formation for manifest % encounter % is committed and frozen', OLD.manifest_id, OLD.encounter_index
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.committed_at IS NOT NULL THEN
    -- QA S7: the commit step. The snapshot must be the manifest's survivors as of now.
    SELECT * INTO m FROM wagon_manifest WHERE id = NEW.manifest_id;
    IF m.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'wagon_formation cannot be committed: manifest % is closed', NEW.manifest_id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.encounter_index <> m.encounters_resolved + 1 THEN
      RAISE EXCEPTION 'wagon_formation cannot be committed: encounter % is not the next unresolved one (% resolved)', NEW.encounter_index, m.encounters_resolved
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.survivors_snapshot IS NULL OR NEW.survivors_snapshot <> m.survivors THEN
      RAISE EXCEPTION 'wagon_formation cannot be committed: survivors_snapshot must equal the manifest''s current survivors'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER wagon_formation_guard_update
  BEFORE UPDATE ON wagon_formation FOR EACH ROW EXECUTE FUNCTION wagon_formation_guard_update();

CREATE FUNCTION wagon_formation_guard_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.committed_at IS NOT NULL AND EXISTS (SELECT 1 FROM wagon_manifest WHERE id = OLD.manifest_id) THEN
    RAISE EXCEPTION 'committed wagon_formation (manifest %, encounter %) is history and may not be deleted', OLD.manifest_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER wagon_formation_guard_delete
  BEFORE DELETE ON wagon_formation FOR EACH ROW EXECUTE FUNCTION wagon_formation_guard_delete();
CREATE TRIGGER wagon_formation_guard_truncate
  BEFORE TRUNCATE ON wagon_formation FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

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

  -- survivors: the same set of refs as before (nothing added, nothing removed), each entry's
  -- identity unchanged, and every state field moving only downward.
  FOREACH kind IN ARRAY ARRAY['units', 'traps', 'fences'] LOOP
    IF jsonb_typeof(NEW.survivors -> kind) <> 'array' OR jsonb_typeof(OLD.survivors -> kind) <> 'array' THEN
      RAISE EXCEPTION 'wagon_manifest.survivors.% must be an array', kind USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_array_length(NEW.survivors -> kind) <> jsonb_array_length(OLD.survivors -> kind) THEN
      RAISE EXCEPTION 'wagon_manifest.survivors.%: entries cannot be added or removed mid-trip', kind
        USING ERRCODE = 'check_violation';
    END IF;
    FOR n IN SELECT e FROM jsonb_array_elements(NEW.survivors -> kind) e LOOP
      SELECT e INTO o FROM jsonb_array_elements(OLD.survivors -> kind) e WHERE e ->> 'ref' = n ->> 'ref';
      IF o IS NULL THEN
        RAISE EXCEPTION 'wagon_manifest.survivors.%: ref % was not packed', kind, n ->> 'ref'
          USING ERRCODE = 'check_violation';
      END IF;
      IF kind = 'units' THEN
        IF n ->> 'typeId' IS DISTINCT FROM o ->> 'typeId' OR n ->> 'mergeLevel' IS DISTINCT FROM o ->> 'mergeLevel'
           OR n ->> 'maxHp' IS DISTINCT FROM o ->> 'maxHp' THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.units: unit % identity is immutable', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
        IF (n ->> 'hp')::integer > (o ->> 'hp')::integer THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.units: unit % hp may not rise (% -> %); there is no healing mid-trip',
            n ->> 'ref', o ->> 'hp', n ->> 'hp' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF kind = 'traps' THEN
        IF n ->> 'typeId' IS DISTINCT FROM o ->> 'typeId' THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.traps: trap % identity is immutable', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
        IF (o ->> 'spent')::boolean AND NOT (n ->> 'spent')::boolean THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.traps: trap % does not re-arm mid-trip', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF n ->> 'tierId' IS DISTINCT FROM o ->> 'tierId' OR n ->> 'maxHp' IS DISTINCT FROM o ->> 'maxHp' THEN
          RAISE EXCEPTION 'wagon_manifest.survivors.fences: segment % identity is immutable', n ->> 'ref' USING ERRCODE = 'check_violation';
        END IF;
        IF (n ->> 'hp')::integer > (o ->> 'hp')::integer THEN
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
  updated_at      timestamptz NOT NULL DEFAULT now(),
  committed_at    timestamptz,
  PRIMARY KEY (manifest_id, encounter_index),
  CONSTRAINT wagon_formation_index_positive     CHECK (encounter_index >= 1),
  CONSTRAINT wagon_formation_is_object          CHECK (jsonb_typeof(formation) = 'object'),
  CONSTRAINT wagon_formation_hash_shape         CHECK (formation_hash ~ '^[0-9a-f]{64}$')
);

-- Drafts are free to change; a committed formation is what was resolved and never changes.
CREATE FUNCTION wagon_formation_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.manifest_id <> OLD.manifest_id OR NEW.encounter_index <> OLD.encounter_index THEN
    RAISE EXCEPTION 'wagon_formation identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.committed_at IS NOT NULL THEN
    IF NEW.formation <> OLD.formation OR NEW.formation_hash <> OLD.formation_hash
       OR NEW.committed_at IS DISTINCT FROM OLD.committed_at THEN
      RAISE EXCEPTION 'wagon_formation for manifest % encounter % is committed and frozen', OLD.manifest_id, OLD.encounter_index
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

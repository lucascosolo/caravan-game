-- Chunk 51: the caravan's saved wagon-circle layout. Slot 0 is the last committed formation,
-- normalised so its encounter's main attack edge is north (@caravan/circle layout.ts). Keyed by
-- caravan (GUARDRAILS §5: the layout names living-unit instances). Slots 1–3 (named layouts) are
-- a follow-up; the CHECK widens then.
CREATE TABLE caravan_layout (
  caravan_id          uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  slot                smallint    NOT NULL CHECK (slot = 0),
  layout              jsonb       NOT NULL,
  battlefield_version integer     NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caravan_id, slot)
);

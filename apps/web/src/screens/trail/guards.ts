/**
 * Shape guards at the client boundary (chunk 06 QA convention): every server payload the
 * formation screen reads is checked here, next to the calls that fetch it, and a bad
 * shape becomes `ApiError(0, "bad_payload")` for the ErrorBox + Retry — never a thrown
 * TypeError from `data.x.find`. The chunk 07 parsers in @caravan/circle are strict (unknown
 * keys, floats and off-lattice cells are refused), so they are the guard for the two
 * structures they know; the view wrappers are checked by hand.
 */
import { formationFromJson, manifestFromJson, type Formation, type Manifest } from "@caravan/circle";
import { ApiError } from "../../api/client.ts";
import type { FormationView, ManifestView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";

export class BadPayload extends ApiError {
  constructor(detail: string) {
    super(0, "bad_payload", `${STRINGS.app.badPayload} (${detail})`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface TripState {
  readonly view: ManifestView;
  readonly packed: Manifest;
  readonly survivors: Manifest;
}

export function guardManifest(raw: unknown): TripState {
  if (!isObject(raw) || !isObject(raw["manifest"])) throw new BadPayload("manifest");
  const m = raw["manifest"];
  if (typeof m["id"] !== "string" || typeof m["caravanId"] !== "string") throw new BadPayload("manifest.id");
  if (!Number.isInteger(m["encountersResolved"]) || (m["encountersResolved"] as number) < 0) throw new BadPayload("manifest.encountersResolved");
  if (!(m["closedAt"] === null || typeof m["closedAt"] === "string")) throw new BadPayload("manifest.closedAt");
  if (!Array.isArray(m["formations"])) throw new BadPayload("manifest.formations");
  for (const f of m["formations"] as unknown[]) {
    if (!isObject(f) || !Number.isInteger(f["encounterIndex"]) || !(f["committedAt"] === null || typeof f["committedAt"] === "string")) throw new BadPayload("manifest.formations[]");
  }
  let packed: Manifest;
  let survivors: Manifest;
  try {
    packed = manifestFromJson(m["packed"]);
    survivors = manifestFromJson(m["survivors"]);
  } catch (err) {
    throw new BadPayload(err instanceof Error ? err.message : "manifest body");
  }
  return { view: m as unknown as ManifestView, packed, survivors };
}

export interface FormationState {
  readonly view: FormationView;
  readonly formation: Formation;
}

export function guardFormation(raw: unknown): FormationState {
  if (!isObject(raw) || !isObject(raw["formation"])) throw new BadPayload("formation");
  const f = raw["formation"];
  if (!Number.isInteger(f["encounterIndex"]) || typeof f["hash"] !== "string") throw new BadPayload("formation.encounterIndex");
  if (!(f["committedAt"] === null || typeof f["committedAt"] === "string")) throw new BadPayload("formation.committedAt");
  if (!Array.isArray(f["gaps"]) || !(f["gaps"] as unknown[]).every((g) => Number.isInteger(g))) throw new BadPayload("formation.gaps");
  let formation: Formation;
  try {
    formation = formationFromJson(f["formation"]);
  } catch (err) {
    throw new BadPayload(err instanceof Error ? err.message : "formation body");
  }
  return { view: f as unknown as FormationView, formation };
}

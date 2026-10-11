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
import type { CandidateMenuView, CandidateView, ChoiceView, FormationView, ManifestView } from "../../api/types.ts";
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

// ── matchmaking (chunk 14) ───────────────────────────────────────────────────────────

function isBand(v: unknown): boolean {
  return isObject(v) && Number.isInteger(v["index"]) && Number.isInteger(v["low"]) && Number.isInteger(v["high"]);
}

function checkCandidate(c: unknown, where: string): asserts c is CandidateView {
  if (!isObject(c) || typeof c["candidateId"] !== "string" || typeof c["partyId"] !== "string") throw new BadPayload(`${where}.candidateId`);
  const owner = c["owner"];
  if (!isObject(owner) || typeof owner["displayName"] !== "string" || typeof owner["authored"] !== "boolean") throw new BadPayload(`${where}.owner`);
  const rep = c["reputation"];
  if (!isObject(rep) || !Number.isInteger(rep["rating"]) || !isBand(rep["band"]) || !Number.isInteger(rep["gapFromCaravan"]) || !Number.isInteger(rep["sandbagEarnMultiplier"])) {
    throw new BadPayload(`${where}.reputation`);
  }
  const scout = c["scout"];
  if (!isObject(scout) || scout["v"] !== 1 || !Array.isArray(scout["units"]) || !Array.isArray(scout["siege"]) || !Array.isArray(scout["edges"])) throw new BadPayload(`${where}.scout`);
  for (const [i, u] of (scout["units"] as unknown[]).entries()) {
    if (!isObject(u)) throw new BadPayload(`${where}.scout.units[${i}]`);
    for (const k of ["ref", "typeId", "displayName", "affinity", "stance", "edge"]) if (typeof u[k] !== "string") throw new BadPayload(`${where}.scout.units[${i}].${k}`);
    for (const k of ["mergeLevel", "offense", "defense", "hp", "moveSpeed", "attackRange", "attackCooldown"]) if (!Number.isInteger(u[k])) throw new BadPayload(`${where}.scout.units[${i}].${k}`);
    const cell = u["cell"];
    if (!isObject(cell) || !Number.isInteger(cell["x"]) || !Number.isInteger(cell["y"])) throw new BadPayload(`${where}.scout.units[${i}].cell`);
    const ab = u["ability"];
    if (!isObject(ab) || typeof ab["archetype"] !== "string" || typeof ab["displayName"] !== "string" || !Number.isInteger(ab["cooldown"])) throw new BadPayload(`${where}.scout.units[${i}].ability`);
  }
  for (const [i, s] of (scout["siege"] as unknown[]).entries()) {
    if (!isObject(s) || typeof s["typeId"] !== "string" || typeof s["displayName"] !== "string" || !isObject(s["counters"]) || typeof s["effect"] !== "string" || !Array.isArray(s["targetTypeIds"])) {
      throw new BadPayload(`${where}.scout.siege[${i}]`);
    }
  }
  const us = scout["unitSlots"];
  const ss = scout["siegeSlots"];
  if (!isObject(us) || !Number.isInteger(us["used"]) || !Number.isInteger(us["cap"]) || !isObject(ss) || !Number.isInteger(ss["used"]) || !Number.isInteger(ss["cap"])) throw new BadPayload(`${where}.scout.slots`);
}

export function guardMenu(raw: unknown): CandidateMenuView {
  if (!isObject(raw) || !isObject(raw["menu"])) throw new BadPayload("menu");
  const m = raw["menu"];
  if (typeof m["tripId"] !== "string" || !Number.isInteger(m["encounterIndex"]) || !Number.isInteger(m["searchSeq"])) throw new BadPayload("menu.tripId");
  const caravan = m["caravan"];
  if (!isObject(caravan) || !Number.isInteger(caravan["rating"]) || !isBand(caravan["band"])) throw new BadPayload("menu.caravan");
  if (!Number.isInteger(m["centre"]) || !Number.isInteger(m["bandWidthUsed"]) || typeof m["widened"] !== "boolean" || typeof m["usedAuthoredFallback"] !== "boolean") throw new BadPayload("menu.band");
  const reroll = m["reroll"];
  if (!isObject(reroll) || reroll["gate"] !== "time" || !Number.isInteger(reroll["cooldownSeconds"]) || !Number.isInteger(reroll["availableAtMs"]) || typeof reroll["available"] !== "boolean") {
    throw new BadPayload("menu.reroll");
  }
  if (!(m["chosen"] === null || (isObject(m["chosen"]) && typeof m["chosen"]["candidateId"] === "string"))) throw new BadPayload("menu.chosen");
  if (!Array.isArray(m["candidates"])) throw new BadPayload("menu.candidates");
  (m["candidates"] as unknown[]).forEach((c, i) => checkCandidate(c, `menu.candidates[${i}]`));
  return m as unknown as CandidateMenuView;
}

export function guardChoice(raw: unknown): ChoiceView {
  if (!isObject(raw)) throw new BadPayload("choice");
  const menu = guardMenu({ menu: raw["menu"] });
  checkCandidate(raw["chosen"], "choice.chosen");
  return { menu, chosen: raw["chosen"] };
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

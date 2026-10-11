/**
 * Compact, versioned, DETERMINISTIC serialization (chunk 07 definition of done).
 *
 * A committed formation is stored per encounter as a snapshot and must byte-compare: the
 * same arrangement, however it was built, produces the same string. So:
 *   - object keys are written in sorted order, recursively (never insertion order);
 *   - arrays are first put in canonical order (normalizeFormation);
 *   - no whitespace; every number must be a safe integer — a float is refused, so a float
 *     can never reach storage or the resolver through this path;
 *   - a version field (`v`) is carried so a later shape change can be told apart.
 *
 * Parsing is STRICT: unknown keys are rejected at every level. That is what keeps
 * elevation, terrain, scenery or any other smuggled field out of a stored formation.
 */
import { DEFAULT_DEFENSIVE_STANCE, DEFENSIVE_STANCES, FORMATION_VERSION, isDefensiveStance, normalizeFormation, oversizedIssue, type DefensiveStance, type Formation } from "./formation.js";
import { ENTRY_EDGES, isCell, isEntryEdge, isRingSegmentIndex, type Cell, type EntryEdge } from "./lattice.js";
import { assertManifest, freezeManifest, type Manifest, MANIFEST_VERSION } from "./manifest.js";
import {
  PARTY_CONFIG_VERSION,
  PARTY_VERSION,
  TARGETING_STANCES,
  assertParty,
  freezeParty,
  isTargetingStance,
  normalizeParty,
  normalizePartyConfig,
  type Party,
  type PartyConfig,
  type TargetingStance,
} from "./party.js";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** JSON with keys sorted recursively and integers only. Equal values stringify identically. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${(value as readonly Json[]).map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as { readonly [key: string]: Json };
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k]!)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError(`canonicalJson: numbers must be safe integers, got ${String(value)}`);
  }
  if (value === undefined) throw new TypeError("canonicalJson: undefined is not serializable");
  return JSON.stringify(value);
}

export class ParseError extends Error {
  constructor(message: string) {
    super(`malformed snapshot: ${message}`);
    this.name = "ParseError";
  }
}

// ── strict decoding helpers ──────────────────────────────────────────────────────────

/** Exactly the required keys, plus any of the optional ones; anything else is refused by name. */
function expectObject(v: unknown, where: string, requiredKeys: readonly string[], optionalKeys: readonly string[] = []): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ParseError(`${where} must be an object`);
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!requiredKeys.includes(k) && !optionalKeys.includes(k)) throw new ParseError(`${where} has unknown key '${k}'`);
  }
  for (const k of requiredKeys) if (!(k in obj)) throw new ParseError(`${where} is missing '${k}'`);
  return obj;
}
function expectStance(v: unknown, where: string): DefensiveStance {
  if (v === undefined) return DEFAULT_DEFENSIVE_STANCE;
  if (!isDefensiveStance(v)) throw new ParseError(`${where} must be one of ${DEFENSIVE_STANCES.join(", ")}`);
  return v;
}
function expectArray(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new ParseError(`${where} must be an array`);
  return v;
}
function expectInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ParseError(`${where} must be a safe integer`);
  return v;
}
function expectString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) throw new ParseError(`${where} must be a non-empty string`);
  return v;
}
function expectBool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new ParseError(`${where} must be a boolean`);
  return v;
}
function expectCell(v: unknown, where: string): Cell {
  const o = expectObject(v, where, ["x", "y"]);
  const cell = { x: expectInt(o["x"], `${where}.x`), y: expectInt(o["y"], `${where}.y`) };
  if (!isCell(cell)) throw new ParseError(`${where} is off the lattice`);
  return cell;
}

// ── formation ────────────────────────────────────────────────────────────────────────

export function serializeFormation(f: Formation): string {
  const n = normalizeFormation(f);
  return canonicalJson({
    v: n.v,
    fences: n.fences.map((p) => ({ ref: p.ref, segment: p.segment })),
    traps: n.traps.map((p) => ({ ref: p.ref, cell: { x: p.cell.x, y: p.cell.y } })),
    posts: n.posts.map((p) => ({ ref: p.ref, cell: { x: p.cell.x, y: p.cell.y }, stance: p.stance })),
  });
}

/** Strict structural parse. Does NOT validate against a manifest — call validateFormation for that. */
export function parseFormation(text: string): Formation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ParseError("not JSON");
  }
  return formationFromJson(raw);
}

/**
 * Strict structural parse of untrusted input. A post's `stance` may be omitted and defaults
 * to `guard` (QA D1); the canonical form always carries it. QA S8: list sizes are checked
 * against the caps BEFORE any entry is looked at, so an oversized body costs nothing.
 */
export function formationFromJson(raw: unknown): Formation {
  const o = expectObject(raw, "formation", ["v", "fences", "traps", "posts"]);
  if (o["v"] !== FORMATION_VERSION) throw new ParseError(`unsupported formation version ${String(o["v"])}`);
  const lists = { fences: expectArray(o["fences"], "formation.fences"), traps: expectArray(o["traps"], "formation.traps"), posts: expectArray(o["posts"], "formation.posts") };
  const oversized = oversizedIssue(lists);
  if (oversized) throw new ParseError(oversized.message);
  const fences = lists.fences.map((p, i) => {
    const e = expectObject(p, `formation.fences[${i}]`, ["ref", "segment"]);
    const segment = expectInt(e["segment"], `formation.fences[${i}].segment`);
    if (!isRingSegmentIndex(segment)) throw new ParseError(`formation.fences[${i}].segment is not a ring position`);
    return { ref: expectString(e["ref"], `formation.fences[${i}].ref`), segment };
  });
  const traps = lists.traps.map((p, i) => {
    const e = expectObject(p, `formation.traps[${i}]`, ["ref", "cell"]);
    return { ref: expectString(e["ref"], `formation.traps[${i}].ref`), cell: expectCell(e["cell"], `formation.traps[${i}].cell`) };
  });
  const posts = lists.posts.map((p, i) => {
    const e = expectObject(p, `formation.posts[${i}]`, ["ref", "cell"], ["stance"]);
    return {
      ref: expectString(e["ref"], `formation.posts[${i}].ref`),
      cell: expectCell(e["cell"], `formation.posts[${i}].cell`),
      stance: expectStance(e["stance"], `formation.posts[${i}].stance`),
    };
  });
  return normalizeFormation({ v: FORMATION_VERSION, fences, traps, posts });
}

// ── manifest ─────────────────────────────────────────────────────────────────────────

export function serializeManifest(m: Manifest): string {
  assertManifest(m);
  return canonicalJson({
    v: m.v,
    units: m.units.map((u) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, maxHp: u.maxHp, hp: u.hp })),
    traps: m.traps.map((t) => ({ ref: t.ref, typeId: t.typeId, spent: t.spent })),
    fences: m.fences.map((f) => ({ ref: f.ref, tierId: f.tierId, maxHp: f.maxHp, hp: f.hp })),
  });
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ParseError("not JSON");
  }
  return manifestFromJson(raw);
}

export function manifestFromJson(raw: unknown): Manifest {
  const o = expectObject(raw, "manifest", ["v", "units", "traps", "fences"]);
  if (o["v"] !== MANIFEST_VERSION) throw new ParseError(`unsupported manifest version ${String(o["v"])}`);
  const units = expectArray(o["units"], "manifest.units").map((p, i) => {
    const w = `manifest.units[${i}]`;
    const e = expectObject(p, w, ["ref", "typeId", "mergeLevel", "maxHp", "hp"]);
    return {
      ref: expectString(e["ref"], `${w}.ref`),
      typeId: expectString(e["typeId"], `${w}.typeId`),
      mergeLevel: expectInt(e["mergeLevel"], `${w}.mergeLevel`),
      maxHp: expectInt(e["maxHp"], `${w}.maxHp`),
      hp: expectInt(e["hp"], `${w}.hp`),
    };
  });
  const traps = expectArray(o["traps"], "manifest.traps").map((p, i) => {
    const w = `manifest.traps[${i}]`;
    const e = expectObject(p, w, ["ref", "typeId", "spent"]);
    return { ref: expectString(e["ref"], `${w}.ref`), typeId: expectString(e["typeId"], `${w}.typeId`), spent: expectBool(e["spent"], `${w}.spent`) };
  });
  const fences = expectArray(o["fences"], "manifest.fences").map((p, i) => {
    const w = `manifest.fences[${i}]`;
    const e = expectObject(p, w, ["ref", "tierId", "maxHp", "hp"]);
    return {
      ref: expectString(e["ref"], `${w}.ref`),
      tierId: expectString(e["tierId"], `${w}.tierId`),
      maxHp: expectInt(e["maxHp"], `${w}.maxHp`),
      hp: expectInt(e["hp"], `${w}.hp`),
    };
  });
  const m: Manifest = { v: MANIFEST_VERSION, units, traps, fences };
  try {
    assertManifest(m);
  } catch (err) {
    throw new ParseError((err as Error).message);
  }
  return freezeManifest(m);
}

// ── chunk 09: the standing raid party ────────────────────────────────────────────────
// Same rules as above: sorted keys, canonical array order (normalizePartyConfig /
// normalizeParty), integers only, a version field, STRICT parsing that refuses unknown
// keys. The stored config and the served snapshot must both byte-compare.

function expectTargetingStance(v: unknown, where: string): TargetingStance {
  if (!isTargetingStance(v)) throw new ParseError(`${where} must be one of ${TARGETING_STANCES.join(", ")}`);
  return v;
}
function expectEdge(v: unknown, where: string): EntryEdge {
  if (!isEntryEdge(v)) throw new ParseError(`${where} must be one of ${ENTRY_EDGES.join(", ")}`);
  return v;
}

export function serializePartyConfig(c: PartyConfig): string {
  if (c.v !== PARTY_CONFIG_VERSION) throw new TypeError(`serializePartyConfig: version ${String(c.v)}`);
  return canonicalJson(normalizePartyConfig(c) as unknown as Json);
}

/** Strict: unknown keys, floats, bad versions, bad enums and off-lattice cells are refused by name. */
export function partyConfigFromJson(raw: unknown): PartyConfig {
  const o = expectObject(raw, "party", ["v", "units", "siege"]);
  if (o["v"] !== PARTY_CONFIG_VERSION) throw new ParseError(`party.v must be ${PARTY_CONFIG_VERSION}`);
  const units = expectArray(o["units"], "party.units").map((u, i) => {
    const e = expectObject(u, `party.units[${i}]`, ["ref", "stance", "edge", "cell"]);
    return {
      ref: expectString(e["ref"], `party.units[${i}].ref`),
      stance: expectTargetingStance(e["stance"], `party.units[${i}].stance`),
      edge: expectEdge(e["edge"], `party.units[${i}].edge`),
      cell: expectCell(e["cell"], `party.units[${i}].cell`),
    };
  });
  const siege = expectArray(o["siege"], "party.siege").map((s, i) => expectString(s, `party.siege[${i}]`));
  return normalizePartyConfig({ v: PARTY_CONFIG_VERSION, units, siege });
}

export function parsePartyConfig(text: string): PartyConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ParseError(`party config is not JSON: ${(err as Error).message}`);
  }
  return partyConfigFromJson(raw);
}

export function serializeParty(p: Party): string {
  assertParty(p);
  return canonicalJson(normalizeParty(p) as unknown as Json);
}

/** Strict decode of a served snapshot (job input / ledger payload) back into a Party. */
export function partyFromJson(raw: unknown): Party {
  const o = expectObject(raw, "party", ["v", "units", "siege"]);
  if (o["v"] !== PARTY_VERSION) throw new ParseError(`party.v must be ${PARTY_VERSION}`);
  const units = expectArray(o["units"], "party.units").map((u, i) => {
    const e = expectObject(u, `party.units[${i}]`, ["ref", "typeId", "mergeLevel", "stance", "edge", "cell"]);
    return {
      ref: expectString(e["ref"], `party.units[${i}].ref`),
      typeId: expectString(e["typeId"], `party.units[${i}].typeId`),
      mergeLevel: expectInt(e["mergeLevel"], `party.units[${i}].mergeLevel`),
      stance: expectTargetingStance(e["stance"], `party.units[${i}].stance`),
      edge: expectEdge(e["edge"], `party.units[${i}].edge`),
      cell: expectCell(e["cell"], `party.units[${i}].cell`),
    };
  });
  const siege = expectArray(o["siege"], "party.siege").map((s, i) => ({
    typeId: expectString(expectObject(s, `party.siege[${i}]`, ["typeId"])["typeId"], `party.siege[${i}].typeId`),
  }));
  const party = freezeParty(normalizeParty({ v: PARTY_VERSION, units, siege }));
  try {
    assertParty(party);
  } catch (err) {
    throw new ParseError((err as Error).message);
  }
  return party;
}

export function parseParty(text: string): Party {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ParseError(`party is not JSON: ${(err as Error).message}`);
  }
  return partyFromJson(raw);
}

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
import { normalizeFormation, type Formation, FORMATION_VERSION } from "./formation.js";
import { isCell, isRingSegmentIndex, type Cell } from "./lattice.js";
import { assertManifest, freezeManifest, type Manifest, MANIFEST_VERSION } from "./manifest.js";

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

function expectObject(v: unknown, where: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ParseError(`${where} must be an object`);
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.includes(k)) throw new ParseError(`${where} has unknown key '${k}'`);
  }
  for (const k of allowedKeys) if (!(k in obj)) throw new ParseError(`${where} is missing '${k}'`);
  return obj;
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
    posts: n.posts.map((p) => ({ ref: p.ref, cell: { x: p.cell.x, y: p.cell.y } })),
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

export function formationFromJson(raw: unknown): Formation {
  const o = expectObject(raw, "formation", ["v", "fences", "traps", "posts"]);
  if (o["v"] !== FORMATION_VERSION) throw new ParseError(`unsupported formation version ${String(o["v"])}`);
  const fences = expectArray(o["fences"], "formation.fences").map((p, i) => {
    const e = expectObject(p, `formation.fences[${i}]`, ["ref", "segment"]);
    const segment = expectInt(e["segment"], `formation.fences[${i}].segment`);
    if (!isRingSegmentIndex(segment)) throw new ParseError(`formation.fences[${i}].segment is not a ring position`);
    return { ref: expectString(e["ref"], `formation.fences[${i}].ref`), segment };
  });
  const traps = expectArray(o["traps"], "formation.traps").map((p, i) => {
    const e = expectObject(p, `formation.traps[${i}]`, ["ref", "cell"]);
    return { ref: expectString(e["ref"], `formation.traps[${i}].ref`), cell: expectCell(e["cell"], `formation.traps[${i}].cell`) };
  });
  const posts = expectArray(o["posts"], "formation.posts").map((p, i) => {
    const e = expectObject(p, `formation.posts[${i}]`, ["ref", "cell"]);
    return { ref: expectString(e["ref"], `formation.posts[${i}].ref`), cell: expectCell(e["cell"], `formation.posts[${i}].cell`) };
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

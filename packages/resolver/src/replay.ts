/**
 * The replay: the stored form of the tick log, and the reader a client plays it back with
 * (chunk 13 LOG_FORMAT). The log a fight produces IS the replay (GUARDRAILS §1): this file
 * only re-encodes it compactly and reads it back. Nothing here simulates.
 *
 * ── LOG_FORMAT, version 2 (REPLAY_FORMAT_VERSION; v1 was chunk 13's first cut) ────────
 * A plain JSON-ready object (the resolver never serializes — it has no JSON; the server
 * stringifies, compresses and stores it):
 *   format "caravan-replay", v 2, resolverVersion, tickRate, tickCap, keyframeInterval
 *   (ticks), ticks (simulated), outcome {kind, end, endTick, depth, deepestUnit},
 *   labels: units [{u, side, ref, typeId, level, maxHp, hp, ab}] (hp = what it brought into
 *   the fight, ab = its ability's ABILITY_ARCHETYPES index), fences [{f, ref, segment, tierId,
 *   category, maxHp, hp}], traps [{i, ref, typeId, x, y}] — enough to draw every entity,
 *   nothing a renderer must look up to place one; events: one positional ROW per log event,
 *   [t, code, ...fields] (CODES below), in log order; count = events.length; check = the SEAL.
 *
 * THE SEAL (v2, QA-13 S3): `check` is FNV-1a (32-bit) over THE WHOLE LOG — the envelope, the
 * outcome, every unit / fence / trap label field and every row — in a fixed field order
 * (`replaySeal`). Every object has an exact key set: an unknown key is refused, so nothing in a
 * stored log sits outside the seal. v1's check covered the rows only (an edited typeId, level,
 * trap position, outcome field or header number passed unseen); v1 logs are not readable here.
 * The seal detects corruption and unsealed edits; it is not a signature (anyone can recompute
 * FNV). AUTHENTICITY is the server's: the sha256 of the stored text is recorded in the job's
 * immutable result at completion, and the replay route marks a log whose sha256 differs
 * `renderable: false`. A re-sealed edit the reader can still catch, it does (NUMBERS below).
 *
 * ROWS (every field an integer except the code; −1 = "none"):
 *   s  spawn           [0, "s", u, x, y]
 *   tg target          [t, "tg", u, kind, id]        kind −1 none, 0 core, 1 unit, 2 trap
 *   p  path            [t, "p", u, speed, x1, y1, b1, x2, y2, b2, …]   b = breach fence or −1
 *   h  hold            [t, "h", u, 1|0]
 *   c  core_reached    [t, "c", u]
 *   fh fence_hit       [t, "fh", u, f, damage, hp]
 *   fb fence_broken    [t, "fb", f]
 *   v  speed           [t, "v", u, speed]
 *   tf trap_fired      [t, "tf", i, u, damage, hp, effect]   effect 0 none, 1 slow, 2 root
 *   tn trap_nullified  [t, "tn", i, u]
 *   ag aggro           [t, "ag", u, v]
 *   dg disengage       [t, "dg", u, why, amount]      why 0 leash, 1 lost, 2 dead; amount −1 = none
 *   rt returned        [t, "rt", u]
 *   rl released        [t, "rl", u, v]
 *   x  hit             [t, "x", u, v, damage, hp]
 *   d  unit_died       [t, "d", u]
 *   ab ability         [t, "ab", u, archetype, …extra, (kind, id, amount, hp)×n]
 *                      archetype = ABILITY_ARCHETYPES index; extra: heal → charges,
 *                      self_buff → until, dash → x, y; none for the others; kind 0 unit, 1 fence
 *   kf keyframe        [t, "kf", nU, (u, x, y, hp, cd, slow, root, abAt)×nU, nF, (f, hp)×nF, nT, i×nT]
 *
 * KEYFRAME_DELTA (the compact keyframe encoding, chunk 10 QA N4 / chunk 11 QA N5): a
 * keyframe row carries only the units whose record changed since the previous keyframe
 * (the first carries every unit), only the fences whose HP changed, and only the traps
 * spent since. `abAt` is the ABSOLUTE tick the ability is next ready (0 = ready), so an
 * idle unit's record does not change from one keyframe to the next. `alive` is not
 * stored: at the end of a tick (after phase 8) a unit is alive exactly when its HP > 0 and a
 * fence intact exactly when its HP > 0 — the encoder asserts both. The reader folds the
 * rows back into FULL keyframes (every unit, fence and trap), identical to the resolver's
 * own keyframe events, so playback can seek to any of them.
 *
 * NUMBERS (v2, QA-13 S3 — consistency checks, not decisions: every number is still copied
 * from a row, the reader only refuses rows that contradict each other). In log order, with HP
 * starting at the labels': a hit (`x`), a trap firing (`tf`), a burst / heavy strike target
 * and a structure-breaker fence target must state hp = max(0, previous − damage); a fence hit
 * (`fh`) the same on the fence; a heal hp = previous + amount (≤ maxHp); a self buff's or a
 * dash's own row the caster's unchanged HP; `d` only at 0 HP and `fb` only at 0 fence HP. The
 * unit dealing a hit, a fence hit or an ability must not have died (`d`) earlier, and an
 * `ab` row's archetype must be its caster's label `ab`.
 *
 * TRUNCATION AND CORRUPTION (fail loudly, never misrender): keyframes fall on fixed ticks —
 * k × keyframeInterval − 1 for every k × keyframeInterval ≤ ticks, plus ticks − 1 — and the
 * last row is always the final keyframe; `count` covers every row and `check` the whole log;
 * and while reading, the reader interpolates the whole fight and compares every keyframe's
 * positions, HP, deaths, fences and traps with what the events produced. Any missing row,
 * extra row, unsealed edit, contradicting number or reordered tick throws ReplayError.
 *
 * THE READER MAKES NO DECISIONS. It never chooses a target, resolves a hit, decides a
 * death or picks a turn: every one of those is a row. It does two things only — copies
 * numbers out of rows (HP, deaths, spent traps, broken fences), and places each unit
 * between known points by the log.ts INTERPOLATION CONTRACT (the leg rule, `hold`, `speed`,
 * the leash-clamped `amount`, the dash leg). It imports nothing from the simulation
 * (tick, combat, path, abilities, posted, traps, move, state): only fixed-point helpers,
 * the field bounds and the archetype list. A test pins that import list.
 */
import { ABILITY_ARCHETYPES, FIELD_HEIGHT, FIELD_WIDTH, type AbilityArchetype } from "./battlefield.js";
import { clamp, isqrt, legOffset } from "./fixed.js";
import type { AbilityEffectLog, LogEvent, LogTarget } from "./log.js";
import type { EndReason, OutcomeKind } from "./outcome.js";
import type { ResolveOutput } from "./resolve.js";

export const REPLAY_FORMAT = "caravan-replay" as const;
/** Bump when the row layout changes; keep reading every version listed in READABLE_REPLAY_FORMATS. */
export const REPLAY_FORMAT_VERSION = 2 as const;
export const READABLE_REPLAY_FORMATS: readonly number[] = [2];

export type ReplayRow = readonly (number | string)[];

export interface ReplayUnitLabel {
  readonly u: number;
  readonly side: "attacker" | "defender";
  readonly ref: string;
  readonly typeId: string;
  readonly level: number;
  readonly maxHp: number;
  /** HP brought into the fight. */
  readonly hp: number;
  /** Its ability's ABILITY_ARCHETYPES index (v2). */
  readonly ab: number;
}
export interface ReplayFenceLabel {
  readonly f: number;
  readonly ref: string;
  readonly segment: number;
  readonly tierId: string;
  readonly category: string;
  readonly maxHp: number;
  readonly hp: number;
}
export interface ReplayTrapLabel {
  readonly i: number;
  readonly ref: string;
  readonly typeId: string;
  readonly x: number;
  readonly y: number;
}
export interface ReplayOutcome {
  readonly kind: OutcomeKind;
  readonly end: EndReason;
  readonly endTick: number;
  readonly depth: number;
  readonly deepestUnit: number;
}

export interface ReplayLog {
  readonly format: typeof REPLAY_FORMAT;
  readonly v: number;
  readonly resolverVersion: number;
  readonly tickRate: number;
  readonly tickCap: number;
  readonly keyframeInterval: number;
  readonly ticks: number;
  readonly outcome: ReplayOutcome;
  readonly units: readonly ReplayUnitLabel[];
  readonly fences: readonly ReplayFenceLabel[];
  readonly traps: readonly ReplayTrapLabel[];
  readonly events: readonly ReplayRow[];
  readonly count: number;
  readonly check: number;
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(`replay refused: ${message}`);
    this.name = "ReplayError";
  }
}

const fail = (m: string): never => {
  throw new ReplayError(m);
};

const TARGET_KINDS: readonly LogTarget["kind"][] = ["core", "unit", "trap"];
const WHY: readonly ("leash" | "lost" | "dead")[] = ["leash", "lost", "dead"];
const EFFECTS: readonly ("slow" | "root" | null)[] = [null, "slow", "root"];
const OUTCOME_KIND_LIST: readonly OutcomeKind[] = ["caravan_held", "caravan_overrun", "stalemate"];
const END_FOR: Readonly<Record<OutcomeKind, EndReason>> = { caravan_held: "party_wiped", caravan_overrun: "core_overrun", stalemate: "tick_cap" };

// ─── checksum ──────────────────────────────────────────────────────────────────────

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v & 0xffff), FNV_PRIME) >>> 0;
}

function mixValue(h: number, v: number | string): number {
  if (typeof v === "string") {
    for (let i = 0; i < v.length; i++) h = mix(h, v.charCodeAt(i));
    return mix(h, 0xfffe);
  }
  h = mix(h, v);
  h = mix(h, v >>> 16);
  return mix(h, Math.floor(v / 4294967296));
}

function mixRows(h: number, rows: readonly ReplayRow[]): number {
  for (const row of rows) {
    h = mix(h, row.length);
    for (const v of row) h = mixValue(h, v);
  }
  return h;
}

/** FNV-1a over every row: each number as two 16-bit halves of its low 32 bits plus its high bits, each code by char code. Integer-only. */
export function replayChecksum(rows: readonly ReplayRow[]): number {
  return mixRows(FNV_OFFSET, rows);
}

/** The keys of each object in a v2 log, in SEAL order (also the exact key sets the reader accepts). */
export const REPLAY_KEYS = {
  envelope: ["format", "v", "resolverVersion", "tickRate", "tickCap", "keyframeInterval", "ticks", "outcome", "units", "fences", "traps", "events", "count", "check"],
  outcome: ["kind", "end", "endTick", "depth", "deepestUnit"],
  unit: ["u", "side", "ref", "typeId", "level", "maxHp", "hp", "ab"],
  fence: ["f", "ref", "segment", "tierId", "category", "maxHp", "hp"],
  trap: ["i", "ref", "typeId", "x", "y"],
} as const;

type Sealable = Omit<ReplayLog, "check">;

/**
 * THE SEAL (see header): FNV-1a over the whole log except `check` itself — every envelope
 * field, the outcome, every label field and every row, in REPLAY_KEYS order, with each list
 * prefixed by its length. Integer-only.
 */
export function replaySeal(log: Sealable): number {
  const rec = log as unknown as Record<string, unknown>;
  let h = FNV_OFFSET;
  const fields = (o: Record<string, unknown>, keys: readonly string[]) => {
    for (const k of keys) h = mixValue(h, o[k] as number | string);
  };
  for (const k of REPLAY_KEYS.envelope) {
    if (k === "outcome") fields(rec.outcome as Record<string, unknown>, REPLAY_KEYS.outcome);
    else if (k === "units" || k === "fences" || k === "traps") {
      const list = rec[k] as readonly Record<string, unknown>[];
      const keys = k === "units" ? REPLAY_KEYS.unit : k === "fences" ? REPLAY_KEYS.fence : REPLAY_KEYS.trap;
      h = mix(h, list.length);
      for (const o of list) fields(o, keys);
    } else if (k === "events") {
      h = mix(h, log.events.length);
      h = mixRows(h, log.events);
    } else if (k !== "check") h = mixValue(h, rec[k] as number | string);
  }
  return h;
}

// ─── encoding ──────────────────────────────────────────────────────────────────────

function targetRow(t: LogTarget | null): [number, number] {
  if (t === null) return [-1, -1];
  return [TARGET_KINDS.indexOf(t.kind), t.id];
}

function tgRow(tg: readonly AbilityEffectLog[]): number[] {
  const out: number[] = [];
  for (const e of tg) out.push(e.kind === "unit" ? 0 : 1, e.id, e.amount, e.hp);
  return out;
}

type UnitRecord = readonly [number, number, number, number, number, number, number];

/**
 * Re-encode a resolver output's log as a ReplayLog (LOG_FORMAT v1). Lossless: readReplay
 * returns exactly `out.log`. Throws if the log breaks an invariant the format relies on.
 */
export function encodeReplay(out: ResolveOutput): ReplayLog {
  const rows: ReplayRow[] = [];
  let prevUnits: (UnitRecord | null)[] = out.units.map(() => null);
  let prevFences: number[] = out.fences.map(() => -1);
  const spentListed: boolean[] = out.traps.map(() => false);
  for (const e of out.log) {
    switch (e.k) {
      case "spawn":
        rows.push([e.t, "s", e.u, e.x, e.y]);
        break;
      case "target":
        rows.push([e.t, "tg", e.u, ...targetRow(e.target)]);
        break;
      case "path": {
        const r: (number | string)[] = [e.t, "p", e.u, e.speed];
        for (const w of e.wp) r.push(w[0], w[1], w[2]);
        rows.push(r);
        break;
      }
      case "hold":
        rows.push([e.t, "h", e.u, e.holding ? 1 : 0]);
        break;
      case "core_reached":
        rows.push([e.t, "c", e.u]);
        break;
      case "fence_hit":
        rows.push([e.t, "fh", e.u, e.f, e.damage, e.hp]);
        break;
      case "fence_broken":
        rows.push([e.t, "fb", e.f]);
        break;
      case "speed":
        rows.push([e.t, "v", e.u, e.speed]);
        break;
      case "trap_fired":
        rows.push([e.t, "tf", e.i, e.u, e.damage, e.hp, EFFECTS.indexOf(e.effect)]);
        break;
      case "trap_nullified":
        rows.push([e.t, "tn", e.i, e.u]);
        break;
      case "aggro":
        rows.push([e.t, "ag", e.u, e.v]);
        break;
      case "disengage":
        rows.push([e.t, "dg", e.u, WHY.indexOf(e.why), "amount" in e ? e.amount : -1]);
        break;
      case "returned":
        rows.push([e.t, "rt", e.u]);
        break;
      case "released":
        rows.push([e.t, "rl", e.u, e.v]);
        break;
      case "hit":
        rows.push([e.t, "x", e.u, e.v, e.damage, e.hp]);
        break;
      case "unit_died":
        rows.push([e.t, "d", e.u]);
        break;
      case "ability": {
        const a = ABILITY_ARCHETYPES.indexOf(e.a);
        if (e.a === "heal_radius") rows.push([e.t, "ab", e.u, a, e.charges, ...tgRow(e.tg)]);
        else if (e.a === "self_buff") rows.push([e.t, "ab", e.u, a, e.until, ...tgRow(e.tg)]);
        else if (e.a === "dash") rows.push([e.t, "ab", e.u, a, e.x, e.y, ...tgRow(e.tg)]);
        else rows.push([e.t, "ab", e.u, a, ...tgRow(e.tg)]);
        break;
      }
      case "keyframe": {
        const r: (number | string)[] = [e.t, "kf"];
        const units: number[] = [];
        let nU = 0;
        const nextUnits = prevUnits.slice();
        for (const k of e.units) {
          if (k.alive !== k.hp > 0) fail(`keyframe t=${e.t}: unit ${k.u} alive=${String(k.alive)} with hp ${k.hp}`);
          const rec: UnitRecord = [k.x, k.y, k.hp, k.cd, k.slow, k.root, k.ab > 0 ? e.t + 1 + k.ab : 0];
          const p = prevUnits[k.u] ?? null;
          if (p === null || rec.some((v, i) => v !== p[i])) {
            units.push(k.u, ...rec);
            nU++;
          }
          nextUnits[k.u] = rec;
        }
        const fences: number[] = [];
        let nF = 0;
        const nextFences = prevFences.slice();
        for (const f of e.fences) {
          if (prevFences[f.f] !== f.hp) {
            fences.push(f.f, f.hp);
            nF++;
          }
          nextFences[f.f] = f.hp;
        }
        const spent: number[] = [];
        for (const t of e.traps) {
          if (t.spent && !spentListed[t.i]) {
            spent.push(t.i);
            spentListed[t.i] = true;
          }
        }
        r.push(nU, ...units, nF, ...fences, spent.length, ...spent);
        rows.push(r);
        prevUnits = nextUnits;
        prevFences = nextFences;
        break;
      }
      default:
        fail(`unknown event ${quoted((e as { k: string }).k)}`);
    }
  }
  const body: Sealable = {
    format: REPLAY_FORMAT,
    v: REPLAY_FORMAT_VERSION,
    resolverVersion: out.resolverVersion,
    tickRate: out.tickRate,
    tickCap: out.tickCap,
    keyframeInterval: out.keyframeInterval,
    ticks: out.ticks,
    outcome: { kind: out.outcome.kind, end: out.outcome.end, endTick: out.outcome.endTick, depth: out.outcome.depth, deepestUnit: out.outcome.deepestUnit },
    units: out.units.map((u) => ({ u: u.id, side: u.side, ref: u.ref, typeId: u.typeId, level: u.mergeLevel, maxHp: u.maxHp, hp: u.startHp, ab: ABILITY_ARCHETYPES.indexOf(u.ability) })),
    fences: out.fences.map((f) => ({ f: f.f, ref: f.ref, segment: f.segment, tierId: f.tierId, category: f.category, maxHp: f.maxHp, hp: f.startHp })),
    traps: out.traps.map((t) => ({ i: t.i, ref: t.ref, typeId: t.typeId, x: t.x, y: t.y })),
    events: rows,
    count: rows.length,
  };
  return { ...body, check: replaySeal(body) };
}

/** A label for an error message without JSON (banned here). */
function quoted(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : typeof v;
}

// ─── reading ───────────────────────────────────────────────────────────────────────

type KeyframeEvent = Extract<LogEvent, { k: "keyframe" }>;

/** What a renderer draws for one tick: the state AFTER that tick. */
export interface ReplayFrame {
  readonly tick: number;
  readonly units: readonly { readonly u: number; readonly x: number; readonly y: number; readonly hp: number; readonly alive: boolean }[];
  readonly fences: readonly { readonly f: number; readonly hp: number; readonly intact: boolean }[];
  readonly traps: readonly { readonly i: number; readonly spent: boolean }[];
}

export interface Replay {
  readonly log: ReplayLog;
  /** The decoded tick log: identical to the resolver's `log` for this fight. */
  readonly events: readonly LogEvent[];
  /** Full keyframes (every unit, fence and trap), in tick order: seek targets. */
  readonly keyframes: readonly KeyframeEvent[];
  /** The events of one tick, in log order. */
  eventsAt(tick: number): readonly LogEvent[];
  /** Positions, HP and structure state after `tick` (0 ≤ tick < ticks), by interpolation only. */
  frame(tick: number): ReplayFrame;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function int(v: unknown, where: string, lo: number, hi: number): number {
  if (!isInt(v) || v < lo || v > hi) fail(`${where} must be an integer in ${lo}..${hi}`);
  return v as number;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") fail(`${where} must be a string`);
  return v as string;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`${where} must be an object`);
  return v as Record<string, unknown>;
}

/** An object with exactly these keys (QA-13 S3: nothing in a stored log sits outside the seal). */
function exact(v: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  const o = obj(v, where);
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${where} has an unknown key ${quoted(k)}`);
  for (const k of keys) if (!(k in o)) fail(`${where} is missing ${quoted(k)}`);
  return o;
}

function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) fail(`${where} must be an array`);
  return v as unknown[];
}

/** Validate the envelope and labels; returns the typed log. */
function assertReplayLog(raw: unknown): ReplayLog {
  const o0 = obj(raw, "replay");
  if (o0.format !== REPLAY_FORMAT) fail(`format must be '${REPLAY_FORMAT}'`);
  const v = int(o0.v, "v", 1, 1_000_000);
  if (!READABLE_REPLAY_FORMATS.includes(v)) fail(`log format v${v} is not readable by this reader (reads ${READABLE_REPLAY_FORMATS.join(", ")})`);
  const o = exact(raw, "replay", REPLAY_KEYS.envelope);
  int(o.resolverVersion, "resolverVersion", 0, 1_000_000);
  int(o.tickRate, "tickRate", 1, 1_000_000);
  const tickCap = int(o.tickCap, "tickCap", 1, 100_000_000);
  int(o.keyframeInterval, "keyframeInterval", 1, 100_000_000);
  const ticks = int(o.ticks, "ticks", 1, tickCap);
  const out = exact(o.outcome, "outcome", REPLAY_KEYS.outcome);
  if (!OUTCOME_KIND_LIST.includes(out.kind as OutcomeKind)) fail("outcome.kind is not one of the three end conditions");
  const kind = out.kind as OutcomeKind;
  if (out.end !== END_FOR[kind]) fail(`outcome.end must be ${END_FOR[kind]} for ${kind}`);
  if (int(out.endTick, "outcome.endTick", 0, tickCap - 1) !== ticks - 1) fail("outcome.endTick must be the last tick simulated");
  if (kind === "stalemate" && ticks !== tickCap) fail("a stalemate runs the full tick cap");
  const depth = int(out.depth, "outcome.depth", 0, 1024);
  if (kind === "caravan_overrun" && depth !== 1024) fail("an overrun's depth is 1024");
  if (kind !== "caravan_overrun" && depth === 1024) fail("depth 1024 is the core: only an overrun reaches it");
  const units = arr(o.units, "units");
  units.forEach((x, i) => {
    const u = exact(x, `units[${i}]`, REPLAY_KEYS.unit);
    if (u.u !== i) fail(`units[${i}].u must be ${i}`);
    if (u.side !== "attacker" && u.side !== "defender") fail(`units[${i}].side`);
    str(u.ref, `units[${i}].ref`);
    str(u.typeId, `units[${i}].typeId`);
    int(u.level, `units[${i}].level`, 1, 1000);
    const maxHp = int(u.maxHp, `units[${i}].maxHp`, 1, 100_000_000);
    int(u.hp, `units[${i}].hp`, 1, maxHp);
    int(u.ab, `units[${i}].ab`, 0, ABILITY_ARCHETYPES.length - 1);
  });
  int(out.deepestUnit, "outcome.deepestUnit", -1, units.length - 1);
  arr(o.fences, "fences").forEach((x, i) => {
    const f = exact(x, `fences[${i}]`, REPLAY_KEYS.fence);
    if (f.f !== i) fail(`fences[${i}].f must be ${i}`);
    str(f.ref, `fences[${i}].ref`);
    int(f.segment, `fences[${i}].segment`, 0, 1000);
    str(f.tierId, `fences[${i}].tierId`);
    str(f.category, `fences[${i}].category`);
    const maxHp = int(f.maxHp, `fences[${i}].maxHp`, 1, 100_000_000);
    int(f.hp, `fences[${i}].hp`, 0, maxHp);
  });
  arr(o.traps, "traps").forEach((x, i) => {
    const t = exact(x, `traps[${i}]`, REPLAY_KEYS.trap);
    if (t.i !== i) fail(`traps[${i}].i must be ${i}`);
    str(t.ref, `traps[${i}].ref`);
    str(t.typeId, `traps[${i}].typeId`);
    int(t.x, `traps[${i}].x`, 0, FIELD_WIDTH - 1);
    int(t.y, `traps[${i}].y`, 0, FIELD_HEIGHT - 1);
  });
  const events = arr(o.events, "events");
  if (int(o.count, "count", 0, 100_000_000) !== events.length) fail(`count ${String(o.count)} but ${events.length} rows: the log is truncated or padded`);
  events.forEach((r, i) => {
    const row = arr(r, `events[${i}]`);
    if (row.length < 2) fail(`events[${i}] is too short`);
    row.forEach((c, k) => {
      if (k === 1 ? typeof c !== "string" : !isInt(c)) fail(`events[${i}][${k}] has the wrong type`);
    });
  });
  if (int(o.check, "check", 0, 4294967295) !== replaySeal(raw as ReplayLog)) fail("seal mismatch: the log was altered or corrupted");
  return raw as ReplayLog;
}

/** Decode the rows back into LogEvents (full keyframes). Validates arities and ids. */
function decodeRows(log: ReplayLog): LogEvent[] {
  const nUnits = log.units.length;
  const nFences = log.fences.length;
  const nTraps = log.traps.length;
  const events: LogEvent[] = [];
  let lastT = 0;
  // Keyframe fold state.
  const kfUnits: { u: number; x: number; y: number; hp: number; alive: boolean; cd: number; slow: number; root: number; abAt: number }[] = [];
  const kfFences: { f: number; hp: number }[] = log.fences.map((f) => ({ f: f.f, hp: -1 }));
  const kfSpent: boolean[] = log.traps.map(() => false);
  let firstKeyframe = true;
  log.events.forEach((row, n) => {
    const where = `events[${n}]`;
    const t = row[0] as number;
    const code = row[1] as string;
    if (t < lastT) fail(`${where}: tick ${t} after tick ${lastT} — rows out of order`);
    if (t >= log.ticks) fail(`${where}: tick ${t} is past the last tick ${log.ticks - 1}`);
    lastT = t;
    const f = (k: number): number => row[k] as number;
    const arity = (len: number): void => {
      if (row.length !== len) fail(`${where} (${code}) must have ${len} fields, has ${row.length}`);
    };
    const unitId = (k: number): number => int(row[k], `${where}[${k}] unit`, 0, nUnits - 1);
    const fenceId = (k: number): number => int(row[k], `${where}[${k}] fence`, 0, nFences - 1);
    const trapId = (k: number): number => int(row[k], `${where}[${k}] trap`, 0, nTraps - 1);
    const tg = (from: number): AbilityEffectLog[] => {
      if ((row.length - from) % 4 !== 0) fail(`${where}: ability targets must come in fours`);
      const out: AbilityEffectLog[] = [];
      for (let k = from; k < row.length; k += 4) {
        const kind = f(k) === 0 ? "unit" : f(k) === 1 ? "fence" : fail(`${where}: target kind`);
        out.push({ kind, id: kind === "unit" ? unitId(k + 1) : fenceId(k + 1), amount: f(k + 2), hp: f(k + 3) });
      }
      return out;
    };
    switch (code) {
      case "s":
        arity(5);
        events.push({ t, k: "spawn", u: unitId(2), x: f(3), y: f(4) });
        break;
      case "tg": {
        arity(5);
        const kind = f(3);
        if (kind < -1 || kind > 2) fail(`${where}: target kind`);
        events.push({ t, k: "target", u: unitId(2), target: kind < 0 ? null : { kind: TARGET_KINDS[kind]!, id: f(4) } });
        break;
      }
      case "p": {
        if (row.length < 4 || (row.length - 4) % 3 !== 0) fail(`${where}: path waypoints must come in threes`);
        const wp: [number, number, number][] = [];
        for (let k = 4; k < row.length; k += 3) wp.push([f(k), f(k + 1), int(row[k + 2], `${where} breach`, -1, nFences - 1)]);
        events.push({ t, k: "path", u: unitId(2), speed: f(3), wp });
        break;
      }
      case "h":
        arity(4);
        events.push({ t, k: "hold", u: unitId(2), holding: int(row[3], `${where} holding`, 0, 1) === 1 });
        break;
      case "c":
        arity(3);
        events.push({ t, k: "core_reached", u: unitId(2) });
        break;
      case "fh":
        arity(6);
        events.push({ t, k: "fence_hit", u: unitId(2), f: fenceId(3), damage: f(4), hp: f(5) });
        break;
      case "fb":
        arity(3);
        events.push({ t, k: "fence_broken", f: fenceId(2) });
        break;
      case "v":
        arity(4);
        events.push({ t, k: "speed", u: unitId(2), speed: f(3) });
        break;
      case "tf":
        arity(7);
        events.push({ t, k: "trap_fired", i: trapId(2), u: unitId(3), damage: f(4), hp: f(5), effect: EFFECTS[int(row[6], `${where} effect`, 0, 2)]! });
        break;
      case "tn":
        arity(4);
        events.push({ t, k: "trap_nullified", i: trapId(2), u: unitId(3) });
        break;
      case "ag":
        arity(4);
        events.push({ t, k: "aggro", u: unitId(2), v: unitId(3) });
        break;
      case "dg": {
        arity(5);
        const why = WHY[int(row[3], `${where} why`, 0, 2)]!;
        const amount = f(4);
        if (amount >= 0) {
          if (why !== "leash") fail(`${where}: only a leash disengage carries an amount`);
          events.push({ t, k: "disengage", u: unitId(2), why: "leash", amount });
        } else events.push({ t, k: "disengage", u: unitId(2), why });
        break;
      }
      case "rt":
        arity(3);
        events.push({ t, k: "returned", u: unitId(2) });
        break;
      case "rl":
        arity(4);
        events.push({ t, k: "released", u: unitId(2), v: unitId(3) });
        break;
      case "x":
        arity(6);
        events.push({ t, k: "hit", u: unitId(2), v: unitId(3), damage: f(4), hp: f(5) });
        break;
      case "d":
        arity(3);
        events.push({ t, k: "unit_died", u: unitId(2) });
        break;
      case "ab": {
        if (row.length < 4) fail(`${where}: ability row too short`);
        const a = ABILITY_ARCHETYPES[int(row[3], `${where} archetype`, 0, ABILITY_ARCHETYPES.length - 1)]! as AbilityArchetype;
        const u = unitId(2);
        // Key order as the resolver writes them (tg before the extras), so the decoded log serializes identically.
        if (a === "heal_radius") events.push({ t, k: "ability", u, a, tg: tg(5), charges: f(4) });
        else if (a === "self_buff") events.push({ t, k: "ability", u, a, tg: tg(5), until: f(4) });
        else if (a === "dash") events.push({ t, k: "ability", u, a, tg: tg(6), x: f(4), y: f(5) });
        else events.push({ t, k: "ability", u, a, tg: tg(4) });
        break;
      }
      case "kf": {
        let at = 2;
        const nU = int(row[at], `${where} unit count`, 0, nUnits);
        at++;
        if (row.length < at + nU * 8 + 1) fail(`${where}: keyframe units cut short`);
        const seen: boolean[] = [];
        for (let k = 0; k < nU; k++, at += 8) {
          const u = unitId(at);
          if (seen[u]) fail(`${where}: unit ${u} twice`);
          seen[u] = true;
          const hp = f(at + 3);
          kfUnits[u] = { u, x: f(at + 1), y: f(at + 2), hp, alive: hp > 0, cd: f(at + 4), slow: f(at + 5), root: f(at + 6), abAt: f(at + 7) };
        }
        const nF = int(row[at], `${where} fence count`, 0, nFences);
        at++;
        if (row.length < at + nF * 2 + 1) fail(`${where}: keyframe fences cut short`);
        for (let k = 0; k < nF; k++, at += 2) kfFences[fenceId(at)]!.hp = f(at + 1);
        const nT = int(row[at], `${where} trap count`, 0, nTraps);
        at++;
        if (row.length !== at + nT) fail(`${where}: keyframe traps cut short or padded`);
        for (let k = 0; k < nT; k++) kfSpent[trapId(at + k)] = true;
        if (firstKeyframe && (nU !== nUnits || nF !== nFences)) fail(`${where}: the first keyframe must list every unit and fence`);
        firstKeyframe = false;
        events.push({
          t,
          k: "keyframe",
          units: kfUnits.map((k) => ({ u: k.u, x: k.x, y: k.y, hp: k.hp, alive: k.alive, cd: k.cd, slow: k.slow, root: k.root, ab: k.abAt > t + 1 ? k.abAt - t - 1 : 0 })),
          fences: kfFences.map((k) => ({ f: k.f, hp: k.hp })),
          traps: kfSpent.map((spent, i) => ({ i, spent })),
        });
        break;
      }
      default:
        fail(`${where}: unknown code ${quoted(code)}`);
    }
  });
  return events;
}

/**
 * The stated outcome must be the one the events show (a check, not a decision: the reader
 * re-reads the end condition from the rows, it never decides one). overrun ⇔ a `core_reached`
 * on the last tick; held ⇔ no arrival and every raider has a `unit_died`; stalemate ⇔ neither,
 * and the cap ran out. Depth is bounded (0..1024, 1024 on an overrun) but not re-derived.
 */
function assertOutcomeMatches(log: ReplayLog, events: readonly LogEvent[]): void {
  const last = log.ticks - 1;
  const arrived = events.some((e) => e.k === "core_reached" && e.t === last);
  const earlier = events.some((e) => e.k === "core_reached" && e.t < last);
  const raiders = log.units.filter((u) => u.side === "attacker").map((u) => u.u);
  const dead = raiders.filter((u) => events.some((e) => e.k === "unit_died" && e.u === u));
  const shown: OutcomeKind = arrived ? "caravan_overrun" : dead.length === raiders.length ? "caravan_held" : "stalemate";
  if (earlier) fail("a raider reached the core before the last tick: the fight would have ended there");
  if (shown !== log.outcome.kind) fail(`outcome ${log.outcome.kind} but the log shows ${shown}`);
  if (shown === "stalemate" && log.ticks !== log.tickCap) fail("the log stops before the cap with neither an arrival nor a wipe: truncated");
}

/**
 * NUMBERS (see header): the rows must agree with each other, in log order. Checks only — every
 * number the renderer uses is still copied from a row.
 */
function assertNumbersConsistent(log: ReplayLog, events: readonly LogEvent[]): void {
  const hp = log.units.map((u) => u.hp);
  const dead = log.units.map(() => false);
  const fenceHp = log.fences.map((f) => f.hp);
  const after = (prev: number, damage: number) => (prev - damage < 0 ? 0 : prev - damage);
  const live = (u: number, e: LogEvent) => {
    if (dead[u]) fail(`tick ${e.t}: unit ${u} acts (${e.k}) after its death`);
  };
  const lands = (u: number, damage: number, stated: number, e: LogEvent) => {
    if (damage < 0 || stated !== after(hp[u]!, damage)) fail(`tick ${e.t}: ${e.k} on unit ${u} states hp ${stated}, but ${hp[u]} − ${damage} gives ${after(hp[u]!, damage)}`);
    hp[u] = stated;
  };
  const landsFence = (f: number, damage: number, stated: number, e: LogEvent) => {
    if (damage < 0 || stated !== after(fenceHp[f]!, damage)) fail(`tick ${e.t}: ${e.k} on fence ${f} states hp ${stated}, but ${fenceHp[f]} − ${damage} gives ${after(fenceHp[f]!, damage)}`);
    fenceHp[f] = stated;
  };
  for (const e of events) {
    switch (e.k) {
      case "hit":
        live(e.u, e);
        lands(e.v, e.damage, e.hp, e);
        break;
      case "trap_fired":
        lands(e.u, e.damage, e.hp, e);
        break;
      case "fence_hit":
        live(e.u, e);
        landsFence(e.f, e.damage, e.hp, e);
        break;
      case "fence_broken":
        if (fenceHp[e.f] !== 0) fail(`tick ${e.t}: fence ${e.f} breaks at hp ${fenceHp[e.f]}`);
        break;
      case "unit_died":
        if (hp[e.u] !== 0 || dead[e.u]) fail(`tick ${e.t}: unit ${e.u} dies at hp ${hp[e.u]}`);
        dead[e.u] = true;
        break;
      case "ability": {
        live(e.u, e);
        if (ABILITY_ARCHETYPES[log.units[e.u]!.ab] !== e.a) fail(`tick ${e.t}: unit ${e.u} fires ${e.a}, but its ability is ${ABILITY_ARCHETYPES[log.units[e.u]!.ab]}`);
        for (const g of e.tg) {
          if (e.a === "burst_radius" || e.a === "heavy_strike") {
            if (g.kind !== "unit") fail(`tick ${e.t}: ${e.a} targets a unit`);
            lands(g.id, g.amount, g.hp, e);
          } else if (e.a === "structure_breaker") {
            if (g.kind !== "fence") fail(`tick ${e.t}: structure_breaker targets a fence`);
            landsFence(g.id, g.amount, g.hp, e);
          } else if (e.a === "heal_radius") {
            if (g.kind !== "unit" || g.amount < 0 || g.hp !== hp[g.id]! + g.amount || g.hp > log.units[g.id]!.maxHp) fail(`tick ${e.t}: heal on unit ${g.id} states hp ${g.hp} from ${hp[g.id]} + ${g.amount}`);
            hp[g.id] = g.hp;
          } else if (g.kind !== "unit" || g.id !== e.u || g.hp !== hp[e.u]) fail(`tick ${e.t}: ${e.a} names its caster ${e.u} at its own hp`);
        }
        break;
      }
      default:
        break;
    }
  }
}

/** The keyframe ticks a log of `ticks` ticks must carry (see TRUNCATION AND CORRUPTION). */
export function expectedKeyframeTicks(ticks: number, interval: number): number[] {
  const out: number[] = [];
  for (let k = interval; k <= ticks; k += interval) out.push(k - 1);
  if (out.length === 0 || out[out.length - 1] !== ticks - 1) out.push(ticks - 1);
  return out;
}

// ─── interpolation (the INTERPOLATION CONTRACT, log.ts) ───────────────────────────

interface Mover {
  x: number;
  y: number;
  wps: { x: number; y: number; b: number }[];
  ax: number;
  ay: number;
  len: number;
  prog: number;
  speed: number;
  pend: number;
  holding: boolean;
  alive: boolean;
  hp: number;
}

interface Snapshot {
  /** The tick whose end this is (−1 = before tick 0). */
  readonly tick: number;
  readonly units: readonly Mover[];
  readonly fenceHp: readonly number[];
  readonly intact: readonly boolean[];
  readonly spent: readonly boolean[];
}

function copyMover(m: Mover): Mover {
  return { ...m, wps: m.wps.slice() };
}

const MAX_X = FIELD_WIDTH - 1;
const MAX_Y = FIELD_HEIGHT - 1;

/** The leg rule (MOVEMENT_LEG): advance `budget` along the route; a breach waypoint is not entered while its fence is intact. */
function step(u: Mover, budget: number, intact: readonly boolean[]): void {
  let rem = budget;
  while (rem > 0 && u.wps.length > 0) {
    const w = u.wps[0]!;
    if (w.b >= 0 && intact[w.b] !== false) break;
    if (u.len < 0) {
      u.ax = u.x;
      u.ay = u.y;
      u.prog = 0;
      u.len = isqrt((w.x - u.x) * (w.x - u.x) + (w.y - u.y) * (w.y - u.y));
    }
    const left = u.len - u.prog;
    if (left <= rem) {
      u.x = w.x;
      u.y = w.y;
      rem -= left;
      u.wps.shift();
      u.len = -1;
      continue;
    }
    const p = u.prog + rem;
    u.x = clamp(u.ax + legOffset(w.x - u.ax, p, u.len), 0, MAX_X);
    u.y = clamp(u.ay + legOffset(w.y - u.ay, p, u.len), 0, MAX_Y);
    u.prog = p;
    rem = 0;
  }
}

/** Advance the snapshot state by one tick using that tick's events. */
function playTick(s: { units: Mover[]; fenceHp: number[]; intact: boolean[]; spent: boolean[] }, evs: readonly LogEvent[]): void {
  for (const u of s.units) {
    if (u.pend >= 0) {
      u.speed = u.pend;
      u.pend = -1;
    }
  }
  for (const e of evs) {
    if (e.k === "path") {
      const u = s.units[e.u]!;
      u.wps = e.wp.map((w) => ({ x: w[0], y: w[1], b: w[2] }));
      u.len = -1;
      u.speed = e.speed;
    } else if (e.k === "hold") s.units[e.u]!.holding = e.holding;
  }
  // Each unit's own movement phase: `speed` along its route, or exactly the logged leash-clamped `amount`.
  s.units.forEach((u, id) => {
    if (!u.alive || u.holding) return;
    let budget = u.speed;
    for (const e of evs) if (e.k === "disengage" && e.u === id && "amount" in e) budget = e.amount;
    step(u, budget, s.intact);
  });
  // Phase 7: a dash is one more leg run of exactly its logged distance.
  for (const e of evs) if (e.k === "ability" && e.a === "dash") step(s.units[e.u]!, e.tg[0]!.amount, s.intact);
  // Numbers copied from rows; deaths and breaks as logged.
  for (const e of evs) {
    switch (e.k) {
      case "speed":
        s.units[e.u]!.pend = e.speed;
        break;
      case "hit":
        s.units[e.v]!.hp = e.hp;
        break;
      case "trap_fired":
        s.units[e.u]!.hp = e.hp;
        s.spent[e.i] = true;
        break;
      case "trap_nullified":
        s.spent[e.i] = true;
        break;
      case "fence_hit":
        s.fenceHp[e.f] = e.hp;
        break;
      case "ability":
        for (const g of e.tg) {
          if (g.kind === "unit") s.units[g.id]!.hp = g.hp;
          else s.fenceHp[g.id] = g.hp;
        }
        break;
      case "fence_broken":
        s.intact[e.f] = false;
        break;
      case "unit_died":
        s.units[e.u]!.alive = false;
        break;
      default:
        break;
    }
  }
}

function frameOf(tick: number, s: { units: readonly Mover[]; fenceHp: readonly number[]; intact: readonly boolean[]; spent: readonly boolean[] }): ReplayFrame {
  return {
    tick,
    units: s.units.map((u, i) => ({ u: i, x: u.x, y: u.y, hp: u.hp, alive: u.alive })),
    fences: s.fenceHp.map((hp, f) => ({ f, hp, intact: s.intact[f]! })),
    traps: s.spent.map((spent, i) => ({ i, spent })),
  };
}

/**
 * Read a stored replay: validate it, decode it, play the whole fight through by
 * interpolation and check every keyframe. Throws ReplayError on anything wrong — a
 * truncated, padded, reordered or edited log never renders.
 */
export function readReplay(raw: unknown): Replay {
  const log = assertReplayLog(raw);
  const events = decodeRows(log);
  const keyframes = events.filter((e): e is KeyframeEvent => e.k === "keyframe");
  const want = expectedKeyframeTicks(log.ticks, log.keyframeInterval);
  const got = keyframes.map((k) => k.t);
  if (got.length !== want.length || got.some((t, i) => t !== want[i])) fail(`keyframes at ticks [${got.join(", ")}], expected [${want.join(", ")}]: the log is truncated or altered`);
  const last = events[events.length - 1];
  if (last === undefined || last.k !== "keyframe" || last.t !== log.ticks - 1) fail("the last row must be the final keyframe: the log is truncated");
  const spawns = events.filter((e): e is Extract<LogEvent, { k: "spawn" }> => e.k === "spawn");
  if (spawns.length !== log.units.length || spawns.some((s, i) => s.u !== i || s.t !== 0)) fail("every unit must spawn once, at tick 0, in id order");
  assertOutcomeMatches(log, events);
  assertNumbersConsistent(log, events);

  const byTick: LogEvent[][] = [];
  for (let t = 0; t < log.ticks; t++) byTick.push([]);
  for (const e of events) byTick[e.t]!.push(e);

  const state = {
    units: spawns.map((s, i): Mover => ({ x: s.x, y: s.y, wps: [], ax: 0, ay: 0, len: -1, prog: 0, speed: 0, pend: -1, holding: false, alive: true, hp: log.units[i]!.hp })),
    fenceHp: log.fences.map((f) => f.hp),
    intact: log.fences.map((f) => f.hp > 0),
    spent: log.traps.map(() => false),
  };
  const snapshot = (tick: number): Snapshot => ({ tick, units: state.units.map(copyMover), fenceHp: state.fenceHp.slice(), intact: state.intact.slice(), spent: state.spent.slice() });
  const snapshots: Snapshot[] = [snapshot(-1)];
  let kf = 0;
  for (let t = 0; t < log.ticks; t++) {
    playTick(state, byTick[t]!);
    const k = keyframes[kf];
    if (k !== undefined && k.t === t) {
      kf++;
      for (const ku of k.units) {
        const m = state.units[ku.u]!;
        if (m.x !== ku.x || m.y !== ku.y || m.hp !== ku.hp || m.alive !== ku.alive) {
          fail(`interpolation diverges from the keyframe at tick ${t} for unit ${ku.u}: (${m.x}, ${m.y}, hp ${m.hp}) vs (${ku.x}, ${ku.y}, hp ${ku.hp}) — the log is incomplete or altered`);
        }
      }
      for (const kfF of k.fences) {
        if (state.fenceHp[kfF.f] !== kfF.hp || state.intact[kfF.f] !== kfF.hp > 0) fail(`fence ${kfF.f} disagrees with the keyframe at tick ${t}`);
      }
      for (const kt of k.traps) if (state.spent[kt.i] !== kt.spent) fail(`trap ${kt.i} disagrees with the keyframe at tick ${t}`);
      snapshots.push(snapshot(t));
    }
  }

  return {
    log,
    events,
    keyframes,
    eventsAt(tick: number): readonly LogEvent[] {
      return byTick[tick] ?? [];
    },
    frame(tick: number): ReplayFrame {
      if (!isInt(tick) || tick < 0 || tick >= log.ticks) fail(`frame ${String(tick)} is outside 0..${log.ticks - 1}`);
      let base = snapshots[0]!;
      for (const s of snapshots) if (s.tick <= tick) base = s;
      const s = { units: base.units.map(copyMover), fenceHp: base.fenceHp.slice(), intact: base.intact.slice(), spent: base.spent.slice() };
      for (let t = base.tick + 1; t <= tick; t++) playTick(s, byTick[t]!);
      return frameOf(tick, s);
    },
  };
}

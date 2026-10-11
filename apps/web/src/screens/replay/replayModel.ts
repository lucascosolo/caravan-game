/**
 * The replay player's model (chunk 22): PURE functions from the server's replay body to what
 * the player shows — the scene at a moment, the event feed, the end card's tally. Nothing
 * here simulates or decides anything:
 *
 *   - the log is read with `readReplay` (@caravan/resolver/replay — the READER only; this
 *     file never imports `resolve`, and the build's bundle check refuses a client bundle
 *     that contains the simulation: apps/web/scripts/check-bundle.mjs);
 *   - positions and HP come from `replay.frame(t)` (keyframe + the log's interpolation
 *     contract); between two ticks the player lerps for smoothness, which is presentation;
 *   - every feed line is ONE log row (a hit, a death, a trap, a fence break, an ability, the
 *     core reached), worded — the feed is a view of the log, not a derivation;
 *   - the outcome shown is the SERVER's (`view.outcome`, what the ledger recorded). If the
 *     log's own ending disagrees with it, the replay is refused rather than shown, so
 *     scrubbing to the end can only ever show the recorded outcome.
 *
 * A log the reader refuses (truncated, edited, a format it cannot read) fails loudly with
 * the reader's message and is never drawn.
 */
import { CORE_CELLS, ENTRY_BAND_DEPTH, GRID_HEIGHT, GRID_WIDTH, RING_ANCHORS, RING_SEGMENTS } from "@caravan/circle";
import { FIXED_POINT_SCALE } from "@caravan/content";
import { readReplay, type Replay, type ReplayFrame } from "@caravan/resolver/replay";
import type { ReplayLabelsView, ReplayView, ReplayViewer } from "../../api/replayTypes.ts";
import { EMPTY_SCENE, fixedToWorld, type EntryEdgeName, type IsoSceneState, type ReplayMarkEntity, type ReplayUnitEntity, type SceneGeometry, type WorldPoint } from "../../iso/index.ts";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.replay;

type LogEvent = Replay["events"][number];

export type FeedKind = "hit" | "death" | "trap" | "fence" | "ability" | "core";

export interface FeedLine {
  /** Stable key: the row's position in the log. */
  readonly key: number;
  readonly tick: number;
  readonly kind: FeedKind;
  readonly text: string;
}

export interface ReplayTally {
  readonly raidersFallen: number;
  readonly raiders: number;
  readonly defendersFallen: number;
  readonly defenders: number;
  readonly fencesBroken: number;
  readonly fences: number;
  readonly trapsSprung: number;
  readonly traps: number;
  readonly coreReached: boolean;
}

export interface ReplayModel {
  readonly replay: Replay;
  readonly viewer: ReplayViewer;
  /** Ticks simulated (frames 0 … ticks − 1). */
  readonly ticks: number;
  readonly tickRate: number;
  /** Seek targets: the full keyframes' ticks, ascending. */
  readonly keyframeTicks: readonly number[];
  readonly feed: readonly FeedLine[];
  readonly tally: ReplayTally;
  /** The edges the raiders came in from (where each one spawned). */
  readonly entryEdges: readonly EntryEdgeName[];
  /** The deepest raider, named from the viewer's side (null when the log names none). */
  readonly deepestName: string | null;
  /** Positions and HP after `tick` (cached). */
  frame(tick: number): ReplayFrame;
  /** The scene at a moment: `at` is a fractional tick (0 … ticks − 1). */
  scene(at: number): IsoSceneState;
}

export type OpenReplay = { readonly ok: true; readonly model: ReplayModel } | { readonly ok: false; readonly reason: string; readonly noLog: boolean; readonly compacted?: true };

/** How long a mark stays over the thing a row reported, in seconds of fight time. */
const MARK_SECONDS = 0.75;

/** The wagon circle's lattice and fixed features, from the resolver's geometry (the same source the trail's circle uses). */
export const REPLAY_GEOMETRY: SceneGeometry = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  coreCells: CORE_CELLS,
  ringCells: RING_SEGMENTS.map((s) => s.cell),
  anchorCells: RING_ANCHORS,
  entryBandDepth: ENTRY_BAND_DEPTH,
};

const cap = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

function edgeOf(p: WorldPoint): EntryEdgeName {
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const d: [EntryEdgeName, number][] = [
    ["north", cy],
    ["east", GRID_WIDTH - 1 - cx],
    ["south", GRID_HEIGHT - 1 - cy],
    ["west", cx],
  ];
  let best = d[0]!;
  for (const x of d) if (x[1] < best[1]) best = x;
  return best[0];
}

/** Each unit's name from the viewer's side: "your Well Digger 2", "the raiders' Dust Rider". */
function unitNames(labels: ReplayLabelsView, viewer: ReplayViewer): string[] {
  const count = new Map<string, number>();
  for (const u of labels.units) count.set(`${u.side}|${u.typeId}`, (count.get(`${u.side}|${u.typeId}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labels.units.map((u) => {
    const k = `${u.side}|${u.typeId}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    const base = (count.get(k) ?? 1) > 1 ? T.numbered(u.displayName, n) : u.displayName;
    const mine = viewer === "caravan" ? u.side === "defender" : u.side === "attacker";
    return mine ? T.yours(base) : u.side === "attacker" ? T.raiders(base) : T.caravans(base);
  });
}

/** Fences and traps are the caravan's: "your Brush Pile #3" to its player, "the caravan's …" to the party's owner. */
function structureName(display: string, viewer: ReplayViewer): string {
  return viewer === "caravan" ? T.yours(display) : T.caravans(display);
}

function fenceDisplay(f: ReplayLabelsView["fences"][number]): string {
  const m = /^f(\d+)$/.exec(f.ref);
  return T.fenceNumbered(f.displayName, m ? Number(m[1]) + 1 : f.segment + 1);
}

function abilityDetail(e: Extract<LogEvent, { k: "ability" }>, tickRate: number): string {
  const units = e.tg.filter((x) => x.kind === "unit");
  const fences = e.tg.filter((x) => x.kind === "fence");
  const total = e.tg.reduce((s, x) => s + x.amount, 0);
  switch (e.a) {
    case "heal_radius":
      return T.abilityHeal(units.length, total, e.charges);
    case "self_buff":
      // In force for the caster's hits through tick `until` (the row's own field).
      return T.abilityBuff(Math.max(0, Math.round(((e.until - e.t) * 10) / tickRate) / 10));
    case "dash":
      // The dash row's one effect is the caster itself; its `amount` is the distance covered (fixed-point).
      return T.abilityDash(Math.round((total * 10) / FIXED_POINT_SCALE) / 10);
    default:
      return fences.length > 0 && units.length === 0 ? T.abilityFenceDamage(total) : T.abilityDamage(e.tg.length, total);
  }
}

/** Word one log row, or null for rows that are mechanics rather than moments (targets, paths, keyframes…). */
function lineFor(e: LogEvent, names: readonly string[], view: ReplayView, tickRate: number): { kind: FeedKind; text: string } | null {
  const L = view.labels;
  const unit = (u: number): string => names[u] ?? T.unknown;
  const trap = (i: number): string => (L.traps[i] ? structureName(L.traps[i]!.displayName, view.viewer) : T.unknown);
  switch (e.k) {
    case "hit":
      return { kind: "hit", text: cap(e.hp > 0 ? T.hit(unit(e.u), unit(e.v), e.damage, e.hp) : T.hitDown(unit(e.u), unit(e.v), e.damage)) };
    case "unit_died":
      return { kind: "death", text: cap(T.died(unit(e.u))) };
    case "trap_fired":
      return { kind: "trap", text: cap(T.trapFired(trap(e.i), unit(e.u), e.damage, e.effect)) };
    case "trap_nullified":
      return { kind: "trap", text: cap(T.trapNullified(trap(e.i), unit(e.u))) };
    case "fence_broken": {
      const f = L.fences[e.f];
      return { kind: "fence", text: cap(T.fenceBroken(f ? structureName(fenceDisplay(f), view.viewer) : T.unknown)) };
    }
    case "ability": {
      const name = L.units[e.u]?.ability ?? T.anAbility;
      return { kind: "ability", text: cap(T.ability(unit(e.u), name, abilityDetail(e, tickRate))) };
    }
    case "core_reached":
      return { kind: "core", text: cap(T.coreReached(unit(e.u))) };
    default:
      return null;
  }
}

/**
 * Read and check a replay body. Refuses (with the reason the player shows): a body the server
 * marked not renderable, a missing log, a log the reader rejects, labels that do not match
 * the log, and a log whose ending disagrees with the outcome the server recorded.
 */
export function openReplay(view: ReplayView): OpenReplay {
  // PHASE-2 §36: the log was compacted to its results summary (past retention) — nothing to play, by design.
  if (view.compacted) return { ok: false, reason: view.reason ?? T.compactedReason, noLog: false, compacted: true };
  if (view.log === null || view.log === undefined) return { ok: false, reason: view.reason ?? T.noLogReason, noLog: true };
  if (!view.renderable) return { ok: false, reason: view.reason ?? T.notRenderableReason, noLog: false };
  let replay: Replay;
  try {
    replay = readReplay(view.log);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), noLog: false };
  }
  const log = replay.log;
  const L = view.labels;
  if (L.units.length !== log.units.length || L.fences.length !== log.fences.length || L.traps.length !== log.traps.length || L.units.some((u, i) => u.u !== i || u.side !== log.units[i]!.side)) {
    return { ok: false, reason: T.labelsMismatch, noLog: false };
  }
  const o = view.outcome;
  if (o && (o.kind !== log.outcome.kind || o.depth !== log.outcome.depth || o.endTick !== log.outcome.endTick)) {
    return { ok: false, reason: T.outcomeMismatch(o.kind, log.outcome.kind), noLog: false };
  }
  return { ok: true, model: buildModel(view, replay) };
}

function buildModel(view: ReplayView, replay: Replay): ReplayModel {
  const log = replay.log;
  const names = unitNames(view.labels, view.viewer);
  const feed: FeedLine[] = [];
  replay.events.forEach((e, i) => {
    const line = lineFor(e, names, view, log.tickRate);
    if (line) feed.push({ key: i, tick: e.t, ...line });
  });
  const died = new Set<number>();
  const broke = new Set<number>();
  const sprung = new Set<number>();
  let core = false;
  for (const e of replay.events) {
    if (e.k === "unit_died") died.add(e.u);
    else if (e.k === "fence_broken") broke.add(e.f);
    else if (e.k === "trap_fired" || e.k === "trap_nullified") sprung.add(e.i);
    else if (e.k === "core_reached") core = true;
  }
  const isRaider = (u: number): boolean => log.units[u]?.side === "attacker";
  const raiders = log.units.filter((u) => u.side === "attacker").length;
  const tally: ReplayTally = {
    raidersFallen: [...died].filter(isRaider).length,
    raiders,
    defendersFallen: [...died].filter((u) => !isRaider(u)).length,
    defenders: log.units.length - raiders,
    fencesBroken: broke.size,
    fences: log.fences.length,
    trapsSprung: sprung.size,
    traps: log.traps.length,
    coreReached: core,
  };
  const edges: EntryEdgeName[] = [];
  for (const e of replay.events) {
    if (e.k !== "spawn" || !isRaider(e.u)) continue;
    const edge = edgeOf(fixedToWorld(e));
    if (!edges.includes(edge)) edges.push(edge);
  }
  const order: readonly EntryEdgeName[] = ["north", "east", "south", "west"];
  edges.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  const cache = new Map<number, ReplayFrame>();
  const frame = (tick: number): ReplayFrame => {
    const t = Math.max(0, Math.min(log.ticks - 1, Math.floor(tick)));
    let f = cache.get(t);
    if (!f) {
      f = replay.frame(t);
      cache.set(t, f);
    }
    return f;
  };

  // Where each mark-worthy row happened, for the scene's marks.
  const markRows = replay.events.map((e, i) => ({ e, i })).filter(({ e }) => e.k === "trap_fired" || e.k === "trap_nullified" || e.k === "unit_died" || e.k === "fence_broken" || e.k === "ability" || e.k === "core_reached");
  const markTicks = Math.max(1, Math.round(MARK_SECONDS * log.tickRate));
  const coreCenter = { x: CORE_CELLS.reduce((s, c) => s + c.x + 0.5, 0) / CORE_CELLS.length, y: CORE_CELLS.reduce((s, c) => s + c.y + 0.5, 0) / CORE_CELLS.length };

  const scene = (at: number): IsoSceneState => {
    const t0 = Math.max(0, Math.min(log.ticks - 1, Math.floor(at)));
    const t1 = Math.min(log.ticks - 1, t0 + 1);
    const frac = Math.max(0, Math.min(1, at - t0));
    const a = frame(t0);
    const b = frame(t1);
    const replayUnits: ReplayUnitEntity[] = [];
    for (const u of a.units) {
      if (!u.alive) continue;
      const label = log.units[u.u]!;
      const next = b.units[u.u]!;
      const p = fixedToWorld(u);
      const q = next.alive ? fixedToWorld(next) : p;
      replayUnits.push({ id: String(u.u), pos: { x: p.x + (q.x - p.x) * frac, y: p.y + (q.y - p.y) * frac }, typeId: label.typeId, level: label.level, side: label.side, hpFraction: u.hp / label.maxHp });
    }
    const fences = a.fences.flatMap((f) => {
      const label = log.fences[f.f]!;
      const seg = RING_SEGMENTS[label.segment];
      return f.intact && seg ? [{ id: `f${f.f}`, cell: seg.cell, tierId: label.tierId, hp: f.hp, maxHp: label.maxHp }] : [];
    });
    const traps = log.traps.map((tr) => ({ id: `t${tr.i}`, pos: fixedToWorld(tr), typeId: tr.typeId, spent: a.traps[tr.i]?.spent ?? false }));
    const marks: ReplayMarkEntity[] = [];
    for (const { e, i } of markRows) {
      if (e.t > t0 || e.t + markTicks < at) continue;
      const age = Math.max(0, Math.min(1, (at - e.t) / markTicks));
      let pos: WorldPoint | null = null;
      let kind: ReplayMarkEntity["kind"];
      if (e.k === "trap_fired" || e.k === "trap_nullified") {
        const tr = log.traps[e.i];
        pos = tr ? fixedToWorld(tr) : null;
        kind = "trap";
      } else if (e.k === "fence_broken") {
        const seg = RING_SEGMENTS[log.fences[e.f]?.segment ?? -1];
        pos = seg ? { x: seg.cell.x + 0.5, y: seg.cell.y + 0.5 } : null;
        kind = "fence";
      } else if (e.k === "core_reached") {
        pos = coreCenter;
        kind = "core";
      } else if (e.k === "unit_died" || e.k === "ability") {
        const f = frame(e.t);
        const u = f.units[e.u];
        pos = u ? fixedToWorld(u) : null;
        kind = e.k === "unit_died" ? "death" : "ability";
      } else continue;
      if (pos) marks.push({ id: `m${i}`, pos, kind, age });
    }
    return { ...EMPTY_SCENE, showRadii: false, fences, traps, replayUnits, marks };
  };

  const deepest = log.outcome.deepestUnit;
  return {
    replay,
    viewer: view.viewer,
    ticks: log.ticks,
    tickRate: log.tickRate,
    keyframeTicks: replay.keyframes.map((k) => k.t),
    feed,
    tally,
    entryEdges: edges,
    deepestName: deepest >= 0 ? (names[deepest] ?? null) : null,
    frame,
    scene,
  };
}

/** Fight time of a tick, as m:ss. */
export function clock(tick: number, tickRate: number): string {
  const s = Math.max(0, Math.floor(tick / tickRate));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The next / previous keyframe from a moment (seek targets; the keyframe state is rendered, never re-simulated). */
export function nextKeyframe(model: ReplayModel, at: number): number {
  return model.keyframeTicks.find((k) => k > Math.floor(at)) ?? model.ticks - 1;
}
export function prevKeyframe(model: ReplayModel, at: number): number {
  const before = model.keyframeTicks.filter((k) => k < Math.floor(at));
  return before.length > 0 ? before[before.length - 1]! : 0;
}

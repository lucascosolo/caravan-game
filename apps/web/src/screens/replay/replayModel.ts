/**
 * The replay player's model (chunk 22): PURE functions from the server's replay body to what
 * the player shows — the scene at a moment, the event feed, the end card's tally, how each
 * fighter fared. Nothing here simulates or decides anything:
 *
 *   - the log is read with `readReplay` (@caravan/resolver/replay — the READER only; this
 *     file never imports `resolve`, and the build's bundle check refuses a client bundle
 *     that contains the simulation: apps/web/scripts/check-bundle.mjs);
 *   - positions and HP come from `replay.frame(t)` (keyframe + the log's interpolation
 *     contract); between two ticks the player lerps for smoothness, which is presentation;
 *   - every feed line is ONE log row (a hit, a fence hit, a death, a trap, a fence break, an
 *     ability, the core reached), worded — the feed is a view of the log, not a derivation.
 *     A death line names the row that took the unit to 0 HP just before it (QA S7);
 *   - every mark is ONE row too, drawn at the reader's frame positions for that row's tick: a
 *     hit is a line from the attacker to its target (QA S4);
 *   - siege pieces and stances are the SERVER's labels, taken from the job's snapshots (QA D1);
 *     the log carries neither and this file never guesses one;
 *   - the outcome shown is the SERVER's (`view.outcome`, what the ledger recorded). If the
 *     log's own ending disagrees with it, the replay is refused rather than shown, so
 *     scrubbing to the end can only ever show the recorded outcome.
 *
 * A log the reader refuses (truncated, edited, a format it cannot read) fails loudly with
 * the reader's message and is never drawn.
 */
import { CORE_CELLS, ENTRY_BAND_DEPTH, GRID_HEIGHT, GRID_WIDTH, RING_ORDER, RING_SEGMENTS, WAGONS } from "@caravan/circle";
import { FIXED_POINT_SCALE } from "@caravan/content";
import { readReplay, type Replay, type ReplayFrame } from "@caravan/resolver/replay";
import type { ReplayLabelsView, ReplayView, ReplayViewer } from "../../api/replayTypes.ts";
import {
  EMPTY_SCENE,
  fixedToWorld,
  type EntryEdgeName,
  type FrameRect,
  type IsoSceneState,
  type ReplayMarkEntity,
  type ReplayUnitEntity,
  type SceneGeometry,
  type CampFrame,
  campFrameOf,
  type SiegeEntity,
  type WorldPoint,
} from "../../iso/index.ts";
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
  /** The units the row names (QA N5: tapping the line highlights them on the field). */
  readonly units: readonly number[];
}

export interface ReplayTally {
  readonly raidersFallen: number;
  readonly raiders: number;
  readonly defendersFallen: number;
  readonly defenders: number;
  readonly fencesBroken: number;
  readonly fences: number;
  /** Traps that fired (QA N3: a siege-nullified trap is NOT counted here). */
  readonly trapsSprung: number;
  /** Traps the party's siege made harmless. */
  readonly trapsNullified: number;
  readonly traps: number;
  readonly coreReached: boolean;
}

/** How one fighter fared, from the rows only (QA S7). */
export interface UnitFate {
  readonly u: number;
  readonly side: "attacker" | "defender";
  readonly text: string;
}

export interface ReplayModel {
  readonly replay: Replay;
  readonly viewer: ReplayViewer;
  /** Ticks simulated (frames 0 … ticks − 1). */
  readonly ticks: number;
  readonly tickRate: number;
  /** Seek targets: the full keyframes' ticks, ascending. */
  readonly keyframeTicks: readonly number[];
  /** The log's keyframe interval in whole seconds (the Back / Forward step, QA N1). */
  readonly keyframeSeconds: number;
  readonly feed: readonly FeedLine[];
  readonly tally: ReplayTally;
  readonly fates: readonly UnitFate[];
  /** The edges the raiders came in from (where each one spawned). */
  readonly entryEdges: readonly EntryEdgeName[];
  /** The deepest raider, named from the viewer's side (null when the log names none). */
  readonly deepestName: string | null;
  /** The party's siege pieces as the server labelled them, with what each counters (QA D1). */
  readonly siegeNames: readonly string[];
  /** Which stances the fighters carried (the legend lists them only when some are known). */
  readonly hasStances: boolean;
  /** QA S2: the camera opens on the ring and the ground the raiders cross, not the whole field. */
  readonly frameRect: FrameRect;
  /** r2 N14: the ring and the ground the raiders cross; the camera moves in to it at `closeTick`. */
  readonly closeRect: FrameRect;
  readonly closeTick: number;
  /** Positions and HP after `tick` (cached). */
  frame(tick: number): ReplayFrame;
  /**
   * The scene at a moment: `at` is a fractional tick (0 … ticks − 1, and beyond for the
   * post-roll hold: the frame clamps at the last tick, the final rows' marks play out).
   * `speed` scales how many fight ticks a mark lasts so its fade is WALL-CLOCK (QA S5).
   */
  scene(at: number, opts?: SceneOptions): IsoSceneState;
}

export interface SceneOptions {
  readonly speed?: number;
  /** Units to highlight (the tapped feed line's). */
  readonly highlight?: ReadonlySet<number>;
}

export type OpenReplay = { readonly ok: true; readonly model: ReplayModel } | { readonly ok: false; readonly reason: string; readonly noLog: boolean; readonly compacted?: true };

/** How long a mark stays over the thing a row reported, in seconds of WALL time at any speed (presentation). */
export const MARK_SECONDS = 1.0;
/** A hit's line is shorter-lived: there are many of them. */
export const HIT_MARK_SECONDS = 0.4;
/** QA S1: the last frame is held this long (wall time) before the end card shows, so the deciding row is seen. */
export const END_HOLD_SECONDS = 1.0;
/** QA S2: how far past the ring, toward each entry edge, the opening frame reaches (cells). Presentation. */
const APPROACH_CELLS = 4;
/** QA S2: a lattice cell is never narrower than this on screen at the opening zoom (CSS px). Presentation. */
export const REPLAY_MIN_CELL_PX = 32;
/** r2 N14: at the opening (every raider's start cell in view) a cell may be this narrow (CSS px). Presentation. */
export const REPLAY_OPENING_MIN_CELL_PX = 12;
/** r2 N14: the camera moves in this long (fight seconds) before the first engagement. Presentation. */
export const CLOSE_LEAD_SECONDS = 1;
/** r3 N12: the opening frame (every start cell in view) is held at most this long (fight seconds). Presentation. */
export const OPENING_HOLD_SECONDS = 2;

/** The wagon circle's lattice and fixed features, from the resolver's geometry (the same source the trail's circle uses). */
export const REPLAY_GEOMETRY: SceneGeometry = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  coreCells: CORE_CELLS,
  ringCells: RING_SEGMENTS.map((s) => s.cell),
  ringOrder: RING_ORDER,
  wagons: WAGONS,
  entryBandDepth: ENTRY_BAND_DEPTH,
};

/** C3 / chunk 50: the replay opens on the whole camp, like the trail (entry bands need not be in frame at rest). */
export const REPLAY_CAMP: CampFrame = campFrameOf({ ringOrder: RING_ORDER, coreCells: CORE_CELLS, wagons: WAGONS });

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

/** Fight time of a tick, as m:ss. */
export function clock(tick: number, tickRate: number): string {
  const s = Math.max(0, Math.floor(tick / tickRate));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Read and check a replay body. Refuses (with the reason the player shows): a body the server
 * marked not renderable, a missing log, a log the reader rejects, labels that do not match
 * the log (side AND type, QA N7), a body for another fight than the one asked for (QA N7), and
 * a log whose ending disagrees with the outcome the server recorded.
 */
export function openReplay(view: ReplayView, expected?: { readonly jobId: string; readonly encounterIndex?: number }): OpenReplay {
  if (expected && (view.jobId !== expected.jobId || (expected.encounterIndex !== undefined && view.encounterIndex !== expected.encounterIndex))) {
    return { ok: false, reason: T.wrongFight, noLog: false };
  }
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
  const unitsMatch = L.units.length === log.units.length && L.units.every((u, i) => u.u === i && u.side === log.units[i]!.side && u.typeId === log.units[i]!.typeId && u.level === log.units[i]!.level);
  const fencesMatch = L.fences.length === log.fences.length && L.fences.every((f, i) => f.f === i && f.tierId === log.fences[i]!.tierId && f.segment === log.fences[i]!.segment);
  const trapsMatch = L.traps.length === log.traps.length && L.traps.every((t, i) => t.i === i && t.typeId === log.traps[i]!.typeId);
  if (!unitsMatch || !fencesMatch || !trapsMatch) return { ok: false, reason: T.labelsMismatch, noLog: false };
  const o = view.outcome;
  if (o && (o.kind !== log.outcome.kind || o.depth !== log.outcome.depth || o.endTick !== log.outcome.endTick)) {
    return { ok: false, reason: T.outcomeMismatch(o.kind, log.outcome.kind), noLog: false };
  }
  return { ok: true, model: buildModel(view, replay) };
}

interface Lethal {
  readonly by: string;
}

function buildModel(view: ReplayView, replay: Replay): ReplayModel {
  const log = replay.log;
  const L = view.labels;
  const viewer = view.viewer;
  const names = unitNames(L, viewer);
  const unit = (u: number): string => names[u] ?? T.unknown;
  const trapName = (i: number): string => (L.traps[i] ? structureName(L.traps[i]!.displayName, viewer) : T.unknown);
  const fenceName = (f: number): string => (L.fences[f] ? structureName(fenceDisplay(L.fences[f]!), viewer) : T.unknown);
  /** The siege piece that counters a trap of this category (the server's labels), if the party brought one. */
  const siegeFor = (i: number): string | null => {
    const cat = L.traps[i]?.category ?? null;
    if (cat === null) return null;
    return L.siege.find((s) => s.counters?.kind === "trap" && s.counters.category === cat)?.displayName ?? null;
  };

  // One forward pass over the rows: the feed, and what last took each unit to 0 HP (S7).
  const lethal = new Map<number, Lethal>();
  const feed: FeedLine[] = [];
  const push = (i: number, e: LogEvent, kind: FeedKind, text: string, units: number[]): void => {
    feed.push({ key: i, tick: e.t, kind, text: cap(text), units });
  };
  replay.events.forEach((e, i) => {
    switch (e.k) {
      case "hit":
        if (e.hp <= 0) lethal.set(e.v, { by: unit(e.u) });
        push(i, e, "hit", e.hp > 0 ? T.hit(unit(e.u), unit(e.v), e.damage, e.hp) : T.hitDown(unit(e.u), unit(e.v), e.damage), [e.u, e.v]);
        break;
      case "fence_hit":
        push(i, e, "hit", T.fenceHit(unit(e.u), fenceName(e.f), e.damage, e.hp), [e.u]);
        break;
      case "unit_died": {
        const by = lethal.get(e.u)?.by ?? null;
        push(i, e, "death", by ? T.diedTo(unit(e.u), by) : T.died(unit(e.u)), [e.u]);
        break;
      }
      case "trap_fired":
        if (e.hp <= 0) lethal.set(e.u, { by: trapName(e.i) });
        push(i, e, "trap", T.trapFired(trapName(e.i), unit(e.u), e.damage, e.effect), [e.u]);
        break;
      case "trap_nullified":
        push(i, e, "trap", T.trapNullified(trapName(e.i), unit(e.u), siegeFor(e.i), viewer), [e.u]);
        break;
      case "fence_broken":
        push(i, e, "fence", T.fenceBroken(fenceName(e.f)), []);
        break;
      case "ability": {
        const name = L.units[e.u]?.ability ?? T.anAbility;
        if (e.a === "burst_radius" || e.a === "heavy_strike" || e.a === "structure_breaker") {
          for (const x of e.tg) if (x.kind === "unit" && x.hp <= 0) lethal.set(x.id, { by: T.byAbility(unit(e.u), name) });
        }
        push(i, e, "ability", T.ability(unit(e.u), name, abilityDetail(e, log.tickRate)), [e.u, ...e.tg.filter((x) => x.kind === "unit" && x.id !== e.u).map((x) => x.id)]);
        break;
      }
      case "core_reached":
        push(i, e, "core", T.coreReached(unit(e.u)), [e.u]);
        break;
      default:
        break;
    }
  });

  const died = new Map<number, number>();
  const cored = new Map<number, number>();
  const broke = new Set<number>();
  const fired = new Set<number>();
  const nullified = new Set<number>();
  for (const e of replay.events) {
    if (e.k === "unit_died") died.set(e.u, e.t);
    else if (e.k === "fence_broken") broke.add(e.f);
    else if (e.k === "trap_fired") fired.add(e.i);
    else if (e.k === "trap_nullified") nullified.add(e.i);
    else if (e.k === "core_reached" && !cored.has(e.u)) cored.set(e.u, e.t);
  }
  const isRaider = (u: number): boolean => log.units[u]?.side === "attacker";
  const raiders = log.units.filter((u) => u.side === "attacker").length;
  const tally: ReplayTally = {
    raidersFallen: [...died.keys()].filter(isRaider).length,
    raiders,
    defendersFallen: [...died.keys()].filter((u) => !isRaider(u)).length,
    defenders: log.units.length - raiders,
    fencesBroken: broke.size,
    fences: log.fences.length,
    trapsSprung: fired.size,
    trapsNullified: [...nullified].filter((i) => !fired.has(i)).length,
    traps: log.traps.length,
    coreReached: cored.size > 0,
  };

  // S7: one line per fighter — the viewer's own first, then the other side.
  const timeRanOut = log.outcome.kind === "stalemate";
  const fates: UnitFate[] = log.units.map((u, i) => {
    const deathAt = died.get(i);
    const coreAt = cored.get(i);
    const fate =
      deathAt !== undefined
        ? T.fateFell(lethal.get(i)?.by ?? null, clock(deathAt, log.tickRate))
        : coreAt !== undefined
          ? T.fateCore(clock(coreAt, log.tickRate))
          : timeRanOut
            ? T.fateStandingTime
            : log.outcome.kind === "caravan_overrun"
              ? T.fateStandingOverrun
              : T.fateStanding;
    return { u: i, side: u.side, text: T.fateLine(cap(unit(i)), fate) };
  });
  const mineSide = viewer === "caravan" ? "defender" : "attacker";
  fates.sort((a, b) => (a.side === b.side ? a.u - b.u : a.side === mineSide ? -1 : 1));

  const edges: EntryEdgeName[] = [];
  for (const e of replay.events) {
    if (e.k !== "spawn" || !isRaider(e.u)) continue;
    const p = fixedToWorld(e);
    const edge = edgeOf(p);
    if (!edges.includes(edge)) edges.push(edge);
  }
  const order: readonly EntryEdgeName[] = ["north", "east", "south", "west"];
  edges.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // S2: the ring's bounding box, reaching APPROACH_CELLS further toward each edge raiders entered from.
  const ringXs = RING_ORDER.map((c) => c.x);
  const ringYs = RING_ORDER.map((c) => c.y);
  let x0 = Math.min(...ringXs) - 1;
  let x1 = Math.max(...ringXs) + 2;
  let y0 = Math.min(...ringYs) - 1;
  let y1 = Math.max(...ringYs) + 2;
  for (const edge of edges) {
    if (edge === "north") y0 -= APPROACH_CELLS;
    else if (edge === "south") y1 += APPROACH_CELLS;
    else if (edge === "west") x0 -= APPROACH_CELLS;
    else x1 += APPROACH_CELLS;
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(GRID_WIDTH, x1);
  y1 = Math.min(GRID_HEIGHT, y1);
  // Final play-test review r2 N14: the close frame (the ring and the ground just outside it) is
  // where the fight is decided; the OPENING frame also takes in every raider's start cell, so no
  // raider is off-canvas when the fight begins. The player follows to the close frame (`closeTick`).
  const closeRect: FrameRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, minCellPx: REPLAY_MIN_CELL_PX };
  let ox0 = x0;
  let oy0 = y0;
  let ox1 = x1;
  let oy1 = y1;
  for (const e of replay.events) {
    if (e.k !== "spawn" || !isRaider(e.u)) continue;
    const p = fixedToWorld(e);
    ox0 = Math.min(ox0, Math.floor(p.x) - 1);
    oy0 = Math.min(oy0, Math.floor(p.y) - 1);
    ox1 = Math.max(ox1, Math.floor(p.x) + 2);
    oy1 = Math.max(oy1, Math.floor(p.y) + 2);
  }
  ox0 = Math.max(0, ox0);
  oy0 = Math.max(0, oy0);
  ox1 = Math.min(GRID_WIDTH, ox1);
  oy1 = Math.min(GRID_HEIGHT, oy1);
  const frameRect: FrameRect = { x: ox0, y: oy0, w: ox1 - ox0, h: oy1 - oy0, minCellPx: REPLAY_OPENING_MIN_CELL_PX };
  // The first engagement (a hit, a fence hit, a trap, an ability), a beat early: the camera moves in then.
  const firstEngagement = replay.events.find((e) => ["hit", "fence_hit", "trap_fired", "trap_nullified", "ability", "unit_died", "core_reached"].includes(e.k));
  // Final play-test review r3 N12: the wide opening is held only long enough to see where the raiders
  // start (OPENING_HOLD_SECONDS), then the camera moves in, however long the walk to the first engagement.
  const closeTick = Math.min(Math.round(OPENING_HOLD_SECONDS * log.tickRate), Math.max(0, (firstEngagement?.t ?? 0) - Math.round(CLOSE_LEAD_SECONDS * log.tickRate)));

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

  // Mark-worthy rows, by tick (a scene looks back only as far as a mark can last).
  const markRows = new Map<number, { e: LogEvent; i: number }[]>();
  replay.events.forEach((e, i) => {
    if (!["hit", "fence_hit", "trap_fired", "trap_nullified", "unit_died", "fence_broken", "ability", "core_reached"].includes(e.k)) return;
    const list = markRows.get(e.t);
    if (list) list.push({ e, i });
    else markRows.set(e.t, [{ e, i }]);
  });
  const coreCenter = { x: CORE_CELLS.reduce((s, c) => s + c.x + 0.5, 0) / CORE_CELLS.length, y: CORE_CELLS.reduce((s, c) => s + c.y + 0.5, 0) / CORE_CELLS.length };
  const segCenter = (f: number): WorldPoint | null => {
    const seg = RING_SEGMENTS[log.fences[f]?.segment ?? -1];
    return seg ? { x: seg.cell.x + 0.5, y: seg.cell.y + 0.5 } : null;
  };
  const unitAt = (tick: number, u: number): WorldPoint | null => {
    const x = frame(tick).units[u];
    return x ? fixedToWorld(x) : null;
  };

  // D1: siege pieces at the edge the raiders came in from (siege has no cell in the model).
  const siege: SiegeEntity[] = L.siege.map((s, i) => ({ id: `${i}:${s.typeId}`, typeId: s.typeId, edge: edges[i % Math.max(1, edges.length)] ?? "north", along: 0.3 + 0.2 * (i % 3) }));
  const siegeNames = L.siege.map((s) => (s.counters ? T.siegeCounters(s.displayName, s.counters.kind, s.counters.category) : s.displayName));

  const scene = (at: number, opts: SceneOptions = {}): IsoSceneState => {
    const speed = Math.max(0.25, opts.speed ?? 1);
    const markTicks = Math.max(1, Math.round(MARK_SECONDS * log.tickRate * speed));
    const hitTicks = Math.max(1, Math.round(HIT_MARK_SECONDS * log.tickRate * speed));
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
      const stance = L.units[u.u]?.stance ?? null;
      replayUnits.push({
        id: String(u.u),
        pos: { x: p.x + (q.x - p.x) * frac, y: p.y + (q.y - p.y) * frac },
        typeId: label.typeId,
        level: label.level,
        side: label.side,
        hpFraction: u.hp / label.maxHp,
        ...(stance ? { stance } : {}),
        ...(opts.highlight?.has(u.u) ? { highlighted: true } : {}),
      });
    }
    const fences = a.fences.flatMap((f) => {
      const label = log.fences[f.f]!;
      const seg = RING_SEGMENTS[label.segment];
      return f.intact && seg ? [{ id: `f${f.f}`, cell: seg.cell, tierId: label.tierId, hp: f.hp, maxHp: label.maxHp }] : [];
    });
    const traps = log.traps.map((tr) => ({ id: `t${tr.i}`, pos: fixedToWorld(tr), typeId: tr.typeId, spent: a.traps[tr.i]?.spent ?? false }));
    const marks: ReplayMarkEntity[] = [];
    for (let t = Math.max(0, t0 - markTicks); t <= t0; t++) {
      for (const { e, i } of markRows.get(t) ?? []) {
        const life = e.k === "hit" || e.k === "fence_hit" ? hitTicks : markTicks;
        if (e.t + life < at) continue;
        const age = Math.max(0, Math.min(1, (at - e.t) / life));
        let pos: WorldPoint | null = null;
        let from: WorldPoint | null = null;
        let kind: ReplayMarkEntity["kind"];
        if (e.k === "hit") {
          from = unitAt(e.t, e.u);
          pos = unitAt(e.t, e.v);
          kind = "hit";
        } else if (e.k === "fence_hit") {
          from = unitAt(e.t, e.u);
          pos = segCenter(e.f);
          kind = "fence_hit";
        } else if (e.k === "trap_fired" || e.k === "trap_nullified") {
          const tr = log.traps[e.i];
          pos = tr ? fixedToWorld(tr) : null;
          kind = "trap";
        } else if (e.k === "fence_broken") {
          pos = segCenter(e.f);
          kind = "fence";
        } else if (e.k === "core_reached") {
          pos = coreCenter;
          kind = "core";
        } else if (e.k === "unit_died" || e.k === "ability") {
          pos = unitAt(e.t, e.u);
          kind = e.k === "unit_died" ? "death" : "ability";
        } else continue;
        if (pos) marks.push({ id: `m${i}`, pos, kind, age, ...(from ? { from } : {}) });
      }
    }
    // C3: a broken segment stays on the ring where the log broke it, drawn broken (scene state only; never hit-tested).
    const brokenFences = a.fences.flatMap((f) => {
      const label = log.fences[f.f]!;
      const seg = RING_SEGMENTS[label.segment];
      return !f.intact && seg ? [{ id: `f${f.f}`, cell: seg.cell, tierId: label.tierId, hp: 0, maxHp: label.maxHp }] : [];
    });
    return { ...EMPTY_SCENE, showRadii: false, fences, brokenFences, traps, replayUnits, marks, siege };
  };

  const deepest = log.outcome.deepestUnit;
  return {
    replay,
    viewer,
    ticks: log.ticks,
    tickRate: log.tickRate,
    keyframeTicks: replay.keyframes.map((k) => k.t),
    keyframeSeconds: Math.max(1, Math.round(log.keyframeInterval / log.tickRate)),
    feed,
    tally,
    fates,
    entryEdges: edges,
    deepestName: deepest >= 0 ? (names[deepest] ?? null) : null,
    siegeNames,
    hasStances: L.units.some((u) => u.stance !== null),
    frameRect,
    closeRect,
    closeTick,
    frame,
    scene,
  };
}

/** The next / previous keyframe from a moment (seek targets; the keyframe state is rendered, never re-simulated). */
export function nextKeyframe(model: ReplayModel, at: number): number {
  return model.keyframeTicks.find((k) => k > Math.floor(at)) ?? model.ticks - 1;
}
export function prevKeyframe(model: ReplayModel, at: number): number {
  const before = model.keyframeTicks.filter((k) => k < Math.floor(at));
  return before.length > 0 ? before[before.length - 1]! : 0;
}

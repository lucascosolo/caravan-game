/**
 * The shared isometric scene (chunk 08): ONE PixiJS 8 scene reused by the wagon circle on
 * the trail (this chunk), the home town (chunk 17) and the battle replay (chunk 22). There
 * must never be a second implementation.
 *
 * What it owns: the island (decorative tiers and cliff edges — inert scenery the resolver
 * never sees), the flat central play area, the four parked wagons on the ring corners, the
 * core, the lattice overlay (visible ONLY while something is being dragged, fading in and
 * out — instantly under reduced motion), the entity layers (fences, traps, posts, attackers,
 * siege; and, for the town, structures and static board units) in painter's depth order,
 * and the overlays (aggro/leash/attack-range circles at true radii, the threat bands on
 * the attacker's entry edges, gap markers, the merge board's cells while a unit is dragged).
 * The town (chunk 17) sets `geometry.fixtures = "town"`: no core, no parked wagons — it is
 * a settlement, never a circle, and never attacked. Its only motion is the mine wheel's
 * ambient turn, which counts nothing.
 *
 * What it does not own: any game state. `update(state)` redraws from a plain description
 * (types.ts); `setCamera` applies a pure camera (projection.ts); `hitTest` is pure (hit.ts).
 * Pointer handling lives in IsoCanvas.tsx so this file never sees a DOM event.
 *
 * Replay (chunk 22): `replayUnits` and `marks` in the state. Entity positions are world points, not cells. A replay feeds interpolated
 * positions straight in (`fixedToWorld` on the log's fixed-point coordinates).
 */
// Final review S2: the hosted client runs under a CSP without 'unsafe-eval' (apps/server/src/web/static.ts).
// PixiJS compiles its uniform / shader sync functions with `new Function` unless this module swaps in
// the eval-free implementations; it must load before any renderer is created.
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Text, UPDATE_PRIORITY } from "pixi.js";
import { TUNABLES } from "@caravan/content";
import {
  TILE_H,
  TILE_W,
  cellDiamond,
  cellToWorld,
  depthKey,
  project,
  radiusEllipse,
  type Camera,
  type CellLike,
  type WorldPoint,
} from "./projection.ts";
import { PALETTE, PLACEHOLDER_SKINS, type PlaceholderSkin, type Skin, type SkinRegistry } from "./skins.ts";
import type { EntryEdgeName, IsoSceneState, PostEntity, ReplayMarkEntity, StructureEntity } from "./types.ts";

/** The lattice and the fixed features the scene draws for every place (from the resolver's geometry). */
export interface SceneGeometry {
  readonly width: number;
  readonly height: number;
  readonly coreCells: readonly CellLike[];
  readonly ringCells: readonly CellLike[];
  readonly anchorCells: readonly CellLike[];
  readonly entryBandDepth: number;
  /**
   * Which fixed features the place has: the wagon circle's core and parked wagons
   * ("circle", the default) or none ("town" — the settlement draws its own structures from
   * the state; it has no core because it is never attacked, GUARDRAILS §0).
   */
  readonly fixtures?: "circle" | "town";
}

export interface SceneOptions {
  readonly geometry: SceneGeometry;
  readonly skins?: SkinRegistry;
  /** `prefers-reduced-motion`: the lattice fade becomes an instant toggle. */
  readonly reducedMotion: boolean;
  readonly background: number;
  /**
   * QA-22 N9: stop the ticker when nothing has changed for a few frames (it wakes on any update,
   * camera move or resize). Opt-in: the replay sets it. The trail's formation e2e fails with it on
   * (a page scroll lands after `scrollTo(0, 0)` on the wheel step) and the cause is not yet
   * understood, so the trail and the town keep the always-running ticker until it is.
   */
  readonly sleepWhenIdle?: boolean;
}

/** GRID_VISIBILITY tunable: lattice alpha while a drag is active, and the fade speed per second. */
export const LATTICE_ALPHA = 0.38;
export const LATTICE_FADE_PER_SECOND = 6;
/** MINE_ANIMATION (chunk 17, presentation only): `TUNABLES.MINE_WHEEL_MS_PER_TURN` in the registry (QA-17 N7). */
const MINE_WHEEL_MS_PER_TURN = TUNABLES.MINE_WHEEL_MS_PER_TURN;

const TIERS = [
  { grow: 7, drop: 34, fill: PALETTE.tier3 },
  { grow: 4.5, drop: 22, fill: PALETTE.tier2 },
  { grow: 2.2, drop: 10, fill: PALETTE.tier1 },
] as const;
const CLIFF_HEIGHT = 14;

/** Fixed scrub positions on the tiers (world coords relative to the lattice). No randomness anywhere. */
const SCRUB: readonly { x: number; y: number; r: number }[] = [
  { x: -3, y: 4, r: 0.5 },
  { x: -4.5, y: 20, r: 0.7 },
  { x: 35, y: 8, r: 0.6 },
  { x: 36.5, y: 27, r: 0.5 },
  { x: 10, y: -3.5, r: 0.6 },
  { x: 26, y: -4.5, r: 0.5 },
  { x: 6, y: 35, r: 0.7 },
  { x: 22, y: 36, r: 0.5 },
  { x: -6, y: 12, r: 0.4 },
  { x: 38, y: 16, r: 0.4 },
];

/** QA-22 N9: the ticker sleeps after this many frames with nothing changing (it wakes on any update, camera move or resize). */
const IDLE_FRAMES_BEFORE_STOP = 3;

/** Per canvas element: the mounts queued on it, run one after another (QA-22 N9). */
interface CanvasSlot {
  chain: Promise<void>;
  queued: number;
}
const SLOTS = new WeakMap<HTMLCanvasElement, CanvasSlot>();
function canvasSlot(canvas: HTMLCanvasElement): CanvasSlot {
  let s = SLOTS.get(canvas);
  if (!s) {
    s = { chain: Promise.resolve(), queued: 0 };
    SLOTS.set(canvas, s);
  }
  return s;
}

/**
 * Destroy an Application. When another scene is about to mount on the same canvas it will get
 * the SAME WebGL context back from `getContext`, so the context must not be force-lost here
 * (PixiJS's GlContextSystem.destroy calls WEBGL_lose_context.loseContext()).
 */
function destroyApp(app: Application, keepContext: boolean): void {
  if (keepContext) {
    const ctx = (app.renderer as unknown as { context?: { extensions?: { loseContext?: unknown } } }).context;
    if (ctx?.extensions) ctx.extensions.loseContext = null;
  }
  app.destroy(false, { children: true });
}

function pts(points: readonly { x: number; y: number }[]): number[] {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y);
  return out;
}

export class IsoScene {
  private app: Application | null = null;
  private readonly world = new Container();
  private readonly island = new Graphics();
  private readonly lattice = new Graphics();
  /** Threat bands and gap markers: redrawn only when the threat overlay itself changes (QA S2). */
  private readonly threatLayer = new Graphics();
  private threatSig = "";
  private readonly overlays = new Graphics();
  /** Entity nodes kept across updates (QA S2): a node is rebuilt only when what it LOOKS like changes; a move only repositions it. */
  private readonly nodes = new Map<string, { sig: string; node: Container }>();
  private ghostSig = "";
  private readonly entities = new Container();
  /** Chunk 22 QA S5: replay marks sit ABOVE the units, so a death cross or an ability star is never hidden by a sprite. */
  private readonly marksLayer = new Graphics();
  private readonly ghost = new Container();
  /** Chunk 22 QA N9: destroy() was called (possibly before `mount` finished initialising). */
  private disposed = false;
  /** Frames the renderer has drawn (a probe: the e2e and tests read it to prove the canvas keeps updating). */
  private frames = 0;
  /** Idle frames since the last change; the ticker stops after a few (QA N9: no rAF while nothing moves). */
  private idleFrames = 0;
  private readonly skins: SkinRegistry;
  private latticeTarget = 0;
  private state: IsoSceneState | null = null;
  private mounted = false;
  /** The mine's head-frame wheel (chunk 17): the ONE ambient animation, cosmetic, no counting. */
  private mineWheel: Graphics | null = null;
  private mineActive = false;
  /** The wheel's angle survives the per-update redraw of the structures (QA-17 N1: no snap back to 0). */
  private mineWheelAngle = 0;
  /** `prefers-reduced-motion`, live: the canvas follows changes to the setting (QA-17 N7). */
  private reducedMotion: boolean;
  /** The canvas this scene mounted on (QA-22 N9: mounts on one element are serialized). */
  private canvas: HTMLCanvasElement | null = null;

  constructor(private readonly opts: SceneOptions) {
    this.skins = opts.skins ?? PLACEHOLDER_SKINS;
    this.entities.sortableChildren = true;
    this.lattice.alpha = 0;
    this.reducedMotion = opts.reducedMotion;
    this.world.addChild(this.island, this.lattice, this.threatLayer, this.overlays, this.entities, this.marksLayer, this.ghost);
  }

  /**
   * Create the renderer on a canvas. Resolves once the first frame can draw; rejects if WebGL is unavailable.
   *
   * QA-22 N9: mounts on ONE canvas element are serialized (React StrictMode mounts, unmounts and
   * remounts on the same element before the first `app.init` resolves). A scene destroyed before
   * its init finished destroys its Application as soon as it exists — without forcing a context
   * loss when a later scene is queued on the same canvas, since that scene will use the same
   * WebGL context. Before this, the first Application was never destroyed and kept drawing stale
   * state on the shared canvas ("location is not from the associated program").
   */
  async mount(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
    const slot = canvasSlot(canvas);
    slot.queued += 1;
    const prior = slot.chain;
    let release!: () => void;
    slot.chain = new Promise<void>((r) => (release = r));
    try {
      await prior;
      slot.queued -= 1;
      if (this.disposed) return;
      const app = new Application();
      await app.init({
        canvas,
        width,
        height,
        background: this.opts.background,
        antialias: true,
        resolution: Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
        autoDensity: true,
        preference: "webgl",
      });
      if (this.disposed) {
        destroyApp(app, slot.queued > 0);
        return;
      }
      this.app = app;
      this.canvas = canvas;
    } finally {
      release();
    }
    const app = this.app;
    if (!app) return;
    // QA N3: PixiJS's AccessibilitySystem (loaded with the browser extensions during init)
    // builds its own hidden DOM overlay on Tab — and a touch "hook" button on mobile — which
    // would duplicate, out of date, the DOM lists that ARE this scene's text alternative.
    // Its listeners and hook are torn down before the first frame; it never activates.
    (app.renderer as unknown as { accessibility?: { destroy(): void } }).accessibility?.destroy();
    this.mounted = true;
    app.stage.addChild(this.world);
    this.drawIsland();
    this.drawLattice();
    app.ticker.add((ticker) => this.tick(ticker.deltaMS));
    // After the render (LOW priority): count the frame, then stop the ticker once nothing has changed for a few frames.
    app.ticker.add(
      () => {
        this.frames += 1;
        if (this.animating()) this.idleFrames = 0;
        else if (this.opts.sleepWhenIdle && ++this.idleFrames >= IDLE_FRAMES_BEFORE_STOP) app.ticker.stop();
      },
      undefined,
      UPDATE_PRIORITY.UTILITY,
    );
    if (this.state) this.update(this.state);
  }

  /** Frames drawn so far (a probe for tests and the e2e: a canvas that stops updating stops counting). */
  get framesDrawn(): number {
    return this.frames;
  }

  /** Whether the ticker is running (QA N9: it sleeps while nothing changes). */
  get ticking(): boolean {
    return this.app?.ticker.started ?? false;
  }

  /** Something on screen is still moving by itself: the lattice fade, or the town's mine wheel. */
  private animating(): boolean {
    return this.lattice.alpha !== this.latticeTarget || (this.mineWheel !== null && this.mineActive && !this.reducedMotion);
  }

  /** A change was made: draw again (restart the ticker if it went to sleep). */
  private wake(): void {
    this.idleFrames = 0;
    const t = this.app?.ticker;
    if (t && !t.started) t.start();
  }

  /** Whether PixiJS's accessibility overlay is active (it must never be, QA N3; the e2e presses Tab and asks). */
  get hasPixiAccessibility(): boolean {
    const r = this.app?.renderer as unknown as { accessibility?: { isActive?: boolean } } | undefined;
    return r?.accessibility?.isActive ?? false;
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  resize(width: number, height: number): void {
    this.app?.renderer.resize(width, height);
    this.wake();
  }

  setCamera(cam: Camera): void {
    this.world.position.set(cam.offsetX, cam.offsetY);
    this.world.scale.set(cam.zoom);
    this.wake();
  }

  destroy(): void {
    this.disposed = true;
    this.mounted = false;
    if (this.app) destroyApp(this.app, this.canvas !== null && canvasSlot(this.canvas).queued > 0);
    this.app = null;
  }

  // ── per-frame: the lattice fade, and (town) the mine wheel's ambient turn ─────────

  private tick(deltaMs: number): void {
    // MINE_ANIMATION (chunk 17): a slow, constant turn while the mine is active (below the
    // storage cap), still at the cap, still under reduced motion. It never advances a
    // number: the displayed balance is the server's, read lazily, not ticked here.
    if (this.mineWheel && this.mineActive && !this.reducedMotion) {
      this.mineWheelAngle = (this.mineWheelAngle + (2 * Math.PI * deltaMs) / MINE_WHEEL_MS_PER_TURN) % (2 * Math.PI);
      this.mineWheel.rotation = this.mineWheelAngle;
    }
    const target = this.latticeTarget;
    if (this.lattice.alpha === target) return;
    if (this.reducedMotion) {
      this.lattice.alpha = target;
      return;
    }
    const step = (LATTICE_FADE_PER_SECOND * deltaMs) / 1000;
    this.lattice.alpha = this.lattice.alpha < target ? Math.min(target, this.lattice.alpha + step) : Math.max(target, this.lattice.alpha - step);
  }

  /** Follow a change to `prefers-reduced-motion` while mounted (QA-17 N7): the wheel stops, the fade becomes a toggle. */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.lattice.alpha = this.latticeTarget;
    this.wake();
  }

  /** Current lattice opacity: tests and the e2e assert it is 0 whenever nothing is dragged. */
  get latticeAlpha(): number {
    return this.lattice.alpha;
  }

  // ── static layers ─────────────────────────────────────────────────────────────────

  private drawIsland(): void {
    const g = this.island;
    const { width, height } = this.opts.geometry;
    g.clear();
    // Water under everything.
    const outer = TIERS[0];
    const sea = [
      project({ x: -outer.grow - 6, y: -outer.grow - 6 }),
      project({ x: width + outer.grow + 6, y: -outer.grow - 6 }),
      project({ x: width + outer.grow + 6, y: height + outer.grow + 6 }),
      project({ x: -outer.grow - 6, y: height + outer.grow + 6 }),
    ].map((p) => ({ x: p.x, y: p.y + outer.drop + CLIFF_HEIGHT }));
    g.poly(pts(sea)).fill({ color: PALETTE.water, alpha: 0.55 });
    // Decorative tiers, outermost first, each dropped lower with a cliff face on its two lower edges.
    for (const tier of TIERS) {
      const top = [
        project({ x: -tier.grow, y: -tier.grow }),
        project({ x: width + tier.grow, y: -tier.grow }),
        project({ x: width + tier.grow, y: height + tier.grow }),
        project({ x: -tier.grow, y: height + tier.grow }),
      ].map((p) => ({ x: p.x, y: p.y + tier.drop }));
      const [n, e, s, w] = top as [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
      g.poly(pts([e, s, { x: s.x, y: s.y + CLIFF_HEIGHT }, { x: e.x, y: e.y + CLIFF_HEIGHT }])).fill(PALETTE.cliff);
      g.poly(pts([s, w, { x: w.x, y: w.y + CLIFF_HEIGHT }, { x: s.x, y: s.y + CLIFF_HEIGHT }])).fill({ color: PALETTE.cliff, alpha: 0.85 });
      g.poly(pts([n, e, s, w])).fill(tier.fill);
    }
    for (const s of SCRUB) {
      const p = project(s);
      const tierIndex = Math.max(0, Math.min(2, Math.floor(Math.max(-s.x, -s.y, s.x - width, s.y - height) / 2.3)));
      const drop = TIERS[2 - tierIndex]!.drop;
      g.ellipse(p.x, p.y + drop, s.r * TILE_W * 0.4, s.r * TILE_H * 0.4).fill({ color: 0x4f6b3a, alpha: 0.9 });
    }
    // The flat central play area: level ground the resolver sees as a 32×32 lattice.
    const field = [project({ x: 0, y: 0 }), project({ x: width, y: 0 }), project({ x: width, y: height }), project({ x: 0, y: height })];
    g.poly(pts(field)).fill(PALETTE.ground).stroke({ width: 2, color: PALETTE.groundLine, alpha: 0.9 });
  }

  private drawLattice(): void {
    const g = this.lattice;
    const { width, height } = this.opts.geometry;
    g.clear();
    for (let x = 0; x <= width; x++) {
      const a = project({ x, y: 0 });
      const b = project({ x, y: height });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    for (let y = 0; y <= height; y++) {
      const a = project({ x: 0, y });
      const b = project({ x: width, y });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: 1, color: PALETTE.lattice, alpha: 1 });
  }

  // ── dynamic layers ────────────────────────────────────────────────────────────────

  update(state: IsoSceneState): void {
    this.state = state;
    if (!this.mounted) return;
    // GRID_VISIBILITY: the lattice shows while something is being dragged OR placed by tap (QA D5).
    this.latticeTarget = state.drag || state.placing ? LATTICE_ALPHA : 0;
    this.drawThreat(state);
    this.drawOverlays(state);
    this.drawEntities(state);
    this.drawMarks(state);
    this.drawGhost(state);
    this.wake();
  }

  /** Replay marks (chunk 22): one shape per kind of log row, fading with age, ABOVE the units (QA S5). */
  private drawMarks(state: IsoSceneState): void {
    const g = this.marksLayer;
    g.clear();
    for (const m of state.marks ?? []) this.drawMark(g, m);
  }

  private drawThreat(state: IsoSceneState): void {
    const sig = state.threat ? `${state.threat.entryEdges.join(",")}|${state.threat.gapCells.map((c) => `${c.x},${c.y}`).join(";")}` : "";
    if (sig === this.threatSig) return;
    this.threatSig = sig;
    const g = this.threatLayer;
    const geo = this.opts.geometry;
    g.clear();
    if (!state.threat) return;
    // Threat bands: the edges this party enters from. Informational, low alpha.
    for (const edge of state.threat.entryEdges) {
      const d = geo.entryBandDepth;
      for (let y = 0; y < geo.height; y++) {
        for (let x = 0; x < geo.width; x++) {
          const inBand = (edge === "north" && y < d) || (edge === "south" && y >= geo.height - d) || (edge === "west" && x < d) || (edge === "east" && x >= geo.width - d);
          if (inBand) g.poly(pts(cellDiamond({ x, y }))).fill({ color: PALETTE.attacker, alpha: 0.18 });
        }
      }
    }
    // Gaps: a soft outline on each open ring position. Same colour as the lattice, never a warning.
    for (const c of state.threat.gapCells) g.poly(pts(cellDiamond(c))).stroke({ width: 1.5, color: PALETTE.gap, alpha: 0.35 });
  }

  private drawOverlays(state: IsoSceneState): void {
    const g = this.overlays;
    const geo = this.opts.geometry;
    g.clear();
    // The merge board (town) while a unit is being dragged: its cells outlined, so the
    // limited surface is visible exactly when it matters and reads as a place at rest.
    if (state.drag?.kind === "unit" && state.boardCells) {
      const taken = new Set((state.boardUnits ?? []).map((u) => `${Math.floor(u.pos.x)},${Math.floor(u.pos.y)}`));
      for (const c of state.boardCells) {
        const free = !taken.has(`${c.x},${c.y}`);
        g.poly(pts(cellDiamond(c))).fill({ color: free ? PALETTE.lattice : PALETTE.outlineDark, alpha: free ? 0.22 : 0.15 });
      }
    }
    // Ring positions while a fence is being dragged or placed by tap, so the 28 targets are visible.
    if (state.drag?.kind === "fence" || state.placing === "fence") {
      const taken = new Set(state.fences.map((f) => `${f.cell.x},${f.cell.y}`));
      for (const c of geo.ringCells) {
        const free = !taken.has(`${c.x},${c.y}`);
        g.poly(pts(cellDiamond(c))).fill({ color: free ? PALETTE.lattice : PALETTE.outlineDark, alpha: free ? 0.22 : 0.15 });
      }
    }
    // Aggro / leash / attack reach as continuous circles at TRUE radii (QA B2: projected world circles).
    if (state.showRadii) for (const p of state.posts) this.drawRadii(g, p.pos, p, p.selected ? 0.9 : 0.5);
    // Entry-band tint for the core so the goal is readable.
    if ((geo.fixtures ?? "circle") === "circle") for (const c of geo.coreCells) g.poly(pts(cellDiamond(c))).fill({ color: PALETTE.core, alpha: 0.18 });
  }

  /**
   * A replay mark: the shape says what happened (colour is a second channel, never the only one).
   * Sized to at least a unit's footprint (QA S5); a mark over a unit is lifted to the unit's body.
   */
  private drawMark(g: Graphics, m: ReplayMarkEntity): void {
    const c = project(m.pos);
    const alpha = Math.max(0, Math.min(1, 1 - m.age)) * 0.95;
    const r = TILE_W * (0.62 + 0.3 * m.age);
    const body = TILE_H * 0.35; // a unit marker's centre sits this far above its ground point
    switch (m.kind) {
      case "hit":
      case "fence_hit": {
        if (!m.from) break;
        const a = project(m.from);
        const ay = a.y - body;
        const by = m.kind === "hit" ? c.y - body : c.y - TILE_H * 0.5;
        if (m.kind === "hit") {
          g.moveTo(a.x, ay).lineTo(c.x, by).stroke({ width: 2.5, color: PALETTE.hit, alpha });
        } else {
          // Dashed: a blow on a fence, not on a unit.
          const n = 6;
          for (let i = 0; i < n; i += 2) {
            g.moveTo(a.x + ((c.x - a.x) * i) / n, ay + ((by - ay) * i) / n).lineTo(a.x + ((c.x - a.x) * (i + 1)) / n, ay + ((by - ay) * (i + 1)) / n);
          }
          g.stroke({ width: 2.5, color: PALETTE.hit, alpha });
        }
        // A small burst where it landed.
        g.circle(c.x, by, 3 + 3 * (1 - m.age)).fill({ color: PALETTE.hit, alpha: alpha * 0.8 });
        break;
      }
      case "trap":
        g.ellipse(c.x, c.y, r, r / 2).stroke({ width: 3.5, color: PALETTE.trap, alpha });
        break;
      case "death": {
        const y = c.y - body;
        g.moveTo(c.x - r / 2, y - r / 4).lineTo(c.x + r / 2, y + r / 4).moveTo(c.x + r / 2, y - r / 4).lineTo(c.x - r / 2, y + r / 4);
        g.stroke({ width: 6, color: PALETTE.outlineDark, alpha });
        g.moveTo(c.x - r / 2, y - r / 4).lineTo(c.x + r / 2, y + r / 4).moveTo(c.x + r / 2, y - r / 4).lineTo(c.x - r / 2, y + r / 4);
        g.stroke({ width: 3, color: PALETTE.lattice, alpha });
        break;
      }
      case "fence":
        g.rect(c.x - r / 2, c.y - r / 4 - body, r, r / 2).stroke({ width: 3.5, color: PALETTE.fenceBreak, alpha });
        break;
      case "ability": {
        const spikes = 6;
        const y = c.y - body;
        for (let i = 0; i < spikes; i++) {
          const a = (i / spikes) * Math.PI * 2;
          g.moveTo(c.x + Math.cos(a) * r * 0.2, y + (Math.sin(a) * r * 0.2) / 2).lineTo(c.x + Math.cos(a) * r * 0.6, y + (Math.sin(a) * r * 0.6) / 2);
        }
        g.stroke({ width: 3, color: PALETTE.siege, alpha });
        break;
      }
      case "core":
        g.poly(pts([{ x: c.x, y: c.y - r / 2 }, { x: c.x + r, y: c.y }, { x: c.x, y: c.y + r / 2 }, { x: c.x - r, y: c.y }])).stroke({ width: 3.5, color: PALETTE.core, alpha });
        break;
    }
  }

  /**
   * The three circles, told apart by LINE STYLE, never by "inner/outer" (QA S11: which one
   * is larger depends on the type): aggro reach = thick solid line with a light fill; leash
   * = thin solid line; attack reach = dotted line. The radii are what the resolver measures
   * (reach includes UNIT_RADIUS; the caller passes them). Hold never leaves its post, so
   * only its attack reach is drawn; guard and reserve draw all three (a reserve post strikes
   * whatever enters its attack reach from the first tick and pursues once the ring is breached).
   */
  private drawRadii(
    g: Graphics,
    pos: WorldPoint,
    r: { readonly aggroRadius: number; readonly leashDistance: number; readonly attackRange: number; readonly stance: PostEntity["stance"] },
    alpha: number,
  ): void {
    const c = project(pos);
    const ell = (radius: number, width: number, a: number, fill = false) => {
      if (radius <= 0) return;
      const { rx, ry } = radiusEllipse(radius);
      g.ellipse(c.x, c.y, rx, ry).stroke({ width, color: PALETTE.defender, alpha: a });
      if (fill) g.ellipse(c.x, c.y, rx, ry).fill({ color: PALETTE.defender, alpha: a * 0.08 });
    };
    const dotted = (radius: number, a: number) => {
      if (radius <= 0) return;
      const { rx, ry } = radiusEllipse(radius);
      const n = Math.max(24, Math.round(radius * 16));
      for (let i = 0; i < n; i += 2) {
        const t0 = (i / n) * Math.PI * 2;
        const t1 = ((i + 1) / n) * Math.PI * 2;
        g.moveTo(c.x + rx * Math.cos(t0), c.y + ry * Math.sin(t0)).lineTo(c.x + rx * Math.cos(t1), c.y + ry * Math.sin(t1));
      }
      g.stroke({ width: 2, color: PALETTE.defender, alpha: a });
    };
    if (r.stance !== "hold") {
      ell(r.leashDistance, 1, alpha * 0.6);
      ell(r.aggroRadius, 2.5, alpha, true);
    }
    dotted(r.attackRange, alpha);
  }

  /** Reuse the node under `key` if it still looks the same (`sig`), else build it; then place it at `pos`. */
  private keep(seen: Set<string>, key: string, sig: string, pos: WorldPoint | null, layerBias: number, build: () => Container): Container {
    seen.add(key);
    const prior = this.nodes.get(key);
    let node: Container;
    if (prior && prior.sig === sig) node = prior.node;
    else {
      if (prior) prior.node.destroy({ children: true });
      node = build();
      this.nodes.set(key, { sig, node });
      this.entities.addChild(node);
    }
    if (pos) {
      const s = project(pos);
      node.position.set(s.x, s.y);
      node.zIndex = depthKey(pos, layerBias);
    }
    return node;
  }

  private drawEntities(state: IsoSceneState): void {
    const seen = new Set<string>();
    const geo = this.opts.geometry;
    this.mineActive = state.mine?.active ?? false;
    // Fixed features first: the core and the four parked wagons (the wagon circle only).
    if ((geo.fixtures ?? "circle") === "circle" && geo.coreCells.length > 0) {
      const coreCenter = {
        x: geo.coreCells.reduce((s, c) => s + c.x + 0.5, 0) / geo.coreCells.length,
        y: geo.coreCells.reduce((s, c) => s + c.y + 0.5, 0) / geo.coreCells.length,
      };
      this.keep(seen, "core", "", coreCenter, 1, () => this.marker(this.skins.core(), coreCenter, 1.6, 1, false));
      geo.anchorCells.forEach((a, i) => this.keep(seen, `anchor:${i}`, "", cellToWorld(a), 1, () => this.marker(this.skins.wagonAnchor(), cellToWorld(a), 1, 1, false)));
    }
    // Town structures (chunk 17): inert scenery, drawn from the state, never simulated.
    for (const s of state.structures ?? []) {
      const sig = `${s.kind}|${s.cell.x},${s.cell.y}|${s.w}x${s.h}|${s.label}`;
      const prior = this.nodes.get(`structure:${s.id}`);
      const rebuilt = !prior || prior.sig !== sig;
      if (rebuilt && s.kind === "mine") this.mineWheel = null;
      this.keep(seen, `structure:${s.id}`, sig, null, 1, () => this.structure(s));
    }
    // Board units (chunk 17): static markers, a level badge, no stance, no radii, no HP.
    for (const u of state.boardUnits ?? []) {
      this.keep(seen, `unit:${u.id}`, `${u.typeId}|${u.mergeLevel}|${u.selected ? 1 : 0}|${u.dimmed ? 1 : 0}|${u.target ? 1 : 0}`, u.pos, 2, () => {
        const skin = this.skins.unit(u.typeId, "defender");
        const node = this.marker(u.dimmed && skin.kind === "placeholder" ? { ...skin, fill: PALETTE.trapSpent } : skin, u.pos, u.target ? 1.15 : 1, 2, u.selected ?? false);
        node.addChild(this.badge(String(u.mergeLevel), TILE_W * 0.22, -TILE_H * 0.55));
        if (u.target) {
          const ring = new Graphics();
          ring.ellipse(0, 0, TILE_W * 0.42, TILE_H * 0.42).stroke({ width: 2, color: PALETTE.core, alpha: 0.95 });
          node.addChild(ring);
        }
        return node;
      });
    }
    for (const f of state.fences) {
      const pos = cellToWorld(f.cell);
      this.keep(seen, `fence:${f.id}`, `${f.tierId}|${f.hp}/${f.maxHp}|${f.selected ? 1 : 0}`, pos, 1, () => {
        const node = this.marker(this.skins.fence(f.tierId), pos, 1, 1, f.selected ?? false);
        const bar = this.hpBar(f.hp / Math.max(1, f.maxHp), PALETTE.defender);
        bar.position.set(0, -TILE_H * 0.9);
        node.addChild(bar);
        return node;
      });
    }
    for (const t of state.traps) {
      this.keep(seen, `trap:${t.id}`, `${t.typeId}|${t.spent ? 1 : 0}|${t.selected ? 1 : 0}`, t.pos, 1, () => {
        const skin = this.skins.trap(t.typeId);
        return this.marker(t.spent && skin.kind === "placeholder" ? { ...skin, fill: PALETTE.trapSpent } : skin, t.pos, 1, 1, t.selected ?? false);
      });
    }
    for (const p of state.posts) {
      this.keep(seen, `post:${p.id}`, `${p.typeId}|${p.mergeLevel}|${p.stance}|${p.hpFraction}|${p.selected ? 1 : 0}`, p.pos, 2, () => {
        const node = this.marker(this.skins.unit(p.typeId, "defender"), p.pos, 1, 2, p.selected ?? false);
        const bar = this.hpBar(p.hpFraction, PALETTE.defender);
        bar.position.set(0, -TILE_H * 1.15);
        node.addChild(bar);
        node.addChild(this.badge(String(p.mergeLevel), TILE_W * 0.22, -TILE_H * 0.55));
        node.addChild(this.stanceMark(p.stance));
        return node;
      });
    }
    for (const a of state.attackers) {
      this.keep(seen, `attacker:${a.id}`, `${a.typeId}|${a.mergeLevel}|${a.selected ? 1 : 0}`, a.pos, 2, () => {
        const node = new Container();
        // QA N10: the skin seam's promise — an attacker carries a DASHED ring under its marker
        // (a defender a solid outline), so the two sides differ by shape, not colour alone.
        node.addChild(this.dashedRing());
        const m = this.marker(this.skins.unit(a.typeId, "attacker"), { x: 0, y: 0 }, 1, 2, a.selected ?? false);
        m.position.set(0, 0);
        node.addChild(m);
        node.addChild(this.badge(String(a.mergeLevel), TILE_W * 0.22, -TILE_H * 0.55));
        return node;
      });
    }
    // Replay units (chunk 22): both sides, wherever the log puts them; HP bar from the log's HP.
    for (const u of state.replayUnits ?? []) {
      // HP is quantized for the node signature only, so a unit is rebuilt on a visible change, not every hit point.
      // (QA S4: a single hit can move nothing here; the hit's own mark shows it.)
      const hpQ = Math.round(Math.max(0, Math.min(1, u.hpFraction)) * 20);
      this.keep(seen, `replay:${u.id}`, `${u.typeId}|${u.level}|${u.side}|${hpQ}|${u.stance ?? ""}|${u.highlighted ? 1 : 0}`, u.pos, 2, () => {
        const node = new Container();
        if (u.highlighted) {
          const ring = new Graphics();
          ring.ellipse(0, 0, TILE_W * 0.55, TILE_H * 0.55).stroke({ width: 3, color: PALETTE.core, alpha: 1 });
          node.addChild(ring);
        }
        if (u.side === "attacker") node.addChild(this.dashedRing());
        const m = this.marker(this.skins.unit(u.typeId, u.side), { x: 0, y: 0 }, 1, 2, u.highlighted ?? false);
        m.position.set(0, 0);
        node.addChild(m);
        const bar = this.hpBar(hpQ / 20, u.side === "attacker" ? PALETTE.attacker : PALETTE.defender);
        bar.position.set(0, -TILE_H * 1.15);
        node.addChild(bar);
        node.addChild(this.badge(String(u.level), TILE_W * 0.22, -TILE_H * 0.55));
        if (u.stance === "guard" || u.stance === "hold" || u.stance === "reserve") node.addChild(this.stanceMark(u.stance));
        else if (u.stance) node.addChild(this.raiderStanceMark(u.stance));
        return node;
      });
    }
    for (const s of state.siege) {
      const pos = this.edgePoint(s.edge, s.along);
      this.keep(seen, `siege:${s.id}`, `${s.typeId}`, pos, 2, () => this.marker(this.skins.siege(s.typeId), pos, 1, 2, false));
    }
    for (const [key, v] of this.nodes) {
      if (seen.has(key)) continue;
      if (key.startsWith("structure:") && v.node.children.includes(this.mineWheel as Graphics)) this.mineWheel = null;
      v.node.destroy({ children: true });
      this.nodes.delete(key);
    }
  }

  private dashedRing(): Graphics {
    const g = new Graphics();
    const rx = TILE_W * 0.38;
    const ry = TILE_H * 0.38;
    const n = 16;
    for (let i = 0; i < n; i += 2) {
      const t0 = (i / n) * Math.PI * 2;
      const t1 = ((i + 1) / n) * Math.PI * 2;
      g.moveTo(rx * Math.cos(t0), ry * Math.sin(t0)).lineTo(rx * Math.cos(t1), ry * Math.sin(t1));
    }
    g.stroke({ width: 2, color: PALETTE.attacker, alpha: 0.95 });
    return g;
  }

  private drawGhost(state: IsoSceneState): void {
    const d = state.drag;
    const sig = d && d.cell ? `${d.kind}|${d.typeId}|${d.valid ? 1 : 0}|${d.radii ? `${d.radii.aggroRadius},${d.radii.leashDistance},${d.radii.attackRange},${d.radii.stance}` : ""}` : "";
    if (!d || !d.cell) {
      if (this.ghostSig !== "") this.ghost.removeChildren().forEach((c) => c.destroy({ children: true }));
      this.ghostSig = "";
      return;
    }
    const s = project(cellToWorld(d.cell));
    if (sig !== this.ghostSig) {
      this.ghost.removeChildren().forEach((c) => c.destroy({ children: true }));
      this.ghostSig = sig;
      // Built around the origin; the container is then moved to the cell (a move is a reposition only).
      const g = new Graphics();
      g.poly(pts(cellDiamond({ x: -0.5, y: -0.5 }))).fill({ color: d.valid ? PALETTE.defender : PALETTE.attacker, alpha: 0.35 });
      this.ghost.addChild(g);
      if (d.radii) {
        const rg = new Graphics();
        this.drawRadii(rg, { x: 0, y: 0 }, d.radii, 0.9);
        this.ghost.addChild(rg);
      }
      const skin =
        d.kind === "fence"
          ? this.skins.fence(d.typeId)
          : d.kind === "trap"
            ? this.skins.trap(d.typeId)
            : this.skins.unit(d.typeId, d.kind === "attacker" ? "attacker" : "defender");
      const m = this.marker(skin, { x: 0, y: 0 }, 1, 3, false);
      m.alpha = 0.75;
      this.ghost.addChild(m);
    }
    this.ghost.position.set(s.x, s.y);
  }

  // ── drawing helpers ───────────────────────────────────────────────────────────────

  /**
   * A town structure (chunk 17): a flat-roofed false-front building, a corral or the mine
   * head-frame, built from the same placeholder vocabulary as the markers (sprites arrive
   * with chunk 26 through the skin seam). The footprint sits on `cell`..`cell + (w, h)`.
   */
  private structure(s: StructureEntity): Container {
    const node = new Container();
    const origin = project({ x: s.cell.x, y: s.cell.y });
    node.position.set(origin.x, origin.y);
    node.zIndex = depthKey({ x: s.cell.x + s.w, y: s.cell.y + s.h }, 1);
    const g = new Graphics();
    // Footprint corners relative to the origin.
    const n = { x: 0, y: 0 };
    const e = project({ x: s.cell.x + s.w, y: s.cell.y });
    const so = project({ x: s.cell.x + s.w, y: s.cell.y + s.h });
    const w = project({ x: s.cell.x, y: s.cell.y + s.h });
    const rel = (p: { x: number; y: number }) => ({ x: p.x - origin.x, y: p.y - origin.y });
    const E = rel(e);
    const S = rel(so);
    const W = rel(w);
    if (s.kind === "corral") {
      g.poly(pts([n, E, S, W])).fill({ color: 0x9c8a5a, alpha: 0.7 }).stroke({ width: 2, color: PALETTE.timber });
      for (const [a, b] of [
        [n, E],
        [E, S],
        [S, W],
        [W, n],
      ] as const) {
        g.moveTo(a.x, a.y - 6).lineTo(b.x, b.y - 6).stroke({ width: 2, color: PALETTE.timber });
      }
    } else {
      const height = s.kind === "mine" ? TILE_H * 1.1 : TILE_H * 1.6;
      const roofColor = s.kind === "mine" ? 0x5a4a3a : 0x6b4e2e;
      const wallColor = s.kind === "mine" ? 0x7a6a55 : 0xb08a5a;
      // Two visible walls (south-east and south-west faces), then the roof on top.
      g.poly(pts([E, S, { x: S.x, y: S.y - height }, { x: E.x, y: E.y - height }])).fill(wallColor).stroke({ width: 1, color: PALETTE.outlineDark });
      g.poly(pts([S, W, { x: W.x, y: W.y - height }, { x: S.x, y: S.y - height }])).fill({ color: wallColor, alpha: 0.8 }).stroke({ width: 1, color: PALETTE.outlineDark });
      g.poly(pts([n, E, S, W].map((p) => ({ x: p.x, y: p.y - height })))).fill(roofColor).stroke({ width: 1.5, color: PALETTE.outlineDark });
      if (s.kind === "mine") {
        // The head-frame: an A-frame over the shaft and the wheel the tick turns.
        const top = { x: S.x, y: S.y - height - TILE_H * 1.4 };
        g.moveTo(E.x, E.y - height).lineTo(top.x, top.y).lineTo(W.x, W.y - height).stroke({ width: 3, color: PALETTE.timber });
        const wheel = new Graphics();
        wheel.circle(0, 0, TILE_H * 0.45).stroke({ width: 3, color: PALETTE.wire });
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 4;
          wheel.moveTo(Math.cos(a) * TILE_H * 0.45, Math.sin(a) * TILE_H * 0.45).lineTo(-Math.cos(a) * TILE_H * 0.45, -Math.sin(a) * TILE_H * 0.45).stroke({ width: 2, color: PALETTE.wire });
        }
        wheel.position.set(top.x, top.y);
        wheel.rotation = this.mineWheelAngle;
        this.mineWheel = wheel;
        node.addChild(g, wheel);
      } else node.addChild(g);
    }
    if (s.kind === "corral") node.addChild(g);
    const t = new Text({ text: s.label, style: { fontSize: 10, fill: 0xf1e9d6, fontFamily: "system-ui, sans-serif", fontWeight: "700" }, resolution: 2 });
    t.anchor.set(0.5);
    t.position.set(S.x, S.y + 4);
    node.addChild(t);
    return node;
  }

  private marker(skin: Skin, pos: WorldPoint, scaleMul: number, layerBias: number, selected: boolean): Container {
    if (skin.kind !== "placeholder") throw new Error("sprite skins arrive with chunk 26; only placeholder skins can be drawn");
    const node = new Container();
    const s = project(pos);
    node.position.set(s.x, s.y);
    node.zIndex = depthKey(pos, layerBias);
    node.addChild(this.placeholder(skin, scaleMul, selected));
    return node;
  }

  private placeholder(skin: PlaceholderSkin, scaleMul: number, selected: boolean): Container {
    const node = new Container();
    const g = new Graphics();
    const w = TILE_W * skin.scale * scaleMul;
    const h = TILE_H * skin.scale * scaleMul;
    const strokeW = selected ? 3 : 1.5;
    const stroke = selected ? 0xf1e9d6 : skin.outline;
    switch (skin.shape) {
      case "circle":
        g.ellipse(0, -h * 0.35, w / 2, h / 2).fill(skin.fill).stroke({ width: strokeW, color: stroke });
        break;
      case "square":
        g.rect(-w / 2, -h * 0.9, w, h).fill(skin.fill).stroke({ width: strokeW, color: stroke });
        break;
      case "triangle":
        g.poly([0, -h * 1.1, w / 2, h * 0.15, -w / 2, h * 0.15]).fill(skin.fill).stroke({ width: strokeW, color: stroke });
        break;
      case "diamond":
        g.poly([0, -h / 2, w / 2, 0, 0, h / 2, -w / 2, 0]).fill(skin.fill).stroke({ width: strokeW, color: stroke });
        break;
      case "bar": {
        // A fence segment: a post-and-rail bar lying along the cell's diamond.
        g.poly([-w / 2, 0, 0, -h / 2, w / 2, 0, 0, h / 2]).fill({ color: skin.fill, alpha: 0.95 }).stroke({ width: strokeW, color: stroke });
        g.rect(-w * 0.06, -h * 1.1, w * 0.12, h * 1.1).fill(skin.fill).stroke({ width: 1, color: stroke });
        break;
      }
      case "wagon": {
        // A parked wagon: body, canvas top, two wheels.
        g.ellipse(-w * 0.28, h * 0.1, w * 0.12, h * 0.26).fill(0x2a2520).stroke({ width: 1, color: stroke });
        g.ellipse(w * 0.28, h * 0.1, w * 0.12, h * 0.26).fill(0x2a2520).stroke({ width: 1, color: stroke });
        g.roundRect(-w * 0.42, -h * 0.7, w * 0.84, h * 0.75, 3).fill(skin.fill).stroke({ width: strokeW, color: stroke });
        g.ellipse(0, -h * 0.75, w * 0.4, h * 0.45).fill(0xe8dcc0).stroke({ width: 1, color: stroke });
        break;
      }
    }
    node.addChild(g);
    if (skin.glyph) {
      const t = new Text({ text: skin.glyph, style: { fontSize: 11, fill: 0x1b1a17, fontFamily: "system-ui, sans-serif", fontWeight: "700" }, resolution: 2 });
      t.anchor.set(0.5);
      t.position.set(0, skin.shape === "diamond" ? 0 : -h * 0.4);
      node.addChild(t);
    }
    return node;
  }

  private hpBar(fraction: number, color: number): Graphics {
    const g = new Graphics();
    const w = TILE_W * 0.5;
    const f = Math.max(0, Math.min(1, fraction));
    g.rect(-w / 2, 0, w, 3).fill({ color: 0x121110, alpha: 0.85 });
    g.rect(-w / 2, 0, w * f, 3).fill(color);
    return g;
  }

  private badge(text: string, x: number, y: number): Container {
    const node = new Container();
    const g = new Graphics();
    g.circle(0, 0, 6.5).fill(0x121110).stroke({ width: 1, color: 0xf1e9d6 });
    const t = new Text({ text, style: { fontSize: 8, fill: 0xf1e9d6, fontFamily: "system-ui, sans-serif", fontWeight: "700" }, resolution: 2 });
    t.anchor.set(0.5);
    node.addChild(g, t);
    node.position.set(x, y);
    return node;
  }

  private stanceMark(stance: PostEntity["stance"]): Graphics {
    // Guard: open chevron (goes out); hold: square (stays); reserve: hollow ring (waits).
    const g = new Graphics();
    const y = TILE_H * 0.35;
    if (stance === "guard") g.moveTo(-5, y + 4).lineTo(0, y - 2).lineTo(5, y + 4).stroke({ width: 2, color: 0xf1e9d6 });
    else if (stance === "hold") g.rect(-4, y - 2, 8, 6).fill(0xf1e9d6);
    else g.circle(0, y + 1, 4).stroke({ width: 2, color: 0xf1e9d6 });
    return g;
  }

  /**
   * A raider's targeting stance (chunk 22 QA D1), told apart by shape: nearest = a dot in a
   * ring (whatever is closest), traps = a downward triangle (the trap glyph), core = a small
   * diamond (the core's shape).
   */
  private raiderStanceMark(stance: "nearest" | "traps" | "core"): Graphics {
    const g = new Graphics();
    const y = TILE_H * 0.35 + 1;
    if (stance === "nearest") {
      g.circle(0, y, 4).stroke({ width: 2, color: 0xf1e9d6 });
      g.circle(0, y, 1.5).fill(0xf1e9d6);
    } else if (stance === "traps") g.poly([-5, y - 3, 5, y - 3, 0, y + 5]).fill(0xf1e9d6);
    else g.poly([0, y - 4, 5, y, 0, y + 4, -5, y]).fill(0xf1e9d6);
    return g;
  }

  private edgePoint(edge: EntryEdgeName, along: number): WorldPoint {
    const { width, height } = this.opts.geometry;
    const t = Math.max(0, Math.min(1, along));
    switch (edge) {
      case "north":
        return { x: t * width, y: -0.8 };
      case "south":
        return { x: t * width, y: height + 0.8 };
      case "west":
        return { x: -0.8, y: t * height };
      case "east":
        return { x: width + 0.8, y: t * height };
    }
  }
}

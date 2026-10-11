/**
 * The shared isometric scene (chunk 08): ONE PixiJS 8 scene reused by the wagon circle on
 * the trail (this chunk), the home town (chunk 17) and the battle replay (chunk 22). There
 * must never be a second implementation.
 *
 * What it owns: the island (decorative tiers and cliff edges — inert scenery the resolver
 * never sees), the flat central play area, the four parked wagons on the ring corners, the
 * core, the lattice overlay (visible ONLY while something is being dragged, fading in and
 * out — instantly under reduced motion), the entity layers (fences, traps, posts, attackers,
 * siege) in painter's depth order, and the overlays (aggro/leash/attack-range circles at
 * true radii, the threat bands on the attacker's entry edges, gap markers).
 *
 * What it does not own: any game state. `update(state)` redraws from a plain description
 * (types.ts); `setCamera` applies a pure camera (projection.ts); `hitTest` is pure (hit.ts).
 * Pointer handling lives in IsoCanvas.tsx so this file never sees a DOM event.
 *
 * Replay hook: entity positions are world points, not cells. A replay feeds interpolated
 * positions straight in (`fixedToWorld` on the log's fixed-point coordinates).
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import {
  TILE_H,
  TILE_W,
  cellDiamond,
  cellToWorld,
  depthKey,
  project,
  type Camera,
  type CellLike,
  type WorldPoint,
} from "./projection.ts";
import { PALETTE, PLACEHOLDER_SKINS, type PlaceholderSkin, type Skin, type SkinRegistry } from "./skins.ts";
import type { EntryEdgeName, IsoSceneState, PostEntity } from "./types.ts";

/** The lattice and the fixed features the scene draws for every place (from the resolver's geometry). */
export interface SceneGeometry {
  readonly width: number;
  readonly height: number;
  readonly coreCells: readonly CellLike[];
  readonly ringCells: readonly CellLike[];
  readonly anchorCells: readonly CellLike[];
  readonly entryBandDepth: number;
}

export interface SceneOptions {
  readonly geometry: SceneGeometry;
  readonly skins?: SkinRegistry;
  /** `prefers-reduced-motion`: the lattice fade becomes an instant toggle. */
  readonly reducedMotion: boolean;
  readonly background: number;
}

/** GRID_VISIBILITY tunable: lattice alpha while a drag is active, and the fade speed per second. */
export const LATTICE_ALPHA = 0.38;
export const LATTICE_FADE_PER_SECOND = 6;

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
  private readonly overlays = new Graphics();
  private readonly entities = new Container();
  private readonly ghost = new Container();
  private readonly skins: SkinRegistry;
  private latticeTarget = 0;
  private state: IsoSceneState | null = null;
  private mounted = false;

  constructor(private readonly opts: SceneOptions) {
    this.skins = opts.skins ?? PLACEHOLDER_SKINS;
    this.entities.sortableChildren = true;
    this.lattice.alpha = 0;
    this.world.addChild(this.island, this.lattice, this.overlays, this.entities, this.ghost);
  }

  /** Create the renderer on a canvas. Resolves once the first frame can draw; rejects if WebGL is unavailable. */
  async mount(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
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
    this.app = app;
    this.mounted = true;
    app.stage.addChild(this.world);
    this.drawIsland();
    this.drawLattice();
    app.ticker.add((ticker) => this.tick(ticker.deltaMS));
    if (this.state) this.update(this.state);
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  resize(width: number, height: number): void {
    this.app?.renderer.resize(width, height);
  }

  setCamera(cam: Camera): void {
    this.world.position.set(cam.offsetX, cam.offsetY);
    this.world.scale.set(cam.zoom);
  }

  destroy(): void {
    this.mounted = false;
    this.app?.destroy(false, { children: true });
    this.app = null;
  }

  // ── per-frame: only the lattice fade is animated ──────────────────────────────────

  private tick(deltaMs: number): void {
    const target = this.latticeTarget;
    if (this.lattice.alpha === target) return;
    if (this.opts.reducedMotion) {
      this.lattice.alpha = target;
      return;
    }
    const step = (LATTICE_FADE_PER_SECOND * deltaMs) / 1000;
    this.lattice.alpha = this.lattice.alpha < target ? Math.min(target, this.lattice.alpha + step) : Math.max(target, this.lattice.alpha - step);
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
    this.latticeTarget = state.drag ? LATTICE_ALPHA : 0;
    this.drawOverlays(state);
    this.drawEntities(state);
    this.drawGhost(state);
  }

  private drawOverlays(state: IsoSceneState): void {
    const g = this.overlays;
    const geo = this.opts.geometry;
    g.clear();
    // Threat bands: the edges this party enters from. Informational, low alpha.
    if (state.threat) {
      for (const edge of state.threat.entryEdges) {
        const d = geo.entryBandDepth;
        const band: CellLike[] = [];
        for (let y = 0; y < geo.height; y++) {
          for (let x = 0; x < geo.width; x++) {
            const inBand =
              (edge === "north" && y < d) || (edge === "south" && y >= geo.height - d) || (edge === "west" && x < d) || (edge === "east" && x >= geo.width - d);
            if (inBand) band.push({ x, y });
          }
        }
        for (const c of band) g.poly(pts(cellDiamond(c))).fill({ color: PALETTE.attacker, alpha: 0.18 });
      }
      // Gaps: a soft outline on each open ring position. Same colour as the lattice, never a warning.
      for (const c of state.threat.gapCells) {
        g.poly(pts(cellDiamond(c))).stroke({ width: 1.5, color: PALETTE.gap, alpha: 0.35 });
      }
    }
    // Ring positions while a fence is being dragged, so the 28 targets are visible.
    if (state.drag?.kind === "fence") {
      const taken = new Set(state.fences.map((f) => `${f.cell.x},${f.cell.y}`));
      for (const c of geo.ringCells) {
        const free = !taken.has(`${c.x},${c.y}`);
        g.poly(pts(cellDiamond(c))).fill({ color: free ? PALETTE.lattice : PALETTE.outlineDark, alpha: free ? 0.22 : 0.15 });
      }
    }
    // Aggro / leash / attack range as continuous circles at true radii (ellipses on screen).
    if (state.showRadii) for (const p of state.posts) this.drawRadii(g, p.pos, p, p.selected ? 0.9 : 0.5);
    // Entry-band tint for the core so the goal is readable.
    for (const c of geo.coreCells) g.poly(pts(cellDiamond(c))).fill({ color: PALETTE.core, alpha: 0.18 });
  }

  private drawRadii(
    g: Graphics,
    pos: WorldPoint,
    r: { readonly aggroRadius: number; readonly leashDistance: number; readonly attackRange: number; readonly stance: PostEntity["stance"] },
    alpha: number,
  ): void {
    const c = project(pos);
    const ell = (radius: number, color: number, width: number, a: number) => {
      if (radius <= 0) return;
      g.ellipse(c.x, c.y, radius * (TILE_W / 2), radius * (TILE_H / 2)).stroke({ width, color, alpha: a });
    };
    if (r.stance === "hold") {
      // Hold: never leaves the post; only its attack range matters.
      ell(r.attackRange, PALETTE.defender, 2, alpha);
      return;
    }
    ell(r.leashDistance, PALETTE.defender, 1, alpha * 0.6);
    ell(r.aggroRadius, PALETTE.defender, 2, alpha);
    g.ellipse(c.x, c.y, r.aggroRadius * (TILE_W / 2), r.aggroRadius * (TILE_H / 2)).fill({ color: PALETTE.defender, alpha: alpha * 0.08 });
    if (r.stance === "reserve") ell(r.attackRange, PALETTE.defender, 1, alpha * 0.5);
  }

  private drawEntities(state: IsoSceneState): void {
    const layer = this.entities;
    layer.removeChildren().forEach((c) => c.destroy({ children: true }));
    const geo = this.opts.geometry;
    // Fixed features first: the core and the four parked wagons.
    const coreCenter = {
      x: geo.coreCells.reduce((s, c) => s + c.x + 0.5, 0) / geo.coreCells.length,
      y: geo.coreCells.reduce((s, c) => s + c.y + 0.5, 0) / geo.coreCells.length,
    };
    layer.addChild(this.marker(this.skins.core(), coreCenter, 1.6, 1, false));
    for (const a of geo.anchorCells) layer.addChild(this.marker(this.skins.wagonAnchor(), cellToWorld(a), 1, 1, false));
    for (const f of state.fences) {
      const pos = cellToWorld(f.cell);
      const node = this.marker(this.skins.fence(f.tierId), pos, 1, 1, f.selected ?? false);
      const bar = this.hpBar(f.hp / Math.max(1, f.maxHp), PALETTE.defender);
      bar.position.set(0, -TILE_H * 0.9);
      node.addChild(bar);
      layer.addChild(node);
    }
    for (const t of state.traps) {
      const skin = this.skins.trap(t.typeId);
      const node = this.marker(t.spent && skin.kind === "placeholder" ? { ...skin, fill: PALETTE.trapSpent } : skin, t.pos, 1, 1, t.selected ?? false);
      layer.addChild(node);
    }
    for (const p of state.posts) {
      const node = this.marker(this.skins.unit(p.typeId, "defender"), p.pos, 1, 2, p.selected ?? false);
      const bar = this.hpBar(p.hpFraction, PALETTE.defender);
      bar.position.set(0, -TILE_H * 1.15);
      node.addChild(bar);
      node.addChild(this.badge(String(p.mergeLevel), TILE_W * 0.22, -TILE_H * 0.55));
      node.addChild(this.stanceMark(p.stance));
      layer.addChild(node);
    }
    for (const a of state.attackers) {
      const node = this.marker(this.skins.unit(a.typeId, "attacker"), a.pos, 1, 2, false);
      node.addChild(this.badge(String(a.mergeLevel), TILE_W * 0.22, -TILE_H * 0.55));
      layer.addChild(node);
    }
    for (const s of state.siege) {
      const pos = this.edgePoint(s.edge, s.along);
      layer.addChild(this.marker(this.skins.siege(s.typeId), pos, 1, 2, false));
    }
  }

  private drawGhost(state: IsoSceneState): void {
    this.ghost.removeChildren().forEach((c) => c.destroy({ children: true }));
    const d = state.drag;
    if (!d || !d.cell) return;
    const pos = cellToWorld(d.cell);
    const g = new Graphics();
    g.poly(pts(cellDiamond(d.cell))).fill({ color: d.valid ? PALETTE.defender : PALETTE.attacker, alpha: 0.35 });
    this.ghost.addChild(g);
    if (d.radii) {
      const rg = new Graphics();
      this.drawRadii(rg, pos, d.radii, 0.9);
      this.ghost.addChild(rg);
    }
    const skin = d.kind === "fence" ? this.skins.fence(d.typeId) : d.kind === "trap" ? this.skins.trap(d.typeId) : this.skins.unit(d.typeId, "defender");
    const m = this.marker(skin, pos, 1, 3, false);
    m.alpha = 0.75;
    this.ghost.addChild(m);
  }

  // ── drawing helpers ───────────────────────────────────────────────────────────────

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

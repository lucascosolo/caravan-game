import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { economyShape, mergePreviewShape, partyShape, recruitViewShape, refugeeViewShape } from "../../api/shapes.ts";
import { expectShape } from "../../api/shape.ts";
import { economyView, mergePreview, partyView, recruitView, refugeeView, uid } from "../../test/townFixtures.ts";
import {
  BOARD_ORIGIN,
  BOARD_SIDE,
  BOARD_SLOTS,
  boardCells,
  canMergeDrop,
  isBoardCell,
  layoutBoard,
  mergeGroups,
  moveUnit,
  overflow,
  pickForMerge,
  productHints,
  quotedCost,
  toOverflow,
  type RosterUnit,
} from "./board.ts";
import { EMPTY_OUTFIT, FENCE_BUDGET, TRAP_CAP, UNIT_CAP, addTrap, outfitMeters, packRequest, removeTrap, setFenceCount, setFenceTier, toggleUnit } from "./outfitModel.ts";
import { collapseOffers, formatCountdown, refugeeTimer } from "./refugeeModel.ts";
import { dropMeaning, townSceneState, TOWN_GEOMETRY, TOWN_STRUCTURES } from "./townScene.ts";

const rider = (n: number, level = 1): RosterUnit => ({ id: uid(n), typeId: "desert.dust_rider", mergeLevel: level });
const digger = (n: number, level = 1): RosterUnit => ({ id: uid(n), typeId: "desert.well_digger", mergeLevel: level });

describe("board model", () => {
  it("is BOARD_SIDE × BOARD_SIDE = 36 cells, centred on the town ground", () => {
    expect(BOARD_SLOTS).toBe(TUNABLES.BOARD_SLOTS);
    expect(BOARD_SLOTS).toBe(36);
    expect(BOARD_SIDE * BOARD_SIDE).toBe(BOARD_SLOTS);
    const cells = boardCells();
    expect(cells).toHaveLength(36);
    expect(new Set(cells.map((c) => `${c.x},${c.y}`)).size).toBe(36);
    expect(cells.every(isBoardCell)).toBe(true);
    expect(isBoardCell({ x: BOARD_ORIGIN.x - 1, y: BOARD_ORIGIN.y })).toBe(false);
    expect(isBoardCell({ x: BOARD_ORIGIN.x + BOARD_SIDE, y: BOARD_ORIGIN.y })).toBe(false);
  });

  it("fills free cells row-major in id order; what does not fit goes to the overflow — acquisition is never refused", () => {
    const units = Array.from({ length: 40 }, (_, i) => rider(i + 1));
    const layout = layoutBoard(units);
    expect(layout.size).toBe(36);
    expect(overflow(units, layout).map((u) => u.id)).toEqual([uid(37), uid(38), uid(39), uid(40)]);
    expect(layout.get(uid(1))).toEqual(BOARD_ORIGIN);
    // Deterministic.
    expect([...layoutBoard(units)]).toEqual([...layout]);
  });

  it("keeps prior placements, drops units that no longer exist, honours product hints, and leaves units sent to the overflow there", () => {
    const units = [rider(1), rider(2), digger(3)];
    let layout = layoutBoard(units);
    layout = moveUnit(layout, uid(3), { x: BOARD_ORIGIN.x + 5, y: BOARD_ORIGIN.y + 5 });
    expect(layout.get(uid(3))).toEqual({ x: BOARD_ORIGIN.x + 5, y: BOARD_ORIGIN.y + 5 });
    // A move onto an occupied cell or off the board changes nothing.
    expect(moveUnit(layout, uid(3), layout.get(uid(1))!)).toBe(layout);
    expect(moveUnit(layout, uid(3), { x: 0, y: 0 })).toBe(layout);
    // Merge 1 + 2 → 9: the product takes the drop target's cell.
    const target = layout.get(uid(1))!;
    const hints = productHints(layout, [uid(1), uid(2)], [uid(9)]);
    const after = layoutBoard([digger(3), rider(9, 2)], layout, hints);
    expect(after.get(uid(9))).toEqual(target);
    expect(after.has(uid(1))).toBe(false);
    expect(after.get(uid(3))).toEqual({ x: BOARD_ORIGIN.x + 5, y: BOARD_ORIGIN.y + 5 });
    // Sent to overflow, it stays there across a re-layout.
    const sent = toOverflow(after, uid(3));
    expect(layoutBoard([digger(3), rider(9, 2)], sent, new Map(), new Set([uid(3)])).has(uid(3))).toBe(false);
    expect(layoutBoard([digger(3), rider(9, 2)], sent).has(uid(3))).toBe(true);
  });

  it("offers a merge drop only for same type and same level, below the cap", () => {
    const units = [rider(1), rider(2), rider(3, 2), digger(4), rider(5, 5), rider(6, 5)];
    expect(canMergeDrop(units, uid(1), uid(2))).toBe(true);
    expect(canMergeDrop(units, uid(1), uid(1))).toBe(false);
    expect(canMergeDrop(units, uid(1), uid(3))).toBe(false);
    expect(canMergeDrop(units, uid(1), uid(4))).toBe(false);
    expect(canMergeDrop(units, uid(5), uid(6))).toBe(false);
  });

  it("groups by type and level and picks the units a 2 → 1 or 5 → 3 consumes", () => {
    const units = [rider(4), rider(1), rider(3), rider(2), rider(5), digger(6)];
    const groups = mergeGroups(units);
    expect(groups.map((g) => `${g.typeId}@${g.mergeLevel}:${g.ids.length}`)).toEqual(["desert.dust_rider@1:5", "desert.well_digger@1:1"]);
    const g = groups[0]!;
    expect(pickForMerge(g, 2)).toEqual([uid(1), uid(2)]);
    expect(pickForMerge(g, 2, [uid(4)])).toEqual([uid(4), uid(1)]);
    expect(pickForMerge(g, 5)).toHaveLength(5);
    expect(pickForMerge(groups[1]!, 2)).toBeNull();
    expect(quotedCost({ "2": 250 }, 2, 1)).toBe(250);
    expect(quotedCost({ "2": 250 }, 2, 3)).toBe(750);
    expect(quotedCost({ "2": 250 }, 3, 1)).toBeNull();
  });

  it("drop meaning: merge onto a matching unit, move to a free cell, nothing elsewhere", () => {
    const units = [rider(1), rider(2), digger(3)];
    const layout = layoutBoard(units);
    expect(dropMeaning(units, layout, uid(1), layout.get(uid(2))!, isBoardCell)).toEqual({ kind: "merge", targetId: uid(2) });
    expect(dropMeaning(units, layout, uid(1), layout.get(uid(3))!, isBoardCell)).toEqual({ kind: "none" });
    expect(dropMeaning(units, layout, uid(1), { x: BOARD_ORIGIN.x + 4, y: BOARD_ORIGIN.y + 4 }, isBoardCell)).toEqual({ kind: "move" });
    expect(dropMeaning(units, layout, uid(1), { x: 1, y: 1 }, isBoardCell)).toEqual({ kind: "none" });
    expect(dropMeaning(units, layout, uid(1), null, isBoardCell)).toEqual({ kind: "none" });
  });

  it("the town scene is a settlement: no core, no wagons, no posts or attackers; units static; board cells only for a drag", () => {
    expect(TOWN_GEOMETRY.fixtures).toBe("town");
    expect(TOWN_GEOMETRY.coreCells).toHaveLength(0);
    expect(TOWN_GEOMETRY.anchorCells).toHaveLength(0);
    // No structure overlaps the board.
    for (const s of TOWN_STRUCTURES) for (let x = s.cell.x; x < s.cell.x + s.w; x++) for (let y = s.cell.y; y < s.cell.y + s.h; y++) expect(isBoardCell({ x, y })).toBe(false);
    const units = [rider(1), rider(2), digger(3)];
    const layout = layoutBoard(units);
    const rest = townSceneState({ units, layout, selectedId: null, drag: null, mineActive: true });
    expect(rest.drag).toBeNull();
    expect(rest.posts).toHaveLength(0);
    expect(rest.attackers).toHaveLength(0);
    expect(rest.threat).toBeNull();
    expect(rest.boardUnits).toHaveLength(3);
    expect(rest.mine).toEqual({ active: true });
    const dragging = townSceneState({ units, layout, selectedId: null, drag: { id: uid(1), cell: layout.get(uid(2))!, valid: true }, mineActive: false });
    expect(dragging.drag).toMatchObject({ kind: "unit", typeId: "desert.dust_rider", valid: true });
    const byId = new Map((dragging.boardUnits ?? []).map((u) => [u.id, u]));
    expect(byId.get(uid(2))).toMatchObject({ target: true, dimmed: false });
    expect(byId.get(uid(3))).toMatchObject({ dimmed: true });
    // Same positions at rest and while dragging: nothing moves on its own.
    expect((rest.boardUnits ?? []).map((u) => u.pos)).toEqual((dragging.boardUnits ?? []).map((u) => u.pos));
  });
});

describe("refugee model", () => {
  it("collapses duplicate slots", () => {
    const c = collapseOffers(refugeeView().menu.offers);
    expect(c.map((o) => [o.unitTypeId, o.times])).toEqual([
      ["desert.dust_rider", 2],
      ["desert.well_digger", 1],
    ]);
  });

  it("timer: counting from the server's msUntilFreeRefresh, stale when it runs out, due when the server says so", () => {
    const v = refugeeView({ timer: { msUntilFreeRefresh: 65_000 } });
    expect(refugeeTimer(v, 0)).toEqual({ kind: "counting", msLeft: 65_000, mmss: "1:05" });
    expect(refugeeTimer(v, 64_500)).toMatchObject({ kind: "counting", mmss: "0:01" });
    expect(refugeeTimer(v, 65_000)).toEqual({ kind: "stale" });
    expect(refugeeTimer(refugeeView({ timer: { freeRefreshDue: true, msUntilFreeRefresh: 0 } }), 0)).toEqual({ kind: "due", claimed: false });
    expect(refugeeTimer(refugeeView({ timer: { freeRefreshDue: true, msUntilFreeRefresh: 0 }, menu: { claimed: { unitTypeId: "desert.dust_rider", instanceId: uid(5), claimedAtMs: 2 } } }), 0)).toEqual({ kind: "due", claimed: true });
    expect(formatCountdown(5_400_000)).toBe("1:30:00");
    expect(formatCountdown(0)).toBe("0:00");
  });
});

describe("outfit model", () => {
  it("measures the draft against DEPLOYMENT_SLOT_CAP, TRAP_SLOT_CAP and FENCE_MATERIAL_BUDGET, and flags overs without trimming", () => {
    expect(UNIT_CAP).toBe(TUNABLES.DEPLOYMENT_SLOT_CAP);
    expect(TRAP_CAP).toBe(TUNABLES.TRAP_SLOT_CAP);
    expect(FENCE_BUDGET).toBe(TUNABLES.FENCE_MATERIAL_BUDGET);
    let d = EMPTY_OUTFIT;
    expect(outfitMeters(d)).toMatchObject({ noUnits: true, anyOver: false });
    for (let i = 1; i <= UNIT_CAP + 1; i++) d = toggleUnit(d, uid(i));
    expect(outfitMeters(d).units).toEqual({ chosen: UNIT_CAP + 1, cap: UNIT_CAP, over: 1 });
    d = toggleUnit(d, uid(1));
    expect(outfitMeters(d).units.over).toBe(0);
    for (let i = 0; i <= TRAP_CAP; i++) d = addTrap(d, "trap.spike_pit");
    expect(outfitMeters(d).traps.over).toBe(1);
    d = removeTrap(d, "trap.spike_pit");
    expect(outfitMeters(d).traps).toEqual({ chosen: TRAP_CAP, cap: TRAP_CAP, over: 0 });
    d = setFenceTier(d, "fence.brush_pile");
    expect(d.fence).toEqual({ tierId: "fence.brush_pile", count: FENCE_BUDGET });
    d = setFenceCount(d, FENCE_BUDGET + 3);
    expect(outfitMeters(d).fence.over).toBe(3);
    expect(outfitMeters(d).anyOver).toBe(true);
    d = setFenceCount(setFenceTier(d, "fence.brush_pile"), 0);
    expect(packRequest(d).fence).toBeNull();
    expect(packRequest(setFenceTier(d, null)).fence).toBeNull();
    expect(packRequest(d).units).toHaveLength(UNIT_CAP);
  });
});

describe("payload guards accept the fixtures (so the tests cannot drift from what the client takes)", () => {
  it("economy, merge preview, refugees, recruit, party", () => {
    expect(() => expectShape(economyShape, economyView())).not.toThrow();
    expect(() => expectShape(mergePreviewShape, mergePreview([uid(1), uid(2)]))).not.toThrow();
    expect(() => expectShape(refugeeViewShape, refugeeView())).not.toThrow();
    expect(() => expectShape(recruitViewShape, recruitView())).not.toThrow();
    expect(() => expectShape(partyShape, { party: partyView() })).not.toThrow();
  });

  it("refuses a recruit body that claims a cooldown (GUARDRAILS §3: always available)", () => {
    expect(() => expectShape(recruitViewShape, { ...recruitView(), availability: { cooldown: 60_000, dailyLimit: null } })).toThrow();
  });

  it("refuses a party body that is not a template (GUARDRAILS §0)", () => {
    const p = partyView();
    expect(() => expectShape(partyShape, { party: { ...p, rules: { ...p.rules, neverConsumed: false } } })).toThrow();
  });
});

// ── QA-17 punch list ─────────────────────────────────────────────────────────────────

describe("QA-17 S6: a selected unit counts as being placed", () => {
  it("selection carries a cell-less placement ghost (lattice + board cells) and dims units it cannot merge with", async () => {
    const { townSceneState: build } = await import("./townScene.ts");
    const units = [
      { id: uid(1), typeId: "desert.dust_rider", mergeLevel: 1 },
      { id: uid(2), typeId: "desert.dust_rider", mergeLevel: 1 },
      { id: uid(3), typeId: "desert.well_digger", mergeLevel: 1 },
    ];
    const layout = layoutBoard(units);
    const sel = build({ units, layout, selectedId: uid(1), drag: null, mineActive: true });
    expect(sel.drag).toEqual({ kind: "unit", typeId: "desert.dust_rider", cell: null, valid: true });
    const byId = new Map((sel.boardUnits ?? []).map((u) => [u.id, u]));
    expect(byId.get(uid(1))).toMatchObject({ selected: true, dimmed: false });
    expect(byId.get(uid(2))).toMatchObject({ dimmed: false });
    expect(byId.get(uid(3))).toMatchObject({ dimmed: true });
    expect(build({ units, layout, selectedId: null, drag: null, mineActive: true }).drag).toBeNull();
  });
});

describe("QA-17 S1: the town opens framed on the board", () => {
  it("at 360 px wide every board cell is at least 44 px wide on screen and the whole board is in view; the island is still reachable", async () => {
    const { frameCamera } = await import("../../iso/IsoCanvas.tsx");
    const { worldToCanvas, fitCamera, ZOOM_MIN, TILE_W } = await import("../../iso/projection.ts");
    const { GRID_WIDTH, GRID_HEIGHT } = await import("@caravan/circle");
    for (const [w, h] of [
      [328, 243],
      [736, 389],
      [300, 208],
    ] as const) {
      const cam = frameCamera(w, h, { x: BOARD_ORIGIN.x, y: BOARD_ORIGIN.y, w: BOARD_SIDE, h: BOARD_SIDE, minCellPx: 44 });
      expect(TILE_W * cam.zoom).toBeGreaterThanOrEqual(44);
      if (w >= 328) {
        for (const c of [
          { x: BOARD_ORIGIN.x, y: BOARD_ORIGIN.y },
          { x: BOARD_ORIGIN.x + BOARD_SIDE, y: BOARD_ORIGIN.y },
          { x: BOARD_ORIGIN.x + BOARD_SIDE, y: BOARD_ORIGIN.y + BOARD_SIDE },
          { x: BOARD_ORIGIN.x, y: BOARD_ORIGIN.y + BOARD_SIDE },
        ]) {
          const p = worldToCanvas(cam, c);
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(w);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(h);
        }
      }
      // Pinching out can reach the whole-island view (the zoom floor is below it).
      expect(ZOOM_MIN).toBeLessThanOrEqual(fitCamera(w, h, GRID_WIDTH, GRID_HEIGHT).zoom);
    }
  });
});

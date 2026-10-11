/**
 * The home town's scene (chunk 17): PURE builders for the shared isometric renderer's input
 * (src/iso — one renderer; this file only describes what to draw). The town is a
 * SETTLEMENT: false-front buildings, a livery corral, the mine head-frame, and the merge
 * board on the flat ground in the middle. It has no core and no parked wagons
 * (`fixtures: "town"`): it is never a wagon circle and never attacked (GUARDRAILS §0).
 *
 * Nothing here moves. Board units are drawn at the cell the player left them on; the only
 * ambient motion in the whole scene is the mine wheel's cosmetic turn, which counts nothing.
 */
import { ENTRY_BAND_DEPTH, GRID_HEIGHT, GRID_WIDTH, type Cell } from "@caravan/circle";
import { cellToWorld, type BoardUnitEntity, type IsoSceneState, type SceneGeometry, type StructureEntity } from "../../iso/index.ts";
import { VIEWER_STORAGE_PREFIX } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";
import { boardCells, canMergeDrop, type BoardLayout, type RosterUnit } from "./board.ts";

export const TOWN_GEOMETRY: SceneGeometry = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  coreCells: [],
  ringCells: [],
  anchorCells: [],
  entryBandDepth: ENTRY_BAND_DEPTH,
  fixtures: "town",
};

const L = STRINGS.town.structures;

/** The settlement's buildings: inert scenery around the board, never on it. */
export const TOWN_STRUCTURES: readonly StructureEntity[] = [
  { id: "saloon", kind: "building", cell: { x: 4, y: 6 }, w: 4, h: 3, label: L.saloon },
  { id: "store", kind: "building", cell: { x: 13, y: 5 }, w: 5, h: 3, label: L.store },
  { id: "mine", kind: "mine", cell: { x: 23, y: 5 }, w: 3, h: 3, label: L.mine },
  { id: "bank", kind: "building", cell: { x: 23, y: 22 }, w: 3, h: 3, label: L.bank },
  { id: "outfitter", kind: "building", cell: { x: 4, y: 22 }, w: 4, h: 3, label: L.outfitter },
  { id: "livery", kind: "corral", cell: { x: 13, y: 24 }, w: 6, h: 3, label: L.livery },
];

export interface TownDrag {
  readonly id: string;
  readonly cell: Cell | null;
  readonly valid: boolean;
}

export interface TownSceneInput {
  readonly units: readonly RosterUnit[];
  readonly layout: BoardLayout;
  readonly selectedId: string | null;
  readonly drag: TownDrag | null;
  /** The mine wheel turns while the store is below the cap (cosmetic). */
  readonly mineActive: boolean;
}

/**
 * The scene state: board units at their cells (static), the structures, the mine, and the
 * board cells (outlined only while a unit is being placed — the renderer draws them only then).
 * While a unit is dragged, units it cannot merge with are dimmed and the one under the
 * ghost is ringed if it can take the drop.
 *
 * "Being placed" includes tap-to-move (QA-17 S6, chunk 08 QA D5): while a unit is SELECTED
 * the scene carries a placement ghost with no cell, so the lattice and the board cells show
 * exactly as during a drag (nothing is drawn under a pointer that is not there), and the
 * units the selection cannot merge with are dimmed. Deselecting hides them again.
 */
export function townSceneState(input: TownSceneInput): IsoSceneState {
  const { units, layout, selectedId, drag, mineActive } = input;
  const byCell = new Map<string, string>();
  for (const [id, c] of layout) byCell.set(`${c.x},${c.y}`, id);
  const targetId = drag?.cell ? (byCell.get(`${drag.cell.x},${drag.cell.y}`) ?? null) : null;
  const selected = drag === null && selectedId !== null ? units.find((u) => u.id === selectedId) : undefined;
  const placingId = drag?.id ?? selected?.id ?? null;
  const boardUnits: BoardUnitEntity[] = [];
  for (const u of units) {
    const cell = layout.get(u.id);
    if (!cell) continue;
    const dimmed = placingId !== null && placingId !== u.id && !canMergeDrop(units, placingId, u.id);
    boardUnits.push({
      id: u.id,
      pos: cellToWorld(cell),
      typeId: u.typeId,
      mergeLevel: u.mergeLevel,
      selected: selectedId === u.id,
      dimmed,
      target: targetId === u.id && drag !== null && drag.id !== u.id && canMergeDrop(units, drag.id, u.id),
    });
  }
  const dragged = drag ? units.find((u) => u.id === drag.id) : undefined;
  return {
    fences: [],
    traps: [],
    posts: [],
    attackers: [],
    siege: [],
    drag:
      drag && dragged
        ? { kind: "unit", typeId: dragged.typeId, cell: drag.cell, valid: drag.valid }
        : selected
          ? { kind: "unit", typeId: selected.typeId, cell: null, valid: true }
          : null,
    threat: null,
    showRadii: false,
    boardUnits,
    structures: TOWN_STRUCTURES,
    mine: { active: mineActive },
    boardCells: boardCells(),
  };
}

/** What a drop of `id` on `cell` means: a merge onto `targetId`, a move to a free board cell, or nothing. */
export type DropMeaning = { readonly kind: "merge"; readonly targetId: string } | { readonly kind: "move" } | { readonly kind: "none" };

export function dropMeaning(units: readonly RosterUnit[], layout: BoardLayout, id: string, cell: Cell | null, isBoardCell: (c: Cell) => boolean): DropMeaning {
  if (!cell || !isBoardCell(cell)) return { kind: "none" };
  let occupant: string | null = null;
  for (const [uid, c] of layout) if (c.x === cell.x && c.y === cell.y) occupant = uid;
  if (occupant === null || occupant === id) return { kind: "move" };
  return canMergeDrop(units, id, occupant) ? { kind: "merge", targetId: occupant } : { kind: "none" };
}

// ── layout persistence: a per-viewer convenience, like a camera (never game state) ──────

/**
 * Keyed by account AND caravan (QA-17 D1): two people sharing a device never see each
 * other's layout, and `clearViewerStorage` (sign-out) removes it with every other
 * per-viewer key. Positions stay per device: another device lays the board out afresh.
 */
export const boardStorageKey = (accountId: string, caravanId: string): string => `${VIEWER_STORAGE_PREFIX}town.board.${accountId}.${caravanId}`;

export interface StoredBoard {
  readonly layout: BoardLayout;
  /** Every unit id the board has seen: a known unit with no cell was sent to the overflow and stays there. */
  readonly known: ReadonlySet<string>;
}

export function loadLayout(accountId: string, caravanId: string): StoredBoard {
  try {
    const raw = window.localStorage.getItem(boardStorageKey(accountId, caravanId));
    if (!raw) return { layout: new Map(), known: new Set() };
    const parsed: unknown = JSON.parse(raw);
    const obj = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { cells?: unknown; known?: unknown }) : {};
    const out = new Map<string, Cell>();
    if (Array.isArray(obj.cells)) {
      for (const e of obj.cells) {
        if (Array.isArray(e) && typeof e[0] === "string" && Number.isInteger(e[1]) && Number.isInteger(e[2])) out.set(e[0], { x: e[1] as number, y: e[2] as number });
      }
    }
    const known = new Set(Array.isArray(obj.known) ? obj.known.filter((k): k is string => typeof k === "string") : []);
    return { layout: out, known };
  } catch {
    return { layout: new Map(), known: new Set() };
  }
}

export function saveLayout(accountId: string, caravanId: string, layout: BoardLayout, known: Iterable<string>): void {
  try {
    window.localStorage.setItem(boardStorageKey(accountId, caravanId), JSON.stringify({ cells: [...layout].map(([id, c]) => [id, c.x, c.y]), known: [...known] }));
  } catch {
    // Storage blocked: the board simply re-lays out next time.
  }
}

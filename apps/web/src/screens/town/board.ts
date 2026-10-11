/**
 * The merge board model (chunk 17): PURE functions over the roster `GET /me` returns and a
 * client-side layout (which unit sits on which board cell). The server holds no board: a
 * board position is presentation, like a camera. What the server decides — whether a merge
 * is legal, what it costs, what comes out — is asked of it through the preview and never
 * computed here; this file only decides what the UI may OFFER (which drops can land).
 *
 * The board is BOARD_SIDE × BOARD_SIDE cells (BOARD_SLOTS) at the centre of the town's flat
 * ground, backed by the overflow: units with no board cell. Acquisition never looks at the
 * board (GUARDRAILS §3 — chunk 17 open question 2): a new unit lands on a free cell if there
 * is one and in the overflow otherwise, never refused.
 *
 * Units on the board are STATIC. Nothing here produces motion; a unit changes cell only
 * when the player drops it somewhere.
 */
import { GRID_HEIGHT, GRID_WIDTH, type Cell } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";

export const BOARD_SIDE: number = TUNABLES.BOARD_SIDE;
export const BOARD_SLOTS: number = TUNABLES.BOARD_SLOTS;
export const MERGE_LEVEL_MAX: number = TUNABLES.MERGE_LEVEL_MAX;
if (BOARD_SIDE * BOARD_SIDE !== BOARD_SLOTS) throw new Error(`BOARD_SLOTS (${BOARD_SLOTS}) must be BOARD_SIDE² (${BOARD_SIDE}²)`);

/** Top-left cell of the board on the town's 32×32 ground: centred. */
export const BOARD_ORIGIN: Cell = { x: Math.floor((GRID_WIDTH - BOARD_SIDE) / 2), y: Math.floor((GRID_HEIGHT - BOARD_SIDE) / 2) };

export interface RosterUnit {
  readonly id: string;
  readonly typeId: string;
  readonly mergeLevel: number;
}

/** Unit id → board cell. Units absent from the map are in the overflow. */
export type BoardLayout = ReadonlyMap<string, Cell>;

export const cellKey = (c: Cell): string => `${c.x},${c.y}`;

/** Every board cell, row-major from the origin (the fill order). */
export function boardCells(): readonly Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < BOARD_SIDE; y++) for (let x = 0; x < BOARD_SIDE; x++) out.push({ x: BOARD_ORIGIN.x + x, y: BOARD_ORIGIN.y + y });
  return out;
}

export function isBoardCell(c: Cell): boolean {
  return Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= BOARD_ORIGIN.x && c.y >= BOARD_ORIGIN.y && c.x < BOARD_ORIGIN.x + BOARD_SIDE && c.y < BOARD_ORIGIN.y + BOARD_SIDE;
}

export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Lay the roster out: keep every prior placement that is still a real unit on a real,
 * unshared board cell; honour `hints` (a produced unit takes its parent's cell) next; then
 * fill free cells row-major with the remaining units in id order — except those in
 * `keepInOverflow` (units the player sent to the overflow stay there). Whatever does not
 * fit is in the overflow. Deterministic: the same inputs give the same board.
 */
export function layoutBoard(
  units: readonly RosterUnit[],
  prior: BoardLayout = new Map(),
  hints: BoardLayout = new Map(),
  keepInOverflow: ReadonlySet<string> = new Set(),
): BoardLayout {
  const ids = new Set(units.map((u) => u.id));
  const out = new Map<string, Cell>();
  const taken = new Set<string>();
  const place = (id: string, c: Cell | undefined): void => {
    if (!c || !ids.has(id) || out.has(id) || !isBoardCell(c) || taken.has(cellKey(c))) return;
    out.set(id, { x: c.x, y: c.y });
    taken.add(cellKey(c));
  };
  for (const [id, c] of prior) place(id, c);
  for (const [id, c] of hints) place(id, c);
  const free = boardCells().filter((c) => !taken.has(cellKey(c)));
  let i = 0;
  for (const u of [...units].sort((a, b) => compareIds(a.id, b.id))) {
    if (out.has(u.id) || keepInOverflow.has(u.id)) continue;
    const c = free[i++];
    if (!c) break;
    out.set(u.id, c);
  }
  return out;
}

export function unitAt(layout: BoardLayout, cell: Cell): string | null {
  for (const [id, c] of layout) if (c.x === cell.x && c.y === cell.y) return id;
  return null;
}

/** Move `id` to `cell` (a board cell that is free or its own). Anything else leaves the layout as it was. */
export function moveUnit(layout: BoardLayout, id: string, cell: Cell): BoardLayout {
  if (!isBoardCell(cell)) return layout;
  const who = unitAt(layout, cell);
  if (who !== null && who !== id) return layout;
  const next = new Map(layout);
  next.set(id, { x: cell.x, y: cell.y });
  return next;
}

export function toOverflow(layout: BoardLayout, id: string): BoardLayout {
  if (!layout.has(id)) return layout;
  const next = new Map(layout);
  next.delete(id);
  return next;
}

export function onBoard(units: readonly RosterUnit[], layout: BoardLayout): readonly RosterUnit[] {
  return units.filter((u) => layout.has(u.id));
}

export function overflow(units: readonly RosterUnit[], layout: BoardLayout): readonly RosterUnit[] {
  return units.filter((u) => !layout.has(u.id)).sort((a, b) => compareIds(a.id, b.id));
}

/** Whether dropping `a` onto `b` is a merge the UI may offer: same type, same level, below the cap, distinct. */
export function canMergeDrop(units: readonly RosterUnit[], a: string, b: string): boolean {
  if (a === b) return false;
  const ua = units.find((u) => u.id === a);
  const ub = units.find((u) => u.id === b);
  return !!ua && !!ub && ua.typeId === ub.typeId && ua.mergeLevel === ub.mergeLevel && ua.mergeLevel < MERGE_LEVEL_MAX;
}

export interface MergeGroup {
  readonly typeId: string;
  readonly mergeLevel: number;
  /** In id order. */
  readonly ids: readonly string[];
}

/** The roster grouped by (type, level), ordered by type id then level. The 5 → 3 affordance lives on these. */
export function mergeGroups(units: readonly RosterUnit[]): readonly MergeGroup[] {
  const map = new Map<string, { typeId: string; mergeLevel: number; ids: string[] }>();
  for (const u of units) {
    const k = `${u.typeId}@${u.mergeLevel}`;
    const g = map.get(k) ?? { typeId: u.typeId, mergeLevel: u.mergeLevel, ids: [] };
    g.ids.push(u.id);
    map.set(k, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, ids: [...g.ids].sort(compareIds) }))
    .sort((a, b) => compareIds(a.typeId, b.typeId) || a.mergeLevel - b.mergeLevel);
}

/**
 * The `n` units a group-level merge consumes: `first` (the dragged pair, or the selection)
 * in the order given, then the rest of the group in id order. Null when the group is short.
 */
export function pickForMerge(group: MergeGroup, n: number, first: readonly string[] = []): readonly string[] | null {
  const chosen = first.filter((id) => group.ids.includes(id));
  for (const id of group.ids) {
    if (chosen.length >= n) break;
    if (!chosen.includes(id)) chosen.push(id);
  }
  return chosen.length === n ? chosen.slice(0, n) : null;
}

/** The server's table is `{ "2": 250, … }` per resulting unit; the group button quotes produce × that. Display only — the preview is authoritative. */
export function quotedCost(table: Readonly<Record<string, number>>, toLevel: number, produce: number): number | null {
  const per = table[String(toLevel)];
  return per === undefined ? null : per * produce;
}

/**
 * Where a merge's products should land: the cell of the first consumed unit that had one
 * (the drop target first, so the product appears where the player dropped), for `count`
 * products — further products take further consumed cells.
 */
export function productHints(layout: BoardLayout, consumedInOrder: readonly string[], producedIds: readonly string[]): BoardLayout {
  const cells = consumedInOrder.map((id) => layout.get(id)).filter((c): c is Cell => !!c);
  const out = new Map<string, Cell>();
  producedIds.forEach((id, i) => {
    const c = cells[i];
    if (c) out.set(id, c);
  });
  return out;
}

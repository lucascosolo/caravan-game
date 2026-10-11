/**
 * The party builder's edit model (chunk 17 UI for chunk 09): PURE functions over
 * @caravan/circle's `PartyConfig`. Every edit returns a new config; nothing is mutated.
 *
 * What this decides is only what the builder may OFFER: a start cell must lie in its
 * edge's entry band, and a unit appears once. The server re-validates the whole party on
 * save with the same @caravan/circle rules (caps, stances, access, roster membership) and
 * its issue list is shown exactly; the builder never derives validity itself.
 *
 * The party is a TEMPLATE (GUARDRAILS §0): nothing here can consume a unit or cost Coin.
 */
import { ENTRY_BAND_DEPTH, ENTRY_EDGES, GRID_HEIGHT, GRID_WIDTH, PARTY_CONFIG_VERSION, isEntryCell, type Cell, type EntryEdge, type PartyConfig, type TargetingStance } from "@caravan/circle";

export const DEFAULT_STANCE: TargetingStance = "nearest";
export const DEFAULT_EDGE: EntryEdge = "north";

function withUnits(c: PartyConfig, units: PartyConfig["units"]): PartyConfig {
  return { v: PARTY_CONFIG_VERSION, units, siege: c.siege };
}

/** The entry edges whose band contains `cell` (a corner cell is in two). Empty when none. */
export function edgesContaining(cell: Cell): readonly EntryEdge[] {
  return ENTRY_EDGES.filter((e) => isEntryCell(cell, e));
}

/** The edge a drop on `cell` means: the unit's current edge if the cell is in its band, else the first band containing it. */
export function edgeForDrop(cell: Cell, preferred: EntryEdge | null): EntryEdge | null {
  const edges = edgesContaining(cell);
  if (edges.length === 0) return null;
  return preferred && edges.includes(preferred) ? preferred : edges[0]!;
}

/** A free-looking default cell on `edge`'s band for the n-th unit placed there: spread along the band, inside its outer row. */
export function defaultCell(edge: EntryEdge, n: number): Cell {
  const along = 2 + ((n * 3) % (GRID_WIDTH - 4));
  switch (edge) {
    case "north":
      return { x: along, y: 0 };
    case "south":
      return { x: along, y: GRID_HEIGHT - 1 };
    case "west":
      return { x: 0, y: along };
    case "east":
      return { x: GRID_WIDTH - 1, y: along };
  }
}

/** Re-snap a cell onto `edge`'s band keeping its position along the edge, for an edge change made from the panel. */
export function snapToEdge(cell: Cell, edge: EntryEdge): Cell {
  const alongX = Math.max(0, Math.min(GRID_WIDTH - 1, cell.x));
  const alongY = Math.max(0, Math.min(GRID_HEIGHT - 1, cell.y));
  const depth = Math.max(0, Math.min(ENTRY_BAND_DEPTH - 1, Math.min(cell.x, cell.y, GRID_WIDTH - 1 - cell.x, GRID_HEIGHT - 1 - cell.y)));
  switch (edge) {
    case "north":
      return { x: alongX, y: depth };
    case "south":
      return { x: alongX, y: GRID_HEIGHT - 1 - depth };
    case "west":
      return { x: depth, y: alongY };
    case "east":
      return { x: GRID_WIDTH - 1 - depth, y: alongY };
  }
}

export function hasUnit(c: PartyConfig, ref: string): boolean {
  return c.units.some((u) => u.ref === ref);
}

/** Add a roster unit with the default stance on the north band. A unit already in the party is left alone. */
export function addUnit(c: PartyConfig, ref: string): PartyConfig {
  if (hasUnit(c, ref)) return c;
  const n = c.units.filter((u) => u.edge === DEFAULT_EDGE).length;
  return withUnits(c, [...c.units, { ref, stance: DEFAULT_STANCE, edge: DEFAULT_EDGE, cell: defaultCell(DEFAULT_EDGE, n) }]);
}

export function removeUnit(c: PartyConfig, ref: string): PartyConfig {
  return withUnits(c, c.units.filter((u) => u.ref !== ref));
}

export function setStance(c: PartyConfig, ref: string, stance: TargetingStance): PartyConfig {
  return withUnits(c, c.units.map((u) => (u.ref === ref ? { ...u, stance } : u)));
}

/** Change the approach edge from the panel; the cell is re-snapped into that band. */
export function setEdge(c: PartyConfig, ref: string, edge: EntryEdge): PartyConfig {
  return withUnits(c, c.units.map((u) => (u.ref === ref ? { ...u, edge, cell: snapToEdge(u.cell, edge) } : u)));
}

/** Whether a drop of `ref` on `cell` is one the builder offers: the cell must be in some entry band. Units may share a cell. */
export function canDropAt(cell: Cell): boolean {
  return edgesContaining(cell).length > 0;
}

/** Drop `ref` on `cell`: the edge becomes the band the cell is in (keeping the current edge at a corner). Off-band drops change nothing. */
export function moveTo(c: PartyConfig, ref: string, cell: Cell): PartyConfig {
  const u = c.units.find((x) => x.ref === ref);
  if (!u) return c;
  const edge = edgeForDrop(cell, u.edge);
  if (!edge) return c;
  return withUnits(c, c.units.map((x) => (x.ref === ref ? { ...x, edge, cell: { x: cell.x, y: cell.y } } : x)));
}

export function toggleSiege(c: PartyConfig, typeId: string): PartyConfig {
  const has = c.siege.includes(typeId);
  return { v: PARTY_CONFIG_VERSION, units: c.units, siege: has ? c.siege.filter((s) => s !== typeId) : [...c.siege, typeId] };
}

/** How many units enter from each edge, for the approach summary. */
export function countsByEdge(c: PartyConfig): readonly { readonly edge: EntryEdge; readonly count: number }[] {
  return ENTRY_EDGES.map((edge) => ({ edge, count: c.units.filter((u) => u.edge === edge).length }));
}

/** Stable equality for the dirty check: canonical order is the server's; here key order is fixed and units sorted by ref. */
export function configKey(c: PartyConfig): string {
  const units = [...c.units].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)).map((u) => `${u.ref}:${u.stance}:${u.edge}:${u.cell.x},${u.cell.y}`);
  return `${units.join("|")}#${[...c.siege].sort().join(",")}`;
}

// ── the DOM alternative to dragging (keyboard / screen reader, PHASE-2 §35) ────────────

/** How many positions run along an edge. */
export function edgeLength(edge: EntryEdge): number {
  return edge === "north" || edge === "south" ? GRID_WIDTH : GRID_HEIGHT;
}

/** Position along `edge` (0 = the west / north end). */
export function alongOf(cell: Cell, edge: EntryEdge): number {
  return edge === "north" || edge === "south" ? cell.x : cell.y;
}

/** Rows (or columns) in from the map border, 0 = the outermost; within the band it is < ENTRY_BAND_DEPTH. */
export function depthOf(cell: Cell, edge: EntryEdge): number {
  switch (edge) {
    case "north":
      return cell.y;
    case "south":
      return GRID_HEIGHT - 1 - cell.y;
    case "west":
      return cell.x;
    case "east":
      return GRID_WIDTH - 1 - cell.x;
  }
}

export function cellOnEdge(edge: EntryEdge, along: number, depth: number): Cell {
  const a = Math.max(0, Math.min(edgeLength(edge) - 1, Math.trunc(along)));
  const d = Math.max(0, Math.min(ENTRY_BAND_DEPTH - 1, Math.trunc(depth)));
  switch (edge) {
    case "north":
      return { x: a, y: d };
    case "south":
      return { x: a, y: GRID_HEIGHT - 1 - d };
    case "west":
      return { x: d, y: a };
    case "east":
      return { x: GRID_WIDTH - 1 - d, y: a };
  }
}

/** Set a unit's start cell on its current edge from the list controls. */
export function setStart(c: PartyConfig, ref: string, along: number, depth: number): PartyConfig {
  return withUnits(c, c.units.map((u) => (u.ref === ref ? { ...u, cell: cellOnEdge(u.edge, along, depth) } : u)));
}

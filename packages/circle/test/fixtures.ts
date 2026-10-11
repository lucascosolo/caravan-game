import { TUNABLES } from "@caravan/content";
import { packManifest, type AccessCheck, type Formation, type Manifest, FORMATION_VERSION, RING_SEGMENTS, type Cell } from "../src/index.js";

export const ALLOW_ALL: AccessCheck = () => true;

/** A full loadout at every cap: 8 desert units, 6 traps, 24 brush-pile segments. */
export function fullPack(): Manifest {
  const res = packManifest(
    {
      units: [
        { instanceId: "u-rider", typeId: "desert.dust_rider", mergeLevel: 1 },
        { instanceId: "u-digger", typeId: "desert.well_digger", mergeLevel: 2 },
        { instanceId: "u-sharp", typeId: "desert.sand_sharpshooter", mergeLevel: 1 },
        { instanceId: "u-canteen", typeId: "desert.canteen_carrier", mergeLevel: 1 },
        { instanceId: "u-coyote", typeId: "desert.coyote_pack", mergeLevel: 3 },
        { instanceId: "u-monkey", typeId: "desert.powder_monkey", mergeLevel: 1 },
        { instanceId: "u-bull", typeId: "desert.longhorn_bull", mergeLevel: 1 },
        { instanceId: "u-vaquero", typeId: "desert.vaquero", mergeLevel: 5 },
      ],
      traps: ["trap.spike_pit", "trap.jaw_trap", "trap.tripwire_snare", "trap.caltrop_scatter", "trap.powder_keg", "trap.tar_pot"],
      fence: { tierId: "fence.brush_pile", count: TUNABLES.FENCE_MATERIAL_BUDGET },
    },
    ALLOW_ALL,
  );
  if (!res.ok) throw new Error(JSON.stringify(res.issues));
  return res.value;
}

/** Cells just inside the ring, on the north-west quadrant, for posts and traps. */
export function innerCells(): Cell[] {
  const out: Cell[] = [];
  const c = RING_SEGMENTS[0]!.cell; // north-west corner of the ring
  for (let y = c.y + 1; y < c.y + 4; y++) for (let x = c.x + 1; x < c.x + 8; x++) out.push({ x, y });
  return out;
}

/**
 * A legal formation from a manifest: every intact fence on consecutive ring positions
 * starting at `firstSegment` (so the gap is wherever the budget runs out), every unspent
 * trap and every living unit on distinct inner cells.
 */
export function arrange(m: Manifest, firstSegment = 0): Formation {
  const cells = innerCells();
  let next = 0;
  const fences = m.fences.filter((f) => f.hp > 0).map((f, i) => ({ ref: f.ref, segment: (firstSegment + i) % RING_SEGMENTS.length }));
  const traps = m.traps.filter((t) => !t.spent).map((t) => ({ ref: t.ref, cell: cells[next++]! }));
  const posts = m.units.filter((u) => u.hp > 0).map((u) => ({ ref: u.ref, cell: cells[next++]! }));
  return { v: FORMATION_VERSION, fences, traps, posts };
}

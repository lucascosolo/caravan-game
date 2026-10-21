import { TUNABLES } from "@caravan/content";
import { DEFAULT_DEFENSIVE_STANCE, packManifest, type AccessCheck, type Formation, type Manifest, FORMATION_VERSION, INTERIOR_POST_CELLS, RING_SEGMENTS, type Cell } from "../src/index.js";

export const ALLOW_ALL: AccessCheck = () => true;

/** A full loadout at every cap: 8 desert units, 6 traps, FENCE_MATERIAL_BUDGET brush-pile segments. */
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

/** Cells inside the round ring, in the north of the interior, for posts and traps. */
export function innerCells(): Cell[] {
  return INTERIOR_POST_CELLS.slice(0, 21).map((c) => ({ x: c.x, y: c.y }));
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
  const posts = m.units.filter((u) => u.hp > 0).map((u) => ({ ref: u.ref, cell: cells[next++]!, stance: DEFAULT_DEFENSIVE_STANCE }));
  return { v: FORMATION_VERSION, fences, traps, posts };
}

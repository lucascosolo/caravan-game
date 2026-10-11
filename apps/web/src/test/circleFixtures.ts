/**
 * Chunk 08 test fixtures: a manifest packed with @caravan/circle's own `packManifest` (so
 * the shape is exactly what the server stores), with carry-forward attrition applied by
 * hand the way `survivors` would arrive: a wounded unit, a dead one, a spent trap, a
 * chipped fence segment and a destroyed one.
 */
import { packManifest, type Manifest } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";

export function packedManifest(): Manifest {
  const res = packManifest(
    {
      units: [
        { instanceId: "u-rider", typeId: "desert.dust_rider", mergeLevel: 1 },
        { instanceId: "u-digger", typeId: "desert.well_digger", mergeLevel: 2 },
        { instanceId: "u-canteen", typeId: "desert.canteen_carrier", mergeLevel: 1 },
      ],
      traps: ["trap.spike_pit", "trap.jaw_trap"],
      fence: { tierId: "fence.brush_pile", count: TUNABLES.FENCE_MATERIAL_BUDGET },
    },
    () => true,
  );
  if (!res.ok) throw new Error(JSON.stringify(res.issues));
  return res.value;
}

/** The same loadout after two encounters: attrition everywhere, nothing restored. */
export function survivorsManifest(): Manifest {
  const m = packedManifest();
  return {
    v: 1,
    units: m.units.map((u) => (u.ref === "u-rider" ? { ...u, hp: Math.trunc(u.maxHp / 3) } : u.ref === "u-digger" ? { ...u, hp: 0 } : u)),
    traps: m.traps.map((t) => (t.ref === "t0" ? { ...t, spent: true } : t)),
    fences: m.fences.map((f) => (f.ref === "f0" ? { ...f, hp: 0 } : f.ref === "f1" ? { ...f, hp: 120 } : f)),
  };
}

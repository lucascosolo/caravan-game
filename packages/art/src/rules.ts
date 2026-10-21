/** Size and anchor rules per asset class (docs/art/STYLE-GUIDE.md §3; footprints in art px). */
import type { ArtClass, Finding } from "./coverage.ts";
import type { AnchorKind } from "./paint.ts";
import { MASTER_DPR } from "./paint.ts";

export interface AssetMeta {
  footprint: [number, number];
  anchor: [number, number];
  /** Pose name → frame file names in the asset folder. Single poses for now ("idle"); room for more frames later. */
  poses: Record<string, string[]>;
}

export interface ClassRule {
  readonly maxFootprint: [number, number];
  /** The anchor is a ground-contact point near the bottom of the footprint. */
  readonly groundAnchor: boolean;
  readonly anchorKind: AnchorKind;
  /** Harmonise the turquoise side colour toward the side keys (units only). */
  readonly sideColour: boolean;
}

export const MASTER_MAX_BYTES = 400 * 1024;

export const CLASS_RULES: Record<ArtClass, ClassRule> = {
  units: { maxFootprint: [48, 56], groundAnchor: true, anchorKind: "foot", sideColour: true },
  wagons: { maxFootprint: [96, 72], groundAnchor: true, anchorKind: "wagon", sideColour: false },
  fences: { maxFootprint: [48, 36], groundAnchor: false, anchorKind: "centre", sideColour: false },
  traps: { maxFootprint: [32, 24], groundAnchor: false, anchorKind: "centre", sideColour: false },
  siege: { maxFootprint: [72, 64], groundAnchor: true, anchorKind: "foot", sideColour: false },
  terrain: { maxFootprint: [96, 64], groundAnchor: false, anchorKind: "centre", sideColour: false },
  town: { maxFootprint: [256, 256], groundAnchor: true, anchorKind: "foot", sideColour: false },
  ui: { maxFootprint: [128, 128], groundAnchor: false, anchorKind: "centre", sideColour: false },
  cosmetics: { maxFootprint: [96, 72], groundAnchor: false, anchorKind: "centre", sideColour: false },
};

export function checkAssetRules(cls: ArtClass, key: string, meta: AssetMeta, master: { width: number; height: number; bytes: number }): Finding[] {
  const id = `${cls}/${key}`;
  const out: Finding[] = [];
  const err = (message: string): number => out.push({ level: "error", id, message });
  const rule = CLASS_RULES[cls];
  const [w, h] = meta.footprint;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) err(`footprint ${w}x${h} must be positive integers`);
  else if (w > rule.maxFootprint[0] || h > rule.maxFootprint[1]) err(`footprint ${w}x${h} exceeds the ${cls} maximum ${rule.maxFootprint.join("x")}`);
  if (master.width !== w * MASTER_DPR || master.height !== h * MASTER_DPR)
    err(`master is ${master.width}x${master.height}; the footprint at ${MASTER_DPR}x needs ${w * MASTER_DPR}x${h * MASTER_DPR}`);
  if (master.bytes > MASTER_MAX_BYTES) err(`master is ${master.bytes} bytes, over ${MASTER_MAX_BYTES}`);
  const [ax, ay] = meta.anchor;
  if (!(ax >= 0 && ax <= w && ay >= 0 && ay <= h)) err(`anchor (${ax}, ${ay}) lies outside the ${w}x${h} footprint`);
  else if (rule.groundAnchor && ay < 0.6 * h) err(`anchor y ${ay} is above the lower 40% of the footprint (ground contact)`);
  if (!meta.poses["idle"]?.length) err("poses must include a non-empty 'idle'");
  return out;
}

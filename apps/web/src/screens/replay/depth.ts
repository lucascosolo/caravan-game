/**
 * DEPTH_METRIC as a percentage for display (chunk 22 QA S6), shared by the replay player and
 * the trip's encounter results. 100 % — "reached the core" — is shown ONLY when the core was
 * reached (an overrun, or a `core_reached` row in the log); anything else is FLOORED and capped
 * at 99, so a held fight at depth 1019–1023 never reads as reaching the core. Presentation only:
 * the depth itself is the server's.
 */
import { FIXED_ONE } from "@caravan/content";

export function depthPercent(depth: number, coreReached: boolean): number {
  if (coreReached) return 100;
  return Math.max(0, Math.min(99, Math.floor((depth * 100) / FIXED_ONE)));
}

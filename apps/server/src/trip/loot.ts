/**
 * Chunk 13 — the attacking party OWNER's loot for one encounter, from the resolver's end
 * condition and DEPTH_METRIC. Pure, integer-only. The resolver never sees Coin: it reports
 * kind and depth; this turns them into an amount; the amount travels in the encounter's
 * outcome (`EncounterOutcome.loot`, the `encounter_resolved` / `party_served_as_encounter`
 * payloads) and is CREDITED — or not — by the settle path (chunk 19 / QA-15 S4), never here
 * and never by the resolver.
 *
 *   caravan_overrun   full × FULL_CLEAR_LOOT_SHARE (100 %)
 *   caravan_held      full × depth^1.5 (PARTIAL_LOOT_CURVE), depth 0..1024:
 *                     floor(full × d × isqrt(d × 1024) / 1024²) — isqrt floors, so the share
 *                     never exceeds d^1.5 and the loot never exceeds full; monotone in d
 *   stalemate         full × STALEMATE_LOOT_SHARE (0): the safety valve favours the caravan
 *
 * `full` is the encounter's Coin value (chunk 16's coinForEncounter(n), the same schedule the
 * caravan's own encounter Coin follows). BOUNDED STAKES: no kind yields more than `full`.
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import { isqrt } from "@caravan/resolver";
import { coinForEncounter } from "../economy/coin.js";
import type { EncounterOutcomeKind } from "./outcome.js";

if (TUNABLES.PARTIAL_LOOT_CURVE !== "full_x_depth_pow_1_5") throw new Error(`PARTIAL_LOOT_CURVE '${String(TUNABLES.PARTIAL_LOOT_CURVE)}' is not implemented`);

/** The share of `full` the owner earns, fixed-point 0..1024 (informational; partyLoot computes with one floor). */
export function partyLootShare(kind: EncounterOutcomeKind, depth: number): number {
  return partyLoot(kind, depth, FIXED_ONE);
}

export function partyLoot(kind: EncounterOutcomeKind, depth: number, full: number): number {
  if (!Number.isSafeInteger(full) || full < 0) throw new RangeError(`full loot must be a non-negative integer, got ${String(full)}`);
  if (!Number.isInteger(depth) || depth < 0 || depth > FIXED_ONE) throw new RangeError(`depth must be an integer in 0..${FIXED_ONE}`);
  const scale = (share: number) => Math.floor((full * share) / FIXED_ONE);
  if (kind === "caravan_overrun") return Math.min(full, scale(TUNABLES.FULL_CLEAR_LOOT_SHARE));
  if (kind === "stalemate") return scale(TUNABLES.STALEMATE_LOOT_SHARE);
  // depth^1.5 with one floor: full × d × ⌊√(d·1024)⌋ / 1024² (≤ 2^53 for full ≤ 8·10⁹).
  const root = isqrt(depth * FIXED_ONE);
  return Math.floor((full * depth * root) / (FIXED_ONE * FIXED_ONE));
}

/** The loot for encounter n of a trip (its Coin value is chunk 16's schedule). */
export function partyLootForEncounter(kind: EncounterOutcomeKind, depth: number, encounterIndex: number): number {
  return partyLoot(kind, depth, coinForEncounter(encounterIndex));
}

/**
 * Chunk 13 / chunk 15 QA S4 — the attacking party OWNER's loot for one encounter, from the
 * resolver's end condition and DEPTH_METRIC. Pure, integer-only. The resolver never sees
 * Coin: it reports kind and depth; this turns them into an amount; the amount travels in the
 * encounter's outcome (`EncounterOutcome.loot`, the `encounter_resolved` /
 * `party_served_as_encounter` payloads) and the trip loop's settle CREDITS exactly that
 * amount to the owner (trip/service.ts, capped by their storage headroom), never more.
 *
 * ONE RULE for what the owner of the party is paid per encounter (chunk 15 QA S4 × chunk 19
 * QA D1 — reconciled so nothing is paid twice):
 *
 *   caravan_held      loot = full × depth^1.5 (PARTIAL_LOOT_CURVE), depth 0..1024:
 *                     floor(full × d × isqrt(d × 1024) / 1024²) — isqrt floors, so the share
 *                     never exceeds d^1.5 and the loot never exceeds full; monotone in d.
 *   caravan_overrun   loot = 0. The owner is paid chunk 19's overrun credits instead: the
 *                     transfer of the trip's unbanked Coin + COIN_PER_PARTY_WIN (one capped
 *                     batch under `transfer:<jobId>`). That IS the "full clear" pay; a depth
 *                     share on top would pay the same clear twice.
 *   stalemate         loot = full × STALEMATE_LOOT_SHARE (0): the safety valve favours the caravan.
 *
 * `full` is the encounter's Coin value at the caravan's display band from the CHOSEN menu
 * row — chunk 16's coinForEncounter(n, band), the same scheduled amount the caravan's own
 * `coin_accrued` starts from (before chunk 19's sandbagging floor, which shapes what the
 * CARAVAN earns, not the owner) — and 0 for a system (authored) owner, who is never credited.
 * The trip loop stamps it into the job input at enqueue (`partyLootFull`), so the reported loot
 * is a pure function of the job input and equals the credit's requested amount.
 * BOUNDED STAKES: no kind yields more than `full`.
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import { isqrt } from "@caravan/resolver";
import type { EncounterOutcomeKind } from "./outcome.js";

if (TUNABLES.PARTIAL_LOOT_CURVE !== "full_x_depth_pow_1_5") throw new Error(`PARTIAL_LOOT_CURVE '${String(TUNABLES.PARTIAL_LOOT_CURVE)}' is not implemented`);

/** The share of `full` the owner earns, fixed-point 0..1024 (informational; partyLoot computes with one floor). */
export function partyLootShare(kind: EncounterOutcomeKind, depth: number): number {
  return partyLoot(kind, depth, FIXED_ONE);
}

export function partyLoot(kind: EncounterOutcomeKind, depth: number, full: number): number {
  if (!Number.isSafeInteger(full) || full < 0) throw new RangeError(`full loot must be a non-negative integer, got ${String(full)}`);
  if (!Number.isInteger(depth) || depth < 0 || depth > FIXED_ONE) throw new RangeError(`depth must be an integer in 0..${FIXED_ONE}`);
  // Paid through chunk 19's transfer + party win, never as loot (see the rule above).
  if (kind === "caravan_overrun") return 0;
  if (kind === "stalemate") return Math.floor((full * TUNABLES.STALEMATE_LOOT_SHARE) / FIXED_ONE);
  // depth^1.5 with one floor: full × d × ⌊√(d·1024)⌋ / 1024² (≤ 2^53 for full ≤ 8·10⁹).
  const root = isqrt(depth * FIXED_ONE);
  return Math.floor((full * depth * root) / (FIXED_ONE * FIXED_ONE));
}

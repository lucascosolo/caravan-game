/**
 * The access seam: "is this type unlocked for this player?" — the ONLY gate on which
 * types may be packed or placed (GUARDRAILS §3). Every chunk-07 validation path asks this
 * function; nothing else decides access.
 *
 * Chunk 05 replaced the STARTING_NODES stub with the real unlock webs: this module is now
 * a thin re-export of `src/unlocks/access.ts`, kept so the circle's callers keep one import
 * path. The living web is read on the caravan (region-scoped); trap, fence-tier and siege
 * access on the account. The predicate is bound once per validation pass, inside the
 * transaction that uses it.
 */
export { accessCheckFor, hasAccess, hasAccess as isUnlocked, unlockedTypeIds, type AccessOwner, type AccessPredicate } from "../unlocks/access.js";

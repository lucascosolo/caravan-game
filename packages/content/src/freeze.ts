/**
 * Deep-freeze for exported content (chunk 03 QA S2). Every exported data structure —
 * CONTENT, the type arrays, TUNABLES, the affinity matrix, REGIONS — is frozen on export
 * so a consumer cannot mutate a balance value at runtime; in strict-mode code (every ES
 * module) an assignment to a frozen object throws a TypeError. `as const` / `readonly`
 * only narrow the TYPE; this is the runtime guarantee, and a test asserts it.
 *
 * Pure: walks plain objects and arrays only, no I/O, no clock.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** True when `value` and everything reachable from it through own enumerable keys is frozen. */
export function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  for (const key of Object.keys(value)) {
    if (!isDeepFrozen((value as Record<string, unknown>)[key])) return false;
  }
  return true;
}

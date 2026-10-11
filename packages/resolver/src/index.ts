/**
 * @caravan/resolver — the deterministic simulation (chunks 10–13).
 *
 * This package is intentionally empty in chunk 01. Its isolation rules are already
 * enforced by eslint.config.js: no imports from outside the package, no float
 * literals, no Math.random / Date / sin / cos / atan2 / exp / pow / sqrt, no I/O.
 * Everything here must be fixed-point integer arithmetic.
 */
export const RESOLVER_VERSION = 0;

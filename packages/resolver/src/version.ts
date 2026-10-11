/**
 * RESOLVER_VERSION is stamped on every output and every stored log (chunk 02 stamps it on
 * resolution rows; chunk 13 stores it with each replay). Bump it whenever any change alters
 * what a stored input resolves to — geometry, phase order, a tie-break, a rounding mode.
 * 0 was the chunk 01 placeholder; 1 is chunk 10's tick loop and movement; 2 is chunk 10's
 * QA round 1 (leg-parametric movement with margin line of sight, the tick-exact breach
 * price, clamped breach edges, same-tick waypoint arrival); 3 is chunk 11's combat
 * (cooldown-paced hits with the affinity layer, swept-path traps, posted-unit stances /
 * aggro / leash, siege counters, unit death, the REACH rule and the new input tunables).
 */
export const RESOLVER_VERSION = 3;

/**
 * RESOLVER_VERSION is stamped on every output and every stored log (chunk 02 stamps it on
 * resolution rows; chunk 13 stores it with each replay). Bump it whenever any change alters
 * what a stored input resolves to — geometry, phase order, a tie-break, a rounding mode.
 * 0 was the chunk 01 placeholder; 1 is chunk 10's tick loop and movement; 2 is chunk 10's
 * QA round 1 (leg-parametric movement with margin line of sight, the tick-exact breach
 * price, clamped breach edges, same-tick waypoint arrival); 3 is chunk 11's combat
 * (cooldown-paced hits with the affinity layer, swept-path traps, posted-unit stances /
 * aggro / leash, siege counters, unit death, the REACH rule and the new input tunables);
 * 4 is chunk 11's QA round 1 (every stance fires in reach, a breacher answers only a unit
 * that can reach it, pursuit routes bounded by leash and aggro, aggro hysteresis on the
 * target last lost, the leash clamp, traps skip 0-HP units, tighter input bounds).
 */
export const RESOLVER_VERSION = 4;

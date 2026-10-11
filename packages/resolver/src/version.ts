/**
 * RESOLVER_VERSION is stamped on every output and every stored log (chunk 02 stamps it on
 * resolution rows; chunk 13 stores it with each replay). Bump it whenever any change alters
 * what a stored input resolves to — geometry, phase order, a tie-break, a rounding mode.
 * 0 was the chunk 01 placeholder; 1 is chunk 10's tick loop and movement.
 */
export const RESOLVER_VERSION = 1;

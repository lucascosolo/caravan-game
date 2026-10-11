/**
 * The system accounts' handle prefix (chunk 25, chunk 14 QA N2 / chunk 25 QA B1), in ONE
 * place with ONE meaning: a LITERAL prefix. Registration refuses it, the seed re-asserts
 * `is_system` on every account under it, and both ask the same question the same way.
 *
 * Never test it with `LIKE 'sys_outfit_%'`: `_` is a LIKE wildcard, so that pattern also
 * matches `sys0outfit0evil` or `sys_outfitx_evil` — names registration (correctly) lets a
 * player take — and the seed would then try to re-flag a player's account and refuse to
 * run at all. SQL callers use `starts_with(username, $1)` with the prefix as a parameter.
 */
export const SYSTEM_USERNAME_PREFIX = "sys_outfit_";

/** True when `username` (already normalized: trimmed, lowercased) starts with the literal prefix. */
export function hasSystemUsernamePrefix(username: string): boolean {
  return username.startsWith(SYSTEM_USERNAME_PREFIX);
}

/** The SQL predicate equivalent to `hasSystemUsernamePrefix(username)`; bind `$n` to SYSTEM_USERNAME_PREFIX. */
export function systemUsernamePrefixSql(param: string): string {
  if (!/^\$\d+$/.test(param)) throw new RangeError("param must be a placeholder like $1");
  return `starts_with(username, ${param})`;
}

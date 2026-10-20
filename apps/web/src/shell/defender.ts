/**
 * Who a standing party struck, in words (results feed, inbox). Exactly what the server sends of
 * the defender — a public username and the caravan's name — never an id.
 *
 * Final play-test review r2 N15: a defender whose owner has since deleted the account carries
 * `departed: true` and no name; it reads "a caravan that has since left the trail", not
 * "someone (someone)". A guest has a caravan name but no username: the caravan name alone.
 */
import { STRINGS } from "../strings.ts";

export interface DefenderLike {
  readonly username: string | null;
  readonly caravanName: string | null;
  readonly departed?: boolean | undefined;
}

export function defenderLabel(d: DefenderLike): string {
  const D = STRINGS.defender;
  if (d.departed === true) return D.departed;
  // Final play-test review r3 N6: strangers see the caravan name, never a username, whatever is sent.
  if (d.caravanName !== null) return d.caravanName;
  if (d.username !== null) return d.username;
  return D.unknown;
}

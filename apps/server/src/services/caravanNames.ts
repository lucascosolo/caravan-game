/**
 * Generated caravan names (final play-test review N8). Every caravan gets a name at creation;
 * one the player did not choose is generated here from the account id, so a guest's standing
 * party is served under its caravan's name instead of "Unnamed drifter". Deterministic (the
 * same account always gets the same name) and presentation only: nothing in matchmaking,
 * resolution or the economy reads a caravan's name.
 */
import { CONTENT } from "@caravan/content";
import { fnv1a32 } from "../acquisition/refugeeMenu.js";
import type { Queryable } from "../db/pool.js";
import { AUTHORED_OUTFITS } from "../matchmaking/authoredOutfits.js";

/** The placeholder every caravan created without a name used to get; still shown as a generic owner name. */
export const LEGACY_DEFAULT_CARAVAN_NAME = "Caravan";

// Final play-test review r2 N4: 32 × 32 = 1,024 names (was 16 × 16 = 256: 2 of 6 accounts collided).
const FIRST = [
  "Dusty", "Copper", "Red Mesa", "Long Shadow", "Iron Creek", "Sagebrush", "Lone Pine", "Dry Gulch",
  "High Lonesome", "Cottonwood", "Silver Spur", "Rattlesnake", "Painted Rock", "Coyote", "Mesquite", "Thunder Ridge",
  "Juniper", "Iron Rail", "Salt Flat", "Blue Mesa", "Prairie", "Buckskin", "Stagecoach", "Tin Cup",
  "Black Butte", "Wild Horse", "Bitter Creek", "Sundown", "Granite", "Dead Man's", "Lost Spring", "Big Sky",
] as const;
const SECOND = [
  "Outfit", "Train", "Company", "Wagons", "Trail Crew", "Freighters", "Drovers", "Line",
  "Haulers", "Party", "Brigade", "Teamsters", "Riders", "Caravan", "Expedition", "Post",
  "Wagon Co.", "Packers", "Trailhands", "Muleskinners", "Convoy", "Rangers", "Movers", "Supply",
  "Express", "Column", "Pioneers", "Settlers", "Mail", "Cartage", "Run", "Fellowship",
] as const;

/** The generated name for a caravan of `accountId` (salt 0) or a re-roll (`salt` > 0). Within CARAVAN_NAME_MAX by construction. */
export function generatedCaravanName(accountId: string, salt = 0): string {
  const seed = salt === 0 ? accountId.toLowerCase() : `${accountId.toLowerCase()}#${salt}`;
  // A few combinations equal a reserved name (an authored outfit is called "High Lonesome
  // Riders"): step to the next deterministic combination, so a generated name is never reserved.
  for (let k = 0; ; k++) {
    const h = fnv1a32(k === 0 ? seed : `${seed}~${k}`);
    const name = `${FIRST[h % FIRST.length]!} ${SECOND[(h >>> 8) % SECOND.length]!}`;
    if (!isReservedCaravanName(name)) return name;
  }
}

/** How many re-rolls a generated name gets before it takes an ordinal suffix. */
const NAME_REROLLS = 32;
const ORDINALS = ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"] as const;

/** The generic names the server itself shows for someone (erasure's tombstone, a nameless owner). */
export const DEPARTED_DISPLAY_NAME = "Departed outfit"; // = account_erasure_display_name() (migration 020)
export const SYSTEM_DISPLAY_NAMES: readonly string[] = [DEPARTED_DISPLAY_NAME, "Departed caravan", "Unnamed outfit", "Unnamed drifter", LEGACY_DEFAULT_CARAVAN_NAME];

/**
 * Final guardrail review r3 N2: names no caravan may take (compared case-insensitively, trimmed):
 * every unit, ability, trap, siege and fence label in content, every authored outfit's name, and
 * the generic names above. A caravan named "Dust Rider" read like a unit in a stranger's scout, and
 * one named "Departed outfit" passed as an erased player.
 */
export const RESERVED_CARAVAN_NAMES: ReadonlySet<string> = new Set(
  [
    ...CONTENT.units.flatMap((u) => [u.displayName, u.ability.displayName]),
    ...CONTENT.traps.map((t) => t.displayName),
    ...CONTENT.siege.map((s) => s.displayName),
    ...CONTENT.fences.map((f) => f.displayName),
    ...Object.values(AUTHORED_OUTFITS).flatMap((os) => os.map((o) => o.name)),
    ...SYSTEM_DISPLAY_NAMES,
  ].map((n) => n.trim().toLowerCase()),
);

export function isReservedCaravanName(name: string): boolean {
  return RESERVED_CARAVAN_NAMES.has(name.trim().toLowerCase());
}

async function nameTaken(db: Queryable, name: string): Promise<boolean> {
  if (isReservedCaravanName(name)) return true;
  const res = await db.query("SELECT 1 FROM caravan WHERE lower(name) = lower($1) LIMIT 1", [name]);
  return (res.rowCount ?? 0) > 0;
}

/** r3 N2: a short, deterministic hex suffix for when the ordinals run out. */
function hashSuffix(accountId: string, name: string, salt: number, digits: number): string {
  return fnv1a32(`${accountId.toLowerCase()}#${name}#${salt}`).toString(16).padStart(8, "0").slice(0, digits);
}

/**
 * r2 N4: a caravan name no other caravan carries (case-insensitive), so the inbox, the scout and
 * the strike lines can tell caravans apart. With no requested name: the generated name, re-rolled
 * on a collision. With one (the player's own, or one a client generated): kept, unless another
 * caravan already carries it — then an ordinal is added ("Dusty Teamsters II"), still within
 * `maxLength`. Best effort, not a constraint: two creations racing on one name may both win.
 */
export async function uniqueCaravanName(db: Queryable, accountId: string, requested: string | undefined, maxLength: number): Promise<string> {
  if (requested === undefined) {
    for (let salt = 0; salt <= NAME_REROLLS; salt++) {
      const name = generatedCaravanName(accountId, salt);
      if (!(await nameTaken(db, name))) return name;
    }
    requested = generatedCaravanName(accountId);
  }
  if (!(await nameTaken(db, requested))) return requested;
  for (const ord of ORDINALS) {
    const suffix = ` ${ord}`;
    const name = `${requested.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
    if (!(await nameTaken(db, name))) return name;
  }
  // r3 N2: past the ordinals, a short hash suffix ("Dusty Teamsters 3fa2"), never the duplicate.
  for (let salt = 0; salt < NAME_REROLLS; salt++) {
    const suffix = ` ${hashSuffix(accountId, requested, salt, salt < NAME_REROLLS / 2 ? 4 : 8)}`;
    const name = `${requested.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
    if (!(await nameTaken(db, name))) return name;
  }
  return `${requested.slice(0, maxLength - 9).trimEnd()} ${hashSuffix(accountId, requested, NAME_REROLLS, 8)}`;
}

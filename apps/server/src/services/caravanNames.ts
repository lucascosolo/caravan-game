/**
 * Generated caravan names (final play-test review N8). Every caravan gets a name at creation;
 * one the player did not choose is generated here from the account id, so a guest's standing
 * party is served under its caravan's name instead of "Unnamed drifter". Deterministic (the
 * same account always gets the same name) and presentation only: nothing in matchmaking,
 * resolution or the economy reads a caravan's name.
 */
import { fnv1a32 } from "../acquisition/refugeeMenu.js";

/** The placeholder every caravan created without a name used to get; still shown as a generic owner name. */
export const LEGACY_DEFAULT_CARAVAN_NAME = "Caravan";

const FIRST = ["Dusty", "Copper", "Red Mesa", "Long Shadow", "Iron Creek", "Sagebrush", "Lone Pine", "Dry Gulch", "High Lonesome", "Cottonwood", "Silver Spur", "Rattlesnake", "Painted Rock", "Coyote", "Mesquite", "Thunder Ridge"] as const;
const SECOND = ["Outfit", "Train", "Company", "Wagons", "Trail Crew", "Freighters", "Drovers", "Line", "Haulers", "Party", "Brigade", "Teamsters", "Riders", "Caravan", "Expedition", "Post"] as const;

/** The generated name for a caravan of `accountId`. Within CARAVAN_NAME_MAX (32) by construction. */
export function generatedCaravanName(accountId: string): string {
  const h = fnv1a32(accountId.toLowerCase());
  return `${FIRST[h % FIRST.length]!} ${SECOND[(h >>> 8) % SECOND.length]!}`;
}

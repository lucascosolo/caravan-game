/**
 * The client–server contract (chunk 08 QA D4): which guard in src/api/shapes.ts the client
 * runs on each recorded route's body. The server suite (`apps/server/test/contract.test.ts`)
 * records the bodies into this folder and runs `checkContract` on them in-process; the web
 * suite (`contract.test.ts` here) runs it on the committed files.
 *
 * `null` = the client has no guard for that route yet (it does not read it). Such routes
 * are SKIPPED and listed by the web test, so the chunk that adds the screen and its guard
 * turns its route on by filling the entry in. Every recorded file must have an entry.
 */
import { ShapeError, expectShape, type Guard } from "../../api/shape.ts";
import {
  authShape,
  choiceShape,
  economyShape,
  formationShape,
  manifestShape,
  meShape,
  menuShape,
  mergePreviewShape,
  partyFeedShape,
  partyShape,
  progressionShape,
  recruitViewShape,
  refugeeViewShape,
  spendResultShape,
  unlocksShape,
  cosmeticsShape,
  equipResultShape,
  purchaseResultShape,
  purchasesShape,
  storeShape,
  unequipResultShape,
} from "../../api/shapes.ts";

export const CONTRACT_GUARDS: Readonly<Record<string, Guard<unknown> | null>> = {
  auth: authShape,
  "auth-login": authShape,
  me: meShape,
  unlocks: unlocksShape,
  progression: progressionShape,
  "unlocks-spend": spendResultShape,
  economy: economyShape,
  "merge-preview": mergePreviewShape,
  refugees: refugeeViewShape,
  recruit: recruitViewShape,
  party: partyShape,
  "party-put": partyShape,
  "party-feed": partyFeedShape,
  "manifest-pack": manifestShape,
  manifest: manifestShape,
  search: menuShape,
  candidates: menuShape,
  choose: choiceShape,
  "formation-put": formationShape,
  formation: formationShape,
  "formation-commit": formationShape,
  // Chunk 20's Packs and Cosmetics screens.
  store: storeShape,
  "store-purchase": purchaseResultShape,
  "store-purchase-replay": purchaseResultShape,
  "store-purchases": purchasesShape,
  cosmetics: cosmeticsShape,
  "cosmetics-owned": cosmeticsShape,
  "cosmetics-equip": equipResultShape,
  "cosmetics-unequip": unequipResultShape,
};

/** Null when `body` passes the route's guard (or the route has none); else the guard's reason. */
export function checkContract(name: string, body: unknown): string | null {
  const guard = CONTRACT_GUARDS[name];
  if (!guard) return null;
  try {
    expectShape(guard, body);
    return null;
  } catch (err) {
    if (err instanceof ShapeError) return err.message;
    throw err;
  }
}

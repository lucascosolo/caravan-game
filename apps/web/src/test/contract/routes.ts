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
import { replayShape } from "../../api/replayShapes.ts";
import { inboxShape, inboxUnreadShape } from "../../api/inboxShapes.ts";
import { analyticsSettingsShape, dashboardShape, telemetryIngestShape } from "../../api/telemetryShapes.ts";
import { onboardingChangeShape, onboardingShape } from "../../onboarding/shapes.ts";
import { bankResultShape, encounterCommitShape, pushResultShape, stakesPreviewShape, tripCapRefusalShape, tripStartShape, tripStatusShape } from "../../api/tripShapes.ts";

export const CONTRACT_GUARDS: Readonly<Record<string, Guard<unknown> | null>> = {
  auth: authShape,
  "auth-login": authShape,
  // Chunk 24: the first-session guide.
  onboarding: onboardingShape,
  "onboarding-advance": onboardingChangeShape,
  "onboarding-skip": onboardingChangeShape,
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
  // The trip loop (chunk 15 routes; chunk 23's client). Fights resolved by chunk 15's test double.
  "trip-status-packed": tripStatusShape,
  "trip-start": tripStartShape,
  "trip-commit": encounterCommitShape,
  "trip-status-resolving": tripStatusShape,
  "trip-status-decide": tripStatusShape,
  "trip-preview": stakesPreviewShape,
  "trip-push": pushResultShape,
  "trip-preview-2": stakesPreviewShape,
  "trip-bank": bankResultShape,
  "trip-status-banked": tripStatusShape,
  "trip-status-overrun": tripStatusShape,
  // Chunk 15 QA D3 / N2: a voided trip, and the preview before the first survival (no bank quote).
  "trip-status-voided": tripStatusShape,
  "trip-preview-start": stakesPreviewShape,
  // The 409 body the client reads through ApiError.body (cap + retryAfterSeconds).
  "trip-start-refused": tripCapRefusalShape,
  // Chunk 20's Packs and Cosmetics screens.
  store: storeShape,
  "store-purchase": purchaseResultShape,
  "store-purchase-replay": purchaseResultShape,
  "store-purchases": purchasesShape,
  cosmetics: cosmeticsShape,
  "cosmetics-owned": cosmeticsShape,
  "cosmetics-equip": equipResultShape,
  "cosmetics-unequip": unequipResultShape,
  // Chunk 22's replay player: a real-resolver fight for both participants, and a double-resolved one (no log).
  replay: replayShape,
  "replay-owner": replayShape,
  "replay-no-log": replayShape,
  // Chunk 29's inbox: the struck party's owner (a real-resolver strike), the badge, a mark-all, and every other category.
  inbox: inboxShape,
  "inbox-unread": inboxUnreadShape,
  "inbox-read": inboxShape,
  "inbox-preferences": inboxShape,
  // Chunk 32: the usage-data setting, a telemetry batch's answer, and the admin dashboard
  // (recorded by apps/server/test/telemetry.test.ts over its seeded history).
  analytics: analyticsSettingsShape,
  "analytics-put": analyticsSettingsShape,
  telemetry: telemetryIngestShape,
  "admin-dashboard": dashboardShape,
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

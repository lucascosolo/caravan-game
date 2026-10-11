/**
 * Chunk 24: the first-session guide's steps, in order (PHASE-2 §24). Mirrored by migration
 * 017's CHECK and its rank function; `test/onboarding.test.ts` pins the two together, and the
 * web client's `src/onboarding/steps.ts` carries the same list (the contract test checks it).
 *
 *   welcome  the first screen: which side you play actively (defense: the wagon circle on a
 *            trip) and which passively (offense: a standing raid party), and that the region
 *            chosen at registration is permanent for the caravan. Never skippable.
 *   roster   take a refugee in town (the ordinary free refugee menu; nothing is granted)
 *   outfit   pack the caravan and ride out
 *   scout    encounter 1: read the three scouted parties and choose one
 *   arrange  encounter 1: the guided arrangement (fence, leave a gap, post, trap, why)
 *   result   encounter 1's real, server-resolved result, then bank or push
 *   free     encounter 2: a free arrangement
 *   bank     encounter 2's result: bank the trip
 *   party    after the trip ends: "while you were out, someone else's party met a caravan"
 *            — the standing party, pre-filled from the roster
 *   done     finished or skipped; the guide never shows again for this account
 */
export const ONBOARDING_STEPS = ["welcome", "roster", "outfit", "scout", "arrange", "result", "free", "bank", "party", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(v: unknown): v is OnboardingStep {
  return typeof v === "string" && (ONBOARDING_STEPS as readonly string[]).includes(v);
}

export function stepRank(s: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(s);
}

/** The guide may be skipped from any step after the first screen (PHASE-2 §24). */
export function canSkipFrom(s: OnboardingStep): boolean {
  return s !== "welcome" && s !== "done";
}

/**
 * The first-session guide's steps (chunk 24), the same ordered list as the server's
 * `apps/server/src/onboarding/steps.ts` (the guard refuses a body whose `steps` differ, so a
 * drift fails the contract test). The server stores how far the account has got; this file
 * only names the steps and their order.
 */
export const ONBOARDING_STEPS = ["welcome", "roster", "outfit", "scout", "arrange", "result", "free", "bank", "party", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function stepRank(s: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(s);
}

/** Whether `a` is further on than `b`. */
export function isAfter(a: OnboardingStep, b: OnboardingStep): boolean {
  return stepRank(a) > stepRank(b);
}

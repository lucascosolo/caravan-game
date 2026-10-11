/**
 * Types and payload guards for the onboarding routes (chunk 24, `apps/server/src/routes/onboarding.ts`).
 * The step list must be exactly the client's (steps.ts): a server that added or reordered a step
 * without the client knowing would be guiding the player through screens this build cannot show.
 */
import { ShapeError, array, boolean, literal, nullable, object, string, type Guard } from "../api/shape.ts";
import { ONBOARDING_STEPS, type OnboardingStep } from "./steps.ts";

export interface OnboardingView {
  readonly step: OnboardingStep;
  readonly steps: readonly OnboardingStep[];
  readonly enrolled: boolean;
  readonly completed: boolean;
  readonly skipped: boolean;
  readonly canSkip: boolean;
  readonly updatedAt: string | null;
}

export interface OnboardingResponse {
  readonly onboarding: OnboardingView;
}

export interface OnboardingChange extends OnboardingResponse {
  readonly changed: boolean;
}

const step: Guard<OnboardingStep> = literal(...ONBOARDING_STEPS);

const sameSteps: Guard<readonly OnboardingStep[]> = (v, path) => {
  const got = array(step, { maxLength: 32 })(v, path);
  if (got.length !== ONBOARDING_STEPS.length || got.some((s, i) => s !== ONBOARDING_STEPS[i])) throw new ShapeError(path, `the steps ${ONBOARDING_STEPS.join(",")}`, v);
  return got;
};

export const onboardingViewShape: Guard<OnboardingView> = object({
  step,
  steps: sameSteps,
  enrolled: boolean(),
  completed: boolean(),
  skipped: boolean(),
  canSkip: boolean(),
  updatedAt: nullable(string({ maxLength: 64 })),
});

export const onboardingShape: Guard<OnboardingResponse> = object({ onboarding: onboardingViewShape });
export const onboardingChangeShape: Guard<OnboardingChange> = object({ onboarding: onboardingViewShape, changed: boolean() });

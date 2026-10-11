/**
 * The first-session guide's state (chunk 24). The SERVER holds how far the account has got
 * (`GET /me/onboarding`, account-level, forward-only); this provider reads it once per sign-in
 * and relays the screens' "the player has reached step X" to `POST /me/onboarding/advance`.
 * Nothing is kept in localStorage / sessionStorage: a reload, another device or a future second
 * caravan all read the same server row.
 *
 * Fail-open: if the guide's state cannot be read, the guide simply does not show — it never
 * blocks the game. It decides nothing about the game either: every screen it sits on reads its
 * own state from the server, exactly as without it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Api } from "../api/client.ts";
import type { OnboardingView } from "./shapes.ts";
import { isAfter, type OnboardingStep } from "./steps.ts";

export interface OnboardingContextValue {
  /** Null while loading, or when the guide's state could not be read (the guide then stays out of the way). */
  readonly view: OnboardingView | null;
  /** The guide is showing: loaded and not finished or skipped. */
  readonly active: boolean;
  /** The step the guide is on (the server's, or one this page has just reached). */
  readonly step: OnboardingStep | null;
  /** The player reached `step`: move forward to it (an earlier or equal step does nothing). */
  readonly reach: (step: OnboardingStep) => Promise<void>;
  readonly skip: () => Promise<void>;
  /** The last save failed (shown as a quiet line; the next reach retries). */
  readonly saveFailed: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ api, children }: { api: Api; children: ReactNode }): JSX.Element {
  const [view, setView] = useState<OnboardingView | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const stepRef = useRef<OnboardingStep | null>(null);

  useEffect(() => {
    let live = true;
    api.onboarding().then(
      (r) => {
        if (!live) return;
        stepRef.current = r.onboarding.step;
        setView(r.onboarding);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const reach = useCallback(
    async (step: OnboardingStep): Promise<void> => {
      const cur = stepRef.current;
      if (cur === null || !isAfter(step, cur)) return;
      stepRef.current = step;
      setView((v) => (v ? { ...v, step, completed: step === "done", canSkip: step !== "done" } : v));
      try {
        const r = await api.advanceOnboarding(step);
        if (stepRef.current !== null && !isAfter(stepRef.current, r.onboarding.step)) {
          stepRef.current = r.onboarding.step;
          setView(r.onboarding);
        }
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      }
    },
    [api],
  );

  const skip = useCallback(async (): Promise<void> => {
    const r = await api.skipOnboarding();
    stepRef.current = r.onboarding.step;
    setView(r.onboarding);
  }, [api]);

  const value = useMemo<OnboardingContextValue>(
    () => ({ view, active: view !== null && !view.completed, step: view?.step ?? null, reach, skip, saveFailed }),
    [view, reach, skip, saveFailed],
  );
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

/** The guide's state, or null outside a provider (component tests render screens without one: no guide). */
export function useOnboarding(): OnboardingContextValue | null {
  return useContext(OnboardingContext);
}

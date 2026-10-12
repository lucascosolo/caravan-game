/**
 * QA-30 D1: the guest's "save your progress" prompt — on the town screen and at the end of a
 * trip, until the guest links a username and password. Never blocking: it is a card in the
 * page with a "Not now".
 *
 * Final play-test review N3: the town card waits until the first-session guide is finished
 * (App.tsx), and "Not now" snoozes it for SAVE_PROMPT_SNOOZE_MS on this device — a per-viewer
 * convenience under VIEWER_STORAGE_PREFIX (cleared on sign-out; if storage is blocked it falls
 * back to this page load only). It holds a timestamp, nothing about the account.
 */
import { useEffect, useState } from "react";
import { VIEWER_STORAGE_PREFIX, onViewerReset, useOptionalSession } from "../../auth/session.tsx";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.account;

/** Presentation tunable: how long "Not now" keeps the prompt away. */
export const SAVE_PROMPT_SNOOZE_MS = 24 * 60 * 60 * 1000;
const SNOOZE_KEY = `${VIEWER_STORAGE_PREFIX}savePrompt.snoozedUntil`;

/** Dismissed for this page load (and forgotten on sign-out). */
let dismissed = false;
onViewerReset(() => {
  dismissed = false;
});

function snoozed(now: number = Date.now()): boolean {
  if (dismissed) return true;
  try {
    const v = Number(window.localStorage.getItem(SNOOZE_KEY) ?? "0");
    return Number.isFinite(v) && v > now;
  } catch {
    return false;
  }
}
function snooze(now: number = Date.now()): void {
  dismissed = true;
  try {
    window.localStorage.setItem(SNOOZE_KEY, String(now + SAVE_PROMPT_SNOOZE_MS));
  } catch {
    // Storage blocked: this page load only.
  }
}

export function GuestSavePrompt({ place }: { readonly place: "town" | "trip_end" }): JSX.Element | null {
  const session = useOptionalSession()?.session ?? null;
  const [hidden, setHidden] = useState(() => snoozed());
  useEffect(() => setHidden(snoozed()), [session?.account.id]);
  if (!session || session.account.guest !== true || hidden) return null;
  return (
    <aside className="card" aria-labelledby={`save-prompt-${place}`} data-testid="guest-save-prompt" data-place={place}>
      <h2 id={`save-prompt-${place}`}>{T.savePromptTitle}</h2>
      <p className="hint">{T.savePromptBody}</p>
      <button type="button" className="btn btn--primary btn--block" onClick={() => navigate("account")}>
        {T.savePromptAction}
      </button>
      <button
        type="button"
        className="btn btn--block"
        onClick={() => {
          snooze();
          setHidden(true);
        }}
      >
        {T.savePromptDismiss}
      </button>
    </aside>
  );
}

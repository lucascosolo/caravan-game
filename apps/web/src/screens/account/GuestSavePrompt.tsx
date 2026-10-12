/**
 * QA-30 D1: the guest's "save your progress" prompt — on the town screen and at the end of a
 * trip, until the guest links a username and password. Never blocking: it is a card in the
 * page with a "Not now" that hides it for the rest of this session (in memory; nothing stored).
 */
import { useEffect, useState } from "react";
import { onViewerReset, useOptionalSession } from "../../auth/session.tsx";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.account;

/** Dismissed for this page load (and forgotten on sign-out). */
let dismissed = false;
onViewerReset(() => {
  dismissed = false;
});

export function GuestSavePrompt({ place }: { readonly place: "town" | "trip_end" }): JSX.Element | null {
  const session = useOptionalSession()?.session ?? null;
  const [hidden, setHidden] = useState(dismissed);
  useEffect(() => setHidden(dismissed), [session?.account.id]);
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
          dismissed = true;
          setHidden(true);
        }}
      >
        {T.savePromptDismiss}
      </button>
    </aside>
  );
}

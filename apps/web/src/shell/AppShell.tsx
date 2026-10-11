/**
 * The app shell: a thin header (who is signed in, the Account screen, sign out), a scrolling main area and a
 * fixed bottom tab bar sized for thumbs (56px tall, each tab a full-width 44px+ target).
 * Portrait-first; on wide screens the content column is capped at 720px, not stretched.
 * The header also carries the inbox button and its unread badge (chunk 29).
 * Chunk 30: a guest has no username — the header says "Guest" and offers the Account screen,
 * where the progress is saved; there is no one-tap sign-out for a guest (it would lose the account).
 */
import type { ReactNode } from "react";
import { STRINGS } from "../strings.ts";
import { InboxButton } from "./InboxButton.tsx";
import { navigate, type Route } from "./router.tsx";

const TABS: readonly { route: Route; label: string; glyph: string }[] = [
  { route: "town", label: STRINGS.tabs.town, glyph: "⌂" },
  { route: "trail", label: STRINGS.tabs.trail, glyph: "⛰" },
  { route: "party", label: STRINGS.tabs.party, glyph: "⚑" },
  { route: "webs", label: STRINGS.tabs.webs, glyph: "✦" },
];

export interface AppShellProps {
  readonly route: Route;
  /** Null for a guest (chunk 30). */
  readonly username: string | null;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}

export function AppShell({ route, username, onSignOut, children }: AppShellProps): JSX.Element {
  const guest = username === null;
  return (
    <div className="shell">
      <main className="shell__main">
        <div className="sheet__head" style={{ marginBottom: 8 }}>
          <span className="hint shell__who">
            {guest ? (
              <span className="badge" data-testid="guest-badge">
                {STRINGS.account.guestBadge}
              </span>
            ) : (
              username
            )}
          </span>
          {/* Chunk 29: the inbox, with the server's unread count. */}
          <span className="shell__headactions">
            <InboxButton route={route} />
            <button type="button" className="btn" aria-current={route === "account" ? "page" : undefined} onClick={() => navigate("account")}>
              {STRINGS.account.open}
            </button>
            {!guest && (
              <button type="button" className="btn" onClick={onSignOut}>
                {STRINGS.app.signOut}
              </button>
            )}
          </span>
        </div>
        {children}
      </main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button
            key={t.route}
            type="button"
            className="tabbar__tab"
            aria-current={route === t.route ? "page" : undefined}
            onClick={() => navigate(t.route)}
          >
            <span className="tabbar__glyph" aria-hidden="true">
              {t.glyph}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

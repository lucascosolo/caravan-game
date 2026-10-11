/**
 * The app shell: a thin header (who is signed in, sign out), a scrolling main area and a
 * fixed bottom tab bar sized for thumbs (56px tall, each tab a full-width 44px+ target).
 * Portrait-first; on wide screens the content column is capped at 720px, not stretched.
 */
import type { ReactNode } from "react";
import { STRINGS } from "../strings.ts";
import { navigate, type Route } from "./router.tsx";

const TABS: readonly { route: Route; label: string; glyph: string }[] = [
  { route: "town", label: STRINGS.tabs.town, glyph: "⌂" },
  { route: "trail", label: STRINGS.tabs.trail, glyph: "⛰" },
  { route: "party", label: STRINGS.tabs.party, glyph: "⚑" },
  { route: "webs", label: STRINGS.tabs.webs, glyph: "✦" },
];

export interface AppShellProps {
  readonly route: Route;
  readonly username: string;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}

export function AppShell({ route, username, onSignOut, children }: AppShellProps): JSX.Element {
  return (
    <div className="shell">
      <main className="shell__main">
        <div className="sheet__head" style={{ marginBottom: 8 }}>
          <span className="hint">{username}</span>
          <button type="button" className="btn" onClick={onSignOut}>
            {STRINGS.app.signOut}
          </button>
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

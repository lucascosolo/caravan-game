/**
 * The app shell (UI kit v2): a rope HUD across the top (who is signed in, the chips a screen hangs
 * through <HudPortal>, then the inbox letter and the Account medallion), a scrolling main area and a
 * saddlebag tab bar fixed to the bottom. Portrait-first; the content column is capped at 720px.
 * Chunk 30: a guest has no username, so the player chip says "Guest" and the Account screen is where
 * progress is saved. Sign-out lives on the Account screen only (final play-test review N13).
 */
import type { ReactNode } from "react";
import { Chip, ChipStrap } from "../ui/ChipStrap.tsx";
import { Icon, cx } from "../ui/Icon.tsx";
import { STRINGS } from "../strings.ts";
import { HudSlotProvider } from "./HudPortal.tsx";
import { OfflineNotice } from "./OfflineNotice.tsx";
import { InboxButton } from "./InboxButton.tsx";
import { navigate, type Route } from "./router.tsx";

const TABS: readonly { route: Route; label: string; icon: string }[] = [
  { route: "town", label: STRINGS.tabs.town, icon: "tab-town" },
  { route: "trail", label: STRINGS.tabs.trail, icon: "tab-trail" },
  { route: "party", label: STRINGS.tabs.party, icon: "tab-party" },
  { route: "webs", label: STRINGS.tabs.webs, icon: "tab-webs" },
];

export interface AppShellProps {
  readonly route: Route;
  /** Null for a guest (chunk 30). */
  readonly username: string | null;
  /** Kept for callers; sign-out is on the Account screen (N13). */
  readonly onSignOut?: () => void;
  readonly children: ReactNode;
  /** Chunk 24 QA N7: the first screen comes before any tab, so the tab bar is not drawn under it. */
  readonly hideTabs?: boolean;
}

export function AppShell({ route, username, children, hideTabs = false }: AppShellProps): JSX.Element {
  const guest = username === null;
  return (
    <HudSlotProvider>
      {(setSlot) => (
        <div className="shell cv-root">
          <ChipStrap
            end={
              <span className="shell__headactions">
                <InboxButton route={route} />
                {/* QA-30 N4: not on the first screen of the guide, which replaces every route. */}
                {!hideTabs && (
                  <button
                    type="button"
                    className={cx("cv-medal", route === "account" && "is-on")}
                    aria-label={STRINGS.account.open}
                    aria-current={route === "account" ? "page" : undefined}
                    onClick={() => navigate("account")}
                  >
                    <Icon name="hat" />
                  </button>
                )}
              </span>
            }
          >
            <Chip kind="badge" icon={guest ? "brand-guest" : "brand"} label="" value={guest ? STRINGS.account.guestBadge : username} testId={guest ? "guest-badge" : "shell-who"} />
            <span className="shell__slot" ref={setSlot} />
          </ChipStrap>
          <OfflineNotice />
          <main className="shell__main">{children}</main>
          {!hideTabs && (
            <nav className="cv-tabbar" aria-label="Main">
              {TABS.map((t) => (
                <button key={t.route} type="button" className={cx("cv-tab", route === t.route && "is-on")} aria-current={route === t.route ? "page" : undefined} onClick={() => navigate(t.route)}>
                  <span className="cv-tab__icon">
                    <Icon name={t.icon} />
                  </span>
                  <span className="cv-tab__word">{t.label}</span>
                </button>
              ))}
            </nav>
          )}
        </div>
      )}
    </HudSlotProvider>
  );
}

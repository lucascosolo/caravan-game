/**
 * Chunk 29: the shell's inbox button with the unread badge. The count is the server's
 * (`GET /me/inbox/unread`), read on mount, on every route change, every INBOX_POLL_MS while the
 * page is visible, and whenever the Inbox screen publishes a fresh count. A failed read hides
 * the badge rather than showing a guess, and the accessible name is then just "Inbox" — not
 * "nothing new", which would be a claim (chunk 29 QA N7). The badge carries the number as text
 * (never colour alone), and the button's accessible name says it in words.
 */
import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api/client.ts";
import { useApi } from "../auth/session.tsx";
import { STRINGS } from "../strings.ts";
import { Icon, cx } from "../ui/Icon.tsx";
import { INBOX_POLL_MS, onUnread } from "./inboxSignal.ts";
import { navigate, type Route } from "./router.tsx";

const T = STRINGS.inbox;

export function InboxButton({ route, api: override }: { readonly route: Route; readonly api?: Api }): JSX.Element {
  const api = useApi(override);
  const [unread, setUnread] = useState<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setUnread((await api.inboxUnread()).unreadCount);
    } catch {
      setUnread(null);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh, route]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
    }, INBOX_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const off = onUnread((n) => setUnread(n));
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      off();
    };
  }, [refresh]);

  const count = unread ?? 0;
  return (
    <button
      type="button"
      className={cx("cv-medal", route === "inbox" && "is-on")}
      data-testid="inbox-button"
      aria-label={unread === null ? T.button : T.buttonLabel(count)}
      aria-current={route === "inbox" ? "page" : undefined}
      onClick={() => navigate("inbox")}
    >
      <Icon name="letter" />
      {count > 0 && (
        <span className="cv-badge" data-testid="inbox-badge" aria-hidden="true">
          {T.badge(count)}
        </span>
      )}
    </button>
  );
}

/** The connection notice (UI-SYSTEM §8.8): a note hung from the rope while the browser reports offline. */
import { useEffect, useState } from "react";
import { STRINGS } from "../strings.ts";
import { Icon } from "../ui/Icon.tsx";

export function OfflineNotice(): JSX.Element | null {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  useEffect(() => {
    const on = (): void => setOffline(false);
    const off = (): void => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="cv-banner-sign shell__offline" role="status" data-testid="offline-notice">
      <Icon name="broken-wheel" />
      <span className="cv-banner-sign__text">{STRINGS.ui.offline}</span>
    </div>
  );
}

/**
 * Chunk 32: the usage-data opt-out, inside the inbox's settings disclosure (the client's one
 * settings place). The setting is the SERVER's (`GET/PUT /me/analytics`): the server drops an
 * opted-out account's telemetry and deletes what it kept; this toggle also tells the live
 * reporter at once. If the setting cannot be read, the toggle is not shown (never a guess).
 */
import { useEffect, useState } from "react";
import type { Api } from "../../api/client.ts";
import { STRINGS } from "../../strings.ts";
import { setTelemetryOptOut } from "../../telemetry/telemetry.ts";

const T = STRINGS.privacy;

export function AnalyticsToggle({ api }: { readonly api: Api }): JSX.Element | null {
  const [optedOut, setOptedOut] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const s = await api.analyticsSettings();
        if (live) setOptedOut(s.optedOut);
      } catch {
        if (live) setOptedOut(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  if (optedOut === null) return null;

  const change = async (share: boolean): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      const s = await api.setAnalyticsOptOut(!share);
      setOptedOut(s.optedOut);
      setTelemetryOptOut(s.optedOut);
      setStatus(T.saved(!s.optedOut));
    } catch {
      setStatus(T.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="analytics-settings" style={{ marginTop: 12 }}>
      <p className="card__name">{T.heading}</p>
      <p className="hint">{T.intro}</p>
      <label>
        <input type="checkbox" checked={!optedOut} disabled={busy} onChange={(e) => void change(e.currentTarget.checked)} data-testid="analytics-share" /> <span>{T.toggle}</span>
      </label>
      <p className="hint" role="status" aria-live="polite">
        {status ?? ""}
      </p>
    </div>
  );
}

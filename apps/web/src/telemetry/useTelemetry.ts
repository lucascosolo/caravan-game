/**
 * Chunk 32: one telemetry reporter per signed-in session. Reports the current screen as it
 * changes and any uncaught error (window `error` / `unhandledrejection`; the render error
 * boundary calls `reportCrash`), plus a heartbeat about once a minute while the page is
 * visible, and flushes when the page goes hidden (QA D2). Signing out disposes it: nothing more
 * is sent.
 */
import { useEffect, useRef } from "react";
import type { TelemetryScreen } from "./screens.ts";
import { TELEMETRY_HEARTBEAT_MS, TelemetryReporter, setCurrentReporter, type TelemetrySink } from "./telemetry.ts";

export function useTelemetry(sink: TelemetrySink, signedIn: boolean, screen: TelemetryScreen | null): void {
  const ref = useRef<TelemetryReporter | null>(null);
  useEffect(() => {
    if (!signedIn) return undefined;
    const reporter = new TelemetryReporter(sink);
    ref.current = reporter;
    setCurrentReporter(reporter);
    const onError = (e: ErrorEvent): void => reporter.crash(e.error ?? e);
    const onRejection = (e: PromiseRejectionEvent): void => reporter.crash(e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    // QA N8: the opt-out comes from the server before the first flush.
    void reporter.readSetting();
    // QA D2: a heartbeat while visible; going hidden flushes what is queued.
    const visible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";
    const beat = setInterval(() => {
      if (visible()) reporter.heartbeat();
    }, TELEMETRY_HEARTBEAT_MS);
    const onVisibility = (): void => {
      if (!visible()) void reporter.flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      reporter.dispose();
      setCurrentReporter(null);
      ref.current = null;
    };
  }, [sink, signedIn]);
  useEffect(() => {
    if (screen !== null) ref.current?.screen(screen);
  }, [screen, signedIn]);
}

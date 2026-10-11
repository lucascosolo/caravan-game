/**
 * Chunk 32: one telemetry reporter per signed-in session. Reports the current screen as it
 * changes and any uncaught error (window `error` / `unhandledrejection`; the render error
 * boundary calls `reportCrash`). Signing out disposes it: nothing more is sent.
 */
import { useEffect, useRef } from "react";
import type { TelemetryScreen } from "./screens.ts";
import { TelemetryReporter, setCurrentReporter, type TelemetrySink } from "./telemetry.ts";

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
    return () => {
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

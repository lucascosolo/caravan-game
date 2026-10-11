/**
 * Countdowns from SERVER time (chunk 08 QA S4, reused by chunk 23's trip cap). A wait is a
 * duration the server's answer implies (`availableAtMs − searchedAtMs`, `nextRegenAtMs −
 * nowMs`, `retryAfterSeconds`), counted down on the monotonic clock from the moment that
 * answer arrived. The device's wall clock is never compared with a server timestamp, so a
 * fast or slow device clock can neither open a gate early nor hold it shut.
 */
import { useEffect, useState } from "react";

export const monotonic = (): number => performance.now();

/**
 * Whole seconds left of `durationMs`, counted on `now` from the moment `anchor` (an object
 * identity: the menu, the refusal, the status read) arrived. Re-read every second; 0 once elapsed.
 */
export function useAnchoredCountdown(anchor: unknown, durationMs: number, now: () => number = monotonic): number {
  const calc = (from: number): number => Math.max(0, Math.ceil((durationMs - (now() - from)) / 1000));
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil(durationMs / 1000)));
  useEffect(() => {
    const t0 = now();
    setLeft(calc(t0));
    if (durationMs <= 0) return;
    const id = window.setInterval(() => setLeft(calc(t0)), 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, durationMs]);
  return left;
}

/** m:ss (h:mm:ss past an hour) for a whole number of seconds. */
export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

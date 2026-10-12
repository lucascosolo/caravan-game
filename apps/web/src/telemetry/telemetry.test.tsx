/**
 * Chunk 32: the client's telemetry reporter and the usage-data toggle. Screen flow and crashes
 * only, batched, closed vocabularies, no message text, no storage; an opted-out answer from the
 * server stops it; sign-out stops it.
 */
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryBatch, TelemetryEvent, TelemetryIngestResult } from "../api/telemetryTypes.ts";
import { AnalyticsToggle } from "../screens/inbox/AnalyticsToggle.tsx";
import { fakeApi } from "../test/townFixtures.ts";
import { TELEMETRY_SCREENS } from "./screens.ts";
import { ROUTES } from "../shell/router.tsx";
import { TELEMETRY_BATCH_MAX, TELEMETRY_HEARTBEAT_MS, TELEMETRY_MAX_AGO_MS, TelemetryReporter, errorClass, fnv1a32Hex, reportCrash, setTelemetryOptOut, stackHash } from "./telemetry.ts";
import { useTelemetry } from "./useTelemetry.ts";

function sink(answer: Partial<TelemetryIngestResult> = {}, setting: () => Promise<{ optedOut: boolean }> = () => Promise.resolve({ optedOut: false })) {
  const batches: TelemetryEvent[][] = [];
  const envelopes: { session: number; seq: number }[] = [];
  return {
    batches,
    envelopes,
    settingReads: 0,
    analyticsSettings() {
      this.settingReads++;
      return setting();
    },
    sendTelemetry: (batch: TelemetryBatch) => {
      batches.push([...batch.events]);
      envelopes.push({ session: batch.session, seq: batch.seq });
      return Promise.resolve({ accepted: batch.events.length, dropped: 0, optedOut: false, ...answer });
    },
  };
}
const label = (e: TelemetryEvent): string => (e.kind === "crash" ? e.errorName : `${e.kind}:${e.screen}`);

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("telemetry reporter (chunk 32)", () => {
  it("every route is a known screen", () => {
    for (const r of ROUTES) expect(TELEMETRY_SCREENS as readonly string[]).toContain(r);
  });

  it("batches screen changes (repeats are not events) and sends them after the flush delay with their age", async () => {
    const s = sink();
    let t = 1_000_000;
    const r = new TelemetryReporter(s, { now: () => t, flushDelayMs: 5000 });
    r.screen("town");
    t += 2000;
    r.screen("town");
    r.screen("trail");
    expect(s.batches).toEqual([]);
    t += 3000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.batches).toEqual([[{ kind: "screen", screen: "town", agoMs: 5000 }, { kind: "screen", screen: "trail", agoMs: 3000 }]]);
  });

  it("caps a batch and sends the rest in the next one", async () => {
    const s = sink();
    const r = new TelemetryReporter(s, { now: () => 0, flushDelayMs: 10 });
    const screens = ["town", "trail"] as const;
    for (let i = 0; i < TELEMETRY_BATCH_MAX + 5; i++) r.screen(screens[i % 2]!);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.batches.map((b) => b.length)).toEqual([TELEMETRY_BATCH_MAX, 5]);
  });

  it("a crash carries the class and an 8-hex stack hash — never the message", async () => {
    const s = sink();
    const r = new TelemetryReporter(s, { now: () => 0, flushDelayMs: 1 });
    r.screen("party");
    const secret = new TypeError("player bob123 typed something private");
    r.crash(secret);
    r.crash("a string thrown");
    await vi.advanceTimersByTimeAsync(1);
    const sent = JSON.stringify(s.batches);
    expect(sent).not.toContain("bob123");
    expect(sent).not.toContain("private");
    expect(s.batches[0]![1]).toEqual({ kind: "crash", screen: "party", errorName: "TypeError", stackHash: stackHash(secret), agoMs: 0 });
    expect(s.batches[0]![2]).toMatchObject({ errorName: "Unknown" });
    expect(stackHash(secret)).toMatch(/^[0-9a-f]{8}$/);
    expect(errorClass(new (class Weird extends Error { override name = "Weird"; })())).toBe("Error");
    expect(fnv1a32Hex("")).toBe("811c9dc5");
  });

  it("stops when the server answers optedOut, and after dispose", async () => {
    const s = sink({ optedOut: true, accepted: 0 });
    const r = new TelemetryReporter(s, { now: () => 0, flushDelayMs: 1 });
    r.screen("town");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.isOptedOut).toBe(true);
    r.screen("trail");
    await vi.advanceTimersByTimeAsync(10);
    expect(s.batches).toHaveLength(1);
    const s2 = sink();
    const r2 = new TelemetryReporter(s2, { now: () => 0, flushDelayMs: 1 });
    r2.screen("town");
    r2.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(s2.batches).toEqual([]);
  });

  it("a failed send is dropped, not retried, and never throws", async () => {
    const send = vi.fn(() => Promise.reject(new Error("offline")));
    const r = new TelemetryReporter({ sendTelemetry: send, analyticsSettings: () => Promise.resolve({ optedOut: false }) }, { now: () => 0, flushDelayMs: 1 });
    r.screen("town");
    await vi.advanceTimersByTimeAsync(50);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("useTelemetry: one reporter per signed-in session, screens as they change, crashes via reportCrash, nothing once signed out", async () => {
    const s = sink();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { rerender, unmount } = renderHook(({ signedIn, screen: sc }) => useTelemetry(s, signedIn, sc), { initialProps: { signedIn: true, screen: "town" as const as "town" | "webs" } });
    rerender({ signedIn: true, screen: "webs" });
    reportCrash(new RangeError("x"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.batches.flat().map(label)).toEqual(["screen:town", "screen:webs", "RangeError"]);
    rerender({ signedIn: false, screen: "webs" });
    reportCrash(new Error("after"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.batches.flat()).toHaveLength(3);
    unmount();
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("chunk 32 QA fixes in the reporter", () => {
  it("D2: every batch carries this page load's session and a rising sequence number", async () => {
    const s = sink();
    const r = new TelemetryReporter(s, { now: () => Date.now(), flushDelayMs: 10, session: 77 });
    r.screen("town");
    await vi.advanceTimersByTimeAsync(10);
    r.screen("trail");
    await vi.advanceTimersByTimeAsync(10);
    expect(s.envelopes).toEqual([{ session: 77, seq: 0 }, { session: 77, seq: 1 }]);
    const other = new TelemetryReporter(sink());
    expect((other as unknown as { session: number }).session).toBeGreaterThan(0);
  });

  it("D2: events older than the flush window are dropped, never sent with a large age", async () => {
    const s = sink();
    let t = 0;
    const r = new TelemetryReporter(s, { now: () => t, flushDelayMs: 1 });
    await r.readSetting();
    r.screen("town");
    t = TELEMETRY_MAX_AGO_MS + 1;
    await r.flush();
    expect(s.batches).toEqual([]);
  });

  it("D2: useTelemetry sends a heartbeat about once a minute while visible, none while hidden, and flushes on hidden", async () => {
    const s = sink();
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    const { unmount } = renderHook(() => useTelemetry(s, true, "trail"));
    await vi.advanceTimersByTimeAsync(TELEMETRY_HEARTBEAT_MS + 5000);
    expect(s.batches.flat().map(label)).toEqual(["screen:trail", "heartbeat:trail"]);
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3 * TELEMETRY_HEARTBEAT_MS);
    expect(s.batches.flat().map(label)).toEqual(["screen:trail", "heartbeat:trail"]);
    // Going hidden sends what is queued at once, without waiting for the flush delay.
    state = "visible";
    reportCrash(new TypeError("x"));
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.batches.flat().map(label)).toEqual(["screen:trail", "heartbeat:trail", "TypeError"]);
    unmount();
  });

  it("N8: nothing is sent before the server's setting is known; an opted-out account sends nothing at all", async () => {
    let release: (v: { optedOut: boolean }) => void = () => undefined;
    const s = sink({}, () => new Promise((res) => (release = res)));
    const { unmount } = renderHook(() => useTelemetry(s, true, "town"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.batches).toEqual([]);
    release({ optedOut: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.batches).toEqual([]);
    unmount();
    // A failed read holds the queue and asks again on the next flush.
    let calls = 0;
    const s2 = sink({}, () => (++calls === 1 ? Promise.reject(new Error("down")) : Promise.resolve({ optedOut: false })));
    const r = new TelemetryReporter(s2, { now: () => Date.now(), flushDelayMs: 5 });
    r.screen("town");
    await vi.advanceTimersByTimeAsync(5);
    expect(s2.batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    expect(s2.batches.flat().map(label)).toEqual(["screen:town"]);
  });

  it("S2: opting out empties the live reporter's queue before the request is sent", async () => {
    const s = sink();
    const { unmount } = renderHook(() => useTelemetry(s, true, "inbox"));
    let queuedAtPut = -1;
    const api = fakeApi({
      analyticsSettings: () => Promise.resolve({ optedOut: false }),
      setAnalyticsOptOut: (optedOut) => {
        queuedAtPut = s.batches.length;
        return Promise.resolve({ optedOut });
      },
    });
    render(<AnalyticsToggle api={api} />);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(await screen.findByTestId("analytics-share"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(queuedAtPut).toBe(0);
    expect(s.batches).toEqual([]);
    setTelemetryOptOut(false);
    unmount();
  });
});

describe("the usage-data toggle (chunk 32)", () => {
  it("reads the server's setting, opting out says what was deleted, opting back in", async () => {
    const puts: boolean[] = [];
    const api = fakeApi({
      analyticsSettings: () => Promise.resolve({ optedOut: false }),
      setAnalyticsOptOut: (optedOut) => (puts.push(optedOut), Promise.resolve({ optedOut })),
    });
    render(<AnalyticsToggle api={api} />);
    const box = await screen.findByTestId("analytics-share");
    expect(box).toBeChecked();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(box);
    expect(await screen.findByText(/Usage data is off, and what was kept has been deleted/)).toBeInTheDocument();
    expect(screen.getByTestId("analytics-share")).not.toBeChecked();
    await user.click(screen.getByTestId("analytics-share"));
    expect(await screen.findByText("Usage data is shared.")).toBeInTheDocument();
    expect(puts).toEqual([true, false]);
  });

  it("is not shown when the setting cannot be read (never a guess)", async () => {
    const api = fakeApi({ analyticsSettings: () => Promise.reject(new Error("down")) });
    const { container } = render(<AnalyticsToggle api={api} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(container).toBeEmptyDOMElement();
  });
});

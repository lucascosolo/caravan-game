/**
 * Session state: the bearer token and the signed-in account, in memory only. Provides the
 * typed API client bound to that token. A 401 from any call drops the session.
 *
 * Chunk 30: nothing is stored in the browser. On launch — and once more after a 401 — the
 * provider asks the server to resume (POST /auth/resume): the server reads its own HttpOnly
 * device cookie, which this code never sees, and answers a fresh bearer token for the same
 * account. A guest therefore survives a reload without a username, a password or any
 * localStorage. `resuming` is true while that first answer is out.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, createApi, type Api } from "../api/client.ts";
import type { AccountPublic, AuthResponse } from "../api/types.ts";
import { STRINGS } from "../strings.ts";

export interface Session {
  readonly token: string;
  readonly account: AccountPublic;
}

export interface SessionContextValue {
  readonly session: Session | null;
  readonly api: Api;
  readonly signIn: (auth: AuthResponse) => void;
  /** Chunk 30: a guest's sign-out passes `abandon` (the server refuses it otherwise). */
  readonly signOut: (abandon?: boolean) => Promise<void>;
  /** Chunk 30: true while the launch-time resume is in flight. */
  readonly resuming: boolean;
  /** Chunk 30: the account changed under the same session (a guest linked a username). */
  readonly updateAccount: (account: AccountPublic) => void;
  /** Chunk 30: the account is gone (deleted): forget the session without calling the server; `notice` is shown on the start screen. */
  readonly forget: (notice?: string) => void;
  /**
   * QA-30 S4: the launch / after-401 resume failed for a reason OTHER than "no device here" (a
   * 5xx, the network). The start screen must not show then — a guest pressing "Start playing"
   * would lose their caravan — so the client shows a retry state instead.
   */
  readonly resumeError: ApiError | null;
  readonly retryResume: () => void;
  /** A one-line notice for the start screen (the account was deleted, a guest left). */
  readonly notice: string | null;
}

/** The one resume answer that means "there is no account on this device": the start screen is right then. */
export function isNoDevice(e: ApiError): boolean {
  return e.status === 401 && e.code === "no_device";
}

/** QA-30 S4: automatic resumes after a 401, per rolling minute: enough for evicted sessions in many tabs, never a loop. */
const AUTO_RESUMES_PER_MINUTE = 3;

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Prefix of every per-viewer convenience a screen keeps in `localStorage` (presentation
 * only, like a camera: the town's board layout, QA-17 D1). Signing out removes every key
 * under it, so the next person on this device starts from a clean layout.
 */
export const VIEWER_STORAGE_PREFIX = "caravan.viewer.";

const viewerResets = new Set<() => void>();

/**
 * Register in-memory per-viewer state to drop on sign-out (QA-17 S4: the party builder's
 * unsaved draft, kept across tab switches). Returns the unregister function.
 */
export function onViewerReset(reset: () => void): () => void {
  viewerResets.add(reset);
  return () => viewerResets.delete(reset);
}

/** Sign-out: every per-viewer convenience, in storage and in memory, is forgotten. */
export function resetViewerState(): void {
  clearViewerStorage();
  for (const reset of viewerResets) reset();
}

export function clearViewerStorage(): void {
  try {
    const store = window.localStorage;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(VIEWER_STORAGE_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Storage blocked or absent: nothing was kept, so nothing to clear.
  }
}

/**
 * `autoResume` (chunk 30): ask the server for the device-cookie session on launch and after a 401.
 * Default: on with the real fetch; off when a test injects `fetchImpl` (its fake server has no
 * device cookie), unless the test asks for it.
 */
export function SessionProvider({ children, fetchImpl, autoResume = fetchImpl === undefined }: { children: ReactNode; fetchImpl?: typeof fetch; autoResume?: boolean }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [resuming, setResuming] = useState(autoResume);
  // Bumped by a 401: try the device cookie once more before showing the start screen.
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const [resumeError, setResumeError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoResumes = useRef<number[]>([]);
  const resumeInFlight = useRef<Promise<AuthResponse> | null>(null);
  // The api reads the token through a ref so one client instance serves every render.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = session?.token ?? null;

  const api = useMemo(
    () =>
      createApi({
        getToken: () => tokenRef.current,
        onUnauthorized: () => {
          // Several calls in flight can 401 together on one dead token: only the first one counts.
          if (tokenRef.current === null) return;
          tokenRef.current = null;
          setSession(null);
          if (!autoResume) return;
          const now = Date.now();
          autoResumes.current = autoResumes.current.filter((t) => now - t < 60_000);
          if (autoResumes.current.length < AUTO_RESUMES_PER_MINUTE) {
            autoResumes.current.push(now);
            setResumeEpoch((n) => n + 1);
          } else {
            // Final play-test review r2 S1: the device cookie keeps answering, but its sessions keep
            // dying. That is NOT "no account here": show the retry state, never the start screen
            // (where a guest's only working button would delete the caravan).
            setResumeError(new ApiError(401, "session_lost", STRINGS.auth.sessionLost));
          }
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    [fetchImpl, autoResume],
  );

  useEffect(() => {
    if (!autoResume) return;
    // Final play-test review r2 S1: reuse the live session. A resume is asked for only when there is
    // no valid token in memory, and never twice at once (StrictMode runs effects twice in dev).
    if (tokenRef.current !== null) {
      setResuming(false);
      return;
    }
    let live = true;
    setResuming(true);
    setResumeError(null);
    const inFlight = resumeInFlight.current ?? api.resume();
    resumeInFlight.current = inFlight;
    const clear = (): void => {
      if (resumeInFlight.current === inFlight) resumeInFlight.current = null;
    };
    inFlight.then(clear, clear);
    inFlight
      .then((auth) => {
        // A sign-in that landed meanwhile wins: never replace a session the player just made.
        if (live) setSession((prev) => prev ?? { token: auth.token, account: auth.account });
      })
      .catch((err: unknown) => {
        // Only a definite 401 no_device means there is nothing to resume — the start screen.
        // Anything else (another 401, a 429, a 5xx, the network, a bad payload) is NOT "no account
        // here": retry, never the start screen (final play-test review r2 S1).
        if (!live) return;
        const e = err instanceof ApiError ? err : new ApiError(0, "network", "network error");
        if (!isNoDevice(e)) setResumeError(e);
      })
      .finally(() => {
        if (live) setResuming(false);
      });
    return () => {
      live = false;
    };
  }, [api, autoResume, resumeEpoch]);

  const signIn = useCallback((auth: AuthResponse) => setSession({ token: auth.token, account: auth.account }), []);
  const signOut = useCallback(
    async (abandon?: boolean) => {
      try {
        await api.logout(abandon);
      } catch {
        // The server may already consider the session gone; locally it is gone either way.
      }
      resetViewerState();
      setSession(null);
    },
    [api],
  );
  const updateAccount = useCallback((account: AccountPublic) => setSession((prev) => (prev ? { ...prev, account } : prev)), []);
  const forget = useCallback((n?: string) => {
    resetViewerState();
    setNotice(n ?? null);
    setSession(null);
  }, []);
  const retryResume = useCallback(() => {
    // A deliberate retry (the retry card, "Continue the guest caravan") gets a fresh automatic budget.
    autoResumes.current = [];
    setResumeError(null);
    setResumeEpoch((n) => n + 1);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ session, api, signIn, signOut, resuming, updateAccount, forget, resumeError, retryResume, notice }),
    [session, api, signIn, signOut, resuming, updateAccount, forget, resumeError, retryResume, notice],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session context when there is one (components that also render outside a provider, in tests). */
export function useOptionalSession(): SessionContextValue | null {
  return useContext(SessionContext);
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

/**
 * The session's API client, or `override` when one is given (a screen's component test
 * injects a fake and renders without a provider). Calls `useContext` unconditionally.
 */
export function useApi(override?: Api): Api {
  const ctx = useContext(SessionContext);
  const api = override ?? ctx?.api;
  if (!api) throw new Error("useApi must be used inside <SessionProvider> or given an api");
  return api;
}

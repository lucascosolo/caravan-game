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
import { createApi, type Api } from "../api/client.ts";
import type { AccountPublic, AuthResponse } from "../api/types.ts";

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
  /** Chunk 30: the account is gone (deleted): forget the session without calling the server. */
  readonly forget: () => void;
}

/** Automatic resumes after a 401, per page load: enough for an evicted session, never a loop. */
const AUTO_RESUMES_MAX = 3;

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
  const autoResumes = useRef(0);
  // The api reads the token through a ref so one client instance serves every render.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = session?.token ?? null;

  const api = useMemo(
    () =>
      createApi({
        getToken: () => tokenRef.current,
        onUnauthorized: () => {
          setSession(null);
          if (autoResume && autoResumes.current < AUTO_RESUMES_MAX) {
            autoResumes.current += 1;
            setResumeEpoch((n) => n + 1);
          }
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    [fetchImpl, autoResume],
  );

  useEffect(() => {
    if (!autoResume) return;
    let live = true;
    setResuming(true);
    api
      .resume()
      .then((auth) => {
        // A sign-in that landed meanwhile wins: never replace a session the player just made.
        if (live) setSession((prev) => prev ?? { token: auth.token, account: auth.account });
      })
      .catch(() => {
        // No device here (401 no_device), or the server is unreachable: the start screen shows.
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
  const forget = useCallback(() => {
    resetViewerState();
    setSession(null);
  }, []);

  const value = useMemo<SessionContextValue>(() => ({ session, api, signIn, signOut, resuming, updateAccount, forget }), [session, api, signIn, signOut, resuming, updateAccount, forget]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
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

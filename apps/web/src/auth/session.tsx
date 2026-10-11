/**
 * Session state: the bearer token and the signed-in account, in memory only. Provides the
 * typed API client bound to that token. A 401 from any call drops the session.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
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
  readonly signOut: () => Promise<void>;
}

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

export function SessionProvider({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  // The api reads the token through a ref so one client instance serves every render.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = session?.token ?? null;

  const api = useMemo(
    () =>
      createApi({
        getToken: () => tokenRef.current,
        onUnauthorized: () => setSession(null),
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    [fetchImpl],
  );

  const signIn = useCallback((auth: AuthResponse) => setSession({ token: auth.token, account: auth.account }), []);
  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The server may already consider the session gone; locally it is gone either way.
    }
    resetViewerState();
    setSession(null);
  }, [api]);

  const value = useMemo<SessionContextValue>(() => ({ session, api, signIn, signOut }), [session, api, signIn, signOut]);
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

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

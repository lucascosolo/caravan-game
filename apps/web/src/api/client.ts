/**
 * A tiny typed `fetch` wrapper over the server's routes.
 *
 * The bearer token lives in memory only (the session context, src/auth/session.tsx) and is
 * read through `getToken` on every call. Nothing here touches localStorage or cookies: a
 * reload logs the player out, which is the intended v1 behaviour until chunk 25 (account
 * lifecycle) decides how sessions persist.
 *
 * Every non-2xx response becomes an `ApiError` carrying the server's exact `{error,
 * message}` body, so a screen can surface the real reason (a 409 `insufficient_points`
 * says how many points the node costs and how many are available).
 *
 * Every 2xx body is checked against its shape (shapes.ts, QA-06 B1) before a screen sees
 * it: a body that is not JSON, or JSON of the wrong shape, becomes `ApiError(0,
 * "bad_payload")` with the offending path in `detail`. Screens render that like any other
 * error, with a Retry. Status 0 means "no usable answer from the server": `network` (fetch
 * threw) or `bad_payload`; `ErrorBox` (src/shell) words both for the player.
 */
import { ShapeError, expectShape, type Guard } from "./shape.ts";
import { authShape, meShape, progressionShape, spendResultShape, unlocksShape } from "./shapes.ts";
import type { AuthResponse, ApiErrorBody, MeResponse, ProgressionResponse, SpendRequest, SpendResult, UnlocksResponse } from "./types.ts";

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/api";

/** `code` of an `ApiError` with status 0 when `fetch` itself failed. */
export const NETWORK = "network";
/** `code` of an `ApiError` with status 0 when a 2xx body did not match its shape. */
export const BAD_PAYLOAD = "bad_payload";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Developer-facing particulars (a payload path, a thrown error's text); shown small under the code. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  readonly getToken: () => string | null;
  /** Called on any 401 so the session can be dropped. */
  readonly onUnauthorized?: () => void;
  readonly fetchImpl?: typeof fetch;
  readonly base?: string;
}

export interface RegisterInput {
  readonly username: string;
  readonly password: string;
  readonly region: string;
  readonly caravanName?: string;
}

export interface Api {
  register(input: RegisterInput): Promise<AuthResponse>;
  login(username: string, password: string): Promise<AuthResponse>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  unlocks(): Promise<UnlocksResponse>;
  progression(): Promise<ProgressionResponse>;
  spendUnlock(req: SpendRequest): Promise<SpendResult>;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null && typeof (value as ApiErrorBody).error === "string";
}

export function createApi(opts: ApiOptions): Api {
  const base = opts.base ?? API_BASE;
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  /** `shape` is the guard for a 2xx body; `null` for routes whose answer carries nothing. */
  async function request<T>(method: string, path: string, shape: Guard<T> | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      throw new ApiError(0, NETWORK, err instanceof Error ? err.message : "network error");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      if (isErrorBody(parsed)) throw new ApiError(res.status, parsed.error, parsed.message);
      throw new ApiError(res.status, "http_error", `${res.status} ${res.statusText}`.trim());
    }
    if (shape === null) return undefined as T;
    try {
      return expectShape(shape, parsed);
    } catch (err) {
      if (err instanceof ShapeError) throw new ApiError(0, BAD_PAYLOAD, `${method} ${path} ${err.message}`, `${method} ${path} ${err.message}`);
      throw err;
    }
  }

  return {
    register: (input) => request("POST", "/auth/register", authShape, input),
    login: (username, password) => request("POST", "/auth/login", authShape, { username, password }),
    logout: () => request("POST", "/auth/logout", null),
    me: () => request("GET", "/me", meShape),
    unlocks: () => request("GET", "/me/unlocks", unlocksShape),
    progression: () => request("GET", "/me/progression", progressionShape),
    spendUnlock: (req) => request("POST", "/me/unlocks/spend", spendResultShape, req),
  };
}

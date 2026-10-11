/**
 * Response shapes of the server routes this client reads (apps/server/src/routes/*). Kept
 * by hand and small: the client only needs the fields it renders. Every field here is
 * server state; the client never derives affordability or eligibility itself.
 */

export type UnlockPool = "living" | "trap" | "siege";
export type Scope = "account" | "caravan";

export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
}

export interface AccountPublic {
  readonly id: string;
  readonly username: string;
}

export interface CaravanSummary {
  readonly id: string;
  readonly name: string;
  readonly region_id: string;
}

export interface AuthResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly account: AccountPublic;
}

export interface UnlockPoints {
  readonly granted: number;
  readonly spent: number;
  readonly available: number;
}

/** One node as `GET /me/unlocks` and `POST /me/unlocks/spend` return it. `cost` is already this pool's curve. */
export interface UnlockNodeView {
  readonly id: string;
  readonly tier: number;
  readonly cost: number;
  readonly requires: readonly string[];
  readonly starting: boolean;
  readonly reached: boolean;
  readonly prerequisitesMet: boolean;
  readonly affordable: boolean;
  readonly missing: readonly string[];
}

export interface UnlockWebView {
  readonly id: string;
  readonly pool: UnlockPool;
  readonly scope: Scope;
  readonly regionId: string | null;
  readonly accountId: string;
  readonly caravanId: string | null;
  readonly points: UnlockPoints;
  readonly nodes: readonly UnlockNodeView[];
}

export interface UnlocksResponse {
  readonly webs: readonly UnlockWebView[];
}

export interface SpendRequest {
  readonly pool: UnlockPool;
  readonly nodeId: string;
  readonly caravanId?: string | null;
}

export interface SpendResult {
  readonly created: boolean;
  readonly webId: string;
  readonly pool: UnlockPool;
  readonly node: UnlockNodeView;
  readonly points: UnlockPoints;
  readonly nodes: readonly UnlockNodeView[];
}

/** `GET /me/progression` — the ladder behind each pool's points (chunk 04). */
export interface PoolProgressView {
  readonly pool: UnlockPool;
  readonly scope: Scope;
  readonly accountId: string | null;
  readonly caravanId: string | null;
  readonly reputation: number;
  readonly ladder: {
    readonly level: number;
    readonly points: number;
    readonly cap: number;
    readonly capped: boolean;
    readonly nextRungAt: number | null;
    readonly pointsToNextRung: number | null;
    readonly nextRungUnlockPoints: number | null;
  };
  readonly unlockPoints: UnlockPoints;
}

export interface ProgressionResponse {
  readonly pools: readonly PoolProgressView[];
}

export interface MeResponse {
  readonly account: AccountPublic;
  readonly caravans: readonly CaravanSummary[];
}

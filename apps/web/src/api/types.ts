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
  /** The roster (unit_instance rows) as `GET /me` returns it. */
  readonly units?: readonly UnitInstanceView[];
}

export interface UnitInstanceView {
  readonly id: string;
  readonly caravan_id: string;
  readonly unit_type_id: string;
  readonly merge_level: number;
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

// ── Wagon circle (chunk 07 routes: apps/server/src/routes/circle.ts) ──────────────────

/** One validation issue as the server returns it: a stable code, the exact message, the subject. */
export interface IssueView {
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
}

export interface ManifestUnitView {
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly maxHp: number;
  readonly hp: number;
}
export interface ManifestTrapView {
  readonly ref: string;
  readonly typeId: string;
  readonly spent: boolean;
}
export interface ManifestFenceView {
  readonly ref: string;
  readonly tierId: string;
  readonly maxHp: number;
  readonly hp: number;
}
export interface ManifestBody {
  readonly v: 1;
  readonly units: readonly ManifestUnitView[];
  readonly traps: readonly ManifestTrapView[];
  readonly fences: readonly ManifestFenceView[];
}

/** `GET /caravans/:id/manifest` → `{ manifest }`. `packed` is the trip's loadout; `survivors` is what is left of it NOW. */
export interface ManifestView {
  readonly id: string;
  readonly caravanId: string;
  readonly encountersResolved: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly packed: ManifestBody;
  readonly survivors: ManifestBody;
  readonly summary: {
    readonly unitsAlive: number;
    readonly unitsDead: number;
    readonly trapsUnspent: number;
    readonly trapsSpent: number;
    readonly fencesIntact: number;
    readonly fencesDestroyed: number;
  };
  readonly formations: readonly { readonly encounterIndex: number; readonly hash: string; readonly committedAt: string | null }[];
}

export interface PackManifestRequest {
  readonly units: readonly string[];
  readonly traps: readonly string[];
  readonly fence: { readonly tierId: string; readonly count: number } | null;
}

export type DefensiveStanceView = "guard" | "hold" | "reserve";

export interface FormationBody {
  readonly v: 2;
  readonly fences: readonly { readonly ref: string; readonly segment: number }[];
  readonly traps: readonly { readonly ref: string; readonly cell: { readonly x: number; readonly y: number } }[];
  readonly posts: readonly { readonly ref: string; readonly cell: { readonly x: number; readonly y: number }; readonly stance: DefensiveStanceView }[];
}

/** `PUT|GET /caravans/:id/encounters/:n/formation` and `.../commit` → `{ formation }`. */
export interface FormationView {
  readonly manifestId: string;
  readonly encounterIndex: number;
  readonly formation: FormationBody;
  readonly hash: string;
  readonly gaps: readonly number[];
  readonly committedAt: string | null;
}

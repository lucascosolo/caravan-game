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
  /** Chunk 07's validation errors carry every issue at once (see `IssueView`). */
  readonly issues?: readonly IssueView[];
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

/**
 * The manifest and formation bodies are @caravan/circle's own types: the client parses
 * them with circle's strict `manifestFromJson` / `formationFromJson` (shapes.ts), so a
 * screen holds exactly what the server stores and chunk 07's helpers accept it directly.
 */
export type ManifestBody = import("@caravan/circle").Manifest;
export type ManifestUnitView = import("@caravan/circle").ManifestUnit;
export type ManifestTrapView = import("@caravan/circle").ManifestTrap;
export type ManifestFenceView = import("@caravan/circle").ManifestFence;

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

export type DefensiveStanceView = import("@caravan/circle").DefensiveStance;
export type FormationBody = import("@caravan/circle").Formation;

/** `POST|GET /caravans/:id/manifest` → `{ manifest }`. */
export interface ManifestResponse {
  readonly manifest: ManifestView;
}

// ── Matchmaking & scouting (chunk 14 routes: apps/server/src/routes/matchmaking.ts) ────

/** The scouting view of a party, exactly as the server builds it (`scoutParty`, @caravan/circle). */
export type PartyScoutView = import("@caravan/circle").PartyScoutView;

export interface BandView {
  readonly index: number;
  readonly low: number;
  readonly high: number;
}

/** One offered candidate: everything the defender can read before choosing. */
export interface CandidateView {
  readonly candidateId: string;
  readonly partyId: string;
  readonly owner: { readonly accountId: string; readonly displayName: string; readonly authored: boolean };
  readonly reputation: { readonly rating: number; readonly band: BandView; readonly gapFromCaravan: number; readonly sandbagEarnMultiplier: number };
  readonly scout: PartyScoutView;
}

/** `POST .../search` (201) and `GET .../candidates` → `{ menu }`. */
export interface CandidateMenuView {
  readonly tripId: string;
  readonly encounterIndex: number;
  readonly searchSeq: number;
  readonly caravan: { readonly rating: number; readonly ratingPool: "living"; readonly band: BandView };
  readonly centre: number;
  readonly escalation: { readonly applied: number; readonly perEncounter: number; readonly nextEncounter: number };
  readonly bandWidthUsed: number;
  readonly widened: boolean;
  readonly usedAuthoredFallback: boolean;
  readonly candidates: readonly CandidateView[];
  readonly searchedAtMs: number;
  /** The reroll is free and gated by time only; `availableAtMs` is when the next search opens. */
  readonly reroll: { readonly gate: "time"; readonly cooldownSeconds: number; readonly availableAtMs: number; readonly available: boolean };
  readonly chosen: { readonly candidateId: string; readonly chosenAt: string } | null;
}

/** `POST .../choose` → the menu marked chosen plus the chosen candidate. */
export interface ChoiceView {
  readonly menu: CandidateMenuView;
  readonly chosen: CandidateView;
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

export interface FormationResponse {
  readonly formation: FormationView;
}

/** `POST .../search` (201) and `GET .../candidates` → `{ menu }`. */
export interface CandidateMenuResponse {
  readonly menu: CandidateMenuView;
}

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
  /** Chunk 30: null for a guest (no username or password linked yet). */
  readonly username: string | null;
  /** Chunk 30: true until the guest links a username and password. The server always sends it (the guard requires it); optional here so older fixtures stay valid. */
  readonly guest?: boolean | undefined;
}

export interface CaravanSummary {
  readonly id: string;
  readonly name: string;
  readonly region_id: string;
  /** `in_town` (home, refitting) or `on_trip` (out; nothing is repaired until it returns). Chunk 15 moves it. */
  readonly state?: "in_town" | "on_trip" | undefined;
  /** The roster (unit_instance rows) as `GET /me` returns it. */
  readonly units?: readonly UnitInstanceView[] | undefined;
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
/** N5: the caravan's packed fence and traps, as the candidates read sends them. */
export interface CaravanLoadoutView {
  readonly fences: readonly { readonly tierId: string; readonly displayName: string; readonly category: string; readonly standing: number; readonly packed: number }[];
  readonly traps: readonly { readonly typeId: string; readonly displayName: string; readonly category: string; readonly ready: number; readonly packed: number }[];
}

/** N10: the GET read — null in town with nothing packed. */
export interface ManifestReadResponse {
  readonly manifest: ManifestView | null;
}

/** N10: the GET candidates read — `menu` null (and `searched` false) before the first search. */
export interface CandidatesReadResponse {
  readonly menu: CandidateMenuView | null;
  readonly searched?: boolean | undefined;
  readonly encounterIndex?: number | undefined;
}

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
  /** No account id: the client never sees who owns a party beyond its display name (chunk 14 QA N4). */
  readonly owner: { readonly displayName: string; readonly authored: boolean; readonly flavor: string | null };
  /** `gapBeyondBand` is the part of the gap the earn floor is computed from (chunk 14 QA S3). */
  readonly reputation: { readonly rating: number; readonly band: BandView; readonly gapFromCaravan: number; readonly gapBeyondBand: number; readonly sandbagEarnMultiplier: number };
  readonly scout: PartyScoutView;
}

/** `POST .../search` (201) and `GET .../candidates` → `{ menu }`. */
export interface CandidateMenuView {
  readonly tripId: string;
  readonly encounterIndex: number;
  readonly searchSeq: number;
  readonly caravan: { readonly rating: number; readonly ratingPool: "living"; readonly band: BandView };
  readonly centre: number;
  /** N6: centre − caravan rating and the rule that put it there (encounter 1's offset, or the escalation). */
  readonly centreBasis?: { readonly offset: number; readonly reason: "first_encounter_offset" | "escalation" | "none"; readonly inCaravanBand: boolean; readonly centreBand: BandView } | undefined;
  /** S1: the band-0 cold-start raider cap this search applied, or null. */
  readonly raiderCap?: { readonly packedUnits: number; readonly cap: number; readonly relaxed: boolean; readonly excluded: number } | null | undefined;
  /** N5: the caravan's own packed fence (standing / packed by tier) and traps (ready / packed by type), with categories. */
  readonly caravanLoadout?: CaravanLoadoutView | null | undefined;
  readonly escalation: { readonly applied: number; readonly perEncounter: number; readonly nextEncounter: number };
  readonly bandWidthUsed: number;
  readonly widened: boolean;
  /** The menu needed authored parties from OUTSIDE the widest band (EMPTY_POOL_BEHAVIOR's last step). */
  readonly authoredOutsideBand: boolean;
  /** How much of this menu is authored, against the cap the draw applies (PHASE-2 §25). */
  readonly authoredShare: { readonly authored: number; readonly of: number; readonly shareBp: number; readonly maxShareBp: number };
  /** The band's authored served share at search time (chunk 25); null on menus stored before it existed. */
  readonly authoredServed: { readonly band: number; readonly window: number; readonly served: number; readonly authored: number; readonly weightedDown: boolean } | null;
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

// ── Economy & merging (chunk 16 routes: apps/server/src/routes/economy.ts) ─────────────

/** `GET /me/economy`: the account's Coin as of now, the trickle, the cap headroom, the merge table. */
export interface EconomyView {
  /** Ledger balance plus the trickle pending right now — what the player has. */
  readonly balance: number;
  readonly cap: number;
  /** Room under the cap RIGHT NOW (the trickle keeps filling it). */
  readonly room: number;
  readonly atCap: boolean;
  readonly trickle: {
    readonly ratePerHour: number;
    readonly msPerCoin: number;
    readonly pending: number;
    readonly ledgerBalance: number;
    readonly nextCoinInMs: number | null;
    readonly accruedThroughMs: number;
  };
  readonly overflow: {
    readonly prospectiveEarn: number;
    readonly wouldCredit: number;
    readonly wouldDiscard: number;
    readonly warn: boolean;
    readonly message: string;
  };
  readonly earn: {
    readonly encounterSchedule: readonly number[];
    readonly bankedTripBonus: number;
    readonly partyWin: number;
  };
  readonly merge: {
    /** `{ "2": 250, "3": 900, … }` per resulting unit, keyed by the resulting level. */
    readonly costPerResultingUnitByLevel: Readonly<Record<string, number>>;
    readonly recipes: readonly { readonly spend: number; readonly produce: number }[];
    readonly levelCap: number;
    readonly slotCost: number;
  };
}

/** Stats of one unit at a merge level, as the server's merge preview quotes them. Ratings never scale; HP and damage output do. */
export interface UnitStatsView {
  readonly hp: number;
  readonly offense: number;
  readonly defense: number;
  readonly damageOutputMult: number;
  readonly multDen: number;
  readonly referenceHit: number;
}

/** `POST /me/caravans/:id/merge/preview` — everything the player commits against, before committing. */
export interface MergePreview {
  readonly caravanId: string;
  readonly unitTypeId: string;
  readonly unitDisplayName: string;
  readonly recipe: { readonly spend: number; readonly produce: number };
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly costPerUnit: number;
  readonly totalCost: number;
  /** Ledger balance PLUS pending trickle — what the commit will be checked against. */
  readonly balance: number;
  readonly pendingTrickle: number;
  readonly affordable: boolean;
  readonly consumed: {
    readonly instanceIds: readonly string[];
    readonly inParty: readonly string[];
    readonly count: number;
    readonly slots: number;
    readonly perUnit: UnitStatsView;
    readonly combined: UnitStatsView;
  };
  readonly requiresConfirmInParty: boolean;
  readonly produced: { readonly count: number; readonly slots: number; readonly perUnit: UnitStatsView; readonly combined: UnitStatsView };
  readonly slotsFreed: number;
  readonly ability: { readonly archetype: string; readonly displayName: string };
}

export interface MergeRequest {
  readonly instanceIds: readonly string[];
  /** Only the literal `true` confirms consuming a unit the standing party names (409 `unit_in_party` otherwise). */
  readonly confirmInParty?: boolean;
}

/** `POST /me/caravans/:id/merge` → the committed merge (or the stored one on a replay). */
export interface MergeResultView {
  readonly replayed: boolean;
  readonly merged: { readonly unitTypeId: string; readonly fromLevel: number; readonly toLevel: number; readonly coinCost: number };
  readonly consumedInstanceIds: readonly string[];
  readonly producedInstanceIds: readonly string[];
  readonly produced: readonly UnitInstanceView[];
  readonly balanceAfter: number;
}

// ── Unit acquisition (chunk 18 routes: apps/server/src/routes/acquisition.ts) ──────────

export interface UnitTypeSummaryView {
  readonly unitTypeId: string;
  readonly displayName: string;
  readonly affinity: string;
  readonly ability: { readonly archetype: string; readonly displayName: string };
}

export interface InventoryStatusView {
  readonly count: number;
  readonly cap: number;
  readonly room: number;
  readonly full: boolean;
}

export interface RefugeeOfferView extends UnitTypeSummaryView {
  readonly slot: number;
}

export interface RefugeeMenuView {
  /** Pass back as `sequence` (claim) or `fromSequence` (reroll, refresh). */
  readonly sequence: number;
  readonly origin: "free" | "reroll";
  readonly rerollsThisWindow: number;
  /** Exactly REFUGEE_OFFER_COUNT slots; with a small pool, slots repeat a type (collapsed on screen). */
  readonly offers: readonly RefugeeOfferView[];
  readonly generatedAtMs: number;
  readonly claimed: { readonly unitTypeId: string; readonly instanceId: string; readonly claimedAtMs: number } | null;
}

/** `GET /me/caravans/:id/refugees` — the menu, the free timer, the next reroll cost, the balance. GET never writes past the first menu. */
export interface RefugeeView {
  readonly caravanId: string;
  readonly menu: RefugeeMenuView;
  readonly timer: {
    readonly intervalMs: number;
    readonly windowOpenedAtMs: number;
    readonly nextFreeRefreshAtMs: number;
    readonly msUntilFreeRefresh: number;
    /** The next free menu is owed: claim the current one or take the refresh (free). */
    readonly freeRefreshDue: boolean;
    readonly refreshedNow: boolean;
  };
  readonly reroll: {
    readonly nextCost: number;
    readonly nextIndex: number;
    readonly schedule: readonly number[];
    readonly affordable: boolean;
    readonly forfeitsUnclaimedOffer: boolean;
    readonly blockedByFreeRefresh: boolean;
  };
  readonly balance: number;
  readonly pendingTrickle: number;
  readonly inventory: InventoryStatusView;
}

export interface AcquiredView {
  readonly unitTypeId: string;
  readonly instanceId: string;
  readonly mergeLevel: number;
  readonly source: string;
  readonly coinCost: number;
}

export interface RefugeeClaimResult {
  readonly replayed: boolean;
  readonly acquired: AcquiredView;
  readonly refugees: RefugeeView;
}

export interface RefugeeRefreshResult {
  readonly replayed: boolean;
  readonly fromSequence: number;
  readonly forfeitedOffers: readonly RefugeeOfferView[] | null;
  readonly refugees: RefugeeView;
}

export interface RefugeeRerollResult {
  readonly replayed: boolean;
  readonly fromSequence: number;
  readonly coinCost: number;
  readonly balanceAfter: number;
  readonly refugees: RefugeeView;
}

export interface RecruitOfferView extends UnitTypeSummaryView {
  readonly cost: number;
  readonly affordable: boolean;
}

/** `GET /me/caravans/:id/recruit` — every unlocked type at its fixed cost; locked types listed, never sold. */
export interface RecruitView {
  readonly caravanId: string;
  readonly costBase: number;
  readonly scaling: string;
  readonly recruitable: readonly RecruitOfferView[];
  readonly locked: readonly UnitTypeSummaryView[];
  readonly balance: number;
  readonly pendingTrickle: number;
  readonly inventory: InventoryStatusView;
  readonly availability: { readonly cooldown: null; readonly dailyLimit: null };
}

export interface RecruitResult {
  readonly replayed: boolean;
  readonly acquired: AcquiredView;
  readonly coinCost: number;
  readonly balanceAfter: number;
  readonly inventory: InventoryStatusView;
}

// ── Standing raid party (chunk 09 routes: apps/server/src/routes/party.ts) ────────────

export type PartyConfigBody = import("@caravan/circle").PartyConfig;
export type TargetingStanceView = import("@caravan/circle").TargetingStance;
export type EntryEdgeView = import("@caravan/circle").EntryEdge;
export type ScoutSiegeView = import("@caravan/circle").ScoutSiege;

/** One living unit of the roster as the party builder sees it. */
export interface RosterEntryView {
  readonly instanceId: string;
  readonly caravanId: string;
  readonly typeId: string;
  readonly displayName: string;
  readonly mergeLevel: number;
  readonly slotCost: 1;
  /** The rating it fights with IN A PARTY (offense is `ratingInUse`). */
  readonly offense: number;
  readonly defense: number;
  readonly hp: number;
  readonly unlocked: boolean;
  readonly inParty: boolean;
  readonly packedOnTrip: boolean;
  readonly aliveOnTrip: boolean | null;
}

/** `GET|PUT /me/party` → `{ party }`. */
export interface PartyView {
  readonly id: string;
  readonly slot: number;
  readonly savedAt: string;
  readonly hash: string;
  readonly config: PartyConfigBody;
  readonly valid: boolean;
  readonly issues: readonly IssueView[];
  /** Byte-for-byte what a scouting defender is served; null while invalid. */
  readonly scout: PartyScoutView | null;
  readonly edges: readonly EntryEdgeView[];
  readonly caps: { readonly units: number; readonly siege: number; readonly edges: number; readonly editCooldownMs: number; readonly partiesPerAccount: number };
  readonly rules: {
    readonly template: true;
    readonly neverConsumed: true;
    readonly unitsMayAlsoBePackedOnTrips: true;
    readonly ratingInUse: "offense";
    readonly stances: readonly string[];
  };
  readonly roster: readonly RosterEntryView[];
  readonly siegeCatalog: readonly (ScoutSiegeView & { readonly unlocked: boolean })[];
  /** D5: the server's suggested party — the saved one plus free unlocked roster units and the owner's unlocked siege. Null when it adds nothing. */
  readonly suggested?: PartyConfigBody | null | undefined;
}

export interface PartyResponse {
  readonly party: PartyView;
}

/** One place the party was served (`GET /me/party/feed`). The owner was never there; this is how they learn. */
export interface PartyFeedEntryView {
  readonly seq: number;
  readonly occurredAt: string;
  readonly jobId: string | null;
  readonly encounterIndex: number | null;
  readonly defender: { readonly username: string | null; readonly caravanName: string | null; readonly regionId: string | null };
  readonly outcomeKind: string | null;
  readonly coinEarned: number;
  readonly reputationDelta: number;
  readonly ladderPointsGained: number;
}

export interface PartyFeedPage {
  readonly entries: readonly PartyFeedEntryView[];
  readonly nextBefore: number;
  readonly hasMore: boolean;
}

// ── Store & cosmetics (chunk 20 routes), the Packs and Cosmetics screens ─────────────

export type CosmeticKindView = "unit_skin" | "wagon_skin" | "fence_style" | "town_decoration" | "party_banner";
export type PackTierView = 1 | 2 | 3;

/** A cosmetic as the server describes it. Purely visual: there is no numeric field to show. */
export interface CosmeticInfoView {
  readonly id: string;
  readonly kind: CosmeticKindView;
  readonly displayName: string;
  readonly description: string;
  /** The living unit type a skin applies to; null for every other kind. */
  readonly appliesTo: string | null;
  readonly reviewNote: string;
  /** The equip slot it occupies: the kind, or `unit_skin:<unit type id>`. */
  readonly slot: string;
}

/** One entry of what a pack grants. Exactly two kinds exist; nothing else can be sold. */
export type PackContentView = { readonly kind: "coin"; readonly amount: number } | { readonly kind: "cosmetic"; readonly cosmeticId: string };

/** What crediting an amount would do to the balance right now (chunk 16's forecast). */
export interface StoreOverflowView {
  readonly balance: number;
  readonly cap: number;
  readonly room: number;
  readonly prospectiveEarn: number;
  readonly wouldCredit: number;
  readonly wouldDiscard: number;
  readonly atCap: boolean;
  readonly warn: boolean;
  readonly message: string;
}

export interface PackOfferBaseView {
  readonly id: string;
  readonly weekIndex: number;
  readonly tier: PackTierView;
  readonly priceCents: number;
  readonly priceDisplay: string;
  /** Fixed week to week. */
  readonly coin: number;
  readonly cosmetics: readonly CosmeticInfoView[];
  /** The exact list the purchase grants (the guard checks `coin` and `cosmetics` agree with it). */
  readonly contents: readonly PackContentView[];
  /** sha256 of the canonical contents; sent back with the purchase (QA-20 S2). */
  readonly contentsHash: string;
}

export interface PackOfferView extends PackOfferBaseView {
  readonly purchased: boolean;
  readonly purchasedAt: string | null;
  readonly purchaseId: string | null;
  readonly overflow: StoreOverflowView;
}

export interface UpcomingWeekView {
  readonly weekIndex: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly offers: readonly PackOfferBaseView[];
}

export interface StoreView {
  readonly backend: { readonly name: string; readonly sandbox: true; readonly realCharges: false; readonly message: string };
  readonly week: { readonly index: number; readonly startsAtMs: number; readonly endsAtMs: number; readonly nowMs: number };
  readonly balance: { readonly balance: number; readonly cap: number; readonly room: number; readonly atCap: boolean; readonly pendingTrickle: number };
  readonly offers: readonly PackOfferView[];
  /** Every still-unpurchased tier at once (tiers stack within a week). */
  readonly combined: { readonly tiers: readonly PackTierView[]; readonly coin: number; readonly overflow: StoreOverflowView };
  readonly upcoming: readonly UpcomingWeekView[];
  readonly ceiling: {
    /** THE pay-to-accelerate number: all three tiers combined. */
    readonly weeklyPayCeiling: number;
    readonly freeWeeklyEarnEstimate: number;
    readonly paidToFreeRatioBp: number;
    readonly paidToFreeRatioMaxBp: number;
    readonly storageCap: number;
    readonly purchaseLimitPerTierPerWeek: number;
    readonly note: string;
  };
}

export interface PurchaseRequest {
  readonly tier: PackTierView;
  readonly weekIndex: number;
  readonly contentsHash: string;
}

export interface PackPurchaseView {
  readonly id: string;
  readonly weekIndex: number;
  readonly tier: PackTierView;
  readonly backend: string;
  /** Null only while the row is an unsettled reservation. */
  readonly sandboxReceipt: string | null;
  readonly priceCents: number;
  readonly contents: readonly PackContentView[];
  readonly coin: { readonly requested: number; readonly credited: number; readonly discarded: number };
  readonly purchasedAt: string;
  readonly settled: boolean;
}

export interface PurchaseResult {
  readonly sandbox: true;
  /** True => this tier was already bought this week; the stored outcome came back and nothing moved. */
  readonly replayed: boolean;
  readonly purchase: PackPurchaseView;
  readonly coin: { readonly requested: number; readonly credited: number; readonly discarded: number; readonly balanceAfter: number; readonly cap: number };
  readonly cosmeticsGranted: readonly string[];
  readonly cosmeticsAlreadyOwned: readonly string[];
}

export interface PurchasesList {
  readonly purchases: readonly PackPurchaseView[];
}

export interface OwnedCosmeticView extends CosmeticInfoView {
  readonly purchaseId: string;
  readonly grantedAt: string;
  readonly equipped: boolean;
}

export interface CatalogCosmeticView extends CosmeticInfoView {
  readonly owned: boolean;
  readonly nextOffer: { readonly weekIndex: number; readonly tier: PackTierView } | null;
}

export interface CosmeticsView {
  readonly kinds: readonly CosmeticKindView[];
  readonly owned: readonly OwnedCosmeticView[];
  /** slot → cosmetic id. */
  readonly equipped: Readonly<Record<string, string>>;
  readonly catalog: readonly CatalogCosmeticView[];
}

export interface EquipResult {
  readonly slot: string;
  readonly cosmeticId: string;
  readonly equipped: Readonly<Record<string, string>>;
}

export interface UnequipResult {
  readonly slot: string;
  readonly cleared: boolean;
  readonly equipped: Readonly<Record<string, string>>;
}

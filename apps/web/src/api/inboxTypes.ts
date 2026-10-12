/**
 * The in-app inbox (chunk 29 routes: GET /me/inbox, GET /me/inbox/unread, POST /me/inbox/read,
 * PUT /me/inbox/preferences). Every item is derived by the server from the ledger and the
 * existing timers; the client renders it and never decides what is read.
 */

export type InboxCategoryView = "party_strike" | "refugees_arrived" | "trip_cap_refilled" | "mine_near_cap" | "packs_rotated" | "party_changed";

export interface InboxStrikeView {
  readonly seq: number;
  readonly occurredAt: string;
  readonly jobId: string | null;
  readonly encounterIndex: number | null;
  readonly outcomeKind: string | null;
  /** What the results feed shows of the defender, no more: never an account id. */
  readonly defender: { readonly username: string | null; readonly caravanName: string | null; readonly regionId: string | null };
  readonly coinEarned: number;
  readonly coinTransferred: number;
  /** What the owner's storage cap discarded from this strike's credits (the results feed's number). */
  readonly coinDiscardedAtCap: number;
  readonly reputationDelta: number;
  readonly ladderPointsGained: number;
}

export interface StrikeDetailView {
  readonly count: number;
  readonly held: number;
  readonly overran: number;
  readonly stalemate: number;
  readonly other: number;
  readonly coinEarned: number;
  readonly coinTransferred: number;
  readonly coinDiscardedAtCap: number;
  readonly reputationDelta: number;
  readonly ladderPointsGained: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** False for an older batch sent without its lines: fetch them with `inboxStrikes(window)`. */
  readonly linesIncluded: boolean;
  readonly strikes: readonly InboxStrikeView[];
  readonly notListed: number;
}

export interface RefugeeDetailView {
  readonly caravanId: string;
  readonly caravanName: string;
  readonly regionId: string;
  readonly arrivedAtMs: number;
  readonly currentMenuUnclaimed: boolean;
}

export interface TripCapDetailView {
  readonly available: number;
  readonly cap: number;
  readonly fullAtMs: number;
}

export interface MineDetailView {
  readonly balance: number;
  readonly cap: number;
  readonly atCap: boolean;
  readonly thresholdPercent: number;
  readonly ratePerHour: number;
  readonly capReachedAtMs: number | null;
}

/** Final play-test review S2: the standing party repaired itself after a merge or a trip loss. */
export interface PartyChangedDetailView {
  readonly reason: "merge" | "trip_loss";
  readonly carriedOver: number;
  readonly dropped: number;
  readonly unitsNow: number;
  readonly empty: boolean;
}

export interface PacksDetailView {
  readonly weekIndex: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

interface ItemBase<C extends InboxCategoryView, D> {
  readonly key: string;
  readonly category: C;
  readonly version: number;
  readonly occurredAtMs: number;
  readonly occurredAt: string;
  readonly unread: boolean;
  readonly detail: D;
}

export type InboxItemView =
  | ItemBase<"party_strike", StrikeDetailView>
  | ItemBase<"refugees_arrived", RefugeeDetailView>
  | ItemBase<"trip_cap_refilled", TripCapDetailView>
  | ItemBase<"mine_near_cap", MineDetailView>
  | ItemBase<"packs_rotated", PacksDetailView>
  | ItemBase<"party_changed", PartyChangedDetailView>;

export interface InboxPreferenceView {
  readonly category: InboxCategoryView;
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
}

export interface InboxView {
  readonly items: readonly InboxItemView[];
  readonly unreadCount: number;
  readonly preferences: readonly InboxPreferenceView[];
  /** Strike batches not listed (past the 30th, or older than the horizon); null when none. The results feed has them. */
  readonly olderStrikes: { readonly batchesPastLimit: number; readonly beforeHorizon: boolean } | null;
  readonly strikeBatchWindowMs: number;
  readonly horizonMs: number;
  readonly delivery: "in_app";
}

export interface InboxUnreadView {
  readonly unreadCount: number;
}

/** The key and the version the client is SHOWING, for each item to mark (there is no "mark everything": chunk 29 QA S1). */
export interface InboxMarkRequest {
  readonly marks: readonly { readonly key: string; readonly version: number }[];
}

/** The inbox after a mark, plus the keys it no longer shows (nothing was stored for them). */
export interface InboxMarkResult extends InboxView {
  readonly ignored: readonly string[];
}

/** GET /me/inbox/strikes/:window — one older batch's lines. */
export interface InboxStrikeLinesView {
  readonly window: number;
  readonly strikes: readonly InboxStrikeView[];
}

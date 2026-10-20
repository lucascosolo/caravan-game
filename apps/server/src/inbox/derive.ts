/**
 * The inbox's pure part (chunk 29): from already-read stored state to items. No clock, no I/O;
 * `nowMs` is a parameter. service.ts reads the state and calls these.
 *
 * Every item has a stable KEY (what the read mark is stored under) and a VERSION (an integer
 * that grows when the item gains something new). An item is unread while no read mark for its
 * key has reached its version.
 *
 *   party_strike       key strike:<window index>     version = newest ledger seq among the batch's strikes
 *                                                    AND the credits / progression they caused (QA S2: a
 *                                                    settle that lands later moves the version, so a read
 *                                                    batch whose totals changed is unread again)
 *   refugees_arrived   key refugees:<caravan>:<ms>   version = the instant the free menu was owed
 *   trip_cap_refilled  key trip_cap:<ms>             version = the instant the cap was full again
 *   mine_near_cap      key mine:<last spend seq>     version = 1 (one per stretch between spends)
 *   packs_rotated      key packs:<week index>        version = 1
 *   party_changed      key party:<ledger seq>        version = 1 (one per standing_party_repaired event, S2)
 */
import { INBOX_MINE_NEAR_CAP_PERCENT, INBOX_STRIKES_PER_ITEM, INBOX_STRIKE_BATCH_WINDOW_MS, INBOX_HORIZON_MS, type InboxCategory } from "./tunables.js";

/** One strike, as the owner's results feed reports it, minus anything the inbox does not need. */
export interface InboxStrike {
  seq: number;
  occurredAt: string;
  jobId: string | null;
  encounterIndex: number | null;
  /** caravan_held | caravan_overrun | stalemate (chunk 13), or null if the resolution wrote none. */
  outcomeKind: string | null;
  /** Exactly what the results feed shows of the defender: the caravan's name and region (username always null, r3 N6). Never an account id. */
  defender: {
    username: string | null;
    caravanName: string | null;
    regionId: string | null;
    /** Final play-test review r2 N15: the defender has since deleted their account (the fight stays; nothing about who it was). */
    departed: boolean;
  };
  coinEarned: number;
  coinTransferred: number;
  /** Of what this strike would have credited: the part the owner's storage cap discarded (the feed's `coinDiscardedAtCap`). */
  coinDiscardedAtCap: number;
  reputationDelta: number;
  ladderPointsGained: number;
}

/** One strike window's totals, summed in SQL over every strike in it (not only the listed ones). */
export interface StrikeWindowTotals {
  window: number;
  count: number;
  /** The item's version: the newest seq among the strikes and their owner-side events (QA S2). */
  maxSeq: number;
  /** When the newest strike of the window happened (the item's time). */
  newestAtMs: number;
  held: number;
  overran: number;
  stalemate: number;
  coinEarned: number;
  coinTransferred: number;
  coinDiscardedAtCap: number;
  reputationDelta: number;
  ladderPointsGained: number;
}

export interface StrikeDetail {
  count: number;
  held: number;
  overran: number;
  stalemate: number;
  /** Strikes whose outcome was none of the three (an unresolved placeholder). */
  other: number;
  coinEarned: number;
  coinTransferred: number;
  coinDiscardedAtCap: number;
  reputationDelta: number;
  ladderPointsGained: number;
  windowStartMs: number;
  windowEndMs: number;
  /**
   * Whether `strikes` was filled in. Only the newest INBOX_ITEMIZED_BATCHES batches carry their
   * lines in the inbox read (QA S4); an older batch's lines come from GET /me/inbox/strikes/:window.
   */
  linesIncluded: boolean;
  /** Newest first, at most INBOX_STRIKES_PER_ITEM (empty when `linesIncluded` is false). */
  strikes: InboxStrike[];
  /** Strikes in this window counted above but never itemized (count − INBOX_STRIKES_PER_ITEM; see the Party tab's results feed). */
  notListed: number;
}

export interface RefugeeDetail {
  caravanId: string;
  caravanName: string;
  regionId: string;
  /** When the free menu became owed (the drip's grid point). */
  arrivedAtMs: number;
  /** The menu waiting now is unclaimed: taking the free one replaces it (chunk 18 QA D1). */
  currentMenuUnclaimed: boolean;
}

export interface TripCapDetail {
  available: number;
  cap: number;
  fullAtMs: number;
}

export interface MineDetail {
  balance: number;
  cap: number;
  atCap: boolean;
  thresholdPercent: number;
  ratePerHour: number;
  /** When the trickle reaches the cap and stops, if nothing is spent; null when already there. */
  capReachedAtMs: number | null;
}

/** S2: one `standing_party_repaired` event, as the owner is told about it. */
export interface PartyChangedDetail {
  /** What removed the units: a merge (their slots carry over to the merged unit) or a trip loss (their slots are dropped). */
  reason: "merge" | "trip_loss";
  /** Slots re-pointed to a merged unit. */
  carriedOver: number;
  /** Slots dropped (the unit is gone and nothing replaced it). */
  dropped: number;
  /** Living units the party fields now. */
  unitsNow: number;
  /** True when the party is left with no units: it is not served until the owner adds one. */
  empty: boolean;
}

export interface PacksDetail {
  weekIndex: number;
  startsAtMs: number;
  endsAtMs: number;
}

interface ItemBase<C extends InboxCategory, D> {
  key: string;
  category: C;
  version: number;
  occurredAtMs: number;
  occurredAt: string;
  unread: boolean;
  detail: D;
}

export type InboxItem =
  | ItemBase<"party_strike", StrikeDetail>
  | ItemBase<"refugees_arrived", RefugeeDetail>
  | ItemBase<"trip_cap_refilled", TripCapDetail>
  | ItemBase<"mine_near_cap", MineDetail>
  | ItemBase<"packs_rotated", PacksDetail>
  | ItemBase<"party_changed", PartyChangedDetail>;

/** An item before the read state is applied. */
export type DraftItem = Omit<InboxItem, "unread"> & { unread?: never };

const iso = (ms: number): string => new Date(ms).toISOString();

export function strikeWindowOf(occurredAtMs: number, windowMs: number = INBOX_STRIKE_BATCH_WINDOW_MS): number {
  return Math.floor(occurredAtMs / windowMs);
}

/**
 * The first instant the inbox looks at: the start of the window holding `now − horizon`, so a
 * batch is shown whole or not at all and its count always matches the feed's for that hour (QA N1).
 */
export function horizonStartMs(nowMs: number, horizonMs: number = INBOX_HORIZON_MS, windowMs: number = INBOX_STRIKE_BATCH_WINDOW_MS): number {
  return Math.floor((nowMs - horizonMs) / windowMs) * windowMs;
}

/** The strike lines of one window: those of `listed` inside it, newest first, at most INBOX_STRIKES_PER_ITEM. */
export function windowLines(window: number, listed: readonly InboxStrike[], windowMs: number = INBOX_STRIKE_BATCH_WINDOW_MS): InboxStrike[] {
  return listed
    .filter((s) => strikeWindowOf(Date.parse(s.occurredAt), windowMs) === window)
    .sort((a, b) => b.seq - a.seq)
    .slice(0, INBOX_STRIKES_PER_ITEM);
}

/**
 * One batched strike item per window. `listed` are its lines (any order; filtered to the window
 * here), or null when this batch's lines are not part of this read (QA S4).
 */
export function strikeItem(t: StrikeWindowTotals, listed: readonly InboxStrike[] | null, windowMs: number = INBOX_STRIKE_BATCH_WINDOW_MS): DraftItem {
  const lines = listed === null ? [] : windowLines(t.window, listed, windowMs);
  const newest = t.newestAtMs;
  const detail: StrikeDetail = {
    count: t.count,
    held: t.held,
    overran: t.overran,
    stalemate: t.stalemate,
    other: Math.max(0, t.count - t.held - t.overran - t.stalemate),
    coinEarned: t.coinEarned,
    coinTransferred: t.coinTransferred,
    coinDiscardedAtCap: t.coinDiscardedAtCap,
    reputationDelta: t.reputationDelta,
    ladderPointsGained: t.ladderPointsGained,
    windowStartMs: t.window * windowMs,
    windowEndMs: (t.window + 1) * windowMs,
    linesIncluded: listed !== null,
    strikes: lines,
    notListed: Math.max(0, t.count - INBOX_STRIKES_PER_ITEM),
  };
  return { key: `strike:${t.window}`, category: "party_strike", version: t.maxSeq, occurredAtMs: newest, occurredAt: iso(newest), detail };
}

/** The refugee drip owes a free menu once the window after the current menu's opens. */
export function refugeeItem(
  caravan: { id: string; name: string; regionId: string },
  menu: { windowOpenedAtMs: number; claimed: boolean } | null,
  intervalMs: number,
  nowMs: number,
): DraftItem | null {
  if (!menu) return null;
  const arrivedAtMs = menu.windowOpenedAtMs + intervalMs;
  if (nowMs < arrivedAtMs) return null;
  return {
    key: `refugees:${caravan.id}:${arrivedAtMs}`,
    category: "refugees_arrived",
    version: arrivedAtMs,
    occurredAtMs: arrivedAtMs,
    occurredAt: iso(arrivedAtMs),
    detail: { caravanId: caravan.id, caravanName: caravan.name, regionId: caravan.regionId, arrivedAtMs, currentMenuUnclaimed: !menu.claimed },
  };
}

/** The trip cap is full again at its stored timestamp (chunk 15: `tat`); nothing before the first use. */
export function tripCapItem(tatMs: number, cap: number, nowMs: number, horizonMs: number): DraftItem | null {
  if (tatMs <= 0 || tatMs > nowMs || nowMs - tatMs > horizonMs) return null;
  return {
    key: `trip_cap:${tatMs}`,
    category: "trip_cap_refilled",
    version: tatMs,
    occurredAtMs: tatMs,
    occurredAt: iso(tatMs),
    detail: { available: cap, cap, fullAtMs: tatMs },
  };
}

export interface MineState {
  /** What the player sees: ledger balance + pending trickle (chunk 16). */
  balance: number;
  ledgerBalance: number;
  cap: number;
  accruedFromMs: number;
  nextCoinInMs: number;
  msPerCoin: number;
  ratePerHour: number;
  /** seq of the last coin_spent (0 when none): the stretch this item belongs to. */
  lastSpendSeq: number;
  /** When the ledger balance last rose (the latest credit after that spend), else the account's creation. */
  lastCreditMs: number;
}

export function mineThreshold(cap: number, percent: number = INBOX_MINE_NEAR_CAP_PERCENT): number {
  return Math.floor((cap * percent) / 100);
}

export function mineItem(m: MineState, nowMs: number, percent: number = INBOX_MINE_NEAR_CAP_PERCENT): DraftItem | null {
  const threshold = mineThreshold(m.cap, percent);
  if (m.cap <= 0 || m.balance < threshold) return null;
  const atCap = m.balance >= m.cap;
  // When the line was crossed: by the trickle still pending (computable to the coin), or by a
  // credit already in the ledger (its instant). Presentation only.
  const crossedAt = m.ledgerBalance < threshold ? m.accruedFromMs + (threshold - m.ledgerBalance) * m.msPerCoin : m.lastCreditMs;
  const occurredAtMs = Math.min(nowMs, Math.max(0, crossedAt));
  return {
    key: `mine:${m.lastSpendSeq}`,
    category: "mine_near_cap",
    version: 1,
    occurredAtMs,
    occurredAt: iso(occurredAtMs),
    detail: {
      balance: m.balance,
      cap: m.cap,
      atCap,
      thresholdPercent: percent,
      ratePerHour: m.ratePerHour,
      capReachedAtMs: atCap ? null : nowMs + m.nextCoinInMs + (m.cap - m.balance - 1) * m.msPerCoin,
    },
  };
}

/** This week's rotation, once, and only for a week that began after the account existed. */
export function packsItem(week: { index: number; startsAtMs: number; endsAtMs: number }, accountCreatedMs: number): DraftItem | null {
  if (week.startsAtMs < accountCreatedMs) return null;
  return {
    key: `packs:${week.index}`,
    category: "packs_rotated",
    version: 1,
    occurredAtMs: week.startsAtMs,
    occurredAt: iso(week.startsAtMs),
    detail: { weekIndex: week.index, startsAtMs: week.startsAtMs, endsAtMs: week.endsAtMs },
  };
}

/** S2: one notice per `standing_party_repaired` event (its ledger seq and payload). */
export function partyChangedItem(e: { seq: number; occurredAtMs: number; payload: Record<string, unknown> }): DraftItem {
  const n = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
  const p = e.payload;
  return {
    key: `party:${e.seq}`,
    category: "party_changed",
    version: 1,
    occurredAtMs: e.occurredAtMs,
    occurredAt: iso(e.occurredAtMs),
    detail: {
      reason: p["reason"] === "merge" ? "merge" : "trip_loss",
      carriedOver: Array.isArray(p["repointed"]) ? p["repointed"].length : 0,
      dropped: Array.isArray(p["dropped"]) ? p["dropped"].length : 0,
      unitsNow: n(p["units"]),
      empty: p["empty"] === true,
    },
  };
}

/** Apply the read marks; newest first, ties by key (a total order). */
export function finishItems(drafts: readonly DraftItem[], readVersions: ReadonlyMap<string, number>): InboxItem[] {
  return drafts
    .map((d) => ({ ...d, unread: (readVersions.get(d.key) ?? -1) < d.version }) as InboxItem)
    .sort((a, b) => b.occurredAtMs - a.occurredAtMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

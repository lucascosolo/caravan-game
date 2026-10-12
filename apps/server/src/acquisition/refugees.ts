/**
 * The refugee drip (chunk 18): the free, passive path to a level-1 unit.
 *
 * A MENU is exactly REFUGEE_OFFER_COUNT offers drawn from the caravan's unlocked living
 * pool (chunk 05's reached set — nothing else), stored in `refugee_menu` with its seed and
 * the pool it was drawn from. The player takes exactly ONE offer per menu; which one is
 * always their choice, and the pick yields exactly that type — no further randomness
 * (GUARDRAILS §1). There is one menu at a time; menus arrive three ways:
 *
 *   free     one per REFUGEE_REFRESH_INTERVAL_MINUTES, on a FIXED GRID (QA D2): the caravan's
 *            first menu sets the anchor and every free menu sits on anchor + k·interval, so
 *            the rate is the same for everyone whatever their polling cadence. A due refresh
 *            is TAKEN, never pushed (QA D1): a free refresh never replaces an unclaimed menu
 *            on its own. It is taken by a claim of the current menu (the next menu is
 *            generated in the same request) or by `POST .../refugees/refresh` (free,
 *            idempotent), which forfeits an unclaimed menu knowingly. One menu per take,
 *            however long the player was away (no stockpiling).
 *   reroll   Coin, through `spendCoin`, at REFUGEE_REROLL_COST_SCHEDULE[rerolls so far in
 *            this window]: a SOONER menu from the SAME pool and the same draw, nothing more.
 *            A reroll never moves the free timer, and is refused (never charged) while a free
 *            refresh is due: Coin is never charged for a menu the timer owed.
 *   bootstrap the caravan's first menu, written by the first GET (the only write a GET ever
 *            does: there is nothing to forfeit and nothing to replace).
 *
 * Roster relief (final play-test review S1, REFUGEE_ROSTER_FLOOR): while the caravan is IN TOWN
 * with fewer living units than the floor, the next free menu is due as soon as the current one is
 * CLAIMED rather than on the grid — one menu at a time (final guardrail review r2 S1) — the same
 * free menu, from the same unlocked pool, taken the same way (a claim takes the next one in the
 * same request; `refresh` takes it explicitly). A new menu before claiming is the paid reroll. A free menu taken early opens
 * its window at that instant (the grid re-anchors), so the drip never runs ahead of the timer
 * once the roster is back at the floor. It is a tuning of the free timer, never a grant.
 *
 * GET never writes otherwise (QA S2): past the timer it reports `timer.freeRefreshDue` and
 * leaves the menu alone. Every mutating request names the menu it is looking at
 * (`sequence` / `fromSequence`, required — QA S1) so a retry can never land on a later menu.
 *
 * The wall clock enters exactly once: "is the free timer up", via `nowMs` (injectable; the
 * route passes Date.now()). The draw itself is `refugeeMenu.ts`, pure and seeded by
 * (caravan id, sequence). Every grant goes through `grantUnit`, which re-checks access at
 * the boundary — a menu row is not trusted as proof of access, so even a tampered row
 * cannot yield a locked type.
 *
 * Idempotency: a claim's causation id is `refugee_claim:<caravan>:<sequence>`; concurrent
 * or retried claims of one menu serialize on the account append lock and every one after
 * the first returns the stored outcome (one instance). A reroll's is
 * `refugee_reroll:<caravan>:<from sequence>`; a retry replays its stored menu. A refresh
 * writes no ledger event; its retry replays when the menu after `fromSequence` is free.
 */
import { TUNABLES, getUnitType } from "@caravan/content";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { RefugeeMenuRow, UnitInstanceRow } from "../db/types.js";
import type { LedgerEventRow } from "../ledger/events.js";
import { appendEvents, causationExists, listEventsByCausation, lockAccountForAppend } from "../ledger/ledger.js";
import { spendCoin } from "../economy/coin.js";
import { peekTrickle } from "../economy/trickle.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { reachedNodeIds, type AccessOwner } from "../unlocks/access.js";
import {
  grantUnit,
  normalizeCaravanId,
  normalizeSequence,
  normalizeUnitTypeId,
  readInventory,
  readOwnedCaravan,
  summarizeUnit,
  type InventoryStatus,
  type UnitAcquiredPayload,
  type UnitTypeSummary,
} from "./grant.js";
import { REFUGEE_REFRESH_INTERVAL_MS, drawForSequence, rerollCost } from "./refugeeMenu.js";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────────────────

/** A stored row that cannot be served: the one error class for "the data is not what this module writes" (QA N3). */
export function menuCorrupt(caravanId: string, detail: string): AppError {
  return new AppError(409, "menu_corrupt", `refugee menu state for caravan ${caravanId} is inconsistent: ${detail}`);
}

async function readCurrentMenu(db: Queryable, caravanId: string): Promise<RefugeeMenuRow | null> {
  const res = await db.query<RefugeeMenuRow>("SELECT * FROM refugee_menu WHERE caravan_id = $1 ORDER BY sequence DESC LIMIT 1", [caravanId]);
  return res.rows[0] ?? null;
}

async function readMenu(db: Queryable, caravanId: string, sequence: number): Promise<RefugeeMenuRow | null> {
  const res = await db.query<RefugeeMenuRow>("SELECT * FROM refugee_menu WHERE caravan_id = $1 AND sequence = $2", [caravanId, sequence]);
  return res.rows[0] ?? null;
}

/** The caravan's unlocked living pool, sorted: the ONLY input the draw sees besides the seed. */
async function unlockedLivingPool(db: Queryable, owner: AccessOwner): Promise<string[]> {
  return [...(await reachedNodeIds(db, "living", owner))].sort();
}

async function insertMenu(
  client: pg.PoolClient,
  owner: AccessOwner,
  sequence: number,
  origin: "free" | "reroll",
  windowSequence: number,
  windowOpenedAtMs: number,
  nowMs: number,
): Promise<RefugeeMenuRow> {
  const pool = await unlockedLivingPool(client, owner);
  const draw = drawForSequence(owner.caravanId, sequence, pool);
  const res = await client.query<RefugeeMenuRow>(
    `INSERT INTO refugee_menu (caravan_id, sequence, origin, window_sequence, seed, pool_type_ids, offered_type_ids, generated_at_ms, window_opened_at_ms)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) RETURNING *`,
    [owner.caravanId, sequence, origin, windowSequence, draw.seed, JSON.stringify(draw.pool), JSON.stringify(draw.offers), nowMs, windowOpenedAtMs],
  );
  return res.rows[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The free timer: a fixed grid (QA D2), taken rather than pushed (QA D1)
// ─────────────────────────────────────────────────────────────────────────────────────────

/** When the free window after `menu`'s opens. */
export function nextFreeRefreshAtMs(menu: Pick<RefugeeMenuRow, "window_opened_at_ms">): number {
  return menu.window_opened_at_ms + REFUGEE_REFRESH_INTERVAL_MS;
}

export function isFreeRefreshDue(menu: Pick<RefugeeMenuRow, "window_opened_at_ms">, nowMs: number): boolean {
  return nowMs >= nextFreeRefreshAtMs(menu);
}

/** TUNABLES.REFUGEE_ROSTER_FLOOR: below this many living units, a caravan in town has its free menu due at once. */
export const REFUGEE_ROSTER_FLOOR: number = TUNABLES.REFUGEE_ROSTER_FLOOR;
if (!Number.isInteger(REFUGEE_ROSTER_FLOOR) || REFUGEE_ROSTER_FLOOR < 0) throw new Error("TUNABLES.REFUGEE_ROSTER_FLOOR must be a non-negative integer");

/** Whether roster relief is on for a caravan right now (S1): in town, and fewer living units than the floor. */
export interface RosterRelief {
  active: boolean;
  rosterFloor: number;
  rosterSize: number;
  inTown: boolean;
}

/** PURE. The relief rule on already-read facts. */
export function rosterReliefOf(inTown: boolean, rosterSize: number, floor: number = REFUGEE_ROSTER_FLOOR): RosterRelief {
  return { active: floor > 0 && inTown && rosterSize < floor, rosterFloor: floor, rosterSize, inTown };
}

/** Read the caravan's state and living roster size (every instance it owns, packed or not). */
export async function readRosterRelief(db: Queryable, caravanId: string): Promise<RosterRelief> {
  const res = await db.query<{ state: string; n: number }>(
    "SELECT c.state, (SELECT count(*)::int FROM unit_instance u WHERE u.caravan_id = c.id) AS n FROM caravan c WHERE c.id = $1",
    [caravanId],
  );
  const row = res.rows[0];
  return rosterReliefOf(row?.state === "in_town", row?.n ?? 0);
}

/**
 * The free menu is owed: by the grid, or by roster relief — and relief owes ONE MENU AT A TIME
 * (final guardrail review round 2, S1): a new relief menu only once the current one is claimed.
 * An unclaimed menu under relief is not re-drawn for free; another menu before claiming it is
 * the ordinary paid reroll. (Before this, `refresh` under relief was an unlimited free re-draw:
 * a free exact pick and an unthrottled row writer.)
 */
export function freeMenuOwed(menu: Pick<RefugeeMenuRow, "window_opened_at_ms" | "claimed_type_id">, nowMs: number, relief: RosterRelief): boolean {
  return isFreeRefreshDue(menu, nowMs) || (relief.active && menu.claimed_type_id !== null);
}

/**
 * The grid point a free refresh taken at `nowMs` belongs to: the latest
 * `anchor + k·interval` that is <= nowMs. Ten intervals late still yields one menu, and the
 * next window opens one interval after THIS grid point, not one interval after the read.
 */
function gridPointFor(menu: Pick<RefugeeMenuRow, "window_opened_at_ms">, nowMs: number): number {
  const k = Math.floor((nowMs - menu.window_opened_at_ms) / REFUGEE_REFRESH_INTERVAL_MS);
  return menu.window_opened_at_ms + Math.max(1, k) * REFUGEE_REFRESH_INTERVAL_MS;
}

/**
 * Write the free menu owed after `current`. Caller has checked `freeMenuOwed` and holds the
 * account lock. Owed by the grid: the window opens at its grid point. Owed only by roster
 * relief (the grid is not up yet): the window opens now, re-anchoring the grid.
 */
async function takeFreeRefresh(client: pg.PoolClient, owner: AccessOwner, current: RefugeeMenuRow, nowMs: number): Promise<RefugeeMenuRow> {
  const next = current.sequence + 1;
  const opensAt = isFreeRefreshDue(current, nowMs) ? gridPointFor(current, nowMs) : nowMs;
  return insertMenu(client, owner, next, "free", next, opensAt, nowMs);
}

/** The caravan's first menu: sets the grid anchor. Holds the lock; re-reads in case a concurrent bootstrap won. */
async function bootstrapMenu(client: pg.PoolClient, owner: AccessOwner, nowMs: number): Promise<{ menu: RefugeeMenuRow; created: boolean }> {
  await lockAccountForAppend(client, owner.accountId);
  const raced = await readCurrentMenu(client, owner.caravanId);
  if (raced) return { menu: raced, created: false };
  return { menu: await insertMenu(client, owner, 1, "free", 1, nowMs, nowMs), created: true };
}

/** The current menu for a mutating request: must exist (GET bootstraps it). Caller holds the lock. */
async function requireCurrentMenu(client: pg.PoolClient, caravanId: string): Promise<RefugeeMenuRow> {
  const current = await readCurrentMenu(client, caravanId);
  if (!current) throw conflict("no_menu", `caravan ${caravanId} has no refugee menu yet; GET .../refugees first`);
  return current;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The view: everything the player commits against, before they commit (GUARDRAILS §4)
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface RefugeeOffer extends UnitTypeSummary {
  slot: number;
}

export interface RefugeeMenuView {
  /** Pass this back as `sequence` (claim) or `fromSequence` (reroll, refresh). */
  sequence: number;
  origin: "free" | "reroll";
  /** How many Coin rerolls produced menus in this window before this one (0 = the free menu). */
  rerollsThisWindow: number;
  /** Replay inputs, stored: the seed and the exact pool the offers were drawn from. */
  seed: number;
  poolTypeIds: string[];
  /** Exactly REFUGEE_OFFER_COUNT slots; with a pool smaller than that, slots repeat types (the UI collapses them). */
  offers: RefugeeOffer[];
  generatedAtMs: number;
  claimed: { unitTypeId: string; instanceId: string; claimedAtMs: number } | null;
}

export interface RefugeeView {
  caravanId: string;
  menu: RefugeeMenuView;
  timer: {
    intervalMs: number;
    /** The grid point this menu's window belongs to. Rerolls never move it; free menus step it by whole intervals. */
    windowOpenedAtMs: number;
    nextFreeRefreshAtMs: number;
    /** Clamped to [0, intervalMs] so a clock that went backwards cannot show more than one interval. */
    msUntilFreeRefresh: number;
    /** True when the next free menu is owed: claim the current one, or POST .../refresh { fromSequence } to take it. */
    freeRefreshDue: boolean;
    /** True when THIS request generated a free menu (a bootstrap, a claim's follow-on refresh, or a refresh). */
    refreshedNow: boolean;
  };
  /**
   * Final play-test review S1: roster relief. `active` = the caravan is in town with fewer than
   * `rosterFloor` living units, so once the current menu is claimed the next free menu is due at
   * once (`timer.freeRefreshDue`) whatever the grid says — one menu at a time (final guardrail
   * review r2 S1). Same pool, same draw, one pick: a sooner free menu, never a wider one.
   */
  relief: RosterRelief;
  reroll: {
    /** What the NEXT reroll costs right now. */
    nextCost: number;
    nextIndex: number;
    schedule: readonly number[];
    affordable: boolean;
    /** Rerolling replaces the current menu; if it is unclaimed, its offers are forfeited. */
    forfeitsUnclaimedOffer: boolean;
    /** A reroll is refused (409 `free_refresh_due`, never charged) while a free refresh is due. */
    blockedByFreeRefresh: boolean;
  };
  /** Ledger balance plus the pending trickle — what a spend right now is checked against. */
  balance: number;
  pendingTrickle: number;
  inventory: InventoryStatus;
}

function menuView(menu: RefugeeMenuRow): RefugeeMenuView {
  if (!Array.isArray(menu.offered_type_ids) || menu.offered_type_ids.length === 0 || !Array.isArray(menu.pool_type_ids)) {
    throw menuCorrupt(menu.caravan_id, `menu ${menu.sequence} holds ${JSON.stringify(menu.offered_type_ids)} as its offers`);
  }
  return {
    sequence: menu.sequence,
    origin: menu.origin,
    rerollsThisWindow: menu.sequence - menu.window_sequence,
    seed: menu.seed,
    poolTypeIds: menu.pool_type_ids,
    offers: menu.offered_type_ids.map((id, slot) => {
      const unit = getUnitType(id);
      if (!unit) throw menuCorrupt(menu.caravan_id, `menu ${menu.sequence} offers '${String(id)}', which is not a living unit type in content`);
      return { slot, ...summarizeUnit(unit) };
    }),
    generatedAtMs: menu.generated_at_ms,
    claimed:
      menu.claimed_type_id !== null && menu.claimed_instance_id !== null && menu.claimed_at_ms !== null
        ? { unitTypeId: menu.claimed_type_id, instanceId: menu.claimed_instance_id, claimedAtMs: menu.claimed_at_ms }
        : null,
  };
}

async function buildView(
  db: Queryable,
  owner: AccessOwner,
  menu: RefugeeMenuRow,
  refreshedNow: boolean,
  nowMs: number,
  balance: number,
  pendingTrickle: number,
): Promise<RefugeeView> {
  const nextIndex = menu.sequence - menu.window_sequence;
  const nextCost = rerollCost(nextIndex);
  const nextAt = nextFreeRefreshAtMs(menu);
  const relief = await readRosterRelief(db, owner.caravanId);
  const due = freeMenuOwed(menu, nowMs, relief);
  return {
    caravanId: owner.caravanId,
    menu: menuView(menu),
    timer: {
      intervalMs: REFUGEE_REFRESH_INTERVAL_MS,
      windowOpenedAtMs: menu.window_opened_at_ms,
      nextFreeRefreshAtMs: nextAt,
      msUntilFreeRefresh: Math.min(REFUGEE_REFRESH_INTERVAL_MS, Math.max(0, nextAt - nowMs)),
      freeRefreshDue: due,
      refreshedNow,
    },
    reroll: {
      nextCost,
      nextIndex,
      schedule: TUNABLES.REFUGEE_REROLL_COST_SCHEDULE,
      affordable: balance >= nextCost,
      forfeitsUnclaimedOffer: menu.claimed_type_id === null,
      blockedByFreeRefresh: due,
    },
    relief,
    balance,
    pendingTrickle,
    inventory: await readInventory(db, owner.caravanId),
  };
}

/**
 * GET: the current menu, the timer, the next reroll cost and the balance. Writes nothing —
 * except the caravan's very first menu, which it bootstraps (nothing to forfeit, nothing to
 * replace). Past the timer it reports `freeRefreshDue` and leaves the menu alone (QA D1/S2).
 */
export async function viewRefugees(pool: pg.Pool, input: { accountId: string; caravanId: string; nowMs?: number }): Promise<RefugeeView> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const nowMs = input.nowMs ?? Date.now();
  return withTransaction(pool, async (client) => {
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, false);
    let menu = await readCurrentMenu(client, caravanId);
    let refreshedNow = false;
    if (!menu) {
      const boot = await bootstrapMenu(client, owner, nowMs);
      menu = boot.menu;
      refreshedNow = boot.created;
    }
    const trickle = await peekTrickle(client, input.accountId, nowMs);
    return buildView(client, owner, menu, refreshedNow, nowMs, trickle.balance, trickle.pending);
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Claim: the player's pick, and only their pick
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface ClaimResult {
  /** True when this menu had already been claimed with this type: the stored outcome, nothing new. */
  replayed: boolean;
  acquired: UnitAcquiredPayload;
  /** The instance, or null on a replay whose instance has since been merged away or lost. */
  instance: UnitInstanceRow | null;
  events: LedgerEventRow[];
  /** The state after the claim: the next free menu when one was due (taken here), else the claimed menu. */
  view: RefugeeView;
}

export function claimCausationId(caravanId: string, sequence: number): string {
  return `refugee_claim:${caravanId}:${sequence}`;
}

export function rerollCausationId(caravanId: string, fromSequence: number): string {
  return `refugee_reroll:${caravanId}:${fromSequence}`;
}

async function findAcquired(client: pg.PoolClient, causationId: string): Promise<{ events: LedgerEventRow[]; acquired: UnitAcquiredPayload } | null> {
  const events = await listEventsByCausation(client, causationId);
  const hit = events.find((e) => e.event_type === "unit_acquired");
  if (!hit) return null;
  return { events, acquired: hit.payload as UnitAcquiredPayload };
}

async function readInstance(db: Queryable, caravanId: string, instanceId: string): Promise<UnitInstanceRow | null> {
  const res = await db.query<UnitInstanceRow>("SELECT * FROM unit_instance WHERE id = $1 AND caravan_id = $2", [instanceId, caravanId]);
  return res.rows[0] ?? null;
}

/**
 * Take one offer from menu `sequence` (required: the menu the client is looking at). A claim
 * against a menu that has since been replaced is refused (409 `menu_expired`) rather than
 * silently applied to the new one. An unclaimed menu is never expired by the timer alone
 * (QA D1): claiming it past the timer succeeds, and the due free menu is generated in the
 * same request.
 */
export async function claimRefugee(
  pool: pg.Pool,
  input: { accountId: string; caravanId: string; unitTypeId: unknown; sequence: unknown; nowMs?: number },
): Promise<ClaimResult> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const unitTypeId = normalizeUnitTypeId(input.unitTypeId);
  const sequence = normalizeSequence(input.sequence, "sequence");
  const nowMs = input.nowMs ?? Date.now();
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, true);
    const current = await requireCurrentMenu(client, caravanId);
    const causationId = claimCausationId(caravanId, sequence);
    const prior = await findAcquired(client, causationId);
    if (prior) {
      if (prior.acquired.unitTypeId !== unitTypeId) {
        throw conflict("menu_claimed", `menu ${sequence} was already claimed for '${prior.acquired.unitTypeId}'; one pick per menu`);
      }
      const trickle = await peekTrickle(client, input.accountId, nowMs);
      return {
        replayed: true,
        acquired: prior.acquired,
        instance: await readInstance(client, caravanId, prior.acquired.instanceId),
        events: prior.events,
        view: await buildView(client, owner, current, false, nowMs, trickle.balance, trickle.pending),
      };
    }
    if (sequence !== current.sequence) {
      throw conflict("menu_expired", `menu ${sequence} has been replaced by menu ${current.sequence}; read the current menu and pick again`);
    }
    if (current.claimed_type_id !== null) {
      throw conflict("menu_claimed", `menu ${sequence} was already claimed for '${current.claimed_type_id}'; one pick per menu`);
    }
    if (!current.offered_type_ids.includes(unitTypeId)) {
      throw badRequest("not_offered", `'${unitTypeId}' is not one of menu ${sequence}'s offers: ${current.offered_type_ids.join(", ")}`);
    }
    // The boundary: access is re-checked here against the ledger, never trusted from the row.
    const grant = await grantUnit(client, owner, unitTypeId, "refugee", 0, { menuSequence: sequence });
    const events = await appendEvents(client, causationId, [grant.draft]);
    const upd = await client.query(
      `UPDATE refugee_menu SET claimed_type_id = $3, claimed_instance_id = $4, claimed_at_ms = $5
       WHERE caravan_id = $1 AND sequence = $2 AND claimed_type_id IS NULL`,
      [caravanId, sequence, grant.unit.id, grant.instance.id, nowMs],
    );
    if (upd.rowCount !== 1) throw conflict("menu_claimed", `menu ${sequence} was claimed underneath this request`);
    // The claim takes the due free refresh (QA D1): the next menu arrives in this request.
    // Roster relief is read AFTER the grant: the claimed unit counts toward the floor (S1).
    // `current` was read before the claim's UPDATE: it is claimed now.
    const due = freeMenuOwed({ ...current, claimed_type_id: unitTypeId }, nowMs, await readRosterRelief(client, caravanId));
    const after = due ? await takeFreeRefresh(client, owner, current, nowMs) : (await readMenu(client, caravanId, sequence))!;
    const trickle = await peekTrickle(client, input.accountId, nowMs);
    return {
      replayed: false,
      acquired: grant.payload,
      instance: grant.instance,
      events,
      view: await buildView(client, owner, after, due, nowMs, trickle.balance, trickle.pending),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Refresh: take the free menu the timer owes (QA D1) — free, idempotent, explicit
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface RefreshResult {
  /** True when the menu after `fromSequence` was already a free one: the stored menu, nothing new. */
  replayed: boolean;
  fromSequence: number;
  produced: RefugeeMenuView;
  /** The offers of the unclaimed menu this refresh forfeited, or null when it was claimed (or on a replay). */
  forfeitedOffers: RefugeeOffer[] | null;
  view: RefugeeView;
}

/**
 * Take the due free refresh explicitly. `fromSequence` (required) is the current menu; if it
 * is unclaimed its offers are forfeited — knowingly, which is why this is a POST and not a
 * side effect of reading. Refused while the timer is not up (409 `free_refresh_not_due`).
 * A retry whose first attempt landed replays (200) because the menu after `fromSequence`
 * is then a free one; a reroll in that slot means the player did something else: 409
 * `stale_menu`.
 */
export async function refreshRefugees(
  pool: pg.Pool,
  input: { accountId: string; caravanId: string; fromSequence: unknown; nowMs?: number },
): Promise<RefreshResult> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const fromSequence = normalizeSequence(input.fromSequence, "fromSequence");
  const nowMs = input.nowMs ?? Date.now();
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, true);
    const current = await requireCurrentMenu(client, caravanId);
    const trickle = await peekTrickle(client, input.accountId, nowMs);
    if (fromSequence < current.sequence) {
      const next = await readMenu(client, caravanId, fromSequence + 1);
      if (next && next.origin === "free") {
        return {
          replayed: true,
          fromSequence,
          produced: menuView(next),
          forfeitedOffers: null,
          view: await buildView(client, owner, current, false, nowMs, trickle.balance, trickle.pending),
        };
      }
    }
    if (fromSequence !== current.sequence) {
      throw conflict("stale_menu", `fromSequence ${fromSequence} is not the current menu (${current.sequence}); read the current menu and decide again`);
    }
    const relief = await readRosterRelief(client, caravanId);
    if (!freeMenuOwed(current, nowMs, relief)) {
      if (relief.active) {
        throw conflict("free_refresh_not_due", `roster relief owes one free menu at a time: claim one of menu ${current.sequence}'s offers and the next free menu comes with it, or reroll for Coin to see another one first`);
      }
      throw conflict("free_refresh_not_due", `the next free menu opens at ${nextFreeRefreshAtMs(current)} (in ${nextFreeRefreshAtMs(current) - nowMs} ms); reroll for Coin to see one sooner`);
    }
    const forfeited = current.claimed_type_id === null ? menuView(current).offers : null;
    const produced = await takeFreeRefresh(client, owner, current, nowMs);
    return {
      replayed: false,
      fromSequence,
      produced: menuView(produced),
      forfeitedOffers: forfeited,
      view: await buildView(client, owner, produced, true, nowMs, trickle.balance, trickle.pending),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Reroll: Coin for a sooner menu — same pool, same draw, same timer
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface RerollResult {
  /** True when `fromSequence` named a reroll that had already committed: its stored menu, no charge. */
  replayed: boolean;
  fromSequence: number;
  /** The menu the reroll produced (the current menu unless a later one has replaced it). */
  produced: RefugeeMenuView;
  coinCost: number;
  events: LedgerEventRow[];
  balanceAfter: number;
  view: RefugeeView;
}

export async function rerollRefugees(
  pool: pg.Pool,
  input: { accountId: string; caravanId: string; fromSequence: unknown; nowMs?: number },
): Promise<RerollResult> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const fromSequence = normalizeSequence(input.fromSequence, "fromSequence");
  const nowMs = input.nowMs ?? Date.now();
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, true);
    const current = await requireCurrentMenu(client, caravanId);
    const causationId = rerollCausationId(caravanId, fromSequence);
    if (await causationExists(client, causationId)) {
      const events = await listEventsByCausation(client, causationId);
      const produced = await readMenu(client, caravanId, fromSequence + 1);
      if (!produced || produced.origin !== "reroll") {
        throw menuCorrupt(caravanId, `reroll ${causationId} committed but menu ${fromSequence + 1} is ${produced ? `a ${produced.origin} menu` : "missing"}`);
      }
      const trickle = await peekTrickle(client, input.accountId, nowMs);
      const coinCost = Number(events[0]?.payload["amount"] ?? 0);
      return {
        replayed: true,
        fromSequence,
        produced: menuView(produced),
        coinCost,
        events,
        balanceAfter: trickle.balance,
        view: await buildView(client, owner, current, false, nowMs, trickle.balance, trickle.pending),
      };
    }
    if (fromSequence !== current.sequence) {
      throw conflict("stale_menu", `fromSequence ${fromSequence} is not the current menu (${current.sequence}); read the current menu and decide again`);
    }
    // Coin is never charged for a menu the timer owes (nor one roster relief owes): take the free one first.
    if (freeMenuOwed(current, nowMs, await readRosterRelief(client, caravanId))) {
      throw conflict("free_refresh_due", `a free menu is due for menu ${current.sequence}; claim it or POST .../refugees/refresh instead of paying`);
    }
    const index = current.sequence - current.window_sequence;
    const cost = rerollCost(index);
    const toSequence = current.sequence + 1;
    const spend = await spendCoin(client, input.accountId, cost, "refugee_reroll", nowMs, {
      causationId,
      extra: { caravanId, fromSequence, toSequence, rerollIndex: index },
    });
    const produced = await insertMenu(client, owner, toSequence, "reroll", current.window_sequence, current.window_opened_at_ms, nowMs);
    return {
      replayed: false,
      fromSequence,
      produced: menuView(produced),
      coinCost: cost,
      events: spend.events,
      balanceAfter: spend.balanceAfter,
      view: await buildView(client, owner, produced, false, nowMs, spend.balanceAfter, 0),
    };
  });
}

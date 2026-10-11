/**
 * The refugee drip (chunk 18): the free, passive path to a level-1 unit.
 *
 * A MENU is exactly REFUGEE_OFFER_COUNT offers drawn from the caravan's unlocked living
 * pool (chunk 05's reached set — nothing else), stored in `refugee_menu` with its seed and
 * the pool it was drawn from. The player takes exactly ONE offer per menu; which one is
 * always their choice, and the pick yields exactly that type — no further randomness
 * (GUARDRAILS §1). Menus arrive two ways:
 *
 *   free    every REFUGEE_REFRESH_INTERVAL_MINUTES, lazily: the first read (or claim, or
 *           reroll) after the timer is up generates the next menu — one menu, however long
 *           the player was away (no stockpiling), and the timer restarts from that moment.
 *           A free refresh replaces the current menu whether or not it was claimed, and
 *           opens a new reroll window.
 *   reroll  Coin, through `spendCoin`, at REFUGEE_REROLL_COST_SCHEDULE[rerolls so far in
 *           this window]: a SOONER menu from the SAME pool and the same draw, nothing more.
 *           A reroll does not move the free timer, so it is purely additive, and the next
 *           free menu is always the same distance away whether or not the player paid.
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
 * `refugee_reroll:<caravan>:<from sequence>`; a retry that names `fromSequence` replays.
 */
import { TUNABLES, getUnitType } from "@caravan/content";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { RefugeeMenuRow, UnitInstanceRow } from "../db/types.js";
import type { LedgerEventRow } from "../ledger/events.js";
import { appendEvents, causationExists, listEventsByCausation, lockAccountForAppend } from "../ledger/ledger.js";
import { spendCoin } from "../economy/coin.js";
import { peekTrickle } from "../economy/trickle.js";
import { badRequest, conflict } from "../services/errors.js";
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
  nowMs: number,
): Promise<RefugeeMenuRow> {
  const pool = await unlockedLivingPool(client, owner);
  const draw = drawForSequence(owner.caravanId, sequence, pool);
  const res = await client.query<RefugeeMenuRow>(
    `INSERT INTO refugee_menu (caravan_id, sequence, origin, window_sequence, seed, pool_type_ids, offered_type_ids, generated_at_ms)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING *`,
    [owner.caravanId, sequence, origin, windowSequence, draw.seed, JSON.stringify(draw.pool), JSON.stringify(draw.offers), nowMs],
  );
  return res.rows[0]!;
}

interface CurrentMenu {
  menu: RefugeeMenuRow;
  /** The free menu that opened this reroll window (== `menu` when the current menu is free). */
  windowOpener: RefugeeMenuRow;
  /** True when this call generated a free menu. */
  refreshed: boolean;
}

/**
 * The menu as of `nowMs`: the stored current one, or a fresh free one if there is none yet
 * or the timer is up. Must run under the account append lock (it may write).
 */
async function ensureCurrentMenu(client: pg.PoolClient, owner: AccessOwner, nowMs: number): Promise<CurrentMenu> {
  const current = await readCurrentMenu(client, owner.caravanId);
  if (!current) {
    const menu = await insertMenu(client, owner, 1, "free", 1, nowMs);
    return { menu, windowOpener: menu, refreshed: true };
  }
  const opener = current.window_sequence === current.sequence ? current : await readMenu(client, owner.caravanId, current.window_sequence);
  if (!opener) throw new Error(`refugee menu ${owner.caravanId}#${current.window_sequence} (window opener) is missing`);
  if (nowMs >= opener.generated_at_ms + REFUGEE_REFRESH_INTERVAL_MS) {
    const next = current.sequence + 1;
    const menu = await insertMenu(client, owner, next, "free", next, nowMs);
    return { menu, windowOpener: menu, refreshed: true };
  }
  return { menu: current, windowOpener: opener, refreshed: false };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The view: everything the player commits against, before they commit (GUARDRAILS §4)
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface RefugeeOffer extends UnitTypeSummary {
  slot: number;
}

export interface RefugeeMenuView {
  sequence: number;
  origin: "free" | "reroll";
  /** How many Coin rerolls produced menus in this window before this one (0 = the free menu). */
  rerollsThisWindow: number;
  /** Replay inputs, stored: the seed and the exact pool the offers were drawn from. */
  seed: number;
  poolTypeIds: string[];
  offers: RefugeeOffer[];
  generatedAtMs: number;
  claimed: { unitTypeId: string; instanceId: string; claimedAtMs: number } | null;
}

export interface RefugeeView {
  caravanId: string;
  menu: RefugeeMenuView;
  timer: {
    intervalMs: number;
    /** When the free menu that opened this window was generated — the timer's anchor. Rerolls never move it. */
    windowOpenedAtMs: number;
    nextFreeRefreshAtMs: number;
    msUntilFreeRefresh: number;
    /** True when this read generated a fresh free menu. */
    refreshedNow: boolean;
  };
  reroll: {
    /** What the NEXT reroll costs right now. */
    nextCost: number;
    nextIndex: number;
    schedule: readonly number[];
    affordable: boolean;
    /** Rerolling replaces the current menu; if it is unclaimed, its offers are forfeited. */
    forfeitsUnclaimedOffer: boolean;
  };
  /** Ledger balance plus the pending trickle — what a spend right now is checked against. */
  balance: number;
  pendingTrickle: number;
  inventory: InventoryStatus;
}

function menuView(menu: RefugeeMenuRow): RefugeeMenuView {
  return {
    sequence: menu.sequence,
    origin: menu.origin,
    rerollsThisWindow: menu.sequence - menu.window_sequence,
    seed: menu.seed,
    poolTypeIds: menu.pool_type_ids,
    offers: menu.offered_type_ids.map((id, slot) => {
      const unit = getUnitType(id);
      if (!unit) throw new Error(`stored refugee offer '${id}' is not in content`);
      return { slot, ...summarizeUnit(unit) };
    }),
    generatedAtMs: menu.generated_at_ms,
    claimed:
      menu.claimed_type_id !== null && menu.claimed_instance_id !== null && menu.claimed_at_ms !== null
        ? { unitTypeId: menu.claimed_type_id, instanceId: menu.claimed_instance_id, claimedAtMs: menu.claimed_at_ms }
        : null,
  };
}

async function buildView(db: Queryable, owner: AccessOwner, cur: CurrentMenu, nowMs: number, balance: number, pendingTrickle: number): Promise<RefugeeView> {
  const nextIndex = cur.menu.sequence - cur.menu.window_sequence;
  const nextCost = rerollCost(nextIndex);
  const nextFreeRefreshAtMs = cur.windowOpener.generated_at_ms + REFUGEE_REFRESH_INTERVAL_MS;
  return {
    caravanId: owner.caravanId,
    menu: menuView(cur.menu),
    timer: {
      intervalMs: REFUGEE_REFRESH_INTERVAL_MS,
      windowOpenedAtMs: cur.windowOpener.generated_at_ms,
      nextFreeRefreshAtMs,
      msUntilFreeRefresh: Math.max(0, nextFreeRefreshAtMs - nowMs),
      refreshedNow: cur.refreshed,
    },
    reroll: {
      nextCost,
      nextIndex,
      schedule: TUNABLES.REFUGEE_REROLL_COST_SCHEDULE,
      affordable: balance >= nextCost,
      forfeitsUnclaimedOffer: cur.menu.claimed_type_id === null,
    },
    balance,
    pendingTrickle,
    inventory: await readInventory(db, owner.caravanId),
  };
}

/**
 * GET: the current menu (generating the free one if the timer is up), the timer, the next
 * reroll cost and the balance. Under the account lock because it may write a menu row.
 */
export async function viewRefugees(pool: pg.Pool, input: { accountId: string; caravanId: string; nowMs?: number }): Promise<RefugeeView> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const nowMs = input.nowMs ?? Date.now();
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, false);
    const cur = await ensureCurrentMenu(client, owner, nowMs);
    const trickle = await peekTrickle(client, input.accountId, nowMs);
    return buildView(client, owner, cur, nowMs, trickle.balance, trickle.pending);
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
 * Take one offer from the current menu. `sequence`, if given, must be the menu the client
 * is looking at: a claim against a menu that has since been replaced is refused (409
 * `menu_expired`) rather than silently applied to the new one.
 */
export async function claimRefugee(
  pool: pg.Pool,
  input: { accountId: string; caravanId: string; unitTypeId: unknown; sequence?: unknown; nowMs?: number },
): Promise<ClaimResult> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const unitTypeId = normalizeUnitTypeId(input.unitTypeId);
  const wanted = normalizeSequence(input.sequence, "sequence");
  const nowMs = input.nowMs ?? Date.now();
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, true);
    const cur = await ensureCurrentMenu(client, owner, nowMs);
    const sequence = wanted ?? cur.menu.sequence;
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
        view: await buildView(client, owner, cur, nowMs, trickle.balance, trickle.pending),
      };
    }
    if (sequence !== cur.menu.sequence) {
      throw conflict("menu_expired", `menu ${sequence} has been replaced by menu ${cur.menu.sequence}; read the current menu and pick again`);
    }
    if (cur.menu.claimed_type_id !== null) {
      throw conflict("menu_claimed", `menu ${sequence} was already claimed for '${cur.menu.claimed_type_id}'; one pick per menu`);
    }
    if (!cur.menu.offered_type_ids.includes(unitTypeId)) {
      throw badRequest("not_offered", `'${unitTypeId}' is not one of menu ${sequence}'s offers: ${cur.menu.offered_type_ids.join(", ")}`);
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
    const after = (await readMenu(client, caravanId, sequence))!;
    const trickle = await peekTrickle(client, input.accountId, nowMs);
    return {
      replayed: false,
      acquired: grant.payload,
      instance: grant.instance,
      events,
      view: await buildView(client, owner, { ...cur, menu: after }, nowMs, trickle.balance, trickle.pending),
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
  input: { accountId: string; caravanId: string; fromSequence?: unknown; nowMs?: number },
): Promise<RerollResult> {
  const caravanId = normalizeCaravanId(input.caravanId);
  const wantedFrom = normalizeSequence(input.fromSequence, "fromSequence");
  const nowMs = input.nowMs ?? Date.now();
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const owner = await readOwnedCaravan(client, input.accountId, caravanId, true);
    // A due free refresh happens first, for free: Coin is never charged for a menu the timer owed.
    const cur = await ensureCurrentMenu(client, owner, nowMs);
    const fromSequence = wantedFrom ?? cur.menu.sequence;
    const causationId = rerollCausationId(caravanId, fromSequence);
    if (await causationExists(client, causationId)) {
      const events = await listEventsByCausation(client, causationId);
      const produced = await readMenu(client, caravanId, fromSequence + 1);
      if (!produced) throw new Error(`reroll ${causationId} committed but menu ${fromSequence + 1} is missing`);
      const trickle = await peekTrickle(client, input.accountId, nowMs);
      const coinCost = Number(events[0]?.payload["amount"] ?? 0);
      return {
        replayed: true,
        fromSequence,
        produced: menuView(produced),
        coinCost,
        events,
        balanceAfter: trickle.balance,
        view: await buildView(client, owner, cur, nowMs, trickle.balance, trickle.pending),
      };
    }
    if (fromSequence !== cur.menu.sequence) {
      throw conflict("stale_menu", `fromSequence ${fromSequence} is not the current menu (${cur.menu.sequence}); read the current menu and decide again`);
    }
    const index = cur.menu.sequence - cur.menu.window_sequence;
    const cost = rerollCost(index);
    const toSequence = cur.menu.sequence + 1;
    const spend = await spendCoin(client, input.accountId, cost, "refugee_reroll", nowMs, {
      causationId,
      extra: { caravanId, fromSequence, toSequence, rerollIndex: index },
    });
    const produced = await insertMenu(client, owner, toSequence, "reroll", cur.menu.window_sequence, nowMs);
    const next: CurrentMenu = { menu: produced, windowOpener: cur.windowOpener, refreshed: cur.refreshed };
    return {
      replayed: false,
      fromSequence,
      produced: menuView(produced),
      coinCost: cost,
      events: spend.events,
      balanceAfter: spend.balanceAfter,
      view: await buildView(client, owner, next, nowMs, spend.balanceAfter, 0),
    };
  });
}

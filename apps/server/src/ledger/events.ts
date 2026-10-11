/**
 * Ledger event vocabulary. These shapes are the contract later chunks write through —
 * define them here once rather than letting each chunk invent its own.
 *
 * Scope rules (GUARDRAILS §5), mirrored by the CHECK constraint in migration 002:
 *   account : caravanId must be null   — Coin, the standing party, served-party feed
 *   caravan : caravanId required       — roster, trips, encounters, formations
 *   pool    : payload.pool decides     — living -> caravan, trap/siege -> account
 */
import type { Pool } from "../db/types.js";

export const LEDGER_EVENT_TYPES = [
  "coin_earned",
  "coin_spent",
  "coin_lost_on_wipe",
  "coin_transferred_to_defender",
  "coin_purchased",
  "reputation_changed",
  "ladder_progress_gained",
  "unlock_points_granted",
  "unlock_node_purchased",
  "unit_acquired",
  "unit_merged",
  "unit_demerged_on_death",
  "unit_lost_on_wipe",
  "trip_started",
  "stop_resolved",
  "trip_banked",
  "trip_overrun",
  "encounter_resolved",
  "formation_committed",
  "standing_party_saved",
  "party_served_as_encounter",
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export type LedgerScope = "account" | "caravan" | "pool";

export const LEDGER_EVENT_SCOPE: Readonly<Record<LedgerEventType, LedgerScope>> = {
  coin_earned: "account",
  coin_spent: "account",
  coin_lost_on_wipe: "caravan", // unbanked trip Coin that was never in the account balance
  coin_transferred_to_defender: "account",
  coin_purchased: "account",
  reputation_changed: "pool",
  ladder_progress_gained: "pool",
  unlock_points_granted: "pool",
  unlock_node_purchased: "pool",
  unit_acquired: "caravan",
  unit_merged: "caravan",
  unit_demerged_on_death: "caravan",
  unit_lost_on_wipe: "caravan",
  trip_started: "caravan",
  stop_resolved: "caravan",
  trip_banked: "caravan",
  trip_overrun: "caravan",
  encounter_resolved: "caravan",
  formation_committed: "caravan",
  standing_party_saved: "account",
  party_served_as_encounter: "account",
};

/** Events that record a resolution. They must carry the resolver version. */
export const RESOLUTION_EVENT_TYPES: ReadonlySet<LedgerEventType> = new Set<LedgerEventType>([
  "encounter_resolved",
  "stop_resolved",
  "party_served_as_encounter",
]);

/** Event types whose fold moves account.coin_balance. */
export const COIN_CREDIT_TYPES: ReadonlySet<LedgerEventType> = new Set<LedgerEventType>([
  "coin_earned",
  "coin_purchased",
  "coin_transferred_to_defender",
]);
export const COIN_DEBIT_TYPES: ReadonlySet<LedgerEventType> = new Set<LedgerEventType>(["coin_spent"]);

// ---------------------------------------------------------------------------------------
// Payload shapes. Every value must be plain JSON; every number an integer.
// ---------------------------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** `amount` is the amount actually applied to the balance (already clamped to the storage
 *  cap by the writer); `overflowDiscarded` records what the cap swallowed, if anything. */
export interface CoinPayload extends JsonObject {
  amount: number;
  reason: string;
  overflowDiscarded?: number;
}

export interface PoolPayload extends JsonObject {
  pool: Pool;
}

export interface ReputationChangedPayload extends PoolPayload {
  delta: number;
  reason: string;
}

export interface LadderProgressGainedPayload extends PoolPayload {
  /**
   * Change to ladder_points, >= 0. Points are CUMULATIVE (chunk 04): nothing resets on a
   * rung crossing, so every delta is non-negative and the DB refuses anything else
   * (migration 003).
   */
  pointsDelta: number;
  /** Rungs crossed by this event, 0..LADDER_RUNGS_PER_POOL. Ladder level never decreases. */
  levelsGained: number;
}

export interface UnlockPointsGrantedPayload extends PoolPayload {
  /** > 0; there is no negative grant and no revoke. */
  points: number;
  /** The rung this grant pays out, 1..LADDER_RUNGS_PER_POOL. Mandatory: one grant per rung, ever (unique index). */
  rung: number;
}

export interface UnlockNodePurchasedPayload extends PoolPayload {
  nodeId: string;
  cost: number;
}

/** A draft event as produced by a job handler or a request-driven writer. */
export interface LedgerEventDraft {
  type: LedgerEventType;
  accountId: string;
  caravanId?: string | null;
  resolverVersion?: number | null;
  payload: JsonObject;
}

export interface LedgerEventRow {
  seq: number;
  event_type: LedgerEventType;
  account_id: string;
  caravan_id: string | null;
  causation_id: string;
  causation_seq: number;
  resolver_version: number | null;
  payload: JsonObject;
  occurred_at: Date;
}

/**
 * The deterministic part of a stored event: everything except the global seq and the
 * wall-clock stamp. "Two resolutions of the same job must produce the same event stream"
 * is asserted over this shape.
 */
export interface LedgerEventIdentity {
  type: LedgerEventType;
  accountId: string;
  caravanId: string | null;
  causationId: string;
  causationSeq: number;
  resolverVersion: number | null;
  payload: JsonObject;
}

export function eventIdentity(row: LedgerEventRow): LedgerEventIdentity {
  return {
    type: row.event_type,
    accountId: row.account_id,
    caravanId: row.caravan_id,
    causationId: row.causation_id,
    causationSeq: row.causation_seq,
    resolverVersion: row.resolver_version,
    payload: row.payload,
  };
}

/** JSON with object keys sorted recursively, so equal values stringify identically. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new TypeError(`ledger payloads must be integers; got ${value}`);
  }
  return JSON.stringify(value);
}

function isPool(v: unknown): v is Pool {
  return v === "living" || v === "trap" || v === "siege";
}

/**
 * Validate a draft against the scope rules before it reaches the database, so a wrong-
 * scope event fails with a readable message rather than a CHECK violation. The CHECK
 * still fires for anything that bypasses this.
 */
export function validateDraft(draft: LedgerEventDraft): void {
  if (!LEDGER_EVENT_TYPES.includes(draft.type)) throw new TypeError(`unknown ledger event type '${draft.type}'`);
  const scope = LEDGER_EVENT_SCOPE[draft.type];
  const caravanId = draft.caravanId ?? null;
  const fail = (why: string): never => {
    throw new TypeError(`ledger event '${draft.type}' ${why}`);
  };
  if (scope === "account" && caravanId !== null) fail("is account-level and must not carry a caravan id");
  if (scope === "caravan" && caravanId === null) fail("is caravan-level and requires a caravan id");
  if (scope === "pool") {
    const pool = draft.payload["pool"];
    if (!isPool(pool)) fail("requires payload.pool of living|trap|siege");
    if (pool === "living" && caravanId === null) fail("for the living pool requires a caravan id (caravan-level progress)");
    if (pool !== "living" && caravanId !== null) fail(`for the ${pool} pool must not carry a caravan id (account-level progress)`);
  }
  if (RESOLUTION_EVENT_TYPES.has(draft.type) && typeof draft.resolverVersion !== "number") {
    fail("is a resolution event and requires resolverVersion");
  }
  if (COIN_CREDIT_TYPES.has(draft.type) || COIN_DEBIT_TYPES.has(draft.type) || draft.type === "coin_lost_on_wipe") {
    const amount = draft.payload["amount"];
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
      fail("requires a non-negative integer payload.amount");
    }
  }
  canonicalJson(draft.payload); // throws on non-integer numbers
}

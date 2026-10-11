import type { RegionId } from "@caravan/content";

export type Pool = "living" | "trap" | "siege";
export type CaravanState = "in_town" | "on_trip";

export interface AccountRow {
  id: string;
  /** Chunk 30: null for a guest (and the erasure tombstone); set once, by linking. */
  username: string | null;
  /** Chunk 30: null exactly when username is. */
  password_hash: string | null;
  coin_balance: number;
  coin_storage_cap: number;
  created_at: Date;
  /** Chunk 14/25: a non-player owner of authored cold-start parties. Never logs in, never holds Coin. */
  is_system: boolean;
  /** Chunk 30: when the guest linked a username + password (registration counts as linked at creation). */
  linked_at: Date | null;
}

/** Chunk 30: an account with a login (registered, or a guest that linked one). */
export type LinkedAccountRow = AccountRow & { username: string; password_hash: string };

export interface CaravanRow {
  id: string;
  account_id: string;
  region_id: RegionId;
  name: string;
  state: CaravanState;
  created_at: Date;
}

export interface PoolProgressRow {
  id: string;
  pool: Pool;
  account_id: string | null;
  caravan_id: string | null;
  reputation: number;
  ladder_level: number;
  ladder_points: number;
  unlock_points_granted: number;
  unlock_points_spent: number;
  created_at: Date;
  updated_at: Date;
}

export interface UnitInstanceRow {
  id: string;
  caravan_id: string;
  unit_type_id: string;
  merge_level: number;
  created_at: Date;
}

/** Chunk 18: one refugee menu (see migration 007). jsonb columns come back parsed. */
export interface RefugeeMenuRow {
  caravan_id: string;
  sequence: number;
  origin: "free" | "reroll";
  window_sequence: number;
  seed: number;
  pool_type_ids: string[];
  offered_type_ids: string[];
  generated_at_ms: number;
  /** The free-timer grid point this menu's window belongs to (QA D2); the next free window opens one interval later. */
  window_opened_at_ms: number;
  claimed_type_id: string | null;
  claimed_instance_id: string | null;
  claimed_at_ms: number | null;
  created_at: Date;
}

export interface SessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  /** Chunk 30: the device this bearer session was issued to (migration 019). */
  device_id: string;
}

/** Public shape of an account (never includes the password hash). */
export interface AccountPublic {
  id: string;
  /** Chunk 30: null for a guest. */
  username: string | null;
  /** Chunk 30: true until a username + password is linked. */
  guest: boolean;
  coinBalance: number;
  coinStorageCap: number;
  createdAt: string;
}

export function toAccountPublic(row: AccountRow): AccountPublic {
  return {
    id: row.id,
    username: row.username,
    guest: row.username === null,
    coinBalance: row.coin_balance,
    coinStorageCap: row.coin_storage_cap,
    createdAt: row.created_at.toISOString(),
  };
}

// ---- chunk 02 -------------------------------------------------------------------------
export type JobStatus = "queued" | "leased" | "completed" | "parked";

export interface ResolutionJobRow {
  id: string;
  kind: string;
  account_id: string;
  caravan_id: string;
  input: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  leased_by: string | null;
  lease_expires_at: Date | null;
  /** A queued job is ready only once this has passed (retry backoff, QA-02 N3). */
  next_attempt_at: Date;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  completed_at: Date | null;
  /** Operator requeue audit (QA-02 R2-S3): written only by resolution_job_requeue(). */
  requeued_at: Date | null;
  requeued_by: string | null;
  requeue_count: number;
}

export interface StandingPartyRow {
  /** Chunk 09: the party's own id; `(account_id, slot)` is unique and v1 uses slot 0 only. */
  id: string;
  account_id: string;
  slot: number;
  /** @caravan/circle PartyConfig in canonical form (the owner's choices; no stats, no HP). */
  composition: Record<string, unknown>;
  /** Chunk 09 QA S4: composition changes so far; the save event's causation counter. */
  save_seq: number;
  created_at: Date;
  /** Moves exactly when `composition` does (trigger); the job snapshot records it as `savedAt`. */
  updated_at: Date;
}

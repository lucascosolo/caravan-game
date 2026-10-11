import type { RegionId } from "@caravan/content";

export type Pool = "living" | "trap" | "siege";
export type CaravanState = "in_town" | "on_trip";

export interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  coin_balance: number;
  coin_storage_cap: number;
  created_at: Date;
}

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

export interface SessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
}

/** Public shape of an account (never includes the password hash). */
export interface AccountPublic {
  id: string;
  username: string;
  coinBalance: number;
  coinStorageCap: number;
  createdAt: string;
}

export function toAccountPublic(row: AccountRow): AccountPublic {
  return {
    id: row.id,
    username: row.username,
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
}

export interface StandingPartyRow {
  account_id: string;
  created_at: Date;
  updated_at: Date;
}

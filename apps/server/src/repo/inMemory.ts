import type { UnlockedAccess } from "@caravan/content";
import type { UnitInstance } from "../domain/account.js";
import type { StandingParty } from "../domain/standingParty.js";
import type { Replay, ResolutionRecord } from "../domain/replay.js";

/**
 * In-memory repositories standing in for chunk 01's Postgres layer. Each
 * store holds immutable rows — `save` always replaces the whole entry, never
 * mutates a returned object in place — so a caller who already holds a
 * reference (an in-flight resolution, a stored snapshot) is never affected by
 * a later `save`. Swapping these for real Postgres-backed implementations
 * later should not require changing any caller, since the interfaces are the
 * contract.
 */

export interface StandingPartyRepository {
  get(id: string): StandingParty | undefined;
  save(party: StandingParty): void;
  listByAccount(accountId: string): readonly StandingParty[];
}

export class InMemoryStandingPartyRepository implements StandingPartyRepository {
  private rows = new Map<string, StandingParty>();

  get(id: string): StandingParty | undefined {
    return this.rows.get(id);
  }

  save(party: StandingParty): void {
    this.rows.set(party.id, party);
  }

  listByAccount(accountId: string): readonly StandingParty[] {
    return [...this.rows.values()].filter((p) => p.accountId === accountId);
  }
}

export interface UnitInstanceRepository {
  get(id: string): UnitInstance | undefined;
  listByCaravan(caravanId: string): readonly UnitInstance[];
  save(instance: UnitInstance): void;
}

export class InMemoryUnitInstanceRepository implements UnitInstanceRepository {
  private rows = new Map<string, UnitInstance>();

  get(id: string): UnitInstance | undefined {
    return this.rows.get(id);
  }

  listByCaravan(caravanId: string): readonly UnitInstance[] {
    return [...this.rows.values()].filter((u) => u.caravanId === caravanId);
  }

  save(instance: UnitInstance): void {
    this.rows.set(instance.id, instance);
  }
}

export interface ReplayRepository {
  get(id: string): Replay | undefined;
  save(replay: Replay): void;
}

export class InMemoryReplayRepository implements ReplayRepository {
  private rows = new Map<string, Replay>();

  get(id: string): Replay | undefined {
    return this.rows.get(id);
  }

  save(replay: Replay): void {
    if (this.rows.has(replay.id)) {
      throw new Error(`Replay ${replay.id} already exists — replays are append-only and never overwritten`);
    }
    this.rows.set(replay.id, replay);
  }
}

export interface ResolutionRecordRepository {
  save(record: ResolutionRecord): void;
  listByParty(partyId: string): readonly ResolutionRecord[];
}

export class InMemoryResolutionRecordRepository implements ResolutionRecordRepository {
  private rows: ResolutionRecord[] = [];

  save(record: ResolutionRecord): void {
    this.rows.push(record);
  }

  listByParty(partyId: string): readonly ResolutionRecord[] {
    return this.rows.filter((r) => r.partyId === partyId);
  }
}

export interface AccessRepository {
  getForAccount(accountId: string): UnlockedAccess;
}

/** Fixed grant, standing in for chunk 05's ladder-funded unlock spend. */
export class InMemoryAccessRepository implements AccessRepository {
  private rows = new Map<string, UnlockedAccess>();

  grant(accountId: string, access: UnlockedAccess): void {
    this.rows.set(accountId, access);
  }

  getForAccount(accountId: string): UnlockedAccess {
    return (
      this.rows.get(accountId) ?? {
        livingUnitTypeIds: new Set(),
        siegeTypeIds: new Set(),
        trapTypeIds: new Set(),
      }
    );
  }
}

import { TUNABLES, type ApproachEdge, type Stance } from "@caravan/content";
import { resolveEncounter, type DefendingSideInput } from "@caravan/resolver";
import type { IdGenerator } from "../domain/ids.js";
import {
  addSiegeSlot,
  addUnitSlot,
  createEmptyParty,
  removeSiegeSlot,
  removeUnitSlot,
  setUnitStance,
  snapshotParty,
  toPartyView,
  validateParty,
  type LatticeCell,
  type PartyView,
  type StandingParty,
} from "../domain/standingParty.js";
import type { Replay, ResolutionRecord } from "../domain/replay.js";
import type {
  AccessRepository,
  ReplayRepository,
  ResolutionRecordRepository,
  StandingPartyRepository,
  UnitInstanceRepository,
} from "../repo/inMemory.js";

export class TooManyPartiesError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} already has PARTIES_PER_ACCOUNT (${TUNABLES.PARTIES_PER_ACCOUNT}) standing parties`);
    this.name = "TooManyPartiesError";
  }
}

export class PartyNotFoundError extends Error {
  constructor(partyId: string) {
    super(`Standing party ${partyId} not found`);
    this.name = "PartyNotFoundError";
  }
}

export interface ServeEncounterInput {
  readonly partyId: string;
  readonly tripId: string;
  readonly defendingSide: DefendingSideInput;
  /** Injected rather than read from Date.now() internally, keeping this
   * service's own tests deterministic and matching the resolver's own
   * "no wall-clock reads" discipline one layer up. */
  readonly takenAt: string;
}

export interface ServeEncounterOutput {
  readonly record: ResolutionRecord;
  readonly replay: Replay;
}

/**
 * Orchestrates the standing raid party: builder edits, server-side
 * validation, and serving the party into an encounter. The one invariant
 * every method here must uphold (chunk 09 criterion 2, GUARDRAILS.md #0): no
 * method in this class ever writes to `unitRepo`. Serving a party into
 * dozens of resolutions, including losses, must never touch the owner's
 * roster — that is the entire "template, not expedition" guarantee.
 */
export class StandingPartyService {
  constructor(
    private readonly partyRepo: StandingPartyRepository,
    private readonly unitRepo: UnitInstanceRepository,
    private readonly replayRepo: ReplayRepository,
    private readonly resolutionRepo: ResolutionRecordRepository,
    private readonly accessRepo: AccessRepository,
    private readonly idGen: IdGenerator,
  ) {}

  private requireParty(partyId: string): StandingParty {
    const party = this.partyRepo.get(partyId);
    if (!party) throw new PartyNotFoundError(partyId);
    return party;
  }

  private unitInstancesForParty(party: StandingParty): Map<string, ReturnType<UnitInstanceRepository["get"]>> {
    const map = new Map<string, ReturnType<UnitInstanceRepository["get"]>>();
    for (const slot of party.unitSlots) {
      map.set(slot.unitInstanceId, this.unitRepo.get(slot.unitInstanceId));
    }
    return map;
  }

  private validateAgainstAccount(party: StandingParty, ownedCaravanIds: ReadonlySet<string>): void {
    const unitInstancesById = new Map<string, NonNullable<ReturnType<UnitInstanceRepository["get"]>>>();
    for (const slot of party.unitSlots) {
      const instance = this.unitRepo.get(slot.unitInstanceId);
      if (instance) unitInstancesById.set(slot.unitInstanceId, instance);
    }
    const access = this.accessRepo.getForAccount(party.accountId);
    validateParty(party, { unitInstancesById, ownedCaravanIds, access });
  }

  createParty(accountId: string): StandingParty {
    const existing = this.partyRepo.listByAccount(accountId);
    if (existing.length >= TUNABLES.PARTIES_PER_ACCOUNT) {
      throw new TooManyPartiesError(accountId);
    }
    const party = createEmptyParty(this.idGen.next("party"), accountId);
    this.partyRepo.save(party);
    return party;
  }

  addUnit(
    partyId: string,
    ownedCaravanIds: ReadonlySet<string>,
    input: { unitInstanceId: string; stance: Stance; edge: ApproachEdge; startPosition: LatticeCell },
  ): StandingParty {
    const party = this.requireParty(partyId);
    const updated = addUnitSlot(party, input);
    this.validateAgainstAccount(updated, ownedCaravanIds);
    this.partyRepo.save(updated);
    return updated;
  }

  addSiege(
    partyId: string,
    ownedCaravanIds: ReadonlySet<string>,
    input: { siegeTypeId: string; edge: ApproachEdge; startPosition: LatticeCell },
  ): StandingParty {
    const party = this.requireParty(partyId);
    const updated = addSiegeSlot(party, input);
    this.validateAgainstAccount(updated, ownedCaravanIds);
    this.partyRepo.save(updated);
    return updated;
  }

  removeUnit(partyId: string, slotIndex: number): StandingParty {
    const party = this.requireParty(partyId);
    const updated = removeUnitSlot(party, slotIndex);
    this.partyRepo.save(updated);
    return updated;
  }

  removeSiege(partyId: string, slotIndex: number): StandingParty {
    const party = this.requireParty(partyId);
    const updated = removeSiegeSlot(party, slotIndex);
    this.partyRepo.save(updated);
    return updated;
  }

  setStance(partyId: string, slotIndex: number, stance: Stance): StandingParty {
    const party = this.requireParty(partyId);
    const updated = setUnitStance(party, slotIndex, stance);
    this.partyRepo.save(updated);
    return updated;
  }

  /** The builder's own view of the party it owns. */
  getPartyView(partyId: string): PartyView {
    const party = this.requireParty(partyId);
    const unitInstancesById = new Map<string, NonNullable<ReturnType<UnitInstanceRepository["get"]>>>();
    for (const slot of party.unitSlots) {
      const instance = this.unitRepo.get(slot.unitInstanceId);
      if (instance) unitInstancesById.set(slot.unitInstanceId, instance);
    }
    return toPartyView(party, unitInstancesById);
  }

  /**
   * What a caravan player sees when scouting this party before arranging
   * their circle. Deliberately just calls `getPartyView` — see that
   * function's doc comment on why sharing one code path is load-bearing here.
   */
  getScoutingView(partyId: string): PartyView {
    return this.getPartyView(partyId);
  }

  /**
   * Serves the party into one encounter. Snapshots the party at this exact
   * instant, resolves it, and stores an immutable replay + results-feed row.
   * Never reads or writes anything that could change the owner's roster —
   * that omission is the whole guarantee (chunk 09 criterion 2).
   */
  serveEncounter(input: ServeEncounterInput): ServeEncounterOutput {
    const party = this.requireParty(input.partyId);
    const unitInstancesById = new Map<string, NonNullable<ReturnType<UnitInstanceRepository["get"]>>>();
    for (const slot of party.unitSlots) {
      const instance = this.unitRepo.get(slot.unitInstanceId);
      if (instance) unitInstancesById.set(slot.unitInstanceId, instance);
    }

    const snapshot = snapshotParty(party, unitInstancesById, input.takenAt);

    const result = resolveEncounter({
      attackingParty: {
        partyId: snapshot.partyId,
        snapshotVersion: snapshot.partyVersionAtSnapshot,
        units: snapshot.units,
        siege: snapshot.siege.map((s) => ({
          slotIndex: s.slotIndex,
          typeId: s.siegeTypeId,
          countersFenceCategory: s.countersFenceCategory,
          countersTrapCategory: s.countersTrapCategory,
          edge: s.edge,
          startPosition: s.startPosition,
        })),
      },
      defendingSide: input.defendingSide,
    });

    const replay: Replay = {
      id: this.idGen.next("replay"),
      tripId: input.tripId,
      partySnapshot: snapshot,
      resolverVersion: result.resolverVersion,
      outcome: result.outcome,
      depthFractionMilli: result.depthFractionMilli,
      tickLog: result.tickLog,
      createdAt: input.takenAt,
    };
    this.replayRepo.save(replay);

    const record: ResolutionRecord = {
      id: this.idGen.next("resolution"),
      partyId: party.id,
      partyVersionAtServe: party.version,
      tripId: input.tripId,
      outcome: result.outcome,
      brokeCaravan: result.outcome === "overrun",
      replayId: replay.id,
      servedAt: input.takenAt,
    };
    this.resolutionRepo.save(record);

    return { record, replay };
  }

  getResultsFeed(partyId: string): readonly ResolutionRecord[] {
    return this.resolutionRepo.listByParty(partyId);
  }

  getReplay(replayId: string): Replay | undefined {
    return this.replayRepo.get(replayId);
  }
}

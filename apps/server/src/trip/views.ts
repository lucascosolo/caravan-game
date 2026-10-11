/**
 * Read-model projections for the trip client flow (chunk 23). PURE: they turn rows the trip
 * loop already stores into what the client renders, so the client never derives a game fact
 * (apps/web README §4) — not what an encounter cost, not what a trip delivered.
 *
 *   encounterResultOf  one SETTLED encounter's attrition, from its resolution job: the
 *                      survivors it was committed against (job input) and the outcome the
 *                      resolver recorded (job result). Units killed / damaged, traps spent,
 *                      fences broken / damaged — exactly the fight's own delta.
 *   endingOfBanked     the delivery as the `trip_banked` event recorded it.
 *   endingOfOverrun    the collapse as the `trip_overrun` event recorded it, WITHOUT the
 *                      party owner's account id (chunk 14 N4: no owner id reaches a client).
 *
 * Nothing here decides anything; a projection of a malformed row returns null rather than
 * guessing.
 */
import { TUNABLES } from "@caravan/content";
import type { ResolutionJobRow } from "../db/types.js";
import type { JsonObject } from "../ledger/events.js";
import { assertTripEncounterOutcome, resolverInputFromJob } from "./outcome.js";

export interface EncounterResultView extends JsonObject {
  /** The resolution job: the replay (chunk 22) is keyed by it. */
  jobId: string;
  unitsKilled: { ref: string; typeId: string; mergeLevel: number; hpBefore: number; maxHp: number }[];
  unitsDamaged: { ref: string; typeId: string; mergeLevel: number; hpBefore: number; hpAfter: number; maxHp: number }[];
  /** Posted units that came through untouched. */
  unitsUnhurt: { ref: string; typeId: string; mergeLevel: number; hp: number; maxHp: number }[];
  trapsSpent: { ref: string; typeId: string }[];
  /** Laid traps that did not fire: still armed. */
  trapsUnfired: { ref: string; typeId: string }[];
  fencesBroken: { ref: string; tierId: string; maxHp: number }[];
  fencesDamaged: { ref: string; tierId: string; hpBefore: number; hpAfter: number; maxHp: number }[];
}

/** The fight's own delta: before = the survivors the formation was committed with; after = the outcome. */
export function encounterResultOf(job: ResolutionJobRow | null): EncounterResultView | null {
  if (!job || job.status !== "completed") return null;
  const outcome = (job.result as { outcome?: unknown } | null)?.outcome;
  try {
    assertTripEncounterOutcome(outcome);
    const { survivors, formation } = resolverInputFromJob(job.input as Record<string, unknown>);
    const unit = new Map(survivors.units.map((u) => [u.ref, u]));
    const trap = new Map(survivors.traps.map((t) => [t.ref, t]));
    const fence = new Map(survivors.fences.map((f) => [f.ref, f]));
    const view: EncounterResultView = { jobId: job.id, unitsKilled: [], unitsDamaged: [], unitsUnhurt: [], trapsSpent: [], trapsUnfired: [], fencesBroken: [], fencesDamaged: [] };
    for (const o of outcome.units) {
      const u = unit.get(o.ref);
      if (!u) return null;
      if (o.hp === 0 && u.hp > 0) view.unitsKilled.push({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, hpBefore: u.hp, maxHp: u.maxHp });
      else if (o.hp < u.hp) view.unitsDamaged.push({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, hpBefore: u.hp, hpAfter: o.hp, maxHp: u.maxHp });
      else view.unitsUnhurt.push({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, hp: u.hp, maxHp: u.maxHp });
    }
    const spent = new Set(outcome.spentTraps);
    for (const t of formation.traps) {
      const s = trap.get(t.ref);
      if (!s) return null;
      (spent.has(t.ref) ? view.trapsSpent : view.trapsUnfired).push({ ref: s.ref, typeId: s.typeId });
    }
    for (const o of outcome.fences) {
      const f = fence.get(o.ref);
      if (!f) return null;
      if (o.hp === 0 && f.hp > 0) view.fencesBroken.push({ ref: f.ref, tierId: f.tierId, maxHp: f.maxHp });
      else if (o.hp < f.hp) view.fencesDamaged.push({ ref: f.ref, tierId: f.tierId, hpBefore: f.hp, hpAfter: o.hp, maxHp: f.maxHp });
    }
    return view;
  } catch {
    return null;
  }
}

export interface BankedEndingView extends JsonObject {
  kind: "banked";
  encountersSurvived: number;
  /** The encounters' Coin, carried unbanked until now. */
  unbankedCoin: number;
  deliveryBonus: number;
  /** unbankedCoin + deliveryBonus: what the bank asked to credit. */
  requested: number;
  credited: number;
  /** Past the storage cap: discarded (chunk 16 COIN_OVERFLOW_BEHAVIOR). */
  discarded: number;
  restored: JsonObject;
}

export interface OverrunEndingView extends JsonObject {
  kind: "overrun";
  /** The encounter at which the caravan fell. */
  encounterIndex: number;
  /** The trip's unbanked Coin: never credited. */
  coinLost: number;
  /** Alive when the caravan fell: lost outright. */
  unitsLostOutright: { ref: string; typeId: string; mergeLevel: number }[];
  /** Died on the trip: de-merged one level (floored), not destroyed. */
  unitsDeMerged: { ref: string; typeId: string; mergeLevel: number; mergeLevelAfter: number; diedAtEncounter: number }[];
  /** Whether the losses above have been applied to the roster (chunk 19). */
  lossesApplied: boolean;
}

export type TripEndingView = BankedEndingView | OverrunEndingView;

const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

export function endingOfBanked(payload: Record<string, unknown>): BankedEndingView {
  const restored = payload["restored"];
  return {
    kind: "banked",
    encountersSurvived: int(payload["encountersSurvived"]),
    unbankedCoin: int(payload["unbankedCoin"]),
    deliveryBonus: int(payload["deliveryBonus"]),
    requested: int(payload["requested"]),
    credited: int(payload["credited"]),
    discarded: int(payload["discarded"]),
    restored: restored && typeof restored === "object" && !Array.isArray(restored) ? (restored as JsonObject) : {},
  };
}

export function endingOfOverrun(payload: Record<string, unknown>): OverrunEndingView {
  const floor = TUNABLES.MERGE_LEVEL_MIN;
  return {
    kind: "overrun",
    encounterIndex: int(payload["encounterIndex"]),
    coinLost: int(payload["unbankedCoin"]),
    unitsLostOutright: list(payload["unitsAliveAtCollapse"]).map((u) => ({ ref: str(u["ref"]), typeId: str(u["typeId"]), mergeLevel: int(u["mergeLevel"]) })),
    unitsDeMerged: list(payload["unitsDiedOnTrip"]).map((u) => ({
      ref: str(u["ref"]),
      typeId: str(u["typeId"]),
      mergeLevel: int(u["mergeLevel"]),
      // Chunk 19 may record the level it applied; until then the rule (one level, floored).
      mergeLevelAfter: typeof u["mergeLevelAfter"] === "number" ? int(u["mergeLevelAfter"]) : Math.max(floor, int(u["mergeLevel"]) - 1),
      diedAtEncounter: int(u["diedAtEncounter"]),
    })),
    lossesApplied: payload["lossesApplied"] === true,
  };
}

/**
 * Trip fixtures for component tests (chunk 23): the REAL server bodies the contract test
 * recorded (src/test/contract/trip-*.json, chunk 15's routes driven by its test double), run
 * through the client's own guards, plus small editors over them. So a component test renders
 * exactly what the server sends, and drifts with it.
 */
import { expectShape } from "../api/shape.ts";
import { bankResultShape, stakesPreviewShape, tripCapRefusalShape, tripStatusShape } from "../api/tripShapes.ts";
import type { BankResult, StakesPreview, TripCapRefusal, TripCapView, TripStatusView, TripView } from "../api/tripTypes.ts";
import { ApiError } from "../api/client.ts";
import decideJson from "./contract/trip-status-decide.json";
import resolvingJson from "./contract/trip-status-resolving.json";
import packedJson from "./contract/trip-status-packed.json";
import bankedJson from "./contract/trip-status-banked.json";
import overrunJson from "./contract/trip-status-overrun.json";
import voidedJson from "./contract/trip-status-voided.json";
import previewStartJson from "./contract/trip-preview-start.json";
import previewJson from "./contract/trip-preview.json";
import preview2Json from "./contract/trip-preview-2.json";
import refusedJson from "./contract/trip-start-refused.json";
import bankJson from "./contract/trip-bank.json";

export const statusDecide = (): TripStatusView => expectShape(tripStatusShape, decideJson.body);
export const statusResolving = (): TripStatusView => expectShape(tripStatusShape, resolvingJson.body);
export const statusPacked = (): TripStatusView => expectShape(tripStatusShape, packedJson.body);
export const statusBanked = (): TripStatusView => expectShape(tripStatusShape, bankedJson.body);
export const statusOverrun = (): TripStatusView => expectShape(tripStatusShape, overrunJson.body);
/**
 * Chunk 15 QA D3: a trip whose encounter 2 could not be resolved (its job parked): voided, banked
 * as of encounter 1 (Coin + delivery credited, the level-2 rider that died there de-merged 2 → 1).
 */
export const statusVoided = (): TripStatusView => expectShape(tripStatusShape, voidedJson.body);
/** The raw recorded voided body (for guard tests that edit it). */
export const voidedRaw = (): Record<string, any> => structuredClone(voidedJson.body) as Record<string, any>;
/** Chunk 15 QA N2: the preview right after riding out, before any survival: no `bankNow`, no `harderThanThisEncounter`. */
export const previewAtStart = (): StakesPreview => expectShape(stakesPreviewShape, previewStartJson.body);
export const previewAfter1 = (): StakesPreview => expectShape(stakesPreviewShape, previewJson.body);
/**
 * After encounter 2 of the recorded trip: the caravan HELD but its level-3 veteran died there
 * (chunk 23 QA S4), so `bankNow.unitsDeMerged` and `ifOverrun.unitsDeMergedNotDestroyed` list it.
 */
export const previewAfter2 = (): StakesPreview => expectShape(stakesPreviewShape, preview2Json.body);
/** The bank of that trip at encounter 2: `restored.deMerged` lists the veteran, 3 → 2. */
export const bankAfter2 = (): BankResult => expectShape(bankResultShape, bankJson.body);
/**
 * Edit a RECORDED body before it goes through the guard (never hand-build a server shape: a
 * hand-built one is how chunk 23's S1/S2 drift passed CI). `edit` gets a deep copy.
 */
export function previewFromRecorded(which: 1 | 2, edit: (raw: Record<string, any>) => void = () => undefined): StakesPreview {
  const raw = structuredClone((which === 1 ? previewJson : preview2Json).body) as Record<string, any>;
  edit(raw);
  return expectShape(stakesPreviewShape, raw);
}
export const capRefusalBody = (): TripCapRefusal & { error: string; message: string } => ({ ...expectShape(tripCapRefusalShape, refusedJson.body), error: refusedJson.body.error, message: refusedJson.body.message });

export function capRefused(): ApiError {
  const b = capRefusalBody();
  return new ApiError(409, "trip_cap_exhausted", b.message, undefined, [], b as unknown as Record<string, unknown>);
}

/** A status with the cap replaced (the server's clock stays `nowMs`). */
export function withCap(s: TripStatusView, cap: Partial<TripCapView>): TripStatusView {
  return { ...s, cap: { ...s.cap, ...cap } };
}

/** A status with the trip edited. */
export function withTrip(s: TripStatusView, trip: Partial<TripView> | null): TripStatusView {
  return { ...s, trip: trip === null ? null : { ...s.trip!, ...trip } };
}

/** An arranging trip at encounter n (from the decide fixture). */
export function statusArranging(n: number): TripStatusView {
  const s = statusDecide();
  return withTrip(s, { phase: "arranging", currentEncounter: n, decisionFor: null, encounters: n === 1 ? [] : s.trip!.encounters.map((e) => ({ ...e, decision: "pushed" as const })), encountersResolved: n - 1 });
}

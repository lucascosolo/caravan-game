/**
 * Trip fixtures for component tests (chunk 23): the REAL server bodies the contract test
 * recorded (src/test/contract/trip-*.json, chunk 15's routes driven by its test double), run
 * through the client's own guards, plus small editors over them. So a component test renders
 * exactly what the server sends, and drifts with it.
 */
import { expectShape } from "../api/shape.ts";
import { stakesPreviewShape, tripCapRefusalShape, tripStatusShape } from "../api/tripShapes.ts";
import type { StakesPreview, TripCapRefusal, TripCapView, TripStatusView, TripView } from "../api/tripTypes.ts";
import { ApiError } from "../api/client.ts";
import decideJson from "./contract/trip-status-decide.json";
import resolvingJson from "./contract/trip-status-resolving.json";
import packedJson from "./contract/trip-status-packed.json";
import bankedJson from "./contract/trip-status-banked.json";
import overrunJson from "./contract/trip-status-overrun.json";
import previewJson from "./contract/trip-preview.json";
import preview2Json from "./contract/trip-preview-2.json";
import refusedJson from "./contract/trip-start-refused.json";

export const statusDecide = (): TripStatusView => expectShape(tripStatusShape, decideJson.body);
export const statusResolving = (): TripStatusView => expectShape(tripStatusShape, resolvingJson.body);
export const statusPacked = (): TripStatusView => expectShape(tripStatusShape, packedJson.body);
export const statusBanked = (): TripStatusView => expectShape(tripStatusShape, bankedJson.body);
export const statusOverrun = (): TripStatusView => expectShape(tripStatusShape, overrunJson.body);
export const previewAfter1 = (): StakesPreview => expectShape(stakesPreviewShape, previewJson.body);
export const previewAfter2 = (): StakesPreview => expectShape(stakesPreviewShape, preview2Json.body);
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

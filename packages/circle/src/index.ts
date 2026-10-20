/**
 * @caravan/circle — the wagon circle model (chunk 07).
 *
 * The ACTIVE side of the game: the player is the caravan, is attacked, and arranges this
 * formation against a specific scouted party (GUARDRAILS §0). Two structures with two
 * lifetimes:
 *   - Manifest  (manifest.ts)  — what was packed; locked for the whole trip; carries
 *                                attrition forward (attrition.ts).
 *   - Formation (formation.ts) — how it is arranged for ONE encounter; references the
 *                                manifest; validated server-side; snapshotted (serialize.ts).
 * The PASSIVE side lives here too (chunk 09): party.ts is the standing raid party — a
 * template referencing roster instances, never consumed — with its three targeting
 * stances, entry-band starting positions, and the one scouting view both sides read.
 * The lattice (lattice.ts) is the placement grid and defines, once, how a placed cell
 * becomes a continuous fixed-point position. resolverInput.ts is the closed, flat,
 * integer-only structure the resolver consumes.
 *
 * Pure: no I/O, no clock, no randomness, no floats. Only dependency: @caravan/content.
 */
export * from "./issues.js";
export * from "./lattice.js";
export * from "./manifest.js";
export * from "./formation.js";
export * from "./attrition.js";
export * from "./party.js";
export * from "./serialize.js";
export * from "./resolverInput.js";
export * from "./guide.js";
export * from "./guideLayout.js";
export * from "./raise.js";

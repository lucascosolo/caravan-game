/**
 * Chunk 32: the closed vocabularies the client may send in telemetry. They must equal the
 * server's (apps/server/src/analytics/tunables.ts); the server suite compares them. A screen
 * outside this list, or any free text, is refused by the server — never stored.
 */
export const TELEMETRY_SCREENS = ["town", "trail", "party", "webs", "packs", "cosmetics", "inbox", "login", "welcome", "admin"] as const;
export type TelemetryScreen = (typeof TELEMETRY_SCREENS)[number];

export const TELEMETRY_ERROR_NAMES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "ApiError", "ChunkLoadError", "Unknown"] as const;
export type TelemetryErrorName = (typeof TELEMETRY_ERROR_NAMES)[number];

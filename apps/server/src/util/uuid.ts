/**
 * One UUID check for every route and service that takes an id from the outside (QA-05 S1).
 * Canonical 8-4-4-4-12 hex only — the shape Postgres emits — so a 36-character string of
 * dashes or of hex without groups is refused HERE (a 400 or a 404, as the route decides)
 * instead of reaching the database as a parameter and coming back as a 500.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

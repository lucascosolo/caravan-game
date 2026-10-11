/**
 * Validation results. Validation never throws for player-caused problems: it returns every
 * issue it found so the formation UI (chunk 08) can show all of them at once. Throwing is
 * reserved for programming errors (a malformed manifest, an outcome that would heal).
 */
export interface Issue {
  /** Stable machine code; the server maps it to an HTTP error code. */
  readonly code: IssueCode;
  readonly message: string;
  /** Which entry caused it, when one did: a manifest ref, a type id, or a segment index. */
  readonly subject?: string;
}

export type IssueCode =
  | "unknown_type"
  | "type_locked"
  | "slot_cap_units"
  | "slot_cap_traps"
  | "fence_budget"
  /** QA S3: a manifest must pack at least one living unit — bounded stakes are vacuous otherwise. */
  | "manifest_empty"
  | "duplicate_unit"
  | "bad_merge_level"
  | "bad_count"
  /** QA N1: the structure's `v` is not the version this code validates. */
  | "bad_version"
  /** QA S8: more placements than the caps allow; refused before any per-entry validation. */
  | "oversized"
  | "unknown_ref"
  | "duplicate_ref"
  | "unit_dead"
  | "unit_not_posted"
  | "trap_spent"
  | "fence_destroyed"
  | "bad_segment"
  | "duplicate_segment"
  | "bad_cell"
  | "cell_occupied"
  | "cell_reserved"
  | "post_too_close"
  /** QA D1: a post's defensive stance is not one of DEFENSIVE_STANCES. */
  | "bad_stance"
  // ── chunk 09: standing raid party ──────────────────────────────────────────────────
  /** More siege pieces than SIEGE_SLOT_CAP. */
  | "slot_cap_siege"
  /** The same siege type twice: a counter applies once, so a second piece is a non-choice. */
  | "duplicate_siege"
  /** A unit's approach edge is not one of ENTRY_EDGES. */
  | "bad_edge"
  /** A unit's starting cell is not inside its edge's entry band (START_POSITION_BAND). */
  | "cell_off_band";

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

/**
 * QA S8: an issue list is capped so a hostile body cannot turn validation into a response
 * amplifier. Fifty is plenty for a UI to show "every problem at once" on a legal-sized input.
 */
export const MAX_ISSUES = 50;

export function issue(code: IssueCode, message: string, subject?: string): Issue {
  return subject === undefined ? { code, message } : { code, message, subject };
}

/** The first MAX_ISSUES issues, in the order they were found. */
export function capIssues(issues: readonly Issue[]): readonly Issue[] {
  return issues.length > MAX_ISSUES ? issues.slice(0, MAX_ISSUES) : issues;
}

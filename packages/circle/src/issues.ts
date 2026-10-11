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
  | "duplicate_unit"
  | "bad_merge_level"
  | "bad_count"
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
  | "post_too_close";

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

export function issue(code: IssueCode, message: string, subject?: string): Issue {
  return subject === undefined ? { code, message } : { code, message, subject };
}

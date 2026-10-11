/**
 * Tunables registry — every balance constant in the game lives here, never inline in
 * game logic (AGENTS.md "Working rules"). Chunk 03 builds this out properly; chunk 01
 * seeds only the values it needs. Every value below is a proposed default from a chunk
 * brief and is TUNABLE — none has been balanced.
 */
export const TUNABLES = {
  /** TUNABLE (chunk 01). Number of selectable regions; must equal REGIONS.length. */
  REGION_COUNT: 4,

  /** TUNABLE (chunk 01, PROJECT.md §14). Per-account Coin storage cap. Pure placeholder. */
  COIN_STORAGE_CAP: 50_000,

  /**
   * TUNABLE (chunk 01). v1 enforcement value only — app logic refuses a second caravan,
   * but the schema supports N caravans per account (GUARDRAILS §5).
   */
  MAX_CARAVANS_PER_ACCOUNT: 1,

  /** TUNABLE (chunk 04). Neutral starting Reputation for every pool. A rating, never spent. */
  REPUTATION_START: 1000,

  /** Merge cap is level 5 for everyone (GUARDRAILS §2). Not a balance knob. */
  MERGE_LEVEL_MIN: 1,
  MERGE_LEVEL_MAX: 5,
} as const;

export type Tunables = typeof TUNABLES;

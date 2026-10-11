/**
 * Chunk 24: onboarding progress, account-level (PHASE-2 §24, GUARDRAILS §5: a future second
 * caravan does not retrigger it). A marker of what the player has seen and nothing more:
 * no code path reads it to grant Coin, units, unlock points or access — the tutorial is a
 * real trip under the ordinary rules. Forward-only (also enforced by migration 017's trigger).
 */
import type { Queryable } from "../db/pool.js";
import { badRequest, conflict } from "../services/errors.js";
import { ONBOARDING_STEPS, canSkipFrom, isOnboardingStep, stepRank, type OnboardingStep } from "./steps.js";

interface OnboardingRow {
  account_id: string;
  step: OnboardingStep;
  skipped_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export interface OnboardingView {
  readonly step: OnboardingStep;
  readonly steps: readonly OnboardingStep[];
  /** False for an account with no onboarding row (created before chunk 24 or outside registration): treated as done. */
  readonly enrolled: boolean;
  readonly completed: boolean;
  readonly skipped: boolean;
  readonly canSkip: boolean;
  readonly updatedAt: string | null;
}

function toView(row: OnboardingRow | null): OnboardingView {
  if (!row) return { step: "done", steps: ONBOARDING_STEPS, enrolled: false, completed: true, skipped: false, canSkip: false, updatedAt: null };
  return {
    step: row.step,
    steps: ONBOARDING_STEPS,
    enrolled: true,
    completed: row.completed_at !== null,
    skipped: row.skipped_at !== null,
    canSkip: canSkipFrom(row.step),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Registration: every new player account starts at the first screen. */
export async function enrollOnboarding(db: Queryable, accountId: string): Promise<void> {
  await db.query("INSERT INTO account_onboarding (account_id, step) VALUES ($1, 'welcome') ON CONFLICT (account_id) DO NOTHING", [accountId]);
}

/** Dev / e2e fixtures (seed.ts): an account seeded with a ready roster is not a new player. */
export async function markOnboardingDone(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `INSERT INTO account_onboarding (account_id, step, completed_at) VALUES ($1, 'done', now())
     ON CONFLICT (account_id) DO UPDATE SET step = 'done', completed_at = COALESCE(account_onboarding.completed_at, now()), updated_at = now()`,
    [accountId],
  );
}

async function readRow(db: Queryable, accountId: string, lock: boolean): Promise<OnboardingRow | null> {
  const res = await db.query<OnboardingRow>(`SELECT * FROM account_onboarding WHERE account_id = $1${lock ? " FOR UPDATE" : ""}`, [accountId]);
  return res.rows[0] ?? null;
}

export async function readOnboarding(db: Queryable, accountId: string): Promise<OnboardingView> {
  return toView(await readRow(db, accountId, false));
}

/**
 * Move to `step` if it is further on than where the account stands; an earlier or equal step
 * is a no-op (a second tab, a retry) and answers the current state. Never moves back.
 */
export async function advanceOnboarding(db: Queryable, accountId: string, step: unknown): Promise<OnboardingView & { readonly changed: boolean }> {
  if (!isOnboardingStep(step)) throw badRequest("invalid_step", `'step' must be one of ${ONBOARDING_STEPS.join(", ")}`);
  const row = await readRow(db, accountId, true);
  if (!row || stepRank(step) <= stepRank(row.step)) return { ...toView(row), changed: false };
  // QA N1(a): 'done' by advancing means FINISHED, so only from the last step. Anything earlier
  // is a skip and goes through /skip (which refuses on the first screen and records it as one).
  if (step === "done" && row.step !== "party") {
    throw conflict("onboarding_not_finished", `the guide finishes from 'party'; from '${row.step}' use POST /me/onboarding/skip`);
  }
  const res = await db.query<OnboardingRow>(
    `UPDATE account_onboarding SET step = $2, completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END, updated_at = now()
     WHERE account_id = $1 RETURNING *`,
    [accountId, step],
  );
  return { ...toView(res.rows[0]!), changed: true };
}

/** Skip the rest of the guide. Refused on the first screen (PHASE-2 §24: skippable after it). */
export async function skipOnboarding(db: Queryable, accountId: string): Promise<OnboardingView & { readonly changed: boolean }> {
  const row = await readRow(db, accountId, true);
  if (!row || row.completed_at !== null) return { ...toView(row), changed: false };
  if (!canSkipFrom(row.step)) throw conflict("onboarding_first_screen", "the first screen cannot be skipped: read it, then the rest of the guide can be");
  const res = await db.query<OnboardingRow>(
    `UPDATE account_onboarding SET step = 'done', skipped_at = now(), completed_at = now(), updated_at = now() WHERE account_id = $1 RETURNING *`,
    [accountId],
  );
  return { ...toView(res.rows[0]!), changed: true };
}

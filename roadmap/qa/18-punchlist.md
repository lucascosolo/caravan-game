# Chunk 18 — QA punch list (commit 3248ffd, merged at 0a582ab; migration is 007)

No blockers.

## Decisions (orchestrator)
D1. **A free refresh never replaces an unclaimed menu.** When the timer is up and the current menu is unclaimed, `GET /refugees` reports `freeRefreshDue: true` and leaves the menu alone; the player either claims it (then the due refresh generates the next menu in the same request) or calls the new free, idempotent `POST /refugees/refresh { fromSequence }`, which forfeits the unclaimed menu knowingly. GET never writes. One menu at a time is preserved; no stockpiling (a due refresh yields exactly one menu whenever it is taken).
D2. **Fixed grid anchor.** The next free window opens at `opener.generated_at_ms + k·interval` (the schedule), not at the read that generated the last menu, so the rate is 16/day for everyone regardless of polling cadence; still one menu per take.

## Should-fix
S1. `sequence` (claim) and `fromSequence` (reroll, refresh) are **required**; absent → 400 `invalid_sequence`. The GET supplies them; document in the chunk file. Test: concurrent `{}` rerolls can no longer double-charge.
S2. GET must not mutate (closed by D1). Test: a GET past the timer never writes a row.
S3. Bound sequence fields to `1..2147483647` (safe integer) → 400.

## Nits
N1. Fix the three "006_refugee_menu" references (db/types.ts, chunk file, ORCHESTRATION) to 007.
N2. Clamp `msUntilFreeRefresh` to the interval when the clock goes backwards.
N3. `menuView`/`ensureCurrentMenu` bare `Error` → `AppError(409, 'menu_corrupt')` with caravan id; test.
N4. Document "3 slots, not 3 distinct types" for pools < 3; the UI collapses duplicates.
N5. Record in the chunk file that the reroll is intentionally cheaper than recruit whenever any type is acceptable (it buys time, §2-consistent) so nobody "fixes" it later.

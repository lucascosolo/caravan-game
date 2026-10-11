# Chunk 18 — QA punch list (commit 3248ffd, merged at 0a582ab; migration is 007)

No blockers.

**Round 1 closed 2026-10-11 by the Maker** (every item below is marked `[closed]` with where
it landed; regressions live in `apps/server/test/acquisition.test.ts` under "QA round 1
punch list", built from the reviewer's `det.ts` / `probe.mts`). Awaiting QA re-review.

## Decisions (orchestrator)
D1. [closed] **A free refresh never replaces an unclaimed menu.** When the timer is up and the current menu is unclaimed, `GET /refugees` reports `freeRefreshDue: true` and leaves the menu alone; the player either claims it (then the due refresh generates the next menu in the same request) or calls the new free, idempotent `POST /refugees/refresh { fromSequence }`, which forfeits the unclaimed menu knowingly. GET never writes. One menu at a time is preserved; no stockpiling (a due refresh yields exactly one menu whenever it is taken).
    — `refugees.ts`: `viewRefugees` writes only the caravan's first menu (bootstrap); `timer.freeRefreshDue` / `reroll.blockedByFreeRefresh` in the view; `refreshRefugees` + `POST /refugees/refresh` (201 new / 200 replay, `forfeitedOffers`); `claimRefugee` takes the due refresh after the grant; `rerollRefugees` → 409 `free_refresh_due` while due. Tests: "the free timer…", "an unclaimed menu is never expired…", "through HTTP…", "a reroll is refused, unpaid…", "D1/S2".
D2. [closed] **Fixed grid anchor.** The next free window opens at `opener.generated_at_ms + k·interval` (the schedule), not at the read that generated the last menu, so the rate is 16/day for everyone regardless of polling cadence; still one menu per take.
    — Migration 007 (in place): `window_opened_at_ms` (free menu: its grid point, `<= generated_at_ms` by CHECK; reroll: its opener's). `gridPointFor` = latest `anchor + k·interval ≤ now`; `nextFreeRefreshAtMs` = that + interval. Test "D2" (16 late takes in a day, a week away → one menu on the grid, rerolls inherit the point).

## Should-fix
S1. [closed] `sequence` (claim) and `fromSequence` (reroll, refresh) are **required**; absent → 400 `invalid_sequence`. The GET supplies them; document in the chunk file. Test: concurrent `{}` rerolls can no longer double-charge.
    — `grant.ts#normalizeSequence` now required; the three routes pass the field through unchanged; chunk file "Routes". Tests "S1" ×2 (double-tap `{}` → 400/400, nothing charged; unnamed claim retry → 400, named retry replays across a free refresh with one instance).
S2. [closed] GET must not mutate (closed by D1). Test: a GET past the timer never writes a row.
    — Test "D1/S2" (four late reads, direct and HTTP: snapshot unchanged, one row).
S3. [closed] Bound sequence fields to `1..2147483647` (safe integer) → 400.
    — `MAX_SEQUENCE` in `grant.ts`. Test "S3" (1e308, 2^53+1, 2^31, 0, −1, 1.5, "1", true, null, NaN, ∞ on all three routes; 2147483647 itself reaches the menu check).

## Nits
N1. [closed] Fix the three "006_refugee_menu" references (db/types.ts, chunk file, ORCHESTRATION) to 007.
    — `db/types.ts`, chunk file, ORCHESTRATION built entry.
N2. [closed] Clamp `msUntilFreeRefresh` to the interval when the clock goes backwards.
    — `buildView`: `min(interval, max(0, next − now))`. Test "N2".
N3. [closed] `menuView`/`ensureCurrentMenu` bare `Error` → `AppError(409, 'menu_corrupt')` with caravan id; test.
    — `menuCorrupt(caravanId, detail)` in `refugees.ts`; the opener read is gone (the grid point is on every row). Tests "N3" ×2 (unknown offer id and `[]` → 409 on GET and on refresh with nothing written; a reroll whose menu row is missing).
N4. [closed] Document "3 slots, not 3 distinct types" for pools < 3; the UI collapses duplicates.
    — Chunk file "Three slots, not three distinct types"; `RefugeeMenuView.offers` doc comment.
N5. [closed] Record in the chunk file that the reroll is intentionally cheaper than recruit whenever any type is acceptable (it buys time, §2-consistent) so nobody "fixes" it later.
    — Chunk file "Reroll is cheaper than recruit on purpose".

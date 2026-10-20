# Handoff: from the cloud session to the owner's PC

Written 2026-10-20 at the end of the cloud session that built the game to play-test readiness and
then ran three studio reviews. The next session runs on the owner's PC, with access to the Kenney
library (on the storage VPS), Wiro API credits and the owner's own tools. Read this first, then
`roadmap/state.json` for the machine-readable version of the same facts.

## Where things are

- **Branch:** all work is on `roadmap/phase-2-spec`, pushed to origin.
- **`main`:** about 360 commits behind and can be fast-forwarded (`origin/main` is an ancestor). The fast-forward is the owner's call. Nothing was merged to `main` in the cloud session.
- **`origin/wip/*` branches:** every one is fully merged into `roadmap/phase-2-spec` and can be deleted:
  - 22-replay-fixes, 24-onboarding-fixes, 29-inbox-fixes;
  - 30-accounts, 32-telemetry, 36-performance;
  - 37-balance-sweep, test-isolation.

  The WIP table in `ORCHESTRATION.md`'s "stopping point" entry predates their merge.
- **`origin/wt/t_2e8bcff2` and `origin/wt/t_737ea2f7`:** August drafts of chunks 09, 16 and 17 from an earlier session. They were superseded by the merged chunks and are safe to delete, the owner's call.
- **No PR is open.** None was asked for.

## What state the game is in

**Ready for a closed play test.**
- **Four rounds of final reviews**, each followed by a fix round: play test and guardrails.
- **A confirmation round:** `roadmap/qa/confirmation-playtest.md` and `confirmation-guardrails.md`, both READY at e002854.
- **Fights:** resolve in the server process with the real resolver (RESOLVER_VERSION 9).
- **Hosting:** the play test is hosted by hand from `docs/PLAYTEST-HOSTING.md` as one process (`SERVE_WEB=1`), with the store off.

**Not ready for a soft launch.** All three studio reviews agree:
- design: `roadmap/review/studio-design.md`;
- feel: `studio-feel.md`;
- live-ops and economy: `studio-liveops.md`.

**`roadmap/review/STUDIO-REVIEW.md` merges them** into one ranked plan, from tier 0 to tier 3. It also lists six decisions only the owner can make.

## Setting up on the PC

Follow `AGENTS.md`'s "First time on a fresh clone" block exactly. It covers:
- Node 22 and pnpm 10;
- Postgres 16, with the `caravan` owner role and the `caravan` and `caravan_test` databases;
- `pnpm db:migrate`, which creates the `caravan_app` role;
- `pnpm db:seed:dev`;
- Playwright's Chromium;
- `pnpm check`.

`pnpm check` is every CI gate in CI's order. It took about 20 minutes on 4 cores. The determinism step needs a base ref locally: `DETERMINISM_BASE_REF=3d13921 pnpm check`.

**Gotchas that cost time in the cloud session:**
- **After a container or machine restart Postgres is down.** Start it before any test.
- **Before `pnpm db:reset` of a seeded database,** run `DELETE FROM account WHERE is_system OR username IS NULL` as the owner role. See `AGENTS.md` for when a plain `DELETE FROM account` is needed instead.
- **Union-resolving merges can drop a closing brace,** and CSS is the worst case. One broke every guide style (fixed in 8679d87). Re-run the web tests after any conflicted merge.
- **Migrations are numbered contiguously,** 001–030 today. Branches made in parallel collide, so renumber on merge.
- **Server test files must not depend on order.** See `apps/server/test/per-file-reset.ts`, and check with `vitest run --sequence.shuffle.files`.
- **Never rewrite pushed history.** No force-push on this branch.

## Art and audio on the PC

The plan is `roadmap/review/ART-PLAN.md`. The art bible is `docs/art/STYLE-GUIDE.md`, written from the owner's style board (`assets/reference/style-board-v1.png`) and ten art principles.

**Before generating anything** (ART-PLAN step 1, still to do):
1. Collect the public-domain references the style guide lists, into `assets/reference/`, with sources and licences in `assets/reference/SOURCES.md`. The references are a storybook linework page, a gouache texture scan, a dime-novel cover and wood-type broadsides.
2. Run the palette's contrast and colour-blind checks. The pair to test is Faded Turquoise settlers against Brick Red raiders on Trail Dust ground, under deuteranopia and protanopia.
3. Write `scripts/art/prompt-lint`, which rejects the style guide's banned prompt words.

**Wiro:**
- **Credentials:** `WIRO_API_KEY` and `WIRO_API_SECRET` go in the PC's `.env`, which every script loads. Never commit them, and never paste them into chat.
- **Signing:** requests are signed with HMAC-SHA256. Confirm the exact header names against Wiro's authentication docs before the first call.
- **Models:** `POST /Tool/List` lists them.
- **Spend discipline:** ART-PLAN's rules apply:
  - a cheap sketch round before each batch;
  - one locked style reference;
  - every accepted image recorded in `assets/painted/PROMPTS.md`;
  - the Desert vertical slice must read well in a real replay on a phone before credits go on the full roster.

**Kenney:** use it for greybox and layout stand-ins only. Its neutral look is the opposite of the target. The owner's complete set is now on the storage VPS at `shared/asset-packs/kenney/` (manifest entries 2026-10-20; details in `roadmap/state.json`, `art.kenney_inventory`).

**Code before art:**
- **The canvas legibility patch comes first** (feel review step 7 and ART-PLAN step 2): outlines, contact shadows, side badges and a desaturated ground. It needs no art and fixes today's 1.1:1 contrast.
- **The `iso/skins.ts` seam needs §26 work first.** It throws on `kind: "sprite"`, so PHASE-2 §26 must make it draw sprites before any painted asset can show.

**Audio:** code-synthesised first, at $0, covering every cue in the feel review's finding 15. Paid audio comes only for the handful of cues that matter most. No build may ever depend on a paid service.

## What to do next, in order

1. **Read** `roadmap/GUARDRAILS.md` in full (every session), then `roadmap/review/STUDIO-REVIEW.md`.
2. **Tier 0 (small, no decisions needed):**
   - the play-test nits N1–N6 from `confirmation-playtest.md`;
   - the feel review's no-art week: the voice pass, sticky action bars, replay bookends, prompts off the reward screens and the legibility patch;
   - the KPI instrumentation the play test should collect.
3. **Run the play test** from `docs/PLAYTEST-HOSTING.md`. Read the open balance questions in `BALANCE-LOG.md` off its telemetry before tuning anything.
4. **Owner decisions** (STUDIO-REVIEW.md, "Decisions only the owner can make"):
   - solvability;
   - softer losses: scatter or convalescence;
   - trail conditions;
   - what the store sells;
   - "Build your town";
   - a hosting target.
5. **Tier 1,** the depth milestone, behind its ship gate. Its probes are in `roadmap/review/tools/design-probes/`. **Tier 2,** presentation and art, in parallel.

## Not verified, or left open

- `pnpm check` passed all 11 steps on 8e15642 in 14.8 min (2026-10-20, recorded in `roadmap/state.json`, `last_check`). The handoff commits after it change only docs, review tools outside every build and one AGENTS.md number.
- **Chunk status words in `roadmap/INDEX.md`'s status notes predate the final review rounds.** The play-test gate chunks are 22, 23, 24, 25, 29, 30, 32, 36 and 37. They closed their punch lists and passed the final and confirmation reviews, but nobody has re-labelled them `done`. That is a status call for the next session's QA pass.
- **Open on purpose, handed to later chunks:**
  - chunk 30 N6 (password change and "sign out everywhere", for chunk 34) and N9 (reserving erased handles);
  - chunk 36 D1, D3 and D5 (recorded for launch);
  - chunk 31 (anti-abuse), not built.

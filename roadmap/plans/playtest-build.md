# Plan: from design mock-ups to a playable test build

Owner's goal, 2026-10-21: "Keep working until the game is ready for me to test." Coordinated
by the session that ran the art direction work; each chunk is done by a fresh agent and verified
before the next depends on it. Ledger: `.agent/ledger-playtest-build.md` (not committed).

## Decisions this plan rests on (all 2026-10-20/21, recorded in docs/art/STYLE-GUIDE.md and roadmap/state.json)
- Art: the "middle path". Generated objects are used directly, resampled to exact device size,
  colour-nudged toward the palette, with one shared outline drawn in code. True pixel-art
  pieces (ground, fences, decals) keep the pixel step.
- The round wagon circle with 6 naturally spaced wagons replaces the square ring (chunk 50); the
  geometry is `round-ring.json` from the look test. The whole camp is visible on a phone by
  default, with the scene drawn about 20% smaller (tile 40x20).
- Saved layouts load automatically and turn to face the attack; hints for new players never
  force a change (chunk 51).
- UI: A's materials and objects on B's calm layout with C's pointing pop-ups (the kit in
  ~/.cache/caravan/ui-system/kit after its rebuild).
- Every Kenney asset must earn its place; look at the style board before generating anything.

## Chunks (in dependency order)
| # | Chunk | Agent | Depends on | Verified by |
|---|---|---|---|---|
| C1 | Art pipeline (chunk 26): committed sources, build step, loader, SpriteSkin registry in apps/web/src/iso, readability layer, per-type fallback, coverage and size checks in pnpm check | deep-implementer (worktree) | none | the new art checks and the web tests, typecheck, build |
| C2 | Round wagon circle (chunk 50): resolver geometry, RESOLVER_VERSION bump, goldens, content/circle/server/web follow, formation conversion | deep-implementer (worktree) | none | pnpm check up to e2e (e2e cannot run on this PC) |
| C3 | Camp in the real renderer: camera fits the whole camp, 40x20 tile, ground, fence runs, shadows, painted sprites at device resolution | deep-implementer | C1, C2 | web tests and screenshots of the trail/replay screens |
| C4a-d | UI re-skin to the kit: shell and town; trail and formation; replay and results; party, webs, inbox, store | implementer x4 | kit rebuild, C3 | web tests, typecheck, screenshots per screen |
| C5 | Saved layouts (chunk 51) | deep-implementer | C2 | server and web tests |
| C6 | Test build: full pnpm check, a build the owner can open on a phone (local or hosted, hosting needs the owner's yes) | coordinator | all | the owner plays it |

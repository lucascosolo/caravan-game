# Studio design review probes

These are the scripts behind `roadmap/review/studio-design.md`, kept so its ship gate (STUDIO-REVIEW.md,
tier 1) can be re-run after the depth milestone. They are reference copies of what was run in the cloud
session on 2026-10-20, outside every build and every CI step. Imports have been rewritten to paths relative
to this folder. Nothing else was changed, so expect to adjust a flag or two before the first run.

| Script | What it measures | Run (from the repo root) |
|---|---|---|
| `probes/read-value.mts` | What reading the scout is worth: every band-typical roster against every authored party within ±1 band, all 76 skilled layouts, plus the same layouts with the scouted edge replaced by a fixed north. Gate: no single stance optimal in more than 70 % of matchups, and a scout-blind circle holds under 40 % from band 3 up. | `pnpm --filter @caravan/server exec tsx ../../roadmap/review/tools/design-probes/probes/read-value.mts` |
| `probes/endgame.mts`, `endgame2.mts` | Maxed defenders against the meta standing parties a maxed owner can build. Gate: no party shape held below 15 % or above 85 %. | as above |
| `probes/midgame.mts`, `units.mts` | Mid-game party shapes, and a per-unit-type table. | as above |
| `bot.mts` | An API-level player (personas: `guide`, `naive`, `designer`, `solver`) for a hosted server. It plays real trips through the real routes. | `tsx bot.mts --user NAME --region desert --persona guide --trips 3 [--register] [--base http://127.0.0.1:PORT/api]` |
| `cohort.mjs` | Simulated days for several bots on one hosted server. Before each session it ages only the trip cap (−1 h) and the refugee timer (−1.5 h), never the mine or the ledger. Gate: the median engaged account's day-20 roster is stronger than its day-5 roster, and a strong standing party earns at least as much as a weak one. | `STUDIO_DIR=… node cohort.mjs <fromDay> <toDay>` |
| `run.mjs`, `s_*.mjs` | Playwright snippets for the hand-played phone session (Pixel 5 profile, device cookie kept per profile). | `STUDIO_DIR=… BASE=http://127.0.0.1:PORT node run.mjs <profile> s_first.mjs` |

**Hosting for the bots.**
- **Database:** a throwaway one, set up per `docs/PLAYTEST-HOSTING.md`. The review used `caravan_studio_design`, with an owner role whose password is read from `$STUDIO_DIR/owner.pw`.
- **Server settings:** the server ran with `NODE_ENV=production`, `SERVE_WEB=1`, `STORE_MODE=off` and the real resolver.
- **Bot passwords:** `studio-design-pw-<user>`, test-only and for that throwaway database. Never point the bots at a shared instance.

**Expect it to be slow:**
- the read-value probe fought 160,512 fights;
- the smart solvers' reroll waits made each simulated day slow, which is why they ran 10 days instead of 20.

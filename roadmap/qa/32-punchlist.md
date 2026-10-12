# Chunk 32 — QA punch list (reviewed at roadmap/phase-2-spec @ 7404d7f)

Probes (none committed):
- A `tsx` script beside `src/` that calls `buildDashboard` over the app role on `caravan_dev_qa32`
  (`pnpm db:reset && pnpm db:seed`: 96 authored parties and the dev account, nothing played).
- A `tsx` race script: 200 rounds of `saveSettings(optedOut:false)`, then
  `Promise.all([ingest(one screen event), saveSettings(optedOut:true)])`, then a count of the
  account's kept rows.
- HTTP probes with curl against the built server (`dist/index.js`, port 3968) as the dev account,
  after `node dist/admin.js grant dev --by qa32`, and as a fresh guest.
- `account_erase(dev, <raw token>)` over `caravan_app`, then counts by the owner role.

Baseline: `test/telemetry.test.ts` 30/30 and `test/telemetry-scale.test.ts` 4/4 pass
(`caravan_test_qa32`, the dashboard built in 211 ms over the synthetic history). Web
`src/telemetry`, `src/screens/admin` and `src/screens/inbox` pass 26/26. `pnpm build` passes.
`pnpm e2e` passes 11/11 (`caravan_dev_qa32`, E2E_PORT 3967, E2E_WEB_PORT 4267).

Checked and fine:
- **Admin access.** A missing token, a bad token, a signed-in non-admin and a fresh guest all get
  404 on `/admin/dashboard` for GET, POST, HEAD and OPTIONS. `caravan_app` gets 42501 on
  INSERT, UPDATE and DELETE of `account_admin`. The CLI refuses a malformed `--by` (exit 1) and
  grants and lists over the owner URL. Revocation applies on the next request, because
  `requireAdmin` reads the table every time.
- **Erasure.** `account_erase` over the app role removed the account's `account_analytics` row, all
  51 of its client events and its `account_admin` row. The cascades run as the table owner. No
  analytics row survived.
- **Client payloads.** No account id, username, message, URL or free text is sent. `stackHash`
  strips URLs and line/column numbers before hashing. Unknown keys, screens and classes return
  400. A body over 4 KiB returns 413. `__proto__` keys are refused.
- **One-way.** Nothing outside `src/analytics`, `routes/telemetry.ts`, `admin.ts` and `app.ts`
  names the module or its tables. The store-guards / economy-guards exemptions cover exactly one
  file, `src/analytics/queries.ts` (store-guards.test.ts:123,151; economy-guards.test.ts:257).
- **Panels recomputed by hand from code and the seeded history.** These match: trip length, bank
  versus push, overrun by band (the band expression equals `bandOf`), grind-wall deciles (the
  same fold as the test), and pool-health live/authored counts against the matchmaker's
  `POOL_SQL` filter (siege Reputation, slot 0, units > 0).
- **Payload names checked against the real writers.** Merge `toLevel` (economy/merge.ts:432),
  `tripCap.availableAfter` (trip/service.ts:146), ladder `pointsDelta`/`levelsGained`
  (progression/outcome.ts:187), unlock `nodeId`/`cost`, `mercenary_recruit` /
  `refugee_reroll` reasons, and the job's `result.outcome.endTick`.

## Should-fix

S1. **Authored-party seeding fills the ladder and unlock panels.** — **Closed (fix32):** every panel excludes the authored outfits (system accounts other than chunk 30's tombstone, whose rows are erased players' history) through keyed NOT EXISTS probes; telemetry.test.ts seeds the 96 cold-start parties and the ladder / unlock / earn panels are unchanged, pool health shows 12 authored per band 0–7. `LADDER_GAINED_SQL`
(queries.ts:323-327) and `UNLOCKS_SQL` (queries.ts:329-333) do not exclude system accounts.
`LADDER_LEVELS_SQL` (queries.ts:320) does. `pnpm db:seed` builds the 96 cold-start outfits
through the real writers: `ladder_progress_gained` with reason `authored_set`
(matchmaking/authored.ts:480-482) and `spendUnlockPoints` for every living and siege node
(authored.ts:520-522). Failure scenario (observed): on a freshly seeded DB with one real player
who never played, the 30-day dashboard shows `ladder.gained` = living 616 rungs / 227 048 points
and siege 597 rungs / 216 170 points. It also shows about 300 unlock purchases
(`siege.bridging_planks` ×55, `siege.fence_cutters` ×39, …). None of these came from a player.
Every authored-set version bump (`authored.ts` "updates in place") adds more. §20 #7 and #8 are
tuned against exactly these two panels. Fix: join `account` and add `AND NOT a.is_system` to both
(through the `(account_id, occurred_at)` index or a semi-join, then re-check the plans). Test: seed
the authored set in `telemetry.test.ts`'s `beforeAll`. The ladder/unlock assertions should still
hold, and pool health should then show `authoredParties` of 12 per band (today the test asserts 0,
telemetry.test.ts:369).

S2. **Opting out races a batch already in flight, and the race keeps events after the opt-out.** — **Closed (fix32):** `ingest` and `saveSettings` each run in one transaction that takes `SELECT … FOR UPDATE` on the account's analytics row; the toggle empties the reporter's queue before the PUT. Test: 50 concurrent ingest/opt-out pairs leave 0 rows.
`ingest` reads `opted_out` (clientEvents.ts:235-236) and then inserts later (clientEvents.ts:243).
Both statements are autocommit and take no lock. `saveSettings` UPDATEs and then DELETEs
(clientEvents.ts:222-223). An ingest that read `false` before the UPDATE inserts after the
DELETE. The client makes this likely: the toggle is in the Inbox, entering the Inbox queues a
screen event, and the reporter flushes 5 s later (telemetry.ts:25,154). The reporter learns of the
opt-out only after the PUT returns (AnalyticsToggle.tsx:40-42). Failure scenario (observed, race
probe): in 111 of 200 rounds a row was still kept after `PUT {optedOut:true}` returned, and one row
was still kept at the end with `opted_out = true`. Fix: run `ingest` in one transaction that
locks the row (`SELECT … FROM account_analytics WHERE account_id = $1 FOR UPDATE`), and have
`saveSettings` take the same lock. Alternatively, make the insert itself conditional
(`INSERT … SELECT … WHERE NOT (SELECT opted_out FROM account_analytics WHERE analytics_id = $1)`
under the same row lock). Also clear the reporter's queue before the PUT, not after. Test: the
concurrent pair 50× with no row left over.

## Design-level

D1. **The tick-cap panel's "At cap" column is always 0.** — **Closed (fix32):** "At cap" counts `outcome_kind = 'stalemate'` (as decided); the stalemate at tick 3599 now asserts `atCap: 1`. `TICK_CAP_SQL` counts
`end_tick >= TICK_CAP` (queries.ts:212). The resolver's `endTick` is the last tick simulated, in
`0 … tickCap − 1` (resolver resolve.ts:117; replay.ts:457 rejects anything else), and a stalemate
ends at `TICK_CAP − 1` (trip/outcome.ts:52). No fight can ever match. The test enshrines this: a
stalemate at 3599 asserts `atCap: 0` (telemetry.test.ts:258). The page shows the column twice
(AdminScreen.tsx:245,274). §20 #14 ("fights at / near the cap") reads it. Fix: `end_tick >= $3 - 1`
(or count `outcome_kind = 'stalemate'`) and assert `atCap: 1` for the stalemate.

D2. **Session length is easy to fake from one account, and it undercounts real play.** — **Closed (fix32):** migration 024: each batch carries `{session, seq}` (a random int31 per page load) and the server de-duplicates on (id, session, seq, index); `agoMs` is clamped to the 15 s flush window, so times are receipt times; a `heartbeat` kind about once a minute while visible, flush on `visibilitychange` → hidden (no sendBeacon). Test: the replayed 25-event POST stores nothing and spans ≤ 15 s. The server
trusts every `agoMs` up to an hour (clientEvents.ts:134-136). It does not de-duplicate, and it
does not check that events are ordered against what this id already sent. Failure scenario
(observed): two identical 25-event POSTs, with `agoMs` spread from 3 600 000 down to 0, produced
one session of 3 600 027 ms (bucket "≥60m") with 51 screens, in about a second of wall time. On the
real client side, a screen event is sent only when the route changes (telemetry.ts:97-101), with
no heartbeat or visibility event and no flush on `pagehide`. So 20 minutes of play on `#/trail`
reads as a 0-ms session, and the last ≤5 s of a session is lost on close. §20 #12 ("frequent
last-use starts in short sessions") is tuned against this number. Fix: (a) on the server, clamp
each event's `occurred_at` to at least the newest `occurred_at` already stored for that id (or
refuse a batch that goes back past it), and drop exact duplicates. (b) On the client, send a
`visible`/`hidden` pair (closed vocabulary) or a heartbeat at most every N minutes, and flush with
`sendBeacon`/`keepalive` on `pagehide`. Test: the two-POST replay above yields one session of
≤ the real span.

D3. **§20 #1 and #4 have no panel that shows the metric they are tuned against.** — **Closed (fix32):** new `matchups` (held rate per posted × raider affinity), `mergeLevels` (per side and level) and `fences` (placed / broken / damaged / HP lost per tier, from `result.outcome.fences`) panels; §20 #1 and #4 point at them first, and every TUNING_MAP entry's primary panel must read its own subsystem (PANEL_SUBSYSTEMS, tested). TUNING_MAP #1
(dashboard.ts:56-62) names `AFFINITY_ADVANTAGE_MULT`, `AFFINITY_DISADVANTAGE_MULT` and
`MERGE_MULT_PER_LEVEL`. The panels give only each type's marginal win rate (queries.ts:116-135).
They give no win rate by affinity matchup (defender affinity × attacker affinity) and no win rate
by merge level. A wrong advantage multiplier moves every type's matchups in opposite directions
and leaves the marginals flat. #4 (fence HP) reads "segments placed vs held". The stored outcome
already carries per-segment fence attrition (`result.outcome.fences`, trip/outcome.ts:88), but no
panel reads it. The fence HP is tuned against how often segments break, and nothing shows that.
The DoD ("every §20 number has a panel that shows the metric it should be tuned against") is not
met for these two. Fix: add a `matchups` panel (held rate per (posted affinity, raider affinity)
pair and per merge level, from the same ENC_CTE) and a `fences` panel (segments broken / placed
per tier, from `result.outcome.fences`). Point #1 and #4 at them, and extend the §20 test so each
entry names at least one panel that reads a field of its own subsystem.

D4. **The pack funnel mixes populations.** — **Closed (fix32):** one population for the funnel — analytics ids with screen flow whose account has not opted out — with nested stages (buyers ⊆ store viewers ⊆ viewers); every buyer appears only as `allBuyers`, labelled outside the funnel. Test: an opted-out buyer is in allBuyers only. "Opened the game" and "opened the store"
(queries.ts:356-359) count analytics ids with screen events, which leaves out every opted-out
account. "Bought" (queries.ts:353-354) counts every settled buyer, opted-out ones included. The
page prints them as one funnel (AdminScreen.tsx:284). Failure scenario: three opted-out players
buy and one opted-in player browses. The funnel reads "1 → 1 → 3": a conversion over 100 % that
cannot be read. Fix: restrict `PACK_BUYERS_SQL` (for the funnel line only) to accounts that are
not opted out, or label the buyers figure as "all buyers" outside the funnel. Test: an opted-out
buyer does not appear in the funnel line.

D5. **The account export leaves out the account's analytics data.** — **Closed (fix32):** `exportAccount` includes `analytics: { optedOut, events: [{kind, screen, errorName, stackHash, occurredAt}] }`, without the analytics id; chunk 30's export test extended. `exportAccount`
(account/service.ts:124-170) exports every player-owned table. It omits `account_analytics`
(the opt-out setting) and the account's `analytics_client_event` rows, which are personal data
keyed to the account through the opaque id. Failure scenario: a player asks for their data, gets
the export, and it holds no trace of the 1 000-a-day screen and crash rows the server keeps about
them. Fix: add `analytics: { optedOut, events: [{kind, screen, errorName, stackHash, occurredAt}] }`
(without the analytics id) and extend chunk 30's export test.

D6. **The dashboard has no time bound and is gated only at a 30-day window.** — **Closed (fix32):** `buildDashboard` runs in one READ ONLY transaction with `SET LOCAL statement_timeout` (ANALYTICS_STATEMENT_TIMEOUT_MS 5000, tested); /admin/* is rate-limited per admin (30/min, after the admin check so a non-admin only sees the 404); the gate EXPLAINs every query at 30 and at ANALYTICS_MAX_WINDOW_DAYS and compares each live plan's scan skeleton with the checked-in plan. 120 days passes the gate, so the cap stays 120 (plans `*.120d.txt`). The route runs about
30 queries one after another on the shared app pool (dashboard.ts:221-268), with no
`statement_timeout` (none anywhere in `src/`) and no rate limit. `days` may be up to 120
(routes/telemetry.ts:61). The scale gate EXPLAINs only a 30-day window (telemetry-scale.test.ts:
141-178). Its "bounded time" check allows 20 s, over a synthetic ledger of about 410 events a day.
The checked-in `db/explain/analytics/*.txt` are only checked for existence
(telemetry-scale.test.ts:221-223), never compared with a live plan. Failure scenario: an operator
loads `?days=120` on a production-sized ledger. The sessions sort, the grind-wall per-account walks
and the retention EXISTS probes run unbounded on pool connections the game needs, and nothing
cancels them. Fix: run `buildDashboard` in one `READ ONLY` transaction with
`SET LOCAL statement_timeout` (an operational tunable). Add the 120-day window to the EXPLAIN cases.
Either drop the `.txt` files or compare their node-type skeleton (timestamps stripped).

## Nits

N1. **`/admin/*` 404s are distinguishable from a real unknown route.** — **Closed (fix32):** every non-admin /admin/* answer is Fastify's own unknown-route body (`Route <METHOD>:<url> not found`); tested against a real unknown route for GET and POST on five paths. `/admin/x`, `/admin/` and a
denied `/admin/dashboard` answer `{"error":"not_found","message":"not found"}`
(routes/telemetry.ts:71-73, admin.ts:27). `/admin` and `/nope` answer Fastify's default
`{"message":"Route GET:/nope not found","error":"Not Found","statusCode":404}` (observed). The
comment at admin.ts:26 ("the same 404 an unknown route gives") is untrue, and the admin surface is
fingerprintable. Fix: a `setNotFoundHandler` that answers the same body, or reuse Fastify's shape
in `ADMIN_NOT_FOUND`.

N2. **Out-of-range `week` is a 500.** — **Closed (fix32):** `days` and `week` must be plain digits, `days` 1..120, `week` 0..the current week; 1e308, 0x10, signs and a future week are 400. `week=1e308`, `-99999999999` and `99999999999999` pass
`Number.isInteger` (routes/telemetry.ts:64-65) and crash in `toISOString` (observed:
500 `internal`). `days=0x10` is accepted as 16. Fix: bound `week` to
`[0, weekIndexAt(now)]`, and parse both parameters with `/^\d+$/`.

N3. **The pool-health `authored_over_share` alarm measures a different share than the matchmaker
acts on.** — **Closed (fix32):** the `authored_over_share` alarm reads the matchmaker's own query and window (`AUTHORED_SERVED_SHARE_SQL`, last AUTHORED_SERVED_SHARE_WINDOW menus); the window share is shown as information only. The dashboard uses the authored share of everything served in the dashboard window
(queries.ts:455-462, :681). The matchmaker weights authored parties down on the last
`AUTHORED_SERVED_SHARE_WINDOW` chosen rows of the band (authoredShare.ts). A band can alarm while
the matchmaker sees it under the cap, or the reverse. Fix: compute the alarm with
`authoredServedShare(db, band)` (the same SQL), and show the window share as information only.

N4. **The `empty` alarm ignores self-exclusion and recent-opponent exclusion.** — **Closed (fix32):** new `thin` alarm below CANDIDATES_PER_SEARCH + 1 + RECENT_OPPONENT_EXCLUSION servable parties (`THIN_BAND_PARTIES`). A band with exactly
`CANDIDATES_PER_SEARCH` parties is `ok` (queries.ts:679), even though a searcher whose own party is
one of them, or who just met one (`RECENT_OPPONENT_EXCLUSION`), cannot get a full menu from it.
Fix: alarm below `CANDIDATES_PER_SEARCH + 1 + RECENT_OPPONENT_EXCLUSION`, or document the gap in
the alarm's label.

N5. **The unlock panel cannot show "never bought" nodes.** — **Closed (fix32):** the unlock panel lists every node of every web from @caravan/content, 0 where nobody bought it. TUNING_MAP #8 says "which nodes are
bought (and which never are)" (dashboard.ts:110). `UNLOCKS_SQL` groups only nodes that have
purchases, so a node nobody buys is absent rather than shown as 0. Fix: left-join the unlock webs
from `@caravan/content` in TS and emit zero rows.

N6. **Erased owners' parties count as authored on the attacker panel.** — **Closed (fix32):** `authored` on the attacker panel is the served candidate's stored `owner.authored`, not today's `is_system`. `ENC_CTE.authored` reads
`is_system` of the job's `partyOwnerAccountId` at query time (queries.ts:109). Erasure rewrites
that id to the tombstone, which is `is_system` (migration 020), so an erased player's live party
moves from `live` to authored retroactively. Fix: read the stored candidate's
`owner.authored` (as `POOL_SERVED_SQL` does), or carry `partyOwnerAuthored` from the job input.

N7. **The grind-wall probe dates trickle Coin at flush time.** — **Closed (fix32):** trickle credits are apportioned by their stored `[accruedFromMs, accruedThroughMs)` span to the week (credits up to 7 days after the week read for their in-week share); the panel carries a note saying so. Trickle is credited lazily when the
account next touches Coin (economy/trickle.ts). Coin accrued over days of absence therefore lands
in the week of the next visit, and inflates that week's "free weekly earn" for returning players
(queries.ts:286-301). Fix: document it on the panel, or apportion `trickle` credits by their
accrual span if the payload carries one.

N8. **The reporter forgets the opt-out across reloads.** — **Closed (fix32):** the reporter reads `GET /me/analytics` before its first flush and holds the queue until then (a failed read retries on the next flush); tested. Each sign-in builds a reporter that
assumes opted-in (useTelemetry.ts:14). An opted-out player's first batch after every reload
is still sent, and dropped by the server. The server-side honouring holds, but the bytes still
leave the device. Fix: seed the reporter from `GET /me/analytics` before the first flush (and hold
the queue until then).

N9. **Test gaps.** — **Closed (fix32):** added the S1 seeding, the S2 race, the D1 assertion, a real merge (`/me/caravans/:id/merge`) and a real unlock (`/me/unlocks/spend`) in place of hand-written payloads, and a recursive walk of the three packages. No test seeds the authored set (S1). No test runs concurrent opt-out and ingest
(S2). The tick-cap test asserts the always-zero column (D1). The merge, ladder and unlock rows in
`beforeAll` are hand-written payloads (telemetry.test.ts:166-185) rather than real
`/me/.../merge` and `/me/unlocks/spend` calls. They match today's writers but would not catch a
payload rename. The one-way grep of `packages/{resolver,circle,content}/src` uses a
non-recursive `readdirSync` (telemetry.test.ts:643-646): fine while those dirs are flat, silent once one gets a subfolder. Fix: add the three tests named in S1 / S2
/ D1, drive one merge and one unlock through the routes, and walk the packages recursively.

## Orchestrator decisions (2026-10-11)

- **D1:** count a stalemate by the outcome kind (`stalemate`), not by `endTick >= TICK_CAP`. Fix the test that pins 0.
- **D2:** sessions come from the server's own receipt times. A client batch carries a per-session sequence number. The server de-duplicates on it and clamps `agoMs` to the batch's flush window. The client sends a heartbeat about once a minute while the page is visible, and flushes on `visibilitychange` to hidden. Do not add `sendBeacon` with credentials in the URL.
- **D3: add both panels.** For §20 #1, a win rate by affinity matchup and by merge level, from the stored formation and party snapshots and the outcome. For §20 #4, fence breakage by tier, from the stored outcome's broken segments.
- **D4:** a single population for the whole funnel: accounts that have not opted out. The buyer count is filtered the same way, so conversion can never exceed 100 %.
- **D5:** the account export includes the analytics setting and the account's own client events.
- **D6:** a statement timeout on every dashboard query, a rate limit on `/admin/*`, and the `days` cap lowered to the largest window that passes the EXPLAIN gate. The gate compares the live plan's scan types with the checked-in plan, not just its existence.
- **S1, S2 and every nit are in scope.** S1: every panel excludes system accounts. Add a test that seeds the cold-start parties. S2: ingest and the opt-out save serialize on the account's analytics row, for example with `SELECT … FOR UPDATE` in one transaction. N8: the client reads the opt-out from the server at start.

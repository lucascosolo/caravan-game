# Chunk 29 — QA punch list (reviewed at roadmap/phase-2-spec @ c4b76fd)

Probes (none committed):
- A scratch vitest file beside `test/inbox.test.ts`, run against `caravan_test_qa29`. It reused
  that file's helpers and added: a strike drained without and with `TRIP_SETTLE_HOOKS`, a
  real-resolver strike (`DEFAULT_HANDLERS`), an owner already at the storage cap, fixture strikes
  for the mark-all race and the horizon edge, and DML as `caravan_app` against `inbox_read`.
- A query-timing harness that wraps `pool.query` around `readUnread` / `readInbox`, plus EXPLAIN
  ANALYZE, on `caravan_dev_qa29`. That database held one owner with 5,000 strikes in the last 14
  days and 20,000 older ones, each with a `coin_earned` sibling: ~53k ledger rows in all.
- A Playwright probe (Pixel 5 profile) against the built server at 320, 360 and 390 px, using that
  owner with every category on.

Baseline: `test/inbox.test.ts` 21/21 pass. Web inbox tests 12/12 pass (`InboxScreen.test.tsx`,
`inboxShapes.test.ts`). `pnpm build` passes. `pnpm e2e` passes 7/7 (caravan_dev_qa29, E2E_PORT 3985,
E2E_WEB_PORT 4285).

Checked and fine:
- **Totals on the production settle path.** The inbox and the party feed agree, strike by strike and
  summed, on Coin, the transferred part, Reputation and ladder, for a held strike (loot 353) and an
  overrun. With the owner already at the cap, the item's `coinDiscardedAtCap` (353) equals the
  feed's, and the credited Coin is 0 in both. The credited `amount` and `overflowDiscarded` are
  summed the same way in `service.ts:130-134` and `feed.ts:120-127`.
- **Privacy.** No defender account id or caravan id appears in any body. The defender's own inbox
  never shows the party's side. System owners cannot log in, so they have no inbox. `jobId` still
  embeds the defender's `tripId`, as the feed and the replay already show (QA-22 N10, not counted
  again).
- **Watch the fight with the real resolver.** `GET /me/encounters/:job/replay` returns 200 for the
  listed job, with `viewer: "party_owner"` and a stored `log`.
- **Read-mark clamp.** A mark above the current version is stored at the current version. A stale
  mark keeps the item unread. A key from another account's inbox is refused with 400.
  `caravan_app` cannot TRUNCATE or disable / drop the trigger (inbox.test). A plain UPDATE that
  lowers a version is refused.
- **Opt-out.** An off category leaves the list and the badge. This is checked in the tests and was
  seen in the e2e.
- **Nothing sells.** The mine and packs cards have no button, and no item links to the store. No
  copy implies a device is notified. `noPush` says "nothing is sent to your phone or browser yet".
- **No storage APIs.** The inbox, the button and the signal use none. The one localStorage key seen
  in the probe is chunk 17's town camera.
- **Targets and accessible name.** Every control is at least 44 px at 320 px. The badge's count is
  in the button's accessible name ("Inbox, 30 unread").

Not counted (decided): device push (web push / native) is deferred to the packaging chunk.

## Should-fix

S1. **"Mark all read" marks strikes the player never saw.** The screen sends `{ all: true }`
(InboxScreen.tsx:72). The server then marks every item at its CURRENT version
(service.ts:307-308), so the clamp to "the version the client saw" does not apply. The screen also
never refreshes itself: only the header badge polls. Failure scenario (probe P2, observed): the
owner opens the Inbox and sees one strike at version 4. A second strike lands in the same hour,
which makes it version 5 with a count of 2. The owner taps "Mark all read". The response shows
`unreadCount: 0`, with the batch read at version 5 and a count of 2. The new strike was never on
screen, and nothing will ever show it as new. Build notes say "a stale or inflated mark can neither
hide nor pre-read a new strike". That holds for `marks`, not for `all`. Fix: send
`{ marks: items.filter(unread).map(({key, version}) => ...) }` from the rendered view. There are
at most ~35 items, under the 100 cap. Then drop `all` or make it take an `asOf` map. Test: render
v4, append a strike, mark all, and expect `unreadCount: 1`. InboxScreen.test.tsx:121 currently
enshrines `{ all: true }`.

S2. **A strike's version ignores its own credits, so a late settle changes a read item silently.**
The version is the newest `party_served_as_encounter` seq (derive.ts:148, service.ts:116). The
Coin, Reputation and ladder land under `transfer:<job>` / `progression:<job>`. That happens in the
worker's completion transaction when the hook runs, but on the lazy settle path it lands later
with a higher seq (trip/service.ts:276-279: "a worker run without the hooks, or a settle the
worker's savepoint rolled back"). Failure scenario (probe P1, observed, overrun without hooks): the
owner reads the batch, which shows 0 Coin, 0 Reputation, +0 ladder. The defender then reads their
trip, which settles it. The same item now shows 300 Coin, +25 Reputation, +30 ladder, and is still
`unread: false` with the version unchanged at 7. Fix: make the version the max seq over the served
event and its three causations (`max(greatest(s.seq, x.max_seq))` in `strikeWindows`). Test: drain
without hooks, mark read, settle, and expect unread.

S3. **The strike card breaks the 320 px layout for a valid caravan name.** `.card__line`
(theme.css:546) has no `overflow-wrap`. The strike line
`vs <username> (<caravan name>)` (InboxScreen.tsx:174) cannot wrap a long unbroken name.
CARAVAN_NAME_MAX is 40 (config.ts:43) and spaces are optional. Failure scenario (observed): a
defender caravan named `Dusty_Trail_Wagon_Masters_of_the_FarWest` makes the page 353 px wide at a
320 px viewport. A 40 × `W` name makes it 626 px, so the mobile viewport zooms out and every card
renders at 579-610 px. The e2e's `fitsPortrait` passes only because its fixture name is
"Struck Wagons". Fix: `overflow-wrap: anywhere` on `.inbox-strikes .card__line` (or on `.card__line`,
as `.pack-contents li` and `.replay__lines` do). Add a 40-character no-space name to the e2e fixture.

S4. **The inbox has no size bound in practice: 30 batches × 10 lines, 94 queries, a page 57,000 px
tall.** `draftItems` calls `listedStrikes` once per window (service.ts:215-216). Each call is a full
`listPartyFeed` (three queries, including a `SELECT *` of ledger rows). Observed for an owner who
was struck about 15 times an hour for 14 days: `GET /me/inbox` made 94 queries and took ~140 ms,
returning 94,608 bytes. The screen rendered 300 strike lines with 366 buttons, 56,972 px tall at
320 px. First render took about 1.0-1.2 s in the probe. `strikeWindows` also aggregates EVERY strike
in the horizon (5,000 lateral lookups in the EXPLAIN) before `LIMIT 30`. The served CTE has no
usable index for `(account_id, event_type, occurred_at)`: EXPLAIN shows it reading all the
account's rows (48,556 filtered out), so the cost grows with the account's lifetime. That is paid
by the 60 s badge poll too: ~40 ms for 4 queries with this owner. The badge stayed fast enough
here; the client page did not. Fix: itemize lines only for the newest few batches, or behind a
per-batch disclosure that fetches them. Fetch the listed lines for all windows in one query (window
bounds, not a seq cursor). Limit to windows before aggregating. Add a partial index
`ON ledger_event (account_id, occurred_at) WHERE event_type = 'party_served_as_encounter'`.

## Decisions (orchestrator)

D1. **No process resolves encounters on a production build, so the DoD cannot hold outside test
mode.** `apps/server/src/index.ts` starts a worker only for `CARAVAN_TEST_RESOLVER=double`. No
`src/worker.ts` exists, although `scripts/build.mjs:32` lists it as a candidate entry. So on
`pnpm start` no strike is ever written, and "learns within a minute" cannot happen. The chunk is
not the cause. Decide who ships the production worker (chunk 13 fix round, 15 or 36), and whether
29 stays `built` until it exists.

D2. **What happens to batches past the 30th, and past the 14-day line?** An owner away for three
days with an hourly strike has about 72 batches. The badge says 30 and the 42 older batches are
never shown or counted. No pointer says they exist; `strikeNotListed` covers only lines inside one
batch. Options: a trailing "N earlier batches — see the results feed" line, or collapsing older
batches into one per day. This depends on the shape S4 chooses.

## Nits

N1. **The horizon cuts a batch in half, so its count disagrees with that hour.** `since` is
`now − 14 d` to the millisecond (service.ts:112, :215), not the start of a window. Observed (probe
P3): three strikes in one window, read at `strike2 + 14 d − 5 ms`. The item says count 2, and the
feed shows 3 for that hour. Fix: `since = floor((now − horizon) / W) * W`, or drop a window that
starts before `since`.

N2. **Duplicate keys in one `marks` request return 500.** The upsert at service.ts:317-321 hits
"ON CONFLICT DO UPDATE command cannot affect row a second time". Observed: 500 `internal` on
`{marks:[{key:k,version:v},{key:k,version:1}]}`. Fix: fold by key (max of the clamped versions)
before the insert, or refuse with 400. Add the case to the malformed-body test.

N3. **The forward-only guard can be undone by DELETE + INSERT as `caravan_app`.** The trigger is
`BEFORE UPDATE` only (015_inbox.up.sql:44-45), and the app role has DELETE. Observed (P6): the role
deleted the mark at version 5 and re-inserted it at version 1, and both statements succeeded. Build
notes claim "decrease … refused". Either add a `BEFORE DELETE` guard (account deletion cascades
from `account`, so allow it when the parent row is gone), or reword the note to "UPDATE cannot
decrease". This is UI state, so the reword is acceptable.

N4. **Stale marks fail the whole request with 400 and the screen keeps the stale item.** A key the
inbox no longer shows is refused (service.ts:312). The trip cap key changes when a trip starts, a
refugee key changes when the menu is taken, and a batch leaves after 14 days or past the 30th. The
screen shows the error and does not reload (InboxScreen.tsx:64-65). Observed: 400 `unknown_item`
for `trip_cap:1`. Fix: skip unknown keys in `marks` (report them in the response), or reload the
inbox on `unknown_item`.

N5. **The listed lines are found by a seq cursor and then filtered by time.** `listedStrikes` asks
for the newest `min(count, 10)` strikes with `seq ≤ maxSeq` (service.ts:162). `strikeItem` then
drops those outside the window (derive.ts:128-130). `occurred_at` is the transaction's start
(`DEFAULT now()`, 002:117), while seq order is commit order under the append lock. A long
transaction that straddles an hour can therefore interleave two windows' seqs. Then an older strike
of this window is not listed and `notListed` is inflated. Found by reading the code, not
reproduced. S4's window-bounded query fixes it.

N6. **A strike line hides what the cap discarded.** The batch says "353 Coin did not fit", but its
only line says "0 Coin · 0 Reputation" (InboxScreen.tsx:177). `InboxStrike` has no
`coinDiscardedAtCap` (derive.ts:18-31), although the feed entry has it. Add it, and show "(353 did
not fit)" on the line.

N7. **A failed badge read says "nothing new".** On error `unread` is null (InboxButton.tsx:24-25),
so `count` is 0 (:49). The accessible name then becomes "Inbox, nothing new" (:55,
strings.ts `buttonLabel`). That is a claim, not an unknown. Use a plain "Inbox" name when the count
is unknown.

N8. **The web guard checks only for `accountId`.** Build notes say the line carries "not even the
caravan id". But `defender` (inboxShapes.ts:21-23) accepts a `caravanId`, and `object()` ignores
extra fields, so a server regression that re-adds it, or a top-level `defenderAccountId` on the
line, passes silently. Refuse `caravanId` too, and any key matching `/accountId$/i` anywhere in a
strike line.

N9. **The tests exercise the fallback settle, not the production one.** `strike()` in
inbox.test.ts:101 drains WITHOUT `TRIP_SETTLE_HOOKS` and then settles through `GET …/trip`. This is
why S2 is invisible to the suite. The e2e's "Watch the fight" opens only a fixture job's not-found
state (inbox.spec.ts:1-11). No test plays a stored log from the inbox, although that path works
(probe P8). There is also no test for the mark-all race (S1), the horizon edge (N1), duplicate
marks (N2), a long name at 320 px (S3) or cap-discarded totals. Also, the `describe` title at
inbox.test.ts:420 still says "migration 017" (now 015).

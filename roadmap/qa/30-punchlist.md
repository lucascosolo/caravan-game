# Chunk 30 — QA punch list (reviewed at roadmap/phase-2-spec @ 7404d7f)

Probes (none committed):
- A scratch vitest file beside `test/account-lifecycle.test.ts`, run against `caravan_test_qa30`. It
  reused that file's helpers and added the following: an export of a player with fights both ways,
  scanned for every other player's id; an erasure followed by a gunzip of both kept replay logs; a
  party owner erased after the defender had CHOSEN their candidate but before the commit; a defender
  erased while its own job was LEASED; concurrent links; and cookie / CORS behaviours.
- Raw SQL as `caravan_app` (psql) against `caravan_test_qa30`.
- `curl` against the built server (`caravan_dev_qa30`, :3970, rate limits ON).
- A Playwright probe (Pixel 5 profile) against the built client at 320, 360 and 390 px. It also opened
  five tabs of one guest.

Baseline: `test/account-lifecycle.test.ts` 28/28 pass. The web account and session tests pass 10/10.
`pnpm build` passes. `pnpm e2e` passes 11/11 (caravan_dev_qa30, E2E_PORT 3969, E2E_WEB_PORT 4269).

Checked and fine:
- **Link races.** Two concurrent links of one guest: one gets 200, the other 409 `already_linked`.
  Two guests linking the same name: one gets 200, the other 409 `username_taken`. A case or
  whitespace variant (` NAME `) is refused as taken. A linked name cannot be renamed or unlinked
  (identity guard).
- **Rate-limit keys.** `X-Forwarded-For` is ignored, so rotating it does not bypass the per-IP login
  limit (observed: 429 at the 11th try on one username, and at the 21st per address). Requests
  refused with 429 still count.
- **Cookie flags and scope.** `caravan_device` is HttpOnly, SameSite=Strict and Path=/, and
  `document.cookie` does not show it. There is no CORS header, and the preflight is 404.
  `/auth/logout` with the cookie alone is 401: a bearer token is required.
- **Party owner erased after the defender chose them.** The defender's formation, commit and drain
  all succeed, the trip moves on to encounter 2, and the menu shows "Departed outfit".
- **Defender erased with its own job leased.** The job goes with the caravan. A late
  `resolution_job_complete` on it matches no row and does not crash.
- **The replay logs themselves (gzip).** After erasure they do not contain the erased account id,
  caravan id or username.
- **Phone layout.** At 320, 360 and 390 px the start card, the shell and the Account screen have no
  horizontal overflow. Every visible control is at least 44 px. "Start playing" is in the first
  viewport.
- **Guardrails.** Region stays one-time per caravan: link changes nothing on the caravan, and there
  is no account-level region path. Nothing new can be bought. Devices and sessions are account-level.

## Should-fix

S1. **The "caller proof" of `account_erase` does not hold against the app role.** The build notes
say "a compromised server process can erase only an account whose live token it is handed". But
the check (020_account_lifecycle.up.sql:346-351) only asks whether a `session` row exists with
`token_hash = sha256(arg)`. `caravan_app` has INSERT and UPDATE on `session` (roles.sql:36;
repo/sessions.ts:307 inserts there). So the app role can write a session for any account with a hash
of a token it chose.

Observed (psql as caravan_app):
```
INSERT INTO session (account_id, token_hash, expires_at) VALUES (<victim>, encode(sha256('attacker-chosen-token')), now()+'1h');
SELECT account_erase(<victim>, 'attacker-chosen-token');   -- succeeds; the victim is gone
```
Fix (one session):
- Revoke INSERT and UPDATE on `session` from `caravan_app`.
- Issue sessions through a SECURITY DEFINER `session_issue(account, device, raw_token, expires)`
  that hashes inside the database. The proof is then a token only the database ever hashed.
- Alternatively, keep a per-session secret that the app role cannot read (a column revoke) and
  require it.

Test: add "the app role forges a session and calls account_erase → 42501" to
account-lifecycle.test.ts:595. The current test only tries read-based attacks.

S2. **A TEMP table opens every guard's erasure exception and fools every SECURITY DEFINER
function.** Neither `account_erasure_rewrite` nor `account_erasure_permits` (020 up:195-214) is
schema-qualified or pins a search_path, and they run as the invoker. `caravan_app` holds TEMPORARY
on the database (`has_database_privilege(... 'TEMP')` = t; roles.sql never revokes it). Postgres
searches `pg_temp` FIRST for relations. So
`CREATE TEMP TABLE account_erasure_active(...)` plus a row for `txid_current()` with an
attacker-chosen map turns the guards' exception on.

Observed, inside a rolled-back transaction as caravan_app:
- A `ledger_event` payload was rewritten: `unitTypeId` mountain.grizzly → mountain.boss_level5 and
  `source` starting_roster → mercenary.
- A COMPLETED `resolution_job.result` outcome was rewritten from `caravan_held` to
  `caravan_overrun`.
- The `trip_encounter` guard also passed; only a CHECK caught that edit.

The same root cause defeats the definers' `SET search_path = pg_catalog, public`, because pg_temp is
still searched first when it is not listed. With a `pg_temp.session` row and no real session,
`account_erase(<victim>, 't')` erased the victim (observed). That affects all 14 SECURITY DEFINER
functions (002 ×8, 016 ×4, 020 ×2).

Fix:
- `REVOKE TEMPORARY ON DATABASE … FROM PUBLIC, caravan_app` in roles.sql.
- Add `pg_temp` LAST to every definer's `SET search_path` (`pg_catalog, public, pg_temp`).
- Write `public.account_erasure_active` in the two invoker functions.

Test: as the app role, CREATE TEMP TABLE should fail with 42501. A shadowed `account_erasure_active`
should leave every guard refusing.

S3. **The app role can delete any account directly and destroy the other participant's replay.**
`caravan_app` has DELETE on `account` (roles.sql:36). `encounter_log` and `resolution_job` cascade
from `caravan` (013 up:21-22). So a plain DELETE bypasses `account_erase`, which is "the ONE
path", along with its caller proof and the anonymization.

Observed (psql as caravan_app, rolled back): defender D and party owner P are two live players with
one shared fight. `DELETE FROM account WHERE id = D` removed the fight's `encounter_log` row
(1 → 0). P's `party_served_as_encounter` row stayed, pointing at a job that no longer exists, so
P's replay is lost. No server code issues this DELETE today (grep), but the guard is meant to hold
against a buggy or compromised process.

Fix: revoke DELETE on `account` (and on `caravan`) from `caravan_app`. Alternatively, add a BEFORE
DELETE trigger on `account` that refuses unless `public.account_erasure_active` holds this
transaction's row (after S2). Test: a direct DELETE as the app role → 42501 / 23514.

S4. **A guest loses their account to a second tab or a failed resume, by pressing "Start playing".**
Each device keeps at most `DEVICE_SESSIONS_MAX` = 3 sessions (tunables.ts:218), and every tab's
launch resume adds one, which evicts the oldest. The client re-resumes at most 3 times per load
(session.tsx:35, 96-101). Several in-flight calls 401 together, use up that budget, and the tab
falls back to the start screen. The start screen also appears whenever the launch resume fails for
any reason, a 5xx or the network included (session.tsx:118-120 swallows every error).

That screen offers "Start playing" and "Sign in". Both mint a NEW device and overwrite the cookie
(routes/account.ts:210-213, 221-228; `/auth/guest` never looks at an existing cookie). The guest
account then becomes unreachable for good.

Observed (Playwright, one guest, 5 tabs, each tab opening Account in turn, 2 rounds):
`r0t0..r0t4: acct`, then `r1t0: START r1t1: START`. Pressing "Start playing" in an evicted tab
created a new account and replaced the cookie, and a reload of the first tab resumed the NEW
account.

Fix (one session):
- Server: `/auth/guest`, `/auth/login` and `/auth/register` answer 409 `guest_on_device` when the
  request carries a live device cookie of an unlinked guest, unless `{replaceGuest: true}` is sent.
- Client: show "You have a guest caravan on this device — continue / leave it" in place of the
  start card.
- Client: tell `no_device` apart from other errors, and retry or offer "try again" instead of the
  start card.
- Raise `DEVICE_SESSIONS_MAX` (or evict per tab only beyond a larger cap).

Test: a web session test with five resumes and parallel 401s. A server test that `/auth/guest` with a
live guest cookie is refused.

## Design-level

D1. **The guest is never prompted to link outside the Account screen.** `T.guestWarning` is rendered
in one place only, AccountScreen.tsx:112-114. Observed at 320, 360 and 390 px: neither the first
screen nor the screen after Begin mentions the risk. A guest who never opens "Account" learns that
browser data is the only key only after losing it. The chunk asks for "a clear prompt to link before
data could be lost". Fix: a dismissible banner in the shell for guests, and a link card at moments of
value (first bank, first purchase — a guest can buy packs and lose them with the account, first party
saved). Test: the e2e checks the banner after the first bank.

D2. **"Leave this guest account" does not delete anything, but tells the player it is "gone for
good".** With `{abandon: true}`, `/auth/logout` deletes only the device (auth.ts:74-82). The account,
its caravan and its standing party stay. The party keeps being served into other players' trips
forever, and the data is unreachable for export or deletion. strings.ts:89 says "it is gone for
good".

Two fixes would work:
- Make abandon an erasure: `account_erase` with the caller's bearer token, which is available here.
- Or word it truthfully and offer delete first.

Also add a retention rule for guests whose every device has expired (180 d). They are the same kind
of zombie.

D3. **The per-IP rate limits will lock out a play test.** There is no `trustProxy` option (app.ts:77;
grep finds none). Behind any reverse proxy, `req.ip` is the proxy, so the limits become GLOBAL: 10
new guests per hour and 20 logins per 15 min for everyone (tunables.ts:240-249). Even with no proxy,
a play test at one venue (one NAT address) stops at 10 guest starts per hour (`guestPerIp`), and the
11th tester sees 429 on the first screen.

Fix:
- Add a `TRUST_PROXY` setting (refuse `true` without an explicit hop count or CIDR).
- Raise `guestPerIp` for the play test (e.g. 100 / h, TUNABLE) and pair it with a global ceiling.
- Write the multi-instance hand-off into the deploy checklist: in-memory windows per process mean N
  processes give N× the limits.

D4. **The export is incomplete, and it carries other players' record ids.**
- Missing. The export (service.ts:124-172) omits:
  - chunk 32's `account_analytics` (analytics id, opt-out) and the player's `analytics_client_event`
    rows (screen flow, crashes);
  - `wagon_manifest` / `wagon_formation` (the packing and camp layout, caravan data under
    GUARDRAILS §5);
  - `refugee_menu`;
  - `trip_cap` / `trip_cap_use`;
  - `inbox_read`;
  - the `encounter_candidates` menus of the player's own trips;
  - the replays themselves (only job id and outcome are included).
- Foreign ids. The redaction keys on `*AccountId` / `*_account_id` names only (service.ts:106). In
  the observed export (13.7 KB, a player with one fight each way) there were 14 ids of other
  players' records:
  - 9 trip ids, in `encounters[].job_id`, `ledger[].causation_id`, `payload.jobId` and
    `payload.tripId`;
  - 2 standing-party ids, in `payload.partyId` and `payload.party.partyId`;
  - 3 of the other player's unit-instance ids, in `payload.party.composition.units[].ref`.

Fix: add the missing sections. Redact by VALUE against the set of ids this player owns, not by key
name. Test: build both-way fights, then assert the export contains no UUID outside the player's own
set.

D5. **The tests miss the attacks above, and the DoD round trip has no client test.**
- account-lifecycle.test.ts:595-616 tries only attacks that READ, not ones that WRITE (S1, S3) or
  shadow (S2).
- The "no row names the deleted account" scan (test:483-490) uses `to_jsonb(r)::text`, which shows a
  `bytea` as hex. An id inside `encounter_log.log` (gzip) would never be found. It is clean today
  (probe), but the test is blind to it. Gunzip the log and check it.
- `e2e/account.spec.ts` stops at re-sign-in. The DoD asks for "guest → linked → deleted", and no e2e
  deletes.
- The web suite has no test of a resume that fails with something other than 401, or of parallel
  401s (S4).
- After a delete, the player lands silently on the start card: `STRINGS.account.deleted`
  (strings.ts:86) is never rendered. Observed at 360 and 390 px.

Fix:
- Add the e2e delete step: as a guest, type the phrase, see the confirmation, reload, and see the
  start card.
- Show the deleted notice.
- Add the tests named in S1–S4.

## Nits

N1. **The dashboard reclassifies erased players' fights as authored.**
analytics/queries.ts:109 computes `authored` as "the party owner `is_system`". The tombstone is a
system account, so after a party owner's erasure every past strike by their party counts as an
authored-party fight in the balance dashboard. Fix: exclude
`account_erasure_tombstone_account()` there, or add a third class, "departed".

N2. **Erasure does full scans in one transaction.** Step 4 is
`ledger_event … payload::text LIKE ANY` (020 up:404-408). EXPLAIN shows a Seq Scan. Step 5's
`to_jsonb(ec)::text LIKE` walks every other player's candidate menu. At chunk 36 scale this is
minutes inside one transaction, while holding the account row lock and the rewritten rows.
Coordinate with chunk 36. Options: narrow by causation or job ids, or use an id index (e.g. a GIN
index on `jsonb_path_ops` of known id keys).

N3. **Lockout and enumeration.** A known username can be locked out of password login by anyone,
10 tries per 15 min (`loginPerUsername`). Resume still works, but sign-in on a new device does not.
`/me/account/delete` checks the password outside the login limiter (10 per 15 min per account,
service.ts:76-82), so a stolen bearer token gives a second guessing channel. Register and link
answer `username_taken`. That is inherent, but it is unthrottled per account across guests (10
guests/h × 10 links/15 min per IP). Accepted risks: write them down, or share one per-username
counter between the three.

N4. **The Account button does nothing on the Welcome screen.** The header shows Account during
onboarding's welcome step, but App.tsx:84-87 replaces the screen with `WelcomeScreen` whatever the
route is. Observed at 320 px: tapping "Account" leaves Welcome on screen. Hide the button there, or
let the route through.

N5. **Stale migration text, and reset instructions that miss guests.** 020 down:8 still says
"019 down". The down migration refuses while any guest exists, but AGENTS.md's reset recipe deletes
only `is_system` accounts, so `db:reset` of a dev database with guests fails. Add
`OR username IS NULL` to the documented DELETE.

N6. **No "sign out everywhere".** Revoke-others keeps the current device, and there is no password
change. A linked player who suspects a leaked password can only revoke devices; the holder of the
password signs straight back in. Linking also keeps the guest's device credential unchanged
(observed: the same cookie resumes after link). For the play test, record this as a hand-off to
chunk 34.

N7. **A cookie-only resume from a sibling subdomain evicts sessions.** POST `/auth/resume` with
`text/plain` and only the cookie answers 200 (observed). SameSite=Strict still sends the cookie from
a same-SITE page, such as a sibling subdomain, and every such call evicts one of the device's 3
sessions (S4). Require `content-type: application/json` (a preflight) or a custom header on resume.

N8. **Pseudonymous ids of the erased player stay behind.** The erased player's unit-instance ids
remain in others' ledgers and job inputs. Probe: 7 ledger rows of other accounts, and both kept job
inputs (3 and 4 unit ids). The build notes accept trip and party ids, not unit ids. They name
nothing once the rows are gone, but they link the same player across fights. Either list them as
accepted or map them through the tombstone too.

N9. **An erased username can be registered again at once.** It is asserted as intended
(test:443-444). A newcomer can take a departed player's known handle. Consider reserving erased
handles for a period. This can be done without storing them in clear (a keyed hash).

N10. **The export has no size bound.** It reads the whole ledger and every trip into memory. That is
fine at play-test scale; note a cap or streaming for chunk 36.

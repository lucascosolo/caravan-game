# Hosting the play test

This is the runbook for putting Caravan Vaults in front of outside testers. It runs the game as
**one Node process** (the built server serves the client and the API) on one Linux host, behind
**Caddy** for HTTPS, with **Postgres 16** on the same host. Follow it top to bottom. Every command
is meant to be pasted as written, after you set the variables in step 0.

What the play-test build is:
- `NODE_ENV=production`. The server refuses to start with the repo's default database passwords,
  with the e2e test resolver, or with rate limits off. Source maps are never served. The device
  cookie is `Secure`, so the site **must** be served over HTTPS.
- `STORE_MODE=off`. This is the default in production. Packs are previewed but not sold, and the
  dashboard counts no store funnel.
- The seed creates no login accounts. `db:seed --dev` is refused in production.
- Encounters resolve in the server process with the real resolver. Replays older than 30 days are
  compacted to their summary every hour. Guests whose devices have all expired are erased by the
  same job.

## 0. Set the variables

```sh
export PT_DOMAIN=playtest.example.com     # the public name; DNS A/AAAA must point at this host
export PT_PG_HOST=localhost
export PT_PG_PORT=5432
export PT_DB=caravan_playtest             # one database per play test
export PT_PORT=3000                       # the Node process, on loopback only
export PT_ENV=/etc/caravan/playtest.env   # the environment file the server reads
export PT_REPO=/srv/caravan               # where the code lives
```

You need: Node 22, pnpm 10 (`corepack enable`), Postgres 16 (its `postgres` superuser through
`sudo -u postgres psql`), Caddy 2, `openssl`, and a host whose ports 80 and 443 are reachable
from the internet. Caddy uses those ports to get a certificate.

## 1. Get the code and build it

```sh
git clone <the repo URL> "$PT_REPO" && cd "$PT_REPO"
git checkout <the commit you are hosting>
pnpm install --frozen-lockfile
pnpm build
test -f apps/server/dist/index.js && test -f apps/web/dist/index.html && echo build ok
```

`pnpm build` writes `apps/server/dist` (the server, `db/migrate.js`, `seed.js`, `admin.js`) and
`apps/web/dist` (the client). Nothing else is needed at runtime except `node_modules`.

## 2. Create the roles and the database, with strong passwords

There are two roles. `caravan` **owns** the schema and runs migrations. `caravan_app` is the
DML-only role the server runs as; it cannot disable the schema's guards. The names are fixed:
`apps/server/db/roles.sql` grants by name. Use a Postgres instance dedicated to the play test,
because roles are cluster-wide.

```sh
PT_OWNER_PW="$(openssl rand -hex 24)"
PT_APP_PW="$(openssl rand -hex 24)"
sudo -u postgres psql -v ON_ERROR_STOP=1 -p "$PT_PG_PORT" <<SQL
CREATE ROLE caravan LOGIN PASSWORD '$PT_OWNER_PW' NOSUPERUSER NOCREATEROLE;
CREATE ROLE caravan_app LOGIN PASSWORD '$PT_APP_PW' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE DATABASE $PT_DB OWNER caravan;
SQL
```

If the roles already exist, for example from an earlier play test on this instance, set new
passwords instead: `ALTER ROLE caravan PASSWORD '…'; ALTER ROLE caravan_app PASSWORD '…';`.

If you must share an instance whose `caravan` / `caravan_app` are used by something else with
other passwords, do not touch those. Create two login roles that act as them instead, and use
these names in the URLs of step 3:

```sql
CREATE ROLE caravan_pt_owner LOGIN PASSWORD '<owner pw>' NOSUPERUSER NOCREATEROLE IN ROLE caravan;
ALTER ROLE caravan_pt_owner SET role = caravan;   -- objects stay owned by caravan, so roles.sql's grants apply
CREATE ROLE caravan_pt_app LOGIN PASSWORD '<app pw>' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE caravan_app;
```

The app role must carry no role-level setting; the server refuses one in production.
The passwords `caravan` and `caravan_app` from the repo are refused in production (step 4 shows
the error).

## 3. Write the environment file

```sh
sudo mkdir -p "$(dirname "$PT_ENV")"
sudo tee "$PT_ENV" > /dev/null <<ENV
NODE_ENV=production
DATABASE_URL=postgres://caravan_app:$PT_APP_PW@$PT_PG_HOST:$PT_PG_PORT/$PT_DB
MIGRATE_DATABASE_URL=postgres://caravan:$PT_OWNER_PW@$PT_PG_HOST:$PT_PG_PORT/$PT_DB
HOST=127.0.0.1
PORT=$PT_PORT
SERVE_WEB=1
TRUST_PROXY=1
STORE_MODE=off
ENV
sudo chmod 600 "$PT_ENV"
```

- `SERVE_WEB=1`: the server serves `apps/web/dist` at `/` and the API under `/api`. `WEB_DIST`
  overrides the directory.
- `TRUST_PROXY=1`: exactly one proxy (Caddy) sits in front. The per-address rate limits then key
  on the tester's address rather than Caddy's. Never set it without a proxy, or anyone could
  forge their address.
- `HOST=127.0.0.1`: only Caddy can reach the Node process.

Every script and the server read this file when you point `ENV_FILE` at it. Variables already set
in the environment win. Commands below run as `ENV_FILE="$PT_ENV" …`; a systemd unit uses
`EnvironmentFile=` instead (step 6).

## 4. Migrate

```sh
cd "$PT_REPO"
ENV_FILE="$PT_ENV" node apps/server/dist/db/migrate.js up
ENV_FILE="$PT_ENV" node apps/server/dist/db/migrate.js status | tail -3
```

`up` applies every migration as the owner, then `apps/server/db/roles.sql`: the app role's
grants, and no temporary objects for anyone. Expect `Applied: 1_core_schema, …` and then
`[x]` on every line of `status`. With a repo-default password it stops with:
`MIGRATE_DATABASE_URL uses a default password from this repo; set a strong one … Refused when
NODE_ENV=production`.

## 5. Seed the cold-start parties

```sh
ENV_FILE="$PT_ENV" node apps/server/dist/seed.js
```

This loads the 96 authored standing parties (12 per Reputation band) that a fresh database needs
to serve three scoutable candidates at every band. Expect `Authored parties (set v4): 96 created …`
and `No login accounts were created`. It is idempotent. `--dev` (the dev / e2e fixture account
with a published password) is refused here: `seed --dev is refused when NODE_ENV=production`.

## 6. Run the server

Try it in the foreground first:

```sh
ENV_FILE="$PT_ENV" node apps/server/dist/index.js
```

The first log lines must say: `encounters resolve in-process with the real resolver`,
`store: off (packs previewed, not sold)`, `serving the client from …/apps/web/dist; API under
/api; source maps not served`, `Server listening at http://127.0.0.1:3000`. In a second shell,
`curl -s http://127.0.0.1:$PT_PORT/health` answers `{"ok":true}`. Stop it with Ctrl-C.

Then run it under systemd (`/etc/systemd/system/caravan.service`):

```ini
[Unit]
Description=Caravan Vaults play test
After=network.target postgresql.service

[Service]
WorkingDirectory=/srv/caravan
EnvironmentFile=/etc/caravan/playtest.env
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
User=caravan
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now caravan && journalctl -u caravan -n 20
```

The server refuses to start, and says why in the log, if any of these hold:
- a default or empty database password;
- `CARAVAN_TEST_RESOLVER` is set;
- `CARAVAN_RATE_LIMITS=off`;
- `TRUST_PROXY=true`;
- `SERVE_WEB=1` with no built client;
- the app role carries a role-level setting (`ALTER ROLE caravan_app RESET ALL` clears it).

A crash or restart is safe. A fight whose resolver died holding the job's lease is picked up
again when the 30 s lease expires, and its trip continues.

## 7. HTTPS with Caddy

`/etc/caddy/Caddyfile`:

```caddyfile
{$PT_DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:{$PT_PORT}
}
```

```sh
sudo env PT_DOMAIN="$PT_DOMAIN" PT_PORT="$PT_PORT" caddy run --config /etc/caddy/Caddyfile   # or: systemctl reload caddy, with the two variables in Caddy's environment
```

Caddy obtains and renews the certificate itself, redirects http to https and sets
`X-Forwarded-For`, which `TRUST_PROXY=1` trusts. The server already sends the security headers
(CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`). Do not add another
CSP in Caddy.

To rehearse on one machine without a public name, use `PT_DOMAIN=localhost`. Caddy then uses its
own local CA, which `caddy run` installs into the system, NSS and Java trust stores. Remove it
afterwards with `caddy untrust --cert ~/.local/share/caddy/pki/authorities/local/root.crt`.
`curl --cacert` takes that same root (`/root/.local/…` under sudo).

Check from outside:

```sh
curl -sS https://$PT_DOMAIN/health                         # {"ok":true}
curl -sS https://$PT_DOMAIN/api/health                     # {"ok":true}
curl -sSI https://$PT_DOMAIN/ | grep -i -E '^(content-security-policy|x-frame-options|strict-transport)'
curl -s -o /dev/null -w '%{http_code}\n' https://$PT_DOMAIN/assets/$(ls apps/web/dist/assets | grep '\.js\.map$' | head -1)   # 404: no source maps
```

Then open `https://$PT_DOMAIN/` on a phone. Start as a guest, then link a username under
Account.

## 8. Grant admin

Sign up in the game with the username you will use as the operator, then:

```sh
ENV_FILE="$PT_ENV" node apps/server/dist/admin.js grant <username> --by "$USER"
ENV_FILE="$PT_ENV" node apps/server/dist/admin.js list
```

The admin flag can only be written over the owner connection; no HTTP route writes it. `revoke
<username>` takes it away.

## 9. Read the dashboard

Signed in as the admin, open `https://$PT_DOMAIN/#/admin`. Everyone else gets a plain "not found",
as if the screen did not exist. The same data is at `GET /api/admin/dashboard?days=N&week=W`
(bearer token of an admin session; `days` 1–120).

Every panel is derived from the ledger. It counts only players who have not opted out of usage
data, except where a panel says otherwise. The ones the play test is for:
- trip length and bank-vs-push;
- overrun share by band;
- the matchup, unit, stance, fence and trap panels;
- the ladder and the unlock purchases;
- merge spend;
- the grind-wall probe;
- session length and retention;
- screen flow and crashes;
- pool health, whose alarms mean a band has too few parties to serve.

With `STORE_MODE=off` the pack funnel reads "not counted". The tuning table maps each panel to the
`TUNABLES` it informs.

## 10. Backups

The database is the whole state. Take a custom-format dump as the owner, nightly and before every
upgrade or reset:

```sh
sudo mkdir -p /var/backups/caravan
PGPASSWORD="$PT_OWNER_PW" pg_dump -Fc -h "$PT_PG_HOST" -p "$PT_PG_PORT" -U caravan -d "$PT_DB" -f /var/backups/caravan/$PT_DB-$(date -u +%Y%m%dT%H%MZ).dump
```

The cron line is `0 4 * * * caravan PGPASSWORD=… pg_dump …` with the same arguments; keep about
14 dumps.

Rehearse a restore into a scratch database. The server must not be pointed at it until the
grants are re-applied:

```sh
sudo -u postgres createdb -p "$PT_PG_PORT" -O caravan ${PT_DB}_restore
PGPASSWORD="$PT_OWNER_PW" pg_restore -h "$PT_PG_HOST" -p "$PT_PG_PORT" -U caravan -d ${PT_DB}_restore --no-owner --role=caravan <dump file>
MIGRATE_DATABASE_URL=postgres://caravan:$PT_OWNER_PW@$PT_PG_HOST:$PT_PG_PORT/${PT_DB}_restore NODE_ENV=production node apps/server/dist/db/migrate.js roles
```

## 11. Reset between cohorts

Back up first (step 10). Then stop the server and empty every account. The schema's guards allow
the account cascade and nothing else. Re-apply the schema, re-seed and re-grant:

```sh
sudo systemctl stop caravan
PGPASSWORD="$PT_OWNER_PW" psql -v ON_ERROR_STOP=1 -h "$PT_PG_HOST" -p "$PT_PG_PORT" -U caravan -d "$PT_DB" -c "DELETE FROM account"
ENV_FILE="$PT_ENV" node apps/server/dist/db/migrate.js reset
ENV_FILE="$PT_ENV" node apps/server/dist/seed.js
sudo systemctl start caravan
# sign up the operator again, then step 8
```

Testers' devices still hold a cookie for the old database. `POST /api/auth/resume` now refuses it
(401 `no_device`), so they start again from the first screen.

## 12. Upgrading during the play test

```sh
cd "$PT_REPO" && git fetch && git checkout <new commit> && pnpm install --frozen-lockfile && pnpm build
# back up (step 10), then:
ENV_FILE="$PT_ENV" node apps/server/dist/db/migrate.js up
ENV_FILE="$PT_ENV" node apps/server/dist/seed.js   # a changed authored set updates in place
sudo systemctl restart caravan
```

An open tab keeps running the old client until it reloads. Ask testers to reload after an upgrade.

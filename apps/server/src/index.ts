import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { assertProductionDatabaseUrl, databaseUrl, loadDotEnv, serveWebFromEnv } from "./config.js";
import { RoleSettingsCheckError, readRoleSettings } from "./db/roleSettings.js";
import { inlineWorkerFromEnv } from "./dev/testResolver.js";

// Final review N2: the repo's .env (never overriding the real environment).
loadDotEnv();
// Final review S2: in production the connection must be explicit and must not use a repo default password.
assertProductionDatabaseUrl(process.env, process.env["DATABASE_URL"], "DATABASE_URL");
// Throws (the process refuses to start) when CARAVAN_TEST_RESOLVER is set with NODE_ENV=production.
const inlineEncounterWorker = inlineWorkerFromEnv(process.env);
// Final review S2: SERVE_WEB=1 serves the built client and mounts the API under /api. dist/index.js and
// src/index.ts both sit two levels below apps/, so the default client directory is the same for both.
const here = path.dirname(fileURLToPath(import.meta.url));
const serveWeb = serveWebFromEnv(process.env, path.resolve(here, "..", "..", "web", "dist"));
// Final review N7 (r2 N4: read first, over a connection whose own options override the role's
// timeouts, so the refusal is this message and not a crash): a role-level setting on the server's
// own role (ALTER ROLE … SET) is refused in production.
const production = process.env["NODE_ENV"] === "production";
let settings: string[];
try {
  settings = await readRoleSettings(databaseUrl());
} catch (err) {
  if (!(err instanceof RoleSettingsCheckError)) throw err;
  console.error(`refusing to start: ${err.message}`);
  process.exit(1);
}
if (settings.length > 0 && production) {
  console.error(`refusing to start: the database role has role-level settings (${settings.join("; ")}); clear them with ALTER ROLE … RESET ALL (docs/PLAYTEST-HOSTING.md, step 6)`);
  process.exit(1);
}
// QA-13 S1: the server drains the job queue in-process — with the real resolver unless the flag swaps in the double.
// PHASE-2 §36: and runs the replay-retention sweep (compaction) on a schedule.
const app = await buildApp({ logger: true, inlineEncounterWorker, encounterWorker: true, retentionJob: true, serveWeb });
if (settings.length > 0) app.log.warn(`the database role has role-level settings (${settings.join("; ")}); clear them with ALTER ROLE … RESET ALL`);
if (inlineEncounterWorker) app.log.warn(`CARAVAN_TEST_RESOLVER: encounters resolve with the ${inlineEncounterWorker.name} (dev/test only)`);
else app.log.info(`encounter worker ${app.encounterWorker?.workerId ?? "(none)"}: encounters resolve in-process with the real resolver`);
app.log.info(`store: ${app.storeMode === "off" ? "off (packs previewed, not sold)" : "sandbox ($0 purchases)"}`);
// Final guardrail review r3 N4: only reachable with STORE_SANDBOX_IN_PRODUCTION=1 (config.ts refuses it otherwise).
if (app.storeMode === "sandbox" && process.env["NODE_ENV"] === "production") {
  app.log.warn("WARNING: STORE_MODE=sandbox under NODE_ENV=production (STORE_SANDBOX_IN_PRODUCTION=1): every pack is sold for $0 — players get free Coin. Never for a play test.");
}
if (serveWeb) app.log.info(`serving the client from ${serveWeb.dir}; API under /api${serveWeb.production ? "; source maps not served" : ""}`);
const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "127.0.0.1";
await app.listen({ port, host });

// Final guardrail review r2 N4: graceful shutdown. On SIGTERM / SIGINT (systemctl stop / restart,
// Ctrl-C): stop accepting connections and finish the requests in flight, stop the encounter worker
// leasing (a fight already leased finishes and commits), stop the retention sweep, close the pool,
// then exit 0. A shutdown that hangs is cut off after SHUTDOWN_GRACE_MS (exit 1); any fight it
// still held is re-leased by the next process when its lease expires.
const SHUTDOWN_GRACE_MS = 20_000;
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal}: shutting down (no new leases; finishing requests and the fight in progress)`);
    const timer = setTimeout(() => {
      app.log.error(`shutdown took longer than ${SHUTDOWN_GRACE_MS} ms; exiting`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    app
      .close()
      .then(() => {
        app.log.info("shut down cleanly");
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error(err, "shutdown failed");
        process.exit(1);
      });
  });
}

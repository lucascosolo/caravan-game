import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { assertProductionDatabaseUrl, loadDotEnv, serveWebFromEnv } from "./config.js";
import { checkRoleSettings } from "./db/roleSettings.js";
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
// QA-13 S1: the server drains the job queue in-process — with the real resolver unless the flag swaps in the double.
// PHASE-2 §36: and runs the replay-retention sweep (compaction) on a schedule.
const app = await buildApp({ logger: true, inlineEncounterWorker, encounterWorker: true, retentionJob: true, serveWeb });
// Final review N7: a role-level setting on the server's own role (ALTER ROLE … SET) is refused in production.
const settings = await checkRoleSettings(app.db);
if (settings.length > 0) {
  const msg = `the database role has role-level settings (${settings.join("; ")}); clear them with ALTER ROLE … RESET ALL`;
  if (process.env["NODE_ENV"] === "production") {
    app.log.error(msg);
    await app.close();
    process.exit(1);
  }
  app.log.warn(msg);
}
if (inlineEncounterWorker) app.log.warn(`CARAVAN_TEST_RESOLVER: encounters resolve with the ${inlineEncounterWorker.name} (dev/test only)`);
else app.log.info(`encounter worker ${app.encounterWorker?.workerId ?? "(none)"}: encounters resolve in-process with the real resolver`);
app.log.info(`store: ${app.storeMode === "off" ? "off (packs previewed, not sold)" : "sandbox ($0 purchases)"}`);
if (serveWeb) app.log.info(`serving the client from ${serveWeb.dir}; API under /api${serveWeb.production ? "; source maps not served" : ""}`);
const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "127.0.0.1";
await app.listen({ port, host });

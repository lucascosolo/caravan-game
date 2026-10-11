import { buildApp } from "./app.js";
import { inlineWorkerFromEnv } from "./dev/testResolver.js";

// Throws (the process refuses to start) when CARAVAN_TEST_RESOLVER is set with NODE_ENV=production.
const inlineEncounterWorker = inlineWorkerFromEnv(process.env);
const app = await buildApp({ logger: true, inlineEncounterWorker });
if (inlineEncounterWorker) app.log.warn(`CARAVAN_TEST_RESOLVER: encounters resolve with the ${inlineEncounterWorker.name} (dev/test only)`);
const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "127.0.0.1";
await app.listen({ port, host });

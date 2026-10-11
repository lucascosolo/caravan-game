import { buildApp } from "./app.js";
import { inlineWorkerFromEnv } from "./dev/testResolver.js";

// Throws (the process refuses to start) when CARAVAN_TEST_RESOLVER is set with NODE_ENV=production.
const inlineEncounterWorker = inlineWorkerFromEnv(process.env);
// QA-13 S1: the server drains the job queue in-process — with the real resolver unless the flag swaps in the double.
// PHASE-2 §36: and runs the replay-retention sweep (compaction) on a schedule.
const app = await buildApp({ logger: true, inlineEncounterWorker, encounterWorker: true, retentionJob: true });
if (inlineEncounterWorker) app.log.warn(`CARAVAN_TEST_RESOLVER: encounters resolve with the ${inlineEncounterWorker.name} (dev/test only)`);
else app.log.info(`encounter worker ${app.encounterWorker?.workerId ?? "(none)"}: encounters resolve in-process with the real resolver`);
const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "127.0.0.1";
await app.listen({ port, host });

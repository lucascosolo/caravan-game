/**
 * Rebuild-from-zero check: replays every account's ledger in application code and
 * compares with the live projected columns. Exit code 1 on any mismatch.
 *
 *   tsx src/ledger/rebuild.ts [accountId ...]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../db/pool.js";
import { verifyProjection } from "./projection.js";

export async function rebuildAll(pool: Parameters<typeof verifyProjection>[0], accountIds?: string[]): Promise<{ checked: number; mismatches: string[] }> {
  const ids =
    accountIds && accountIds.length > 0
      ? accountIds
      : (await pool.query<{ id: string }>("SELECT id FROM account ORDER BY created_at, id")).rows.map((r) => r.id);
  const mismatches: string[] = [];
  for (const id of ids) {
    // One bad account is reported as a mismatch and never stops the sweep (QA-02 S3).
    let r: Awaited<ReturnType<typeof verifyProjection>> | undefined;
    let failure: string | undefined;
    try {
      r = await verifyProjection(pool, id);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const ok = r?.ok === true;
    if (!ok) mismatches.push(id);
    console.log(`${ok ? "ok  " : "DIFF"} ${id}${r ? ` (${r.eventsFolded} events)` : ""}`);
    if (failure) console.log("  error:   ", failure);
    if (r && !r.ok) {
      if (r.error) console.log("  error:   ", r.error);
      console.log("  live:    ", JSON.stringify(r.live));
      console.log("  rebuilt: ", JSON.stringify(r.rebuilt));
      if (r.snapshot && !r.snapshot.ok) {
        console.log(`  snapshot through ${r.snapshot.throughSeq} disagrees with the log:`);
        console.log("  stored:  ", JSON.stringify(r.snapshot.stored));
        console.log("  refold:  ", JSON.stringify(r.snapshot.rebuilt));
      }
    }
  }
  return { checked: ids.length, mismatches };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  rebuildAll(pool, process.argv.slice(2))
    .then(({ checked, mismatches }) => {
      console.log(`${checked} account(s) checked, ${mismatches.length} mismatch(es).`);
      process.exitCode = mismatches.length ? 1 : 0;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

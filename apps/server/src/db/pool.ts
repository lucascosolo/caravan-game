import pg from "pg";
import { databaseUrl } from "../config.js";

export type Queryable = pg.Pool | pg.PoolClient;

/**
 * bigint (OID 20) columns come back as strings by default. Chunk 01 parses them to Number
 * because its only bigint columns are Coin, which the storage cap keeps far below 2^53.
 *
 * THIS IS LOSSY ABOVE Number.MAX_SAFE_INTEGER (2^53 - 1). It is a process-wide setting,
 * so any later bigint column inherits it: chunk 02's ledger `seq` (bigserial) and any
 * other unbounded counter must either (a) stay provably below 2^53 for the life of the
 * game, or (b) be read as text / BigInt explicitly in its own queries (`seq::text`) and
 * never flow through this parser. Pick deliberately; do not assume.
 */
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString: string = databaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run `fn` inside a transaction; commits on success, rolls back on throw. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

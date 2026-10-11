import pg from "pg";
import { databaseUrl } from "../config.js";

export type Queryable = pg.Pool | pg.PoolClient;

/** bigint columns come back as strings by default; the schema only uses bigint for Coin,
 *  which fits comfortably in a JS number, so parse them. */
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

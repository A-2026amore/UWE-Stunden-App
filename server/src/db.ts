/**
 * Database access. The pool logs in as `app_api` (NOINHERIT, no rights of its
 * own). Every request runs in its own transaction that switches to a request
 * role with `set local role` and sets the verified user id as
 * `request.jwt.claims` (transaction-local, safe with connection pooling).
 */
import pg from "pg";

export type RequestRole = "app_user" | "app_anon" | "app_auth";
export type Queryable = Pick<pg.PoolClient, "query">;

const ROLES: ReadonlySet<RequestRole> = new Set(["app_user", "app_anon", "app_auth"]);

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "uwe-zeit-api",
    types: {
      getTypeParser(oid: number, format?: string) {
        // date → keep "YYYY-MM-DD" (no timezone shifts through JS Date)
        if (oid === 1082) return (v: string) => v;
        return pg.types.getTypeParser(oid, format as "text");
      },
    } as pg.CustomTypesConfig,
  });
  // An idle client error must not crash the process.
  pool.on("error", (err) => {
    console.error(JSON.stringify({ level: "error", msg: "pg pool error", code: (err as { code?: string }).code ?? null }));
  });
  return pool;
}

/**
 * Runs fn in a transaction as the given request role. userId must come from a
 * verified session (never from client input). Rolled back on any error.
 */
export async function withTx<T>(
  pool: pg.Pool,
  role: RequestRole,
  userId: string | null,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  if (!ROLES.has(role)) throw new Error("invalid request role");
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`); // role is from the fixed allow-list above
    await client.query("set local statement_timeout = '15s'");
    await client.query("select set_config('request.jwt.claims', $1, true)", [userId ? JSON.stringify({ sub: userId }) : ""]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      broken = true;
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

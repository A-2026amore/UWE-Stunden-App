/**
 * Test harness for the database tests (vitest project "db").
 *
 * - DATABASE_URL set (CI: postgres:16 service container): a fresh, uniquely
 *   named database is created on that server for each test file and dropped
 *   afterwards. The URL must point to a superuser (migrations create roles).
 * - Otherwise a throwaway PostgreSQL 16 cluster is started with initdb/pg_ctl
 *   in a temp directory on a free port. PostgreSQL refuses to run as root, so
 *   when running as root the cluster is owned by and started as "postgres".
 *
 * Each test file gets a database with db/migrations/*.sql + db/seed.sql applied.
 * Requests are impersonated like the API does it:
 *   begin; set local role app_user; set_config('request.jwt.claims', '{"sub": …}', true)
 */
import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve(__dirname, "../../..");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const SEED_FILE = join(ROOT, "db", "seed.sql");

export const IDS = {
  tenantA: "11111111-1111-4111-8111-111111111111",
  tenantB: "22222222-2222-4222-8222-222222222222",
  users: {
    ownerA: "a0000000-0000-4000-8000-000000000001",
    managerA: "a0000000-0000-4000-8000-000000000002",
    emp1A: "a0000000-0000-4000-8000-000000000003",
    emp2A: "a0000000-0000-4000-8000-000000000004",
    ownerB: "b0000000-0000-4000-8000-000000000001",
    empB: "b0000000-0000-4000-8000-000000000003",
    superAdmin: "c0000000-0000-4000-8000-000000000001",
    support: "c0000000-0000-4000-8000-000000000002",
  },
  employees: {
    ownerA: "ae000000-0000-4000-8000-000000000001",
    managerA: "ae000000-0000-4000-8000-000000000002",
    emp1A: "ae000000-0000-4000-8000-000000000003",
    emp2A: "ae000000-0000-4000-8000-000000000004",
    ownerB: "be000000-0000-4000-8000-000000000001",
    empB: "be000000-0000-4000-8000-000000000003",
    invitedB: "be000000-0000-4000-8000-000000000004",
  },
  invitationTokenB: "demo-einladung-nur-fuer-tests",
} as const;

type Queryable = Pick<pg.Client, "query">;
export type RequestRole = "app_user" | "app_anon" | "app_auth";

export interface TestDb {
  /** Superuser connection (migration owner). */
  admin: pg.Client;
  /** Connection string of the test database (for additional, e.g. parallel, connections). */
  url: string;
  /** Run fn inside a transaction as a request role impersonating userId. Rolled back unless commit. */
  as<T>(userId: string | null, fn: (q: Queryable) => Promise<T>, opts?: { role?: RequestRole; commit?: boolean }): Promise<T>;
  close(): Promise<void>;
}

function findPgBin(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = "/usr/lib/postgresql";
  if (existsSync(base)) {
    const versions = readdirSync(base).filter((v) => existsSync(join(base, v, "bin", "initdb"))).sort((a, b) => Number(b) - Number(a));
    if (versions[0]) return join(base, versions[0], "bin");
  }
  return ""; // rely on PATH
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

interface Cluster { url: string; stop(): void }

async function startCluster(): Promise<Cluster> {
  const bin = findPgBin();
  const exe = (name: string) => (bin ? join(bin, name) : name);
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const dir = mkdtempSync(join(tmpdir(), "uwe-pg-"));
  const dataDir = join(dir, "data");
  const run = (cmd: string, args: string[]) => {
    if (isRoot) execFileSync("runuser", ["-u", "postgres", "--", cmd, ...args], { stdio: "pipe" });
    else execFileSync(cmd, args, { stdio: "pipe" });
  };
  if (isRoot) {
    const uid = Number(execFileSync("id", ["-u", "postgres"]).toString().trim());
    const gid = Number(execFileSync("id", ["-g", "postgres"]).toString().trim());
    chownSync(dir, uid, gid);
  }
  const port = await freePort();
  run(exe("initdb"), ["-D", dataDir, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C.UTF-8", "--no-sync"]);
  run(exe("pg_ctl"), [
    "-D", dataDir, "-w", "-l", join(dir, "server.log"),
    "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c timezone=Europe/Berlin`,
    "start",
  ]);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        run(exe("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export async function applySchema(client: Queryable, withSeed = true): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    try {
      await client.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  if (withSeed) await client.query(readFileSync(SEED_FILE, "utf8"));
}

export async function setupTestDb(opts: { seed?: boolean } = {}): Promise<TestDb> {
  let cluster: Cluster | null = null;
  let dbUrl: string;
  let dropDb: (() => Promise<void>) | null = null;

  if (process.env.DATABASE_URL) {
    const serverUrl = process.env.DATABASE_URL;
    const name = `uwe_test_${process.pid}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    const c = new pg.Client({ connectionString: serverUrl });
    await c.connect();
    await c.query(`create database ${name}`);
    await c.end();
    const u = new URL(serverUrl);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    dropDb = async () => {
      const d = new pg.Client({ connectionString: serverUrl });
      await d.connect();
      await d.query(`drop database if exists ${name} with (force)`);
      await d.end();
    };
  } else {
    cluster = await startCluster();
    dbUrl = cluster.url;
  }

  const admin = new pg.Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query("set timezone = 'Europe/Berlin'");
  // Cluster-wide objects (roles) must not be created concurrently by parallel
  // test files sharing one server: serialise schema setup with an advisory
  // lock held in the server's maintenance database.
  const lock = new pg.Client({ connectionString: process.env.DATABASE_URL ?? dbUrl });
  await lock.connect();
  try {
    await lock.query("select pg_advisory_lock(727001)");
    await applySchema(admin, opts.seed ?? true);
  } finally {
    await lock.end(); // releases the session lock
  }

  const as: TestDb["as"] = async (userId, fn, o = {}) => {
    const role = o.role ?? "app_user";
    await admin.query("begin");
    try {
      await admin.query(`set local role ${role}`);
      await admin.query("select set_config('request.jwt.claims', $1, true)", [
        userId ? JSON.stringify({ sub: userId, role }) : "",
      ]);
      const result = await fn(admin);
      await admin.query(o.commit ? "commit" : "rollback");
      return result;
    } catch (e) {
      await admin.query("rollback");
      throw e;
    }
  };

  return {
    admin,
    url: dbUrl,
    as,
    async close() {
      await admin.end();
      if (dropDb) await dropDb();
      if (cluster) cluster.stop();
    },
  };
}

/** Resolves to the pg error (with .code) of a rejected promise; fails if it resolves. */
export async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code ?? "", message: err.message };
  }
  throw new Error("Expected a database error, but the statement succeeded.");
}

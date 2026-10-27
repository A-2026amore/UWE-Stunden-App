/**
 * One-off migration job (container: `docker compose run --rm migrate`):
 *
 *   node --import ./server/register.mjs server/src/migrate.ts
 *
 * - Connects with MIGRATION_DATABASE_URL (database owner / superuser – never the
 *   runtime role app_api). Migrations create roles, schemas and RLS policies.
 * - Applies db/migrations/NNNN_*.sql in file order, each in its own transaction,
 *   and records name + SHA-256 in ops.schema_migrations. Already applied files are
 *   skipped; a changed file aborts (migrations are additive, never edited).
 * - An advisory lock prevents two concurrent runs.
 * - APP_API_PASSWORD set: `alter role app_api login password …` (runtime role,
 *   NOINHERIT, no BYPASSRLS). The password is never logged.
 * - MIGRATE_SEED=1: additionally loads db/seed.sql (demo tenants) once. Refused
 *   with NODE_ENV=production. Only for the test environment.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(ROOT, "db", "migrations");
const SEED_FILE = join(ROOT, "db", "seed.sql");
const SEED_NAME = "seed.sql";
// Arbitrary but fixed key for pg_advisory_lock ("stunden-migrate").
const LOCK_KEY = 0x5354_4d47;

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: "info", msg, ...extra }));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface MigrateOptions {
  url: string;
  appApiPassword?: string;
  seed?: boolean;
  production?: boolean;
  migrationsDir?: string;
}

export async function migrate(opts: MigrateOptions): Promise<{ applied: string[]; skipped: string[] }> {
  if (opts.seed && opts.production) throw new Error("MIGRATE_SEED=1 ist mit NODE_ENV=production verboten (Demo-Daten).");
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (files.length === 0) throw new Error(`Keine Migrationen in ${dir} gefunden.`);

  const client = new pg.Client({ connectionString: opts.url, application_name: "stunden-migrate" });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      create schema if not exists ops;
      revoke all on schema ops from public;
      create table if not exists ops.schema_migrations (
        name       text primary key,
        sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default now()
      );
      revoke all on ops.schema_migrations from public;`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; sha256: string }>("select name, sha256 from ops.schema_migrations")).rows.map((r) => [r.name, r.sha256]),
    );

    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      const hash = sha256(sql);
      const prev = done.get(f);
      if (prev) {
        if (prev !== hash) throw new Error(`Migration ${f} wurde nach dem Einspielen verändert (Prüfsumme weicht ab). Abbruch.`);
        skipped.push(f);
        continue;
      }
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into ops.schema_migrations (name, sha256) values ($1, $2)", [f, hash]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw new Error(`Migration ${f} fehlgeschlagen: ${(e as Error).message}`);
      }
      applied.push(f);
      log("Migration eingespielt", { name: f });
    }

    if (opts.seed) {
      if (done.has(SEED_NAME)) {
        skipped.push(SEED_NAME);
      } else {
        const sql = readFileSync(SEED_FILE, "utf8");
        // seed.sql runs its own transaction (begin … commit).
        await client.query(sql);
        await client.query("insert into ops.schema_migrations (name, sha256) values ($1, $2)", [SEED_NAME, sha256(sql)]);
        applied.push(SEED_NAME);
        log("Demo-Daten eingespielt (nur Testumgebung)", { name: SEED_NAME });
      }
    }

    if (opts.appApiPassword) {
      if (opts.appApiPassword.length < 16) throw new Error("APP_API_PASSWORD muss mindestens 16 Zeichen lang sein.");
      await client.query(`alter role app_api login password ${client.escapeLiteral(opts.appApiPassword)}`);
      log("Laufzeitrolle app_api: Anmeldung aktiviert, Passwort gesetzt");
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return { applied, skipped };
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL ?? "";
  if (!url) {
    console.error("MIGRATION_DATABASE_URL fehlt (Verbindung als Datenbank-Eigentümer, nicht als app_api).");
    process.exit(2);
  }
  try {
    const r = await migrate({
      url,
      appApiPassword: process.env.APP_API_PASSWORD || undefined,
      seed: process.env.MIGRATE_SEED === "1",
      production: process.env.NODE_ENV === "production",
    });
    log("Migrationen abgeschlossen", { eingespielt: r.applied.length, uebersprungen: r.skipped.length });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: (e as Error).message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

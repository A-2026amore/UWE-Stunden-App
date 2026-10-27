/**
 * Migration job (server/src/migrate.ts) used by the container setup in deploy/:
 * fresh database → all migrations once, rerun is a no-op, edited files abort,
 * the runtime role app_api can log in but has no BYPASSRLS, seed is opt-in.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../server/src/migrate.ts";
import { setupTestDb, type TestDb } from "../db/support/harness.ts";

const MIGRATIONS = resolve(__dirname, "../../db/migrations");
const PASSWORD = "nur-fuer-tests-migration";

let db: TestDb;
let base: { host: string; port: number; user: string; password: string | undefined };
const created: string[] = [];

// Superuser credentials of the harness (CI: DATABASE_URL with password; locally: trust).
function url(database: string, user = base.user, password = user === base.user ? base.password : undefined): string {
  const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
  return `postgres://${auth}@${base.host}:${base.port}/${database}`;
}

async function freshDatabase(): Promise<string> {
  const name = `uwe_migrate_${process.pid}_${created.length}_${Date.now().toString(36)}`;
  await db.admin.query(`create database ${name}`);
  created.push(name);
  return name;
}

beforeAll(async () => {
  db = await setupTestDb({ seed: false });
  const a = db.admin as unknown as { host: string; port: number; user: string; password?: string };
  base = { host: a.host, port: a.port, user: a.user, password: a.password || undefined };
});

afterAll(async () => {
  for (const name of created) await db.admin.query(`drop database if exists ${name} with (force)`);
  // Other test files set their own app_api password; restore the usual one anyway.
  await db.admin.query("alter role app_api login password 'nur-fuer-tests'");
  await db.close();
});

describe("migration job", () => {
  it("applies every migration once and records it; a rerun changes nothing", async () => {
    const name = await freshDatabase();
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const first = await migrate({ url: url(name), appApiPassword: PASSWORD });
    expect(first.applied).toEqual(files);
    const second = await migrate({ url: url(name) });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(files);

    const c = new pg.Client({ connectionString: url(name) });
    await c.connect();
    try {
      const rows = (await c.query("select name from ops.schema_migrations order by name")).rows.map((r) => r.name);
      expect(rows).toEqual(files);
      // No demo data without MIGRATE_SEED.
      expect((await c.query("select count(*)::int as n from public.tenants")).rows[0].n).toBe(0);
      // Runtime role: login, no superuser, no BYPASSRLS, NOINHERIT; request roles have no BYPASSRLS either.
      const roles = (await c.query(
        "select rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit from pg_roles where rolname in ('app_api','app_user','app_anon','app_auth') order by 1",
      )).rows;
      expect(roles.find((r) => r.rolname === "app_api")).toMatchObject({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolinherit: false });
      expect(roles.every((r) => r.rolbypassrls === false && r.rolsuper === false)).toBe(true);
    } finally {
      await c.end();
    }

    // The API's connection works with the password set by the job and cannot read ops.*.
    const api = new pg.Client({ connectionString: url(name, "app_api", PASSWORD) });
    await api.connect();
    try {
      await api.query("begin; set local role app_anon");
      expect((await api.query("select 1 as ok")).rows[0].ok).toBe(1);
      await api.query("rollback");
      await expect(api.query("select * from ops.schema_migrations")).rejects.toThrow(/permission denied/);
    } finally {
      await api.end();
    }
  });

  it("aborts when an applied migration file was edited", async () => {
    const name = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), "uwe-migrations-"));
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      await migrate({ url: url(name), migrationsDir: dir });
      const first = readdirSync(dir).sort()[0]!;
      appendFileSync(join(dir, first), "\n-- nachträglich geändert\n");
      await expect(migrate({ url: url(name), migrationsDir: dir })).rejects.toThrow(/verändert/);
      // A failing new migration is rolled back completely and not recorded.
      cpSync(MIGRATIONS, dir, { recursive: true });
      writeFileSync(join(dir, "9999_kaputt.sql"), "create table public.zz_test (id int); select 1/0;");
      await expect(migrate({ url: url(name), migrationsDir: dir })).rejects.toThrow(/9999_kaputt\.sql/);
      const c = new pg.Client({ connectionString: url(name) });
      await c.connect();
      try {
        expect((await c.query("select to_regclass('public.zz_test') as t")).rows[0].t).toBeNull();
        expect((await c.query("select count(*)::int as n from ops.schema_migrations where name = '9999_kaputt.sql'")).rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads demo data only on request and never in production", async () => {
    const name = await freshDatabase();
    await expect(migrate({ url: url(name), seed: true, production: true })).rejects.toThrow(/MIGRATE_SEED/);
    const r = await migrate({ url: url(name), seed: true });
    expect(r.applied).toContain("seed.sql");
    expect((await migrate({ url: url(name), seed: true })).skipped).toContain("seed.sql");
    await expect(migrate({ url: url(name), appApiPassword: "zu-kurz" })).rejects.toThrow(/16 Zeichen/);
  });
});

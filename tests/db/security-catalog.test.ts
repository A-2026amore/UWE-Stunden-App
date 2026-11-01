/**
 * Structural security properties of the schema, checked in the PostgreSQL
 * catalog after all migrations (security review 2026-10-28). They protect
 * against regressions in future migrations:
 *  - every SECURITY DEFINER function pins search_path = '' (no hijacking via
 *    objects in a schema on the caller's path)
 *  - RLS is enabled on every table in public and auth
 *  - views run with the caller's rights (security_invoker)
 *  - nothing is granted to PUBLIC; the anonymous role reaches only the
 *    intended functions; request roles never touch auth.* / private.* tables
 *  - the API login role cannot bypass RLS
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
beforeAll(async () => {
  db = await setupTestDb({ seed: false });
});
afterAll(async () => {
  await db?.close();
});

const SCHEMAS = ["public", "auth", "private", "ops"];

describe("functions", () => {
  it("every SECURITY DEFINER function sets search_path to ''", async () => {
    const r = await db.admin.query(
      `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname = any($1)
          and (p.proconfig is null or not ('search_path=""' = any(p.proconfig)))`, [SCHEMAS]);
    expect(r.rows).toEqual([]);
    const count = await db.admin.query(
      "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prosecdef and n.nspname = any($1)", [SCHEMAS]);
    expect(count.rows[0].n).toBeGreaterThan(40);
  });

  it("no function of ours is executable by PUBLIC", async () => {
    const r = await db.admin.query(
      `select n.nspname || '.' || p.proname as f
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1)
          and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE')`, [SCHEMAS]);
    expect(r.rows).toEqual([]);
  });

  it("the anonymous role reaches only the intended functions", async () => {
    const r = await db.admin.query(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1) and has_function_privilege('app_anon', p.oid, 'execute') order by 1`, [SCHEMAS]);
    expect(r.rows.map((x) => x.f)).toEqual(["auth.jwt", "auth.uid", "public.public_tenant_branding"]);
  });

  it("request roles cannot execute auth.* functions that bypass RLS (only app_auth can)", async () => {
    const r = await db.admin.query(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' and p.prosecdef and has_function_privilege('app_user', p.oid, 'execute')`);
    expect(r.rows).toEqual([]);
  });
});

describe("tables and views", () => {
  it("RLS is enabled on every table in public and auth", async () => {
    const r = await db.admin.query(
      `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname in ('public', 'auth') and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it("every view runs with the caller's rights", async () => {
    const r = await db.admin.query(
      `select n.nspname || '.' || c.relname as v, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'v' and n.nspname = any($1)
          and not coalesce('security_invoker=true' = any(c.reloptions), false)`, [SCHEMAS]);
    expect(r.rows).toEqual([]);
  });

  it("nothing is granted to PUBLIC on our tables and views", async () => {
    const r = await db.admin.query(
      `select table_schema || '.' || table_name as t, privilege_type from information_schema.role_table_grants
        where grantee = 'PUBLIC' and table_schema = any($1)`, [SCHEMAS]);
    expect(r.rows).toEqual([]);
  });

  it("request roles have no rights on auth.* (except app_auth) and private.* tables", async () => {
    const r = await db.admin.query(
      `select grantee, table_schema || '.' || table_name as t, privilege_type from information_schema.role_table_grants
        where (grantee in ('app_user', 'app_anon') and table_schema in ('auth', 'private', 'ops'))
           or (grantee = 'app_auth' and table_schema in ('private', 'ops'))
           or (grantee = 'app_anon')`);
    expect(r.rows).toEqual([]);
  });

  it("request roles may not DELETE anywhere (soft delete, append-only history)", async () => {
    const r = await db.admin.query(
      `select grantee, table_schema || '.' || table_name as t from information_schema.role_table_grants
        where grantee in ('app_user', 'app_anon') and privilege_type in ('DELETE', 'TRUNCATE')`);
    expect(r.rows).toEqual([]);
  });
});

describe("roles", () => {
  it("the API login role cannot bypass RLS and owns nothing", async () => {
    const r = await db.admin.query(
      "select rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb from pg_roles where rolname = 'app_api'");
    expect(r.rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false }]);
    const owned = await db.admin.query(
      "select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = 'app_api'");
    expect(owned.rows[0].n).toBe(0);
    const grants = await db.admin.query("select count(*)::int as n from information_schema.role_table_grants where grantee = 'app_api'");
    expect(grants.rows[0].n).toBe(0);
  });

  it("request roles cannot log in and do not bypass RLS", async () => {
    const r = await db.admin.query(
      "select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname in ('app_user', 'app_anon', 'app_auth') order by 1");
    expect(r.rows).toEqual([
      { rolname: "app_anon", rolcanlogin: false, rolbypassrls: false },
      { rolname: "app_auth", rolcanlogin: false, rolbypassrls: false },
      { rolname: "app_user", rolcanlogin: false, rolbypassrls: false },
    ]);
  });
});

/**
 * Migration 0015: tenant status "deactivated" (nothing deleted, no access) and
 * public.platform_system_overview() (platform staff only, numbers only).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, pgError, setupTestDb, type TestDb } from "./support/harness";

let db: TestDb;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});

const A = IDS.tenantA;
const B = IDS.tenantB;
const U = IDS.users;

const count = (user: string, sql: string, params: unknown[] = []) =>
  db.as(user, async (q) => Number((await q.query(sql, params)).rows[0].n));

describe("tenant status 'deactivated'", () => {
  it("only super_admin sets it (reason required); data stays, members lose access; reactivation restores it", async () => {
    const before = await db.admin.query("select count(*)::int n from public.time_entries where tenant_id = $1", [B]);
    expect((await pgError(db.as(U.support, (q) => q.query("select public.set_tenant_status($1, 'deactivated', 'Vertrag beendet')", [B])))).code).toBe("42501");
    expect((await pgError(db.as(U.ownerB, (q) => q.query("select public.set_tenant_status($1, 'deactivated', 'Vertrag beendet')", [B])))).code).toBe("42501");
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'deactivated', '')", [B])))).code).toBe("22023");
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'deleted', 'Test')", [B])))).code).toBe("22023");

    const row = await db.as(U.superAdmin, async (q) =>
      (await q.query("select * from public.set_tenant_status($1, 'deactivated', 'Vertrag beendet')", [B])).rows[0], { commit: true });
    try {
      expect(row.status).toBe("deactivated");
      // Nothing deleted.
      const after = await db.admin.query("select count(*)::int n from public.time_entries where tenant_id = $1", [B]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      // Members of the deactivated tenant see nothing; tenant A is unaffected.
      expect(await count(U.ownerB, "select count(*)::int n from public.employees where tenant_id = $1", [B])).toBe(0);
      expect(await count(U.empB, "select count(*)::int n from public.time_entries where tenant_id = $1", [B])).toBe(0);
      expect(await count(U.ownerA, "select count(*)::int n from public.employees where tenant_id = $1", [A])).toBeGreaterThan(0);
      // The change is audited with the reason.
      const audit = await db.admin.query(
        "select reason, before->>'status' b, after->>'status' a from public.audit_log where entity = 'tenant' and entity_id = $1 order by created_at desc limit 1", [B]);
      expect(audit.rows[0]).toEqual({ reason: "Vertrag beendet", b: "active", a: "deactivated" });
      // The platform still lists the tenant (numbers only).
      const listed = await db.as(U.support, async (q) => (await q.query("select * from public.platform_list_tenants() where tenant_id = $1", [B])).rows);
      expect(listed).toHaveLength(1);
    } finally {
      await db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'active', 'Reaktiviert (Test)')", [B]), { commit: true });
    }
    expect(await count(U.ownerB, "select count(*)::int n from public.employees where tenant_id = $1", [B])).toBeGreaterThan(0);
  });

  it("the owner cannot change the status directly (tenants_guard)", async () => {
    const n = await db.as(U.ownerA, async (q) => (await q.query("update public.tenants set status = 'deactivated' where id = $1", [A])).rowCount).catch((e: { code?: string }) => e.code);
    expect([0, "42501"]).toContain(n);
  });
});

describe("platform_system_overview()", () => {
  it("super_admin and support get counts without personal data", async () => {
    for (const user of [U.superAdmin, U.support]) {
      const o = await db.as(user, async (q) => (await q.query("select public.platform_system_overview() as o")).rows[0].o);
      expect(Object.keys(o).sort()).toEqual(["activeSessions", "databaseTime", "migrations", "tenants"]);
      expect(o.tenants.active).toBeGreaterThanOrEqual(2);
      expect(typeof o.activeSessions).toBe("number");
      // The test database is built without the server's migration runner → unknown.
      expect(o.migrations).toBeNull();
    }
  });

  it("reports the migration level once ops.schema_migrations exists", async () => {
    await db.admin.query(`create schema if not exists ops;
      create table if not exists ops.schema_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now());
      insert into ops.schema_migrations (name, sha256) values ('0014_x.sql', repeat('a', 64)), ('0015_y.sql', repeat('b', 64)), ('seed.sql', repeat('c', 64))
      on conflict do nothing;`);
    try {
      const o = await db.as(U.support, async (q) => (await q.query("select public.platform_system_overview() as o")).rows[0].o);
      expect(o.migrations).toMatchObject({ count: 2, latest: "0015_y.sql" });
    } finally {
      await db.admin.query("drop schema ops cascade");
    }
  });

  it("tenant users and anonymous callers are refused", async () => {
    for (const user of [U.ownerA, U.managerA, U.emp1A]) {
      expect((await pgError(db.as(user, (q) => q.query("select public.platform_system_overview()")))).code).toBe("42501");
    }
    expect((await pgError(db.as(null, (q) => q.query("select public.platform_system_overview()"), { role: "app_anon" }))).code).toBe("42501");
  });
});

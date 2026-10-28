/**
 * Company profile only by the owner (QA 2026-10-28, finding B3; migration 0011):
 * platform staff change no tenant data – not even with a support grant –
 * and tenant status changes only through set_tenant_status (super_admin).
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

const PROFILE_UPDATES = [
  "update public.tenants set branding = jsonb_set(branding, '{slogan}', '\"Plattform\"') where id = $1",
  "update public.tenants set contact = jsonb_set(contact, '{city}', '\"Plattformstadt\"') where id = $1",
  "update public.tenants set settings = jsonb_set(settings, '{breakPolicy,maxShiftMinutes}', '600') where id = $1",
  "update public.tenants set name = 'Plattform GmbH' where id = $1",
];

describe("tenant profile (branding, contact, settings, name)", () => {
  it("super_admin and support change nothing in a tenant row", async () => {
    for (const user of [U.superAdmin, U.support]) {
      for (const sql of PROFILE_UPDATES) {
        const n = await db.as(user, async (q) => (await q.query(sql, [A])).rowCount);
        expect(n, `${user}: ${sql}`).toBe(0);
      }
    }
  });

  it("not even with an active support grant (a grant is read-only)", async () => {
    const grant = await db.as(U.ownerA, async (q) =>
      (await q.query("select * from public.grant_support_access($1, 2, 'Ticket 0815: Branding prüfen')", [A])).rows[0], { commit: true });
    try {
      // The grant works for reading …
      const seen = await db.as(U.superAdmin, async (q) => (await q.query("select count(*)::int n from public.employees where tenant_id = $1", [A])).rows[0].n);
      expect(seen).toBeGreaterThan(0);
      // … but not for changing the profile.
      for (const sql of PROFILE_UPDATES) {
        const n = await db.as(U.superAdmin, async (q) => (await q.query(sql, [A])).rowCount);
        expect(n, sql).toBe(0);
      }
    } finally {
      await db.as(U.ownerA, (q) => q.query("select public.revoke_support_access($1)", [grant.id]), { commit: true });
    }
    const t = (await db.admin.query("select name, branding ->> 'slogan' as slogan, contact ->> 'city' as city from public.tenants where id = $1", [A])).rows[0];
    expect(t.name).not.toBe("Plattform GmbH");
    expect(t.slogan).not.toBe("Plattform");
    expect(t.city).not.toBe("Plattformstadt");
  });

  it("the owner still edits the profile, but not status, slug or demo flag", async () => {
    const r = await db.as(U.ownerA, async (q) =>
      (await q.query("update public.tenants set branding = jsonb_set(branding, '{slogan}', '\"Inhaber\"') where id = $1 returning branding ->> 'slogan' as s", [A])).rows[0]);
    expect(r.s).toBe("Inhaber");
    for (const sql of [
      "update public.tenants set status = 'suspended' where id = $1",
      "update public.tenants set slug = 'neuer-kurzname' where id = $1",
      "update public.tenants set is_demo = not is_demo where id = $1",
    ]) {
      expect((await pgError(db.as(U.ownerA, (q) => q.query(sql, [A])))).code, sql).toBe("42501");
    }
  });

  it("a super_admin who is also owner of a tenant edits it as owner, but changes its status only via set_tenant_status", async () => {
    await db.admin.query(
      "insert into public.employees (id, tenant_id, user_id, personnel_number, display_name, role, status) values ('cd000000-0000-4000-8000-000000000001', $1, $2, 'SA-1', 'Plattform als Inhaber', 'owner', 'active')",
      [B, U.superAdmin]);
    try {
      const n = await db.as(U.superAdmin, async (q) => (await q.query("update public.tenants set name = name where id = $1", [B])).rowCount);
      expect(n).toBe(1);
      expect((await pgError(db.as(U.superAdmin, (q) => q.query("update public.tenants set status = 'suspended' where id = $1", [B])))).code).toBe("42501");
      const s = await db.as(U.superAdmin, async (q) => (await q.query("select status from public.set_tenant_status($1, 'pending', 'Prüfung Test')", [B])).rows[0].status);
      expect(s).toBe("pending");
    } finally {
      await db.admin.query("update public.tenants set status = 'active' where id = $1", [B]);
      await db.admin.query("delete from public.employees where id = 'cd000000-0000-4000-8000-000000000001'");
    }
  });
});

describe("set_tenant_status (SECURITY DEFINER since 0011)", () => {
  it("super_admin changes the status with reason; the audit names actor and reason", async () => {
    await db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'suspended', 'Zahlungsklärung (Test)')", [B]), { commit: true });
    try {
      expect((await db.admin.query("select status from public.tenants where id = $1", [B])).rows[0].status).toBe("suspended");
      const audit = (await db.admin.query(
        "select actor_id, reason, after ->> 'status' as status from public.audit_log where entity = 'tenant' and entity_id = $1 order by created_at desc limit 1", [B])).rows[0];
      expect(audit).toEqual({ actor_id: U.superAdmin, reason: "Zahlungsklärung (Test)", status: "suspended" });
    } finally {
      await db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'active', 'Test Ende')", [B]), { commit: true });
    }
  });

  it("support, owners and managers cannot change the status; invalid input is rejected", async () => {
    for (const user of [U.support, U.ownerA, U.managerA, U.emp1A]) {
      expect((await pgError(db.as(user, (q) => q.query("select public.set_tenant_status($1, 'suspended', 'Versuch')", [A])))).code, user).toBe("42501");
    }
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'geloescht', 'Versuch')", [A])))).code).toBe("22023");
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status($1, 'suspended', '')", [A])))).code).toBe("22023");
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.set_tenant_status('00000000-0000-4000-8000-000000000000', 'suspended', 'Unbekannt')")))).code).toBe("42501");
    expect((await db.admin.query("select status from public.tenants where id = $1", [A])).rows[0].status).toBe("active");
  });
});

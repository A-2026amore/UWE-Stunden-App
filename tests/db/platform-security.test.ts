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
const E = IDS.employees;

const PERSONAL_TABLES = ["time_entries", "time_entry_revisions", "employees", "work_account_allocations", "monthly_statements"];

async function personalCounts(user: string, tenant: string): Promise<Record<string, number>> {
  return db.as(user, async (q) => {
    const out: Record<string, number> = {};
    for (const t of PERSONAL_TABLES) {
      out[t] = (await q.query(`select count(*)::int n from public.${t} where tenant_id = $1`, [tenant])).rows[0].n;
    }
    return out;
  });
}

describe("platform staff and support access", () => {
  it("super_admin sees tenant metadata, licences and counts – but no personal data", async () => {
    await db.as(U.superAdmin, async (q) => {
      expect((await q.query("select count(*)::int n from public.tenants")).rows[0].n).toBe(2);
      expect((await q.query("select count(*)::int n from public.licenses")).rows[0].n).toBe(2);
      const overview = (await q.query("select slug, plan, employee_count, active_employee_count from public.platform_list_tenants()")).rows;
      expect(overview).toEqual([
        { slug: "demo-krankentransporte", plan: "pilot_free", employee_count: 4, active_employee_count: 4 },
        { slug: "muster-pflegedienst", plan: "standard", employee_count: 3, active_employee_count: 2 },
      ]);
      const audit = (await q.query("select distinct entity from public.audit_log order by 1")).rows.map((r) => r.entity);
      expect(audit).toEqual(["license", "support_access_grant", "tenant"]);
    });
    expect(await personalCounts(U.superAdmin, A)).toEqual(Object.fromEntries(PERSONAL_TABLES.map((t) => [t, 0])));
    expect(await personalCounts(U.support, B)).toEqual(Object.fromEntries(PERSONAL_TABLES.map((t) => [t, 0])));
  });

  it("an expired grant (seed, tenant B) gives no access", async () => {
    const n = await db.as(U.superAdmin, async (q) => (await q.query("select count(*)::int n from public.support_access_grants where tenant_id = $1", [B])).rows[0].n);
    expect(n).toBe(1);
    expect((await personalCounts(U.superAdmin, B)).time_entries).toBe(0);
  });

  it("only the tenant owner can grant support access; manager and staff cannot", async () => {
    const e1 = await pgError(db.as(U.managerA, (q) => q.query("select public.grant_support_access($1, 2, 'Fehler im Export')", [A])));
    expect(e1.code).toBe("42501");
    const e2 = await pgError(db.as(U.superAdmin, (q) => q.query("select public.grant_support_access($1, 2, 'Selbstfreigabe')", [A])));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(db.as(U.superAdmin, (q) => q.query(
      "insert into public.support_access_grants (tenant_id, reason, expires_at) values ($1, 'Selbstfreigabe', now() + interval '1 hour')", [A])));
    expect(e3.code).toBe("42501");
  });

  it("with an active grant staff can read the tenant's personal data (read-only, that tenant only)", async () => {
    const grant = await db.as(U.ownerA, async (q) =>
      (await q.query("select * from public.grant_support_access($1, 4, 'Ticket 4711: Monatsabschluss prüfen', $2)", [A, U.superAdmin])).rows[0], { commit: true });
    expect(grant.granted_by).toBe(U.ownerA);
    const counts = await personalCounts(U.superAdmin, A);
    expect(counts.time_entries).toBeGreaterThan(0);
    expect(counts.employees).toBe(4);
    // grant names a specific person → the support user is still excluded
    expect((await personalCounts(U.support, A)).time_entries).toBe(0);
    // other tenant still closed
    expect((await personalCounts(U.superAdmin, B)).time_entries).toBe(0);
    // read-only
    const n = await db.as(U.superAdmin, async (q) => (await q.query("update public.time_entries set note = 'x' where tenant_id = $1", [A])).rowCount);
    expect(n).toBe(0);
    // revoke → closed again
    await db.as(U.ownerA, (q) => q.query("select public.revoke_support_access($1)", [grant.id]), { commit: true });
    expect((await personalCounts(U.superAdmin, A)).time_entries).toBe(0);
  });

  it("after expiry access ends", async () => {
    await db.admin.query(
      "insert into public.support_access_grants (tenant_id, granted_by, reason, starts_at, expires_at) values ($1, $2, 'kurz befristet', now() - interval '2 hours', now() + interval '1 hour')",
      [A, U.ownerA]);
    expect((await personalCounts(U.support, A)).time_entries).toBeGreaterThan(0);
    await db.admin.query("update public.support_access_grants set expires_at = now() - interval '1 minute', starts_at = now() - interval '2 hours' where reason = 'kurz befristet'");
    expect((await personalCounts(U.support, A)).time_entries).toBe(0);
  });

  it("super_admin manages tenants and licences; support may only read", async () => {
    const r = await db.as(U.superAdmin, async (q) => {
      const res = (await q.query("select public.create_tenant('Neuer Demo Betrieb', 'neuer-demo-betrieb', 'pilot_free', true, 'Chefin@Neu.example') as r")).rows[0].r;
      await q.query("update public.licenses set max_employees = 10, valid_until = '2027-06-30' where tenant_id = $1", [res.tenantId]);
      await q.query("select public.set_tenant_status($1, 'suspended', 'Zahlungsklärung (Test)')", [res.tenantId]);
      return res;
    });
    expect(r.invitationToken).toMatch(/^[0-9a-f]{64}$/);
    const e = await pgError(db.as(U.support, (q) => q.query("select public.create_tenant('X', 'xx-test', 'standard', true, 'x@y.example')")));
    expect(e.code).toBe("42501");
    const n = await db.as(U.support, async (q) => (await q.query("update public.licenses set note = 'x'")).rowCount);
    expect(n).toBe(0);
  });

  it("pilot_free cannot be given a price by super_admin either", async () => {
    const e = await pgError(db.as(U.superAdmin, (q) => q.query("update public.licenses set price_cents = 100 where tenant_id = $1", [A])));
    expect(e.code).toBe("23514");
  });
});

describe("audit log is append-only", () => {
  it("no UPDATE / DELETE / TRUNCATE – not even for the superuser", async () => {
    const id = (await db.admin.query("select id from public.audit_log limit 1")).rows[0].id;
    expect((await pgError(db.admin.query("update public.audit_log set reason = 'x' where id = $1", [id]))).code).toBe("42501");
    expect((await pgError(db.admin.query("delete from public.audit_log where id = $1", [id]))).code).toBe("42501");
    expect((await pgError(db.admin.query("truncate public.audit_log"))).code).toBe("42501");
    for (const user of [U.ownerA, U.superAdmin]) {
      expect((await pgError(db.as(user, (q) => q.query("update public.audit_log set reason = 'x'")))).code).toBe("42501");
      expect((await pgError(db.as(user, (q) => q.query("delete from public.audit_log")))).code).toBe("42501");
      expect((await pgError(db.as(user, (q) => q.query("insert into public.audit_log (action, entity) values ('fake', 'fake')")))).code).toBe("42501");
    }
  });

  it("request roles cannot call the internal audit writer", async () => {
    const e = await pgError(db.as(U.ownerA, (q) => q.query("select private.write_audit($1, 'x', 'x', null, null, null, null)", [A])));
    expect(e.code).toBe("42501");
  });
});

describe("no privilege escalation", () => {
  it("employee cannot change own role, status, tenant or account binding", async () => {
    for (const set of ["role = 'owner'", "role = 'manager'", "status = 'active', personnel_number = 'A-999'", `tenant_id = '${B}'`, `user_id = '${U.emp2A}'`]) {
      const e = await pgError(db.as(U.emp1A, (q) => q.query(`update public.employees set ${set} where id = $1`, [E.emp1A])));
      expect(e.code, set).toBe("42501");
    }
    // harmless own field is allowed
    const ok = await db.as(U.emp1A, async (q) => (await q.query("update public.employees set display_name = 'Sam P.' where id = $1", [E.emp1A])).rowCount);
    expect(ok).toBe(1);
  });

  it("manager cannot promote self or others to owner/manager; owner cannot demote self", async () => {
    const e1 = await pgError(db.as(U.managerA, (q) => q.query("update public.employees set role = 'owner' where id = $1", [E.managerA])));
    expect(e1.code).toBe("42501");
    const e2 = await pgError(db.as(U.managerA, (q) => q.query("update public.employees set role = 'manager' where id = $1", [E.emp1A])));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(db.as(U.managerA, (q) => q.query("update public.employees set status = 'deactivated' where id = $1", [E.ownerA])));
    expect(e3.code).toBe("42501");
    const e4 = await pgError(db.as(U.ownerA, (q) => q.query("update public.employees set role = 'employee' where id = $1", [E.ownerA])));
    expect(e4.code).toBe("42501");
    const ok = await db.as(U.ownerA, async (q) => (await q.query("update public.employees set role = 'manager' where id = $1", [E.emp1A])).rowCount);
    expect(ok).toBe(1);
  });

  it("nobody can make themselves platform admin or bind an account on insert", async () => {
    const e = await pgError(db.as(U.ownerA, (q) => q.query("insert into public.platform_admins (user_id, role) values ($1, 'super_admin')", [U.ownerA])));
    expect(e.code).toBe("42501");
    const e2 = await pgError(db.as(U.managerA, (q) => q.query(
      "insert into public.employees (tenant_id, user_id, personnel_number, display_name) values ($1, $2, 'A-300', 'Doppelt')", [A, U.ownerB])));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(db.as(U.managerA, (q) => q.query(
      "insert into public.employees (tenant_id, personnel_number, display_name, role) values ($1, 'A-301', 'Chef 2', 'owner')", [A])));
    expect(e3.code).toBe("42501");
  });

  it("personnel number is unique per tenant only", async () => {
    const e = await pgError(db.admin.query("insert into public.employees (tenant_id, personnel_number, display_name) values ($1, 'A-101', 'Doppelt')", [A]));
    expect(e.code).toBe("23505");
    await db.admin.query("insert into public.employees (tenant_id, personnel_number, display_name, status) values ($1, 'A-101', 'Gleiche Nummer anderer Mandant', 'deactivated')", [B]);
  });
});

describe("authentication tables (role app_auth only)", () => {
  it("app_user and app_anon cannot read auth tables", async () => {
    for (const t of ["auth.users", "auth.sessions", "auth.one_time_tokens"]) {
      expect((await pgError(db.as(U.superAdmin, (q) => q.query(`select * from ${t}`)))).code, t).toBe("42501");
      expect((await pgError(db.as(null, (q) => q.query(`select * from ${t}`), { role: "app_anon" }))).code, t).toBe("42501");
    }
    const e = await pgError(db.as(U.ownerA, (q) => q.query("select * from auth.create_session($1)", [U.ownerA])));
    expect(e.code).toBe("42501");
  });

  it("app_auth cannot read tenant data", async () => {
    const e = await pgError(db.as(null, (q) => q.query("select * from public.time_entries"), { role: "app_auth" }));
    expect(e.code).toBe("42501");
  });

  it("session lifecycle stores only token hashes", async () => {
    await db.admin.query("update auth.users set password_hash = 'scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaGhhc2hoYXNo' where id = $1", [U.emp1A]);
    await db.as(null, async (q) => {
      const login = (await q.query("select * from auth.get_login('Fahrer1@Demo-Krankentransporte.example ')")).rows;
      expect(login).toEqual([{ user_id: U.emp1A, password_hash: "scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaGhhc2hoYXNo" }]);
      const s = (await q.query("select * from auth.create_session($1, interval '1 hour', 'vitest')", [U.emp1A])).rows[0];
      expect(s.token).toMatch(/^[0-9a-f]{64}$/);
      const stored = (await q.query("select token_hash from auth.sessions where id = $1", [s.session_id])).rows[0].token_hash;
      expect(stored).not.toBe(s.token);
      expect((await q.query("select user_id from auth.resolve_session($1)", [s.token])).rows).toEqual([{ user_id: U.emp1A }]);
      expect((await q.query("select auth.revoke_session($1) as r", [s.token])).rows[0].r).toBe(true);
      expect((await q.query("select * from auth.resolve_session($1)", [s.token])).rows).toEqual([]);
    }, { role: "app_auth" });
  });

  it("password reset: unknown e-mail → null; token works once and revokes sessions", async () => {
    await db.as(null, async (q) => {
      expect((await q.query("select auth.create_password_reset('niemand@nirgends.example') as t")).rows[0].t).toBeNull();
      const s = (await q.query("select * from auth.create_session($1)", [U.emp1A])).rows[0];
      const token = (await q.query("select auth.create_password_reset('fahrer1@demo-krankentransporte.example') as t")).rows[0].t;
      const uid = (await q.query("select auth.reset_password($1, 'scrypt$neu$c2FsdA$bmV1ZXJIYXNoV2VydA') as u", [token])).rows[0].u;
      expect(uid).toBe(U.emp1A);
      expect((await q.query("select * from auth.resolve_session($1)", [s.token])).rows).toEqual([]);
      await q.query("savepoint reuse");
      const e = await pgError(q.query("select auth.reset_password($1, 'scrypt$x$c2FsdA$eHh4eHh4eHh4eHh4')", [token]));
      expect(e.code).toBe("22023");
      await q.query("rollback to savepoint reuse");
    }, { role: "app_auth" });
  });

  it("accepting an invitation creates the account and activates the employee", async () => {
    const uid = await db.as(null, async (q) =>
      (await q.query("select auth.accept_invitation($1, 'scrypt$N=16384$c2FsdA$aW52aXRlZEhhc2g') as u", [IDS.invitationTokenB])).rows[0].u,
      { role: "app_auth", commit: true });
    const emp = await db.admin.query("select user_id, status from public.employees where id = $1", [E.invitedB]);
    expect(emp.rows[0]).toEqual({ user_id: uid, status: "active" });
    const ctx = await db.as(uid, async (q) => (await q.query("select public.current_session_context() as c")).rows[0].c);
    expect(ctx.memberships).toEqual([{ tenantId: B, employeeId: E.invitedB, role: "employee", tenantName: "Muster Pflegedienst GmbH", tenantStatus: "active" }]);
    const e = await pgError(db.as(null, (q) => q.query("select auth.accept_invitation($1, 'scrypt$N=16384$c2FsdA$aW52aXRlZEhhc2g')", [IDS.invitationTokenB]), { role: "app_auth" }));
    expect(e.code).toBe("22023");
  });
});

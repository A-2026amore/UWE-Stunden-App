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

/** Tenant-scoped tables with the column holding the tenant id and a harmless update. */
const TABLES: Array<{ table: string; tenantCol: string; update: string; insert: string; insertParams: unknown[] }> = [
  { table: "tenants", tenantCol: "id", update: "name = 'Gekapert'",
    insert: "insert into public.tenants (slug, name, contact) values ('fremd-mandant', 'Fremd', '{\"legalName\":\"x\",\"street\":\"\",\"postalCode\":\"\",\"city\":\"\"}')", insertParams: [] },
  { table: "licenses", tenantCol: "tenant_id", update: "note = 'x'",
    insert: "insert into public.licenses (tenant_id, plan, status) values ($1, 'enterprise', 'suspended')", insertParams: [B] },
  { table: "employees", tenantCol: "tenant_id", update: "display_name = 'Gekapert'",
    insert: "insert into public.employees (tenant_id, personnel_number, display_name) values ($1, 'X-1', 'Eindringling')", insertParams: [B] },
  { table: "support_access_grants", tenantCol: "tenant_id", update: "reason = 'gekapert!'",
    insert: "insert into public.support_access_grants (tenant_id, reason, expires_at) values ($1, 'selbst erteilt', now() + interval '1 day')", insertParams: [B] },
  { table: "invitations", tenantCol: "tenant_id", update: "email = 'x@y.example'",
    insert: "insert into public.invitations (tenant_id, employee_id, email, expires_at) values ($1, $2, 'x@y.example', now() + interval '1 day')", insertParams: [B, E.empB] },
  { table: "time_entries", tenantCol: "tenant_id", update: "note = 'gekapert'",
    insert: "insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time) values ('intrude-0001', $1, $2, '2026-10-20', '08:00', '10:00')", insertParams: [B, E.empB] },
  { table: "time_entry_revisions", tenantCol: "tenant_id", update: "reason = 'x'",
    insert: "insert into public.time_entry_revisions (entry_id, tenant_id, employee_id, version, operation, snapshot) values ('demo-b03-20261002', $1, $2, 99, 'update', '{}')", insertParams: [B, E.empB] },
  { table: "work_account_allocations", tenantCol: "tenant_id", update: "minutes = 1",
    insert: "insert into public.work_account_allocations (tenant_id, employee_id, month, minutes) values ($1, $2, '2026-11', 60)", insertParams: [B, E.empB] },
  { table: "monthly_statements", tenantCol: "tenant_id", update: "status = 'approved'",
    insert: "insert into public.monthly_statements (tenant_id, employee_id, month, status) values ($1, $2, '2026-11', 'approved')", insertParams: [B, E.empB] },
  { table: "audit_log", tenantCol: "tenant_id", update: "reason = 'x'",
    insert: "insert into public.audit_log (tenant_id, action, entity) values ($1, 'fake', 'fake')", insertParams: [B] },
];

describe("cross-tenant isolation (owner of tenant A vs. rows of tenant B)", () => {
  it("tenant B has rows in every table (precondition)", async () => {
    for (const t of TABLES) {
      const { rows } = await db.admin.query(`select count(*)::int as n from public.${t.table} where ${t.tenantCol} = $1`, [B]);
      expect(rows[0].n, t.table).toBeGreaterThan(0);
    }
  });

  for (const t of TABLES) {
    it(`${t.table}: cannot read tenant B rows`, async () => {
      for (const user of [U.ownerA, U.managerA, U.emp1A]) {
        const n = await db.as(user, async (q) =>
          (await q.query(`select count(*)::int as n from public.${t.table} where ${t.tenantCol} = $1`, [B])).rows[0].n);
        expect(n).toBe(0);
      }
    });

    it(`${t.table}: cannot insert rows for tenant B`, async () => {
      const e = await pgError(db.as(U.ownerA, (q) => q.query(t.insert, t.insertParams)));
      expect(["42501"]).toContain(e.code);
    });

    it(`${t.table}: cannot update tenant B rows`, async () => {
      const result = await db.as(U.ownerA, async (q) => {
        try {
          return (await q.query(`update public.${t.table} set ${t.update} where ${t.tenantCol} = $1`, [B])).rowCount;
        } catch (e) {
          return (e as { code: string }).code; // no UPDATE privilege at all
        }
      });
      expect([0, "42501"]).toContain(result);
    });
  }

  it("cannot delete anything (no DELETE privilege)", async () => {
    for (const t of TABLES) {
      const e = await pgError(db.as(U.ownerA, (q) => q.query(`delete from public.${t.table} where ${t.tenantCol} = $1`, [A])));
      expect(e.code, t.table).toBe("42501");
    }
  });

  it("cannot forge tenant_id on insert (own employee, foreign tenant)", async () => {
    const e = await pgError(db.as(U.emp1A, (q) => q.query(
      "insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time) values ('forge-00001', $1, $2, '2026-10-20', '08:00', '10:00')",
      [B, E.emp1A])));
    expect(e.code).toBe("42501");
  });

  it("cross-tenant RPC calls are rejected", async () => {
    const e1 = await pgError(db.as(U.ownerA, (q) => q.query(
      "select public.create_time_entry($1, $2)", [E.empB, { id: "rpc-intrude-01", date: "2026-10-20", start: "08:00", end: "10:00", pauseMinutes: 0 }])));
    expect(e1.code).toBe("42501");
    const sid = (await db.admin.query("select id from public.monthly_statements where tenant_id = $1", [B])).rows[0].id;
    const e2 = await pgError(db.as(U.ownerA, (q) => q.query("select public.approve_statement($1)", [sid])));
    expect(e2.code).toBe("42501");
    const e3 = await pgError(db.as(U.ownerA, (q) => q.query("select public.grant_support_access($1, 2, 'fremder Mandant')", [B])));
    expect(e3.code).toBe("42501");
    const e4 = await pgError(db.as(U.ownerA, (q) => q.query("select public.update_time_entry('be000000-0000-4000-8000-000000000003', 'demo-b03-20261002', '{\"note\":\"x\"}', 1)")));
    expect(e4.code).toBe("42501");
  });

  it("unauthenticated role sees nothing but public branding", async () => {
    const e = await pgError(db.as(null, (q) => q.query("select * from public.tenants"), { role: "app_anon" }));
    expect(e.code).toBe("42501");
    const b = await db.as(null, (q) => q.query("select name, branding->>'primaryColor' as c from public.public_tenant_branding('muster-pflegedienst')"), { role: "app_anon" });
    expect(b.rows).toEqual([{ name: "Muster Pflegedienst GmbH", c: "#2A9D8F" }]);
  });
});

describe("roles inside one tenant", () => {
  it("employee reads only own time entries, not colleagues'", async () => {
    const rows = await db.as(U.emp1A, async (q) => (await q.query("select distinct employee_id from public.time_entries")).rows);
    expect(rows).toEqual([{ employee_id: E.emp1A }]);
    const colleague = await db.as(U.emp1A, async (q) =>
      (await q.query("select count(*)::int n from public.time_entries where employee_id = $1", [E.emp2A])).rows[0].n);
    expect(colleague).toBe(0);
  });

  it("employee cannot insert or update a colleague's entries", async () => {
    const e = await pgError(db.as(U.emp1A, (q) => q.query(
      "insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time) values ('colleague-01', $1, $2, '2026-10-20', '08:00', '10:00')",
      [A, E.emp2A])));
    expect(e.code).toBe("42501");
    const n = await db.as(U.emp1A, async (q) =>
      (await q.query("update public.time_entries set note = 'x' where employee_id = $1", [E.emp2A])).rowCount);
    expect(n).toBe(0);
  });

  it("employee sees only own employee row, own allocations/statements, own tenant", async () => {
    await db.as(U.emp1A, async (q) => {
      expect((await q.query("select id from public.employees")).rows).toEqual([{ id: E.emp1A }]);
      expect((await q.query("select distinct employee_id from public.work_account_allocations")).rows).toEqual([{ employee_id: E.emp1A }]);
      expect((await q.query("select distinct employee_id from public.monthly_statements")).rows).toEqual([{ employee_id: E.emp1A }]);
      expect((await q.query("select id, branding->>'primaryColor' c from public.tenants")).rows).toEqual([{ id: A, c: "#B3001B" }]);
      expect((await q.query("select count(*)::int n from public.licenses")).rows[0].n).toBe(0);
      expect((await q.query("select count(*)::int n from public.audit_log")).rows[0].n).toBe(0);
    });
  });

  it("manager reads all data of own tenant only", async () => {
    await db.as(U.managerA, async (q) => {
      const t = (await q.query("select distinct tenant_id from public.time_entries")).rows;
      expect(t).toEqual([{ tenant_id: A }]);
      const emps = (await q.query("select count(*)::int n from public.employees")).rows[0].n;
      expect(emps).toBe(4);
      const statements = (await q.query("select distinct tenant_id from public.monthly_statements")).rows;
      expect(statements).toEqual([{ tenant_id: A }]);
      const audit = (await q.query("select count(*)::int n from public.audit_log where tenant_id = $1", [A])).rows[0].n;
      expect(audit).toBeGreaterThan(0);
    });
  });

  it("only the owner edits the company profile; employees and managers cannot", async () => {
    for (const user of [U.emp1A, U.managerA]) {
      const n = await db.as(user, async (q) => (await q.query("update public.tenants set name = 'X GmbH' where id = $1", [A])).rowCount);
      expect(n).toBe(0);
    }
    const name = await db.as(U.ownerA, async (q) =>
      (await q.query("update public.tenants set branding = jsonb_set(branding, '{slogan}', '\"Neu\"') where id = $1 returning branding->>'slogan' s", [A])).rows[0].s);
    expect(name).toBe("Neu");
    const e = await pgError(db.as(U.ownerA, (q) => q.query("update public.tenants set status = 'suspended' where id = $1", [A])));
    expect(e.code).toBe("42501");
  });

  it("manager can invite an employee; deactivated users lose access", async () => {
    await db.as(U.managerA, async (q) => {
      const r = await q.query(
        "insert into public.employees (tenant_id, personnel_number, display_name, email) values ($1, 'A-200', 'Neu Person', 'neu@demo-krankentransporte.example') returning id", [A]);
      const inv = await q.query("select public.create_invitation($1) as i", [r.rows[0].id]);
      expect(inv.rows[0].i.token).toMatch(/^[0-9a-f]{64}$/);
    });
    await db.as(U.managerA, (q) => q.query("select public.set_employee_status($1, 'deactivated', 'Austritt (Test)')", [E.emp2A]), { commit: true });
    const n = await db.as(U.emp2A, async (q) => (await q.query("select count(*)::int n from public.time_entries")).rows[0].n);
    expect(n).toBe(0);
    const audit = await db.admin.query("select reason from public.audit_log where entity = 'employee' and entity_id = $1 order by created_at desc limit 1", [E.emp2A]);
    expect(audit.rows[0].reason).toBe("Austritt (Test)");
    await db.admin.query("update public.employees set status = 'active' where id = $1", [E.emp2A]);
  });
});

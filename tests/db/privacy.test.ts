/**
 * Data protection functions (migration 0016): personal data export, tenant
 * export, anonymisation of former employees after the retention period, and
 * the narrow redaction exception to the append-only tables.
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
const U = IDS.users;
const E = IDS.employees;

const exportPerson = (user: string, employee: string) =>
  db.as(user, async (q) => (await q.query("select public.export_personal_data($1) as d", [employee])).rows[0].d, { commit: true });
const exportTenant = (user: string, tenant: string) =>
  db.as(user, async (q) => (await q.query("select public.export_tenant_data($1) as d", [tenant])).rows[0].d, { commit: true });
const anonymize = (user: string, employee: string, confirm: string | null) =>
  db.as(user, async (q) => (await q.query("select * from public.anonymize_employee($1, $2)", [employee, confirm])).rows[0], { commit: true });

/** Deactivates an employee and moves the exit (status history) to 2020-01-01. */
async function deactivateLongAgo(employee: string): Promise<void> {
  await db.admin.query("update public.employees set status = 'deactivated' where id = $1", [employee]);
  await db.admin.query("delete from public.employee_status_history where employee_id = $1 and valid_to is not null", [employee]);
  await db.admin.query(
    "update public.employee_status_history set valid_from = '2020-01-01' where employee_id = $1 and valid_to is null", [employee]);
}

/** Every row of every table in public/auth that contains one of the strings. */
async function rowsContaining(...needles: string[]): Promise<string[]> {
  const tables = (await db.admin.query(
    "select format('%I.%I', table_schema, table_name) as t from information_schema.tables where table_schema in ('public', 'auth') and table_type = 'BASE TABLE'")).rows;
  const hits: string[] = [];
  for (const { t } of tables) {
    for (const n of needles) {
      const r = await db.admin.query(`select count(*)::int as c from ${t} x where x::text ilike '%' || $1 || '%'`, [n]);
      if (r.rows[0].c > 0) hits.push(`${t}: ${n} (${r.rows[0].c})`);
    }
  }
  return hits;
}

describe("export of one person", () => {
  it("the person gets everything incl. account data; the export is audited", async () => {
    const d = await exportPerson(U.emp1A, E.emp1A);
    expect(d.format).toBe("stundenwerk.personal-data.v1");
    expect(d.requestedBy).toBe("self");
    expect(d.person).toMatchObject({ id: E.emp1A, displayName: "Sam Probe", personnelNumber: "A-101", email: "fahrer1@demo-krankentransporte.example" });
    expect(d.account).toMatchObject({ email: "fahrer1@demo-krankentransporte.example", twoFactorEnabled: false });
    expect(d.timeEntries.map((e: { id: string }) => e.id)).toEqual(["demo-a03-20260901", "demo-a03-20260902", "demo-a03-20261001", "demo-a03-20261005"]);
    expect(d.timeEntries[0]).toMatchObject({ date: "2026-09-01", start: "06:00", end: "14:30", pauseMinutes: 30, note: "Frühdienst" });
    expect(d.revisions.length).toBeGreaterThanOrEqual(4);
    expect(d.allocations.map((a: { month: string }) => a.month)).toEqual(["2026-09", "2026-10"]);
    expect(d.statements[0]).toMatchObject({ month: "2026-09", status: "approved", workedMinutes: 915 });
    expect(d.auditLog.some((a: { action: string }) => a.action === "employee.insert")).toBe(true);
    // nothing of colleagues
    const text = JSON.stringify(d);
    expect(text).not.toContain("Jo Demo");
    expect(text).not.toContain("demo-a04-");
    const audit = (await db.admin.query(
      "select actor_id, after from public.audit_log where action = 'employee.data_export' and entity_id = $1", [E.emp1A])).rows;
    expect(audit).toEqual([{ actor_id: U.emp1A, after: { requestedBy: "self" } }]);
  });

  it("the owner gets the same records without the account data", async () => {
    const d = await exportPerson(U.ownerA, E.emp1A);
    expect(d.requestedBy).toBe("owner");
    expect(d.account).toBeNull();
    expect(d.timeEntries).toHaveLength(4);
  });

  it("nobody else: manager, colleague, other tenant, platform staff", async () => {
    for (const u of [U.managerA, U.emp2A, U.ownerB, U.empB, U.superAdmin, U.support]) {
      expect((await pgError(exportPerson(u, E.emp1A))).code).toBe("42501");
    }
    expect((await pgError(exportPerson(U.emp1A, E.emp2A))).code).toBe("42501");
    expect((await pgError(exportPerson(U.ownerA, E.empB))).code).toBe("42501");
  });
});

describe("export of a whole tenant", () => {
  it("owner only, contains all employees and their records", async () => {
    const d = await exportTenant(U.ownerA, A);
    expect(d.format).toBe("stundenwerk.tenant-data.v1");
    expect(d.tenant).toMatchObject({ id: A, slug: "demo-krankentransporte" });
    expect(d.employees.map((e: { personnelNumber: string }) => e.personnelNumber)).toEqual(["A-001", "A-002", "A-101", "A-102"]);
    const sam = d.employees.find((e: { id: string }) => e.id === E.emp1A);
    expect(sam.timeEntries).toHaveLength(4);
    expect(sam.auditLog).toBeUndefined();
    expect(d.auditLog.length).toBeGreaterThan(5);
    expect(JSON.stringify(d)).not.toContain("Muster Pflegedienst");
    for (const u of [U.managerA, U.emp1A, U.ownerB, U.superAdmin, U.support]) {
      expect((await pgError(exportTenant(u, A))).code).toBe("42501");
    }
    expect((await db.admin.query("select count(*)::int as n from public.audit_log where action = 'tenant.data_export' and tenant_id = $1", [A])).rows[0].n).toBe(1);
  });
});

describe("anonymisation", () => {
  it("is refused for active employees, without retention period, before it ends and without confirmation", async () => {
    expect((await pgError(anonymize(U.ownerA, E.emp1A, "A-101"))).message).toMatch(/Nur deaktivierte/);
    await db.admin.query("update public.employees set status = 'deactivated' where id = $1", [E.emp1A]);
    expect((await pgError(anonymize(U.ownerA, E.emp1A, "A-101"))).message).toMatch(/Aufbewahrungsfrist nach dem Austritt festlegen/);
    await db.admin.query("update public.tenants set retention_months_after_exit = 24 where id = $1", [A]);
    const early = await pgError(anonymize(U.ownerA, E.emp1A, "A-101"));
    expect(early.code).toBe("55000");
    expect(early.message).toMatch(/läuft noch bis zum \d\d\.\d\d\.\d{4}/);
    await deactivateLongAgo(E.emp1A);
    expect((await pgError(anonymize(U.ownerA, E.emp1A, "A-102"))).code).toBe("22023");
    expect((await pgError(anonymize(U.ownerA, E.emp1A, null))).code).toBe("22023");
  });

  it("only the owner may anonymise", async () => {
    for (const u of [U.managerA, U.emp2A, U.ownerB, U.superAdmin, U.support]) {
      expect((await pgError(anonymize(u, E.emp1A, "A-101"))).code).toBe("42501");
    }
  });

  it("removes every trace of the person, keeps the working times and is audited", async () => {
    // A rejected correction request and an open one with personal free text.
    await db.admin.query("update public.employees set status = 'active' where id = $1", [E.emp1A]);
    const req = (await db.as(U.emp1A, async (q) => (await q.query(
      "select id from public.create_correction_request($1, 'change', 'demo-a03-20261001', $2::jsonb, $3)",
      [E.emp1A, JSON.stringify({ note: "Sam Probe privat" }), "Sam Probe hat es vergessen"])).rows[0].id, { commit: true })) as string;
    await db.as(U.managerA, (q) => q.query("select public.decide_correction_request($1, 'rejected', 'Gespräch mit Sam Probe')", [req]), { commit: true });
    await db.as(U.managerA, (q) => q.query("select public.correct_time_entry($1, 'demo-a03-20261005', $2::jsonb, 1, 'Sam Probe Nachtrag')",
      [E.emp1A, JSON.stringify({ note: "Sam Probe Nacht" })]), { commit: true });
    await deactivateLongAgo(E.emp1A);
    await db.admin.query("insert into auth.sessions (user_id, token_hash, expires_at, user_agent) values ($1, encode(sha256('s'::bytea), 'hex'), now() + interval '1 day', 'Testbrowser')", [U.emp1A]);

    const minutesBefore = (await db.admin.query(
      "select sum(duration_minutes)::int as m, count(*)::int as n from public.time_entries where employee_id = $1 and deleted_at is null", [E.emp1A])).rows[0];
    const statementBefore = (await db.admin.query("select worked_minutes, billing_minutes, status from public.monthly_statements where employee_id = $1", [E.emp1A])).rows;

    const row = await anonymize(U.ownerA, E.emp1A, "A-101");
    expect(row.display_name).toMatch(/^Anonymisiert [0-9A-F]{8}$/);
    expect(row.personnel_number).toMatch(/^ANON-[0-9A-F]{24}$/);
    expect(row).toMatchObject({ email: null, user_id: null, status: "deactivated" });
    expect(row.anonymized_at).not.toBeNull();

    expect(await rowsContaining("Sam Probe", "fahrer1@demo-krankentransporte", "A-101", "Frühdienst", "Testbrowser")).toEqual([]);
    expect((await db.admin.query(
      "select sum(duration_minutes)::int as m, count(*)::int as n from public.time_entries where employee_id = $1 and deleted_at is null", [E.emp1A])).rows[0])
      .toEqual(minutesBefore);
    expect((await db.admin.query("select worked_minutes, billing_minutes, status from public.monthly_statements where employee_id = $1", [E.emp1A])).rows)
      .toEqual(statementBefore);
    const user = (await db.admin.query("select email, password_hash, disabled_at from auth.users where id = $1", [U.emp1A])).rows[0];
    expect(user.email).toBe(`anonymisiert-${U.emp1A}@anonym.invalid`);
    expect(user.password_hash).toBeNull();
    expect(user.disabled_at).not.toBeNull();
    expect((await db.admin.query("select count(*)::int as n from auth.sessions where user_id = $1", [U.emp1A])).rows[0].n).toBe(0);

    const audit = (await db.admin.query(
      "select actor_id, after, reason from public.audit_log where action = 'employee.anonymize' and entity_id = $1", [E.emp1A])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: U.ownerA, reason: "Anonymisierung nach Ablauf der Aufbewahrungsfrist" });
    expect(audit[0].after.retentionMonths).toBe(24);
    expect(audit[0].after.auditEntriesRedacted).toBeGreaterThan(3);
    // The redaction did not add revisions; the history keeps its structure.
    const revs = (await db.admin.query("select operation, snapshot ->> 'note' as note, reason from public.time_entry_revisions where employee_id = $1 and entry_id = 'demo-a03-20261005' order by version", [E.emp1A])).rows;
    expect(revs).toEqual([
      { operation: "insert", note: "[anonymisiert]", reason: null },
      { operation: "update", note: "[anonymisiert]", reason: "[anonymisiert]" },
    ]);
  });

  it("the anonymised record is final: no edits, no reactivation, no second run", async () => {
    expect((await pgError(db.as(U.ownerA, (q) => q.query("update public.employees set display_name = 'Sam Probe' where id = $1", [E.emp1A]))))
      .code).toBe("42501");
    expect((await pgError(db.as(U.ownerA, (q) => q.query("select public.set_employee_status($1, 'active', 'Wieder da')", [E.emp1A]))))
      .code).toBe("42501");
    expect((await pgError(anonymize(U.ownerA, E.emp1A, (await db.admin.query("select personnel_number from public.employees where id = $1", [E.emp1A])).rows[0].personnel_number))).code)
      .toBe("55000");
  });

  it("an account that is still used in another tenant stays usable", async () => {
    // Jo Demo (emp2A) also works for tenant B with the same account.
    await db.admin.query(
      "insert into public.employees (tenant_id, user_id, personnel_number, display_name, email, role, status) values ($1, $2, 'P-77', 'Jo Demo', 'fahrer2@demo-krankentransporte.example', 'employee', 'active')",
      [IDS.tenantB, U.emp2A]);
    await deactivateLongAgo(E.emp2A);
    await anonymize(U.ownerA, E.emp2A, "A-102");
    const user = (await db.admin.query("select email, password_hash is not null as has_password, disabled_at from auth.users where id = $1", [U.emp2A])).rows[0];
    expect(user).toEqual({ email: "fahrer2@demo-krankentransporte.example", has_password: false, disabled_at: null });
    // tenant A no longer holds the name; tenant B still does (its own record)
    expect((await db.admin.query("select count(*)::int as n from public.employees where tenant_id = $1 and display_name = 'Jo Demo'", [A])).rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int as n from public.employees where tenant_id = $1 and display_name = 'Jo Demo'", [IDS.tenantB])).rows[0].n).toBe(1);
  });
});

describe("append-only protection stays intact outside the anonymisation", () => {
  it("audit_log and revisions cannot be changed or deleted, even by the owner role of the database", async () => {
    expect((await pgError(db.admin.query("update public.audit_log set reason = 'x' where tenant_id = $1", [A]))).code).toBe("42501");
    expect((await pgError(db.admin.query("delete from public.audit_log where tenant_id = $1", [A]))).code).toBe("42501");
    expect((await pgError(db.admin.query("update public.time_entry_revisions set reason = 'x' where tenant_id = $1", [A]))).code).toBe("42501");
  });

  it("request roles cannot fake the redaction marker", async () => {
    expect((await pgError(db.as(U.ownerA, (q) =>
      q.query("insert into private.privacy_redactions (txid, tenant_id, employee_id) values (pg_current_xact_id(), $1, $2)", [A, E.managerA])))).code)
      .toBe("42501");
    expect((await pgError(db.as(U.ownerA, (q) => q.query("select private.redact_personal('{}'::jsonb)")))).code).toBe("42501");
    expect((await pgError(db.as(U.ownerA, (q) => q.query("update public.audit_log set reason = 'x'")))).code).toBe("42501");
  });

  it("decided correction requests stay final", async () => {
    expect((await pgError(db.admin.query("update public.correction_requests set reason = 'geändert' where status <> 'open'"))).code).toBe("55000");
  });
});

describe("retention setting", () => {
  it("is limited to 1–600 months and only the owner changes it (RLS)", async () => {
    expect((await pgError(db.admin.query("update public.tenants set retention_months_after_exit = 0 where id = $1", [A]))).code).toBe("23514");
    const n = await db.as(U.managerA, async (q) => (await q.query("update public.tenants set retention_months_after_exit = 12 where id = $1", [A])).rowCount);
    expect(n).toBe(0);
    const m = await db.as(U.ownerA, async (q) => (await q.query("update public.tenants set retention_months_after_exit = 12 where id = $1", [A])).rowCount);
    expect(m).toBe(1);
  });
});

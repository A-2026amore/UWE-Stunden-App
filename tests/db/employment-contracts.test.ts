/**
 * Migration 0025: employment contract data (hourly wage, kind of contract, target hours).
 * Only leadership writes (managers/owners and the own record only by the owner), the person
 * reads their own, other tenants and platform staff without grant see nothing; audited; exported.
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

const SET = "select * from public.set_employment_contract($1, $2, $3, $4, $5, $6)";
const set = (user: string, emp: string, args: [string, string, number | null, number | null, number], commit = false) =>
  db.as(user, async (q) => (await q.query(SET, [emp, ...args])).rows[0], { commit });
const count = async (emp: string) =>
  (await db.admin.query("select count(*)::int n from public.employment_contracts where employee_id = $1", [emp])).rows[0].n as number;

describe("employment contracts (0025)", () => {
  it("a manager records the contract of an employee; a second save of the same month replaces it", async () => {
    const row = await set(U.managerA, E.emp1A, ["2026-10", "minijob", 1400, 43 * 60, 0], true);
    expect(row).toMatchObject({ tenant_id: A, employee_id: E.emp1A, valid_from: "2026-10", employment_type: "minijob",
      hourly_wage_cents: 1400, monthly_target_minutes: 2580, carry_over_minutes: 0 });
    const again = await set(U.managerA, E.emp1A, ["2026-10", "minijob", 1450, 41 * 60, 120], true);
    expect(again).toMatchObject({ id: row.id, hourly_wage_cents: 1450, monthly_target_minutes: 2460, carry_over_minutes: 120 });
    expect(await count(E.emp1A)).toBe(1);
    // a later version is a new row; open target (null) is allowed
    await set(U.ownerA, E.emp1A, ["2026-12", "offen", null, null, 0], true);
    expect(await count(E.emp1A)).toBe(2);

    const audit = await db.admin.query(
      "select action from public.audit_log where entity = 'employment_contract' and tenant_id = $1 order by created_at", [A]);
    expect(audit.rows.map((r) => r.action)).toEqual(["employment_contract.insert", "employment_contract.update", "employment_contract.insert"]);
  });

  it("the person reads only their own contract; colleagues, other tenants and platform staff see nothing", async () => {
    const read = (user: string) => db.as(user, async (q) =>
      (await q.query("select employee_id, valid_from from public.employment_contracts where tenant_id = $1 order by valid_from", [A])).rows);
    expect(await read(U.emp1A)).toEqual([{ employee_id: E.emp1A, valid_from: "2026-10" }, { employee_id: E.emp1A, valid_from: "2026-12" }]);
    expect(await read(U.emp2A)).toEqual([]);
    expect(await read(U.ownerB)).toEqual([]);
    expect(await read(U.superAdmin)).toEqual([]);
    expect(await read(U.support)).toEqual([]);
    expect((await read(U.managerA)).length).toBe(2);
  });

  it("employees, other tenants and platform staff cannot write; no direct DML", async () => {
    for (const user of [U.emp1A, U.emp2A, U.ownerB, U.superAdmin, U.support]) {
      expect((await pgError(set(user, E.emp2A, ["2026-10", "teilzeit", 1500, 80 * 60, 0]))).code, user).toBe("42501");
    }
    const direct = await pgError(db.as(U.ownerA, (q) => q.query(
      "insert into public.employment_contracts (tenant_id, employee_id, valid_from, employment_type) values ($1, $2, '2026-10', 'vollzeit')", [A, E.emp2A])));
    expect(direct.code).toBe("42501");
    const upd = await pgError(db.as(U.ownerA, (q) => q.query("update public.employment_contracts set hourly_wage_cents = 1 where tenant_id = $1", [A])));
    expect(upd.code).toBe("42501");
  });

  it("a manager cannot change the own contract or one of another leadership person – the owner can", async () => {
    expect((await pgError(set(U.managerA, E.managerA, ["2026-10", "vollzeit", 2500, 160 * 60, 0]))).code).toBe("42501");
    expect((await pgError(set(U.managerA, E.ownerA, ["2026-10", "vollzeit", 2500, 160 * 60, 0]))).code).toBe("42501");
    expect(await set(U.ownerA, E.managerA, ["2026-10", "vollzeit", 2500, 160 * 60, 0])).toMatchObject({ employee_id: E.managerA });
    expect(await set(U.ownerA, E.ownerA, ["2026-10", "offen", null, null, 0])).toMatchObject({ employee_id: E.ownerA });
  });

  it("rejects invalid values (also through the table constraints)", async () => {
    const bad = (args: [string, string, number | null, number | null, number]) => pgError(set(U.managerA, E.emp2A, args));
    expect((await bad(["2026-13", "minijob", 1400, 2580, 0])).code).toBe("22023");
    expect((await bad(["2026-10", "werkvertrag", 1400, 2580, 0])).code).toBe("22023");
    expect((await bad(["2026-10", "minijob", 0, 2580, 0])).code).toBe("22023");
    expect((await bad(["2026-10", "minijob", 1400, 24001, 0])).code).toBe("22023");
    expect((await bad(["2026-10", "minijob", 1400, 2580, 120001])).code).toBe("22023");
    const raw = await pgError(db.admin.query(
      "insert into public.employment_contracts (tenant_id, employee_id, valid_from, employment_type, hourly_wage_cents) values ($1, $2, '2026-10', 'minijob', -5)", [A, E.emp2A]));
    expect(raw.code).toBe("23514");
  });

  it("a version is deleted by the leadership (audited); unknown months are reported", async () => {
    await set(U.managerA, E.emp2A, ["2027-01", "teilzeit", 1500, 80 * 60, 0], true);
    expect((await pgError(db.as(U.emp2A, (q) => q.query("select public.delete_employment_contract($1, '2027-01')", [E.emp2A])))).code).toBe("42501");
    expect((await pgError(db.as(U.managerA, (q) => q.query("select public.delete_employment_contract($1, '2027-02')", [E.emp2A])))).code).toBe("22023");
    await db.as(U.managerA, (q) => q.query("select public.delete_employment_contract($1, '2027-01')", [E.emp2A]), { commit: true });
    expect(await count(E.emp2A)).toBe(0);
    const audit = await db.admin.query(
      "select (before->>'valid_from') m from public.audit_log where action = 'employment_contract.delete' and tenant_id = $1", [A]);
    expect(audit.rows).toEqual([{ m: "2027-01" }]);
  });

  it("the personal data export contains the contract versions", async () => {
    const data = await db.as(U.emp1A, async (q) => (await q.query("select public.export_personal_data($1) d", [E.emp1A])).rows[0].d);
    expect(data.employmentContracts).toEqual([
      expect.objectContaining({ validFrom: "2026-10", employmentType: "minijob", hourlyWageCents: 1450, monthlyTargetMinutes: 2460, carryOverMinutes: 120 }),
      expect.objectContaining({ validFrom: "2026-12", employmentType: "offen", hourlyWageCents: null, monthlyTargetMinutes: null }),
    ]);
    // the other parts of the export are unchanged
    expect(Array.isArray(data.timeEntries)).toBe(true);
    expect(Array.isArray(data.allocations)).toBe(true);
  });

  it("anonymised records are final", async () => {
    const before = (await db.admin.query("select status, email, user_id from public.employees where id = $1", [E.invitedB])).rows[0];
    await db.admin.query("update public.employees set status = 'deactivated', email = null, user_id = null, anonymized_at = now() where id = $1", [E.invitedB]);
    try {
      expect((await pgError(set(U.ownerB, E.invitedB, ["2026-10", "minijob", 1400, 2580, 0]))).code).toBe("55000");
    } finally {
      await db.admin.query("update public.employees set anonymized_at = null, status = $2, email = $3, user_id = $4 where id = $1",
        [E.invitedB, before.status, before.email, before.user_id]);
    }
  });
});

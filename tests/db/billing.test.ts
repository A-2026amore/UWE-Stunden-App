/**
 * Price model (migration 0012): billable persons per month, conditions, default price,
 * billing status with frozen months, employee lock, tenant isolation and
 * "platform staff sees numbers only".
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
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

const C = "33333333-3333-4333-8333-333333333333";
const OWNER_C_USER = "d0000000-0000-4000-8000-000000000001";
const OWNER_C = "de000000-0000-4000-8000-000000000001";

type Period = [status: string, role: string, from: string, to: string | null];
let seq = 0;

/** Employee of tenant C with an explicit status history (the trigger rows are replaced). */
async function person(name: string, periods: Period[], userId: string | null = null): Promise<string> {
  seq += 1;
  const id = `de000000-0000-4000-8000-${String(100 + seq).padStart(12, "0")}`;
  const last = periods[periods.length - 1]!;
  await db.admin.query(
    `insert into public.employees (id, tenant_id, user_id, personnel_number, display_name, role, status)
     values ($1, $2, $3, $4, $5, $6, $7)`, [id, C, userId, `C-${seq}`, name, last[1], last[0]]);
  await db.admin.query("delete from public.employee_status_history where employee_id = $1", [id]);
  for (const [status, role, from, to] of periods) {
    await db.admin.query(
      "insert into public.employee_status_history (tenant_id, employee_id, status, role, valid_from, valid_to) values ($1, $2, $3, $4, $5, $6)",
      [C, id, status, role, from, to]);
  }
  return id;
}

async function entry(employeeId: string, date: string, deleted = false): Promise<void> {
  seq += 1;
  await db.admin.query(
    `insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time, pause_minutes, deleted_at)
     values ($1, $2, $3, $4, '08:00', '12:00', 0, $5)`, [`bill-${seq}`, C, employeeId, date, deleted ? new Date() : null]);
}

async function billing(user: string, tenant: string, month: string) {
  return db.as(user, async (q) => (await q.query("select public.tenant_billing($1, $2) as b", [tenant, month])).rows[0].b);
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await db.admin.query("insert into auth.users (id, email) values ($1, 'inhaber@abrechnung-test.example')", [OWNER_C_USER]);
  await db.admin.query(
    `insert into public.tenants (id, slug, name, status, contact, created_at)
     values ($1, 'abrechnung-test', 'Abrechnung Test GmbH', 'active',
             '{"legalName": "Abrechnung Test GmbH", "street": "", "postalCode": "", "city": ""}', '2026-08-01 00:00 Europe/Berlin')`, [C]);
  await db.admin.query("insert into public.licenses (tenant_id, plan, billing, valid_from) values ($1, 'standard', 'manual', '2026-08-01')", [C]);
  await db.admin.query(
    `insert into public.employees (id, tenant_id, user_id, personnel_number, display_name, role, status)
     values ($1, $2, $3, 'C-0', 'Inhaberin Test', 'owner', 'active')`, [OWNER_C, C, OWNER_C_USER]);
  await db.admin.query("update public.employee_status_history set valid_from = '2026-08-01 00:00 Europe/Berlin' where employee_id = $1", [OWNER_C]);

  ids.full = await person("Voll Aktiv", [["active", "employee", "2026-08-01 00:00+02", null]]);
  ids.lockedMid = await person("Gesperrt Mitte", [
    ["active", "employee", "2026-08-01 00:00+02", "2026-09-10 10:00+02"],
    ["locked", "employee", "2026-09-10 10:00+02", null]]);
  // 30.09. 23:30 Berlin = 21:30 UTC → still September in Berlin.
  ids.lateSept = await person("Spät September", [
    ["invited", "employee", "2026-09-01 00:00+02", "2026-09-30 23:30+02"],
    ["active", "employee", "2026-09-30 23:30+02", null]]);
  // 01.10. 00:30 Berlin = 30.09. 22:30 UTC → October only.
  ids.earlyOct = await person("Früh Oktober", [
    ["invited", "employee", "2026-09-01 00:00+02", "2026-10-01 00:30+02"],
    ["active", "employee", "2026-10-01 00:30+02", null]]);
  ids.deactBefore = await person("Vorher Deaktiviert", [
    ["active", "employee", "2026-08-01 00:00+02", "2026-08-31 23:59+02"],
    ["deactivated", "employee", "2026-08-31 23:59+02", null]]);
  ids.invited = await person("Nur Eingeladen", [["invited", "employee", "2026-08-01 00:00+02", null]]);
  ids.leaderFree = await person("Leitung Ohne Zeiten", [["active", "manager", "2026-08-01 00:00+02", null]]);
  ids.leaderTime = await person("Leitung Mit Zeiten", [["active", "manager", "2026-08-01 00:00+02", null]]);
  ids.leaderDeleted = await person("Leitung Gelöscht", [["active", "manager", "2026-08-01 00:00+02", null]]);
  ids.promoted = await person("Befördert", [
    ["active", "employee", "2026-08-01 00:00+02", "2026-09-15 12:00+02"],
    ["active", "manager", "2026-09-15 12:00+02", null]]);
  await entry(ids.leaderTime, "2026-09-03");
  await entry(ids.leaderDeleted, "2026-09-04", true);
  await entry(OWNER_C, "2026-09-05");
  await entry(OWNER_C, "2026-08-31"); // other month
});

describe("billable persons (Europe/Berlin)", () => {
  it("September: employees active at any time, leadership only with own time entries", async () => {
    const b = await billing(OWNER_C_USER, C, "2026-09");
    const names = b.lines.map((l: { displayName: string }) => l.displayName);
    expect(names.sort()).toEqual(["Befördert", "Gesperrt Mitte", "Inhaberin Test", "Leitung Mit Zeiten", "Spät September", "Voll Aktiv"].sort());
    expect(b).toMatchObject({ billableCount: 6, unitPriceCents: 500, amountCents: 3000, condition: "standard", status: "open", final: false, currency: "EUR" });
    const reasons = Object.fromEntries(b.lines.map((l: { displayName: string; reason: string }) => [l.displayName, l.reason]));
    expect(reasons["Inhaberin Test"]).toBe("leader_with_time");
    expect(reasons["Leitung Mit Zeiten"]).toBe("leader_with_time");
    expect(reasons["Befördert"]).toBe("employee");
    expect(reasons["Voll Aktiv"]).toBe("employee");
  });

  it("October: locked in September and the promoted manager drop out; activation at 00:30 counts for October", async () => {
    const b = await billing(OWNER_C_USER, C, "2026-10");
    const names = b.lines.map((l: { displayName: string }) => l.displayName).sort();
    expect(names).toEqual(["Früh Oktober", "Spät September", "Voll Aktiv"]);
    expect(b.amountCents).toBe(1500);
  });

  it("August: deactivation on 31.08. 23:59 still counts for August", async () => {
    const b = await billing(OWNER_C_USER, C, "2026-08");
    const names = b.lines.map((l: { displayName: string }) => l.displayName);
    expect(names).toContain("Vorher Deaktiviert");
    expect(names).toContain("Inhaberin Test"); // entry on 31.08.
    expect(names).not.toContain("Nur Eingeladen");
  });

  it("future months have no billing; invalid months are rejected", async () => {
    expect((await pgError(billing(OWNER_C_USER, C, "2099-01"))).code).toBe("22023");
    expect((await pgError(billing(OWNER_C_USER, C, "2026-13"))).code).toBe("22023");
  });

  it("seed data: tenant A is a free pilot, tenant B pays the default price", async () => {
    const a = await billing(U.ownerA, A, "2026-10");
    expect(a).toMatchObject({ condition: "pilot_free", unitPriceCents: 0, amountCents: 0, billableCount: 3 });
    expect(a.lines.find((l: { displayName: string }) => l.displayName === "Robin Leitung")?.reason).toBe("leader_with_time");
    expect(a.lines.map((l: { displayName: string }) => l.displayName)).not.toContain("Alex Beispiel");
    const b = await billing(U.ownerB, B, "2026-10");
    expect(b).toMatchObject({ condition: "standard", unitPriceCents: 500, billableCount: 1, amountCents: 500 });
    expect(b.lines.map((l: { displayName: string }) => l.displayName)).toEqual(["Charlie Test"]);
  });

  it("history: months back to the tenant's creation", async () => {
    const rows = await db.as(OWNER_C_USER, async (q) => (await q.query("select * from public.tenant_billing_history($1, 36)", [C])).rows);
    expect(rows[rows.length - 1].month).toBe("2026-08");
    expect(rows.find((r) => r.month === "2026-09")).toMatchObject({ billable_count: 6, amount_cents: 3000 });
  });
});

describe("conditions and default price", () => {
  it("special price applies when its validity overlaps the month; free of charge; pilot_free", async () => {
    await db.admin.query(
      "update public.licenses set employee_price_cents = 350, condition_valid_from = '2026-09-15', condition_valid_until = '2026-12-31', condition_note = 'Rabatt' where tenant_id = $1", [C]);
    expect(await billing(OWNER_C_USER, C, "2026-09")).toMatchObject({ condition: "special", unitPriceCents: 350, amountCents: 2100 });
    expect(await billing(OWNER_C_USER, C, "2026-08")).toMatchObject({ condition: "standard", unitPriceCents: 500 });

    await db.admin.query("update public.licenses set free_of_charge = true where tenant_id = $1", [C]);
    expect(await billing(OWNER_C_USER, C, "2026-09")).toMatchObject({ condition: "free", unitPriceCents: 0, amountCents: 0, billableCount: 6 });

    await db.admin.query("update public.licenses set plan = 'pilot_free', price_cents = 0, billing = 'none', free_of_charge = false where tenant_id = $1", [C]);
    const lic = (await db.admin.query("select free_of_charge from public.licenses where tenant_id = $1", [C])).rows[0];
    expect(lic.free_of_charge).toBe(true); // pilot_free is always free
    expect(await billing(OWNER_C_USER, C, "2026-08")).toMatchObject({ condition: "pilot_free", amountCents: 0 });

    await db.admin.query(
      `update public.licenses set plan = 'standard', billing = 'manual', free_of_charge = false, employee_price_cents = null,
              condition_valid_from = null, condition_valid_until = null, condition_note = null where tenant_id = $1`, [C]);
    expect(await billing(OWNER_C_USER, C, "2026-09")).toMatchObject({ condition: "standard", unitPriceCents: 500 });
  });

  it("invalid conditions are rejected by the database", async () => {
    expect((await pgError(db.admin.query("update public.licenses set employee_price_cents = -1 where tenant_id = $1", [C]))).code).toBe("23514");
    expect((await pgError(db.admin.query(
      "update public.licenses set condition_valid_from = '2026-10-01', condition_valid_until = '2026-09-01' where tenant_id = $1", [C]))).code).toBe("23514");
  });

  it("only the super-admin changes conditions (licence) and the default price – audited", async () => {
    for (const user of [U.support, U.ownerA]) {
      const n = await db.as(user, async (q) => (await q.query("update public.licenses set employee_price_cents = 1 where tenant_id = $1", [C])).rowCount);
      expect(n).toBe(0);
    }
    for (const user of [U.support, U.ownerA, U.managerA]) {
      expect((await pgError(db.as(user, (q) => q.query("select public.platform_set_default_price(100, 'Test')")))).code).toBe("42501");
    }
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_set_default_price(600, '')")))).code).toBe("22023");
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_set_default_price(-5, 'Preis')")))).code).toBe("22023");
    const r = await db.as(U.superAdmin, async (q) => (await q.query("select * from public.platform_set_default_price(600, 'Preisanpassung Test')")).rows[0], { commit: true });
    expect(r.default_price_cents).toBe(600);
    try {
      expect(await billing(OWNER_C_USER, C, "2026-09")).toMatchObject({ unitPriceCents: 600, amountCents: 3600 });
      const audit = await db.as(U.support, async (q) =>
        (await q.query("select * from public.audit_log where entity = 'billing_settings' order by created_at desc limit 1")).rows[0]);
      expect(audit).toMatchObject({ action: "billing_settings.default_price", reason: "Preisanpassung Test", actor_id: U.superAdmin });
      expect(audit.after).toEqual({ defaultPriceCents: 600 });
    } finally {
      await db.as(U.superAdmin, (q) => q.query("select public.platform_set_default_price(500, 'Zurück auf Standard')"), { commit: true });
    }
  });
});

describe("billing status and frozen months", () => {
  it("leaving 'open' freezes count and amount; later changes do not alter the month", async () => {
    const p = await db.as(U.superAdmin, async (q) =>
      (await q.query("select * from public.platform_set_billing_status($1, '2026-09', 'invoiced', 'RE-2026-09-001')", [C])).rows[0], { commit: true });
    expect(p).toMatchObject({ status: "invoiced", billable_count: 6, unit_price_cents: 500, amount_cents: 3000, condition: "standard" });

    // A new person active in September and a new default price – the frozen month stays.
    const late = await person("Nachgetragen", [["active", "employee", "2026-09-20 08:00+02", null]]);
    await db.as(U.superAdmin, (q) => q.query("select public.platform_set_default_price(700, 'Test Einfrieren')"), { commit: true });
    try {
      const b = await billing(OWNER_C_USER, C, "2026-09");
      expect(b).toMatchObject({ final: true, status: "invoiced", billableCount: 6, amountCents: 3000 });
      expect(b.lines.map((l: { displayName: string }) => l.displayName)).not.toContain("Nachgetragen");

      // Status changes keep the snapshot; reopening needs a reason and computes live again.
      await db.as(U.superAdmin, (q) => q.query("select public.platform_set_billing_status($1, '2026-09', 'paid')", [C]), { commit: true });
      expect(await billing(OWNER_C_USER, C, "2026-09")).toMatchObject({ status: "paid", amountCents: 3000 });
      expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_set_billing_status($1, '2026-09', 'open')", [C])))).code).toBe("22023");
      await db.as(U.superAdmin, (q) => q.query("select public.platform_set_billing_status($1, '2026-09', 'open', 'Korrektur Test')", [C]), { commit: true });
      expect(await billing(OWNER_C_USER, C, "2026-09")).toMatchObject({ status: "open", final: false, billableCount: 7, unitPriceCents: 700 });
    } finally {
      await db.as(U.superAdmin, (q) => q.query("select public.platform_set_default_price(500, 'Zurück')"), { commit: true });
      await db.admin.query("update public.employee_status_history set valid_from = '2026-11-01 00:00+01' where employee_id = $1", [late]);
    }

    const audit = await db.admin.query("select action, reason, after from public.audit_log where entity = 'billing_period' and tenant_id = $1 order by created_at", [C]);
    expect(audit.rows.map((r) => r.after.status)).toEqual(["invoiced", "paid", "open"]);
    expect(audit.rows[2].reason).toBe("Korrektur Test");
    expect(JSON.stringify(audit.rows)).not.toContain("Voll Aktiv");
  });

  it("waiving requires a reason; the current month cannot be closed; only super-admins", async () => {
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_set_billing_status($1, '2026-08', 'waived')", [C])))).code).toBe("22023");
    const w = await db.as(U.superAdmin, async (q) =>
      (await q.query("select * from public.platform_set_billing_status($1, '2026-08', 'waived', 'Kulanz Pilotphase')", [C])).rows[0]);
    expect(w.status).toBe("waived");
    const current = (await db.admin.query("select to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM') m")).rows[0].m;
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_set_billing_status($1, $2, 'invoiced')", [C, current])))).code).toBe("55000");
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("select public.platform_set_billing_status($1, '2026-08', 'unbekannt')", [C])))).code).toBe("22023");
    for (const user of [U.support, OWNER_C_USER, U.ownerA]) {
      expect((await pgError(db.as(user, (q) => q.query("select public.platform_set_billing_status($1, '2026-08', 'paid')", [C])))).code, user).toBe("42501");
    }
    // No direct writes for anyone.
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("insert into public.billing_periods (tenant_id, month) values ($1, '2026-07')", [C])))).code).toBe("42501");
    expect((await pgError(db.as(U.superAdmin, (q) => q.query("update public.billing_settings set default_price_cents = 1")))).code).toBe("42501");
  });
});

describe("tenant isolation and data protection", () => {
  it("a customer never sees another tenant's billing; employees see none", async () => {
    expect((await pgError(billing(U.ownerA, B, "2026-10"))).code).toBe("42501");
    expect((await pgError(billing(U.ownerB, A, "2026-10"))).code).toBe("42501");
    expect((await pgError(billing(U.emp1A, A, "2026-10"))).code).toBe("42501");
    expect((await pgError(db.as(U.ownerA, (q) => q.query("select * from public.tenant_billing_history($1)", [C])))).code).toBe("42501");
    await db.as(U.superAdmin, (q) => q.query("select public.platform_set_billing_status($1, '2026-09', 'invoiced')", [B]), { commit: true });
    const seen = await db.as(U.ownerA, async (q) => ({
      periods: (await q.query("select * from public.billing_periods where tenant_id <> $1", [A])).rowCount,
      lines: (await q.query("select * from public.billing_period_lines where tenant_id <> $1", [A])).rowCount,
      history: (await q.query("select * from public.employee_status_history where tenant_id <> $1", [A])).rowCount,
    }));
    expect(seen).toEqual({ periods: 0, lines: 0, history: 0 });
    // Tenant B started in October (seed): the closed September has no billable persons.
    const own = await db.as(U.ownerB, async (q) => (await q.query("select billable_count from public.billing_periods where tenant_id = $1", [B])).rows);
    expect(own).toEqual([{ billable_count: 0 }]);
  });

  it("platform staff sees numbers only – no names, no billable persons, no status history", async () => {
    for (const user of [U.superAdmin, U.support]) {
      const rows = await db.as(user, async (q) => (await q.query("select * from public.platform_billing_overview('2026-09')")).rows);
      const c = rows.find((r) => r.tenant_id === C);
      expect(c).toMatchObject({ billable_count: 6, amount_cents: 3000, unit_price_cents: 500 });
      const text = JSON.stringify(rows);
      for (const name of ["Voll Aktiv", "Inhaberin Test", "Sam Probe", "Charlie Test"]) expect(text).not.toContain(name);
      expect((await pgError(billing(user, C, "2026-09"))).code).toBe("42501");
      const seen = await db.as(user, async (q) => ({
        lines: (await q.query("select * from public.billing_period_lines")).rowCount,
        history: (await q.query("select * from public.employee_status_history")).rowCount,
        periods: (await q.query("select * from public.billing_periods")).rowCount,
      }));
      expect(seen.lines).toBe(0);
      expect(seen.history).toBe(0);
      expect(seen.periods).toBeGreaterThan(0);
    }
    for (const user of [U.ownerA, U.emp1A]) {
      expect((await pgError(db.as(user, (q) => q.query("select * from public.platform_billing_overview('2026-09')")))).code).toBe("42501");
    }
  });
});

describe("employee status 'locked'", () => {
  it("leadership locks and unlocks; locked persons have no access and cannot record time; data stays", async () => {
    await db.as(U.managerA, (q) => q.query("select public.set_employee_status($1, 'locked', 'Gerät verloren')", [E.emp2A]), { commit: true });
    try {
      const ctx = await db.as(U.emp2A, async (q) => (await q.query("select public.current_session_context() c")).rows[0].c);
      expect(ctx.memberships).toEqual([]);
      const n = await db.as(U.emp2A, async (q) => (await q.query("select count(*)::int n from public.time_entries")).rows[0].n);
      expect(n).toBe(0);
      const stored = (await db.admin.query("select count(*)::int n from public.time_entries where employee_id = $1", [E.emp2A])).rows[0].n;
      expect(stored).toBeGreaterThan(0);
      const e = await pgError(db.as(U.emp2A, (q) => q.query("select public.create_time_entry($1, $2)",
        [E.emp2A, { id: "locked-0001", date: "2026-10-20", start: "08:00", end: "10:00", pauseMinutes: 0, note: "" }])));
      expect(e.code).toBe("42501");
      // Lock only from active.
      expect((await pgError(db.as(U.managerA, (q) => q.query("select public.set_employee_status($1, 'locked', 'Nochmal')", [E.emp2A])))).code).toBe("55000");
      // Nobody locks themselves; managers do not lock the owner.
      expect((await pgError(db.as(U.managerA, (q) => q.query("select public.set_employee_status($1, 'locked', 'Selbst')", [E.managerA])))).code).toBe("42501");
      expect((await pgError(db.as(U.managerA, (q) => q.query("select public.set_employee_status($1, 'locked', 'Inhaber')", [E.ownerA])))).code).toBe("42501");
    } finally {
      await db.as(U.managerA, (q) => q.query("select public.set_employee_status($1, 'active', 'Neues Gerät')", [E.emp2A]), { commit: true });
    }
    const hist = await db.admin.query("select status, valid_to is null as open from public.employee_status_history where employee_id = $1 order by valid_from", [E.emp2A]);
    expect(hist.rows.map((r) => r.status)).toEqual(["active", "locked", "active"]);
    expect(hist.rows.map((r) => r.open)).toEqual([false, false, true]);
    const ctx = await db.as(U.emp2A, async (q) => (await q.query("select public.current_session_context() c")).rows[0].c);
    expect(ctx.memberships).toHaveLength(1);
  });

  it("the history is maintained by trigger and not writable by request roles", async () => {
    const e = await pgError(db.as(U.ownerA, (q) => q.query(
      "insert into public.employee_status_history (tenant_id, employee_id, status, role, valid_from) values ($1, $2, 'active', 'employee', now())", [A, E.emp1A])));
    expect(e.code).toBe("42501");
    expect((await pgError(db.as(U.ownerA, (q) => q.query("update public.employee_status_history set valid_from = now() where tenant_id = $1", [A])))).code).toBe("42501");
    // Role change → new period.
    await db.as(U.ownerA, (q) => q.query("update public.employees set role = 'manager' where id = $1", [E.emp1A]), { commit: true });
    await db.as(U.ownerA, (q) => q.query("update public.employees set role = 'employee' where id = $1", [E.emp1A]), { commit: true });
    const roles = await db.admin.query("select role from public.employee_status_history where employee_id = $1 order by valid_from", [E.emp1A]);
    expect(roles.rows.map((r) => r.role)).toEqual(["employee", "manager", "employee"]);
  });
});

describe("migration of existing data", () => {
  it("initialises the history from the audit trail (0001–0011 data, then 0012)", async () => {
    const name = `billing_mig_${Date.now().toString(36)}`;
    await db.admin.query(`create database ${name}`);
    const params = (db.admin as unknown as { connectionParameters: { host: string; port: number; user: string; password?: string } }).connectionParameters;
    const c = new pg.Client({ host: params.host, port: params.port, user: params.user, password: params.password, database: name });
    await c.connect();
    try {
      const dir = resolve(__dirname, "../../db/migrations");
      const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
      for (const f of files.filter((x) => x < "0012")) await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query(`insert into public.tenants (id, slug, name, status, contact) values ($1, 'alt-daten', 'Alt GmbH', 'active',
        '{"legalName": "Alt GmbH", "street": "", "postalCode": "", "city": ""}')`, [C]);
      await c.query("insert into public.employees (id, tenant_id, personnel_number, display_name, role, status) values ($1, $2, 'X1', 'Alt Eins', 'employee', 'invited')", [OWNER_C, C]);
      await c.query("update public.employees set status = 'active' where id = $1", [OWNER_C]);
      await c.query("update public.employees set display_name = 'Alt Eins Neu' where id = $1", [OWNER_C]);
      await c.query("update public.employees set status = 'deactivated' where id = $1", [OWNER_C]);
      await c.query(readFileSync(join(dir, files.find((f) => f.startsWith("0012"))!), "utf8"));
      const h = await c.query("select status, role, valid_to is null as open from public.employee_status_history where employee_id = $1 order by valid_from", [OWNER_C]);
      expect(h.rows).toEqual([
        { status: "invited", role: "employee", open: false },
        { status: "active", role: "employee", open: false },
        { status: "deactivated", role: "employee", open: true },
      ]);
    } finally {
      await c.end();
      await db.admin.query(`drop database ${name} with (force)`);
    }
  });
});

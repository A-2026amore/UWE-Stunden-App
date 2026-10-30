/**
 * Tenant isolation and role scopes through the HTTP API (RLS behind it).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
let statementA: string; // approved September statement of emp1A (tenant A)
let statementB: string; // submitted October statement of empB (tenant B)
const cookies: Record<string, string> = {};

beforeAll(async () => {
  t = await startTestServer();
  statementA = (await t.db.admin.query("select id from public.monthly_statements where employee_id = $1", [IDS.employees.emp1A])).rows[0].id;
  statementB = (await t.db.admin.query("select id from public.monthly_statements where employee_id = $1", [IDS.employees.empB])).rows[0].id;
  for (const who of ["ownerA", "managerA", "emp1A", "emp2A", "ownerB", "empB", "superAdmin", "support"] as const) {
    cookies[who] = await t.login(who);
  }
});
afterAll(async () => {
  await t?.close();
});

const A = IDS.tenantA;
const E = IDS.employees;

/** Every resource of tenant A, addressed through the API. */
function tenantARequests(): [string, string, unknown?][] {
  return [
    ["GET", `/api/tenants/${A}`],
    ["PATCH", `/api/tenants/${A}/branding`, { slogan: "Fremdzugriff" }],
    ["PATCH", `/api/tenants/${A}/contact`, { city: "Fremdstadt" }],
    ["PATCH", `/api/tenants/${A}/settings`, { breakPolicy: { maxShiftMinutes: 600 } }],
    ["GET", `/api/tenants/${A}/support-grant`],
    ["PUT", `/api/tenants/${A}/support-grant`, { hours: 2 }],
    ["GET", `/api/tenants/${A}/employees`],
    ["POST", `/api/tenants/${A}/employees`, { displayName: "Fremd", personnelNumber: "X-1", email: null, role: "employee" }],
    ["PATCH", `/api/employees/${E.emp1A}`, { displayName: "Fremd" }],
    ["POST", `/api/employees/${E.emp1A}/status`, { status: "deactivated", reason: "Fremdzugriff" }],
    ["POST", `/api/employees/${E.emp2A}/invitation`, {}],
    ["GET", `/api/employees/${E.emp1A}/time-entries?month=2026-10`],
    ["GET", `/api/tenants/${A}/time-entries?from=2026-10-01&to=2026-10-31`],
    ["POST", `/api/employees/${E.emp1A}/time-entries`, { id: "fremd-0001", date: "2026-10-20", start: "08:00", end: "12:00", pauseMinutes: 0, note: "" }],
    ["PATCH", `/api/employees/${E.emp1A}/time-entries/demo-a03-20261001`, { patch: { note: "Fremd" }, expectedVersion: 1, reason: "Fremdzugriff" }],
    ["DELETE", `/api/employees/${E.emp1A}/time-entries/demo-a03-20261001`, { expectedVersion: 1, reason: "Fremdzugriff" }],
    ["PATCH", `/api/time-entries/demo-a03-20261001`, { patch: { note: "Fremd" }, expectedVersion: 1, reason: "Fremdzugriff" }],
    ["DELETE", `/api/time-entries/demo-a03-20261001`, { expectedVersion: 1, reason: "Fremdzugriff" }],
    ["GET", `/api/employees/${E.emp1A}/allocations`],
    ["PUT", `/api/employees/${E.emp1A}/allocations/2026-11`, { minutes: 60 }],
    ["POST", `/api/employees/${E.emp1A}/allocations/2026-10/review`, { decision: "approved" }],
    ["GET", `/api/tenants/${A}/statements?month=2026-09`],
    ["GET", `/api/employees/${E.emp1A}/statements/2026-09`],
    ["POST", `/api/employees/${E.emp1A}/statements/2026-10/submit`, {}],
    ["POST", `/api/statements/${statementA}/approve`, {}],
    ["POST", `/api/statements/${statementA}/return`, { reason: "Fremdzugriff" }],
    ["GET", `/api/tenants/${A}/audit`],
  ];
}

describe("cross-tenant access is denied for every resource type", () => {
  for (const who of ["ownerB", "empB"] as const) {
    it(`${who} (tenant B) gets 403 for all tenant-A endpoints`, async () => {
      const results: string[] = [];
      for (const [method, path, body] of tenantARequests()) {
        const r = await t.call(method, path, { cookie: cookies[who], body });
        if (r.status !== 403) results.push(`${method} ${path} → ${r.status}`);
      }
      expect(results).toEqual([]);
    });
  }

  it("nothing of tenant A was changed by the attempts", async () => {
    const tenant = (await t.db.admin.query("select branding, contact, settings from public.tenants where id = $1", [A])).rows[0];
    expect(tenant.branding.slogan).not.toBe("Fremdzugriff");
    expect(tenant.contact.city).not.toBe("Fremdstadt");
    expect(tenant.settings.breakPolicy.maxShiftMinutes).toBe(720);
    const entry = (await t.db.admin.query("select note, version, deleted_at from public.time_entries where employee_id = $1 and id = 'demo-a03-20261001'", [E.emp1A])).rows[0];
    expect(entry).toMatchObject({ note: "", version: 1, deleted_at: null });
    expect((await t.db.admin.query("select count(*)::int as n from public.time_entries where id = 'fremd-0001'")).rows[0].n).toBe(0);
    expect((await t.db.admin.query("select count(*)::int as n from public.employees where personnel_number = 'X-1'")).rows[0].n).toBe(0);
    expect((await t.db.admin.query("select status from public.monthly_statements where id = $1", [statementA])).rows[0].status).toBe("approved");
  });

  it("tenant A cannot touch tenant B either (statement, employee, entries)", async () => {
    const c = cookies.ownerA;
    expect((await t.call("GET", `/api/tenants/${IDS.tenantB}`, { cookie: c })).status).toBe(403);
    expect((await t.call("POST", `/api/statements/${statementB}/return`, { cookie: c, body: { reason: "Fremdzugriff" } })).status).toBe(403);
    expect((await t.call("GET", `/api/employees/${E.empB}/time-entries?month=2026-10`, { cookie: c })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${E.empB}/time-entries`, { cookie: c, body: { id: "fremd-0002", date: "2026-10-20", start: "08:00", end: "12:00", pauseMinutes: 0, note: "" } })).status).toBe(403);
  });

  it("unauthenticated requests get 401", async () => {
    for (const [method, path, body] of tenantARequests()) {
      const r = await t.call(method, path, { body });
      expect(`${method} ${path} → ${r.status}`).toBe(`${method} ${path} → 401`);
    }
  });
});

describe("employee scope", () => {
  it("an employee cannot read colleague data", async () => {
    const c = cookies.emp1A;
    expect((await t.call("GET", `/api/employees/${E.emp2A}/time-entries?month=2026-10`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/employees/${E.emp2A}/allocations`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/employees/${E.emp2A}/statements/2026-10`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/time-entries?from=2026-10-01&to=2026-10-31`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/statements?month=2026-10`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/audit`, { cookie: c })).status).toBe(403);
    expect((await t.call("PATCH", `/api/time-entries/demo-a04-20261001`, { cookie: c, body: { patch: { note: "x" }, expectedVersion: 1 } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${E.emp2A}/time-entries`, { cookie: c, body: { id: "kollege-001", date: "2026-10-21", start: "08:00", end: "10:00", pauseMinutes: 0, note: "" } })).status).toBe(403);
  });

  it("an employee sees only themself in the employee list and can read own data", async () => {
    const c = cookies.emp1A;
    const list = await t.call("GET", `/api/tenants/${A}/employees`, { cookie: c });
    expect(list.status).toBe(200);
    expect(list.body.map((e: { id: string }) => e.id)).toEqual([E.emp1A]);
    const own = await t.call("GET", `/api/employees/${E.emp1A}/time-entries?month=2026-10`, { cookie: c });
    expect(own.status).toBe(200);
    expect(own.body.map((e: { id: string }) => e.id)).toEqual(["demo-a03-20261001", "demo-a03-20261005"]);
    expect(own.body[0]).toMatchObject({ date: "2026-10-01", start: "07:00", end: "15:00", pauseMinutes: 30, version: 1, deletedAt: null, source: "app" });
    expect((await t.call("GET", `/api/tenants/${A}`, { cookie: c })).status).toBe(200);
  });

  it("an employee cannot change tenant data, roles or their own status", async () => {
    const c = cookies.emp1A;
    expect((await t.call("PATCH", `/api/tenants/${A}/branding`, { cookie: c, body: { slogan: "Mitarbeiter" } })).status).toBe(403);
    expect((await t.call("PATCH", `/api/employees/${E.emp1A}`, { cookie: c, body: { role: "owner" } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${E.emp1A}/status`, { cookie: c, body: { status: "deactivated", reason: "Selbst" } })).status).toBe(403);
    const name = await t.call("PATCH", `/api/employees/${E.emp1A}`, { cookie: c, body: { displayName: "Sam Probe (geändert)" } });
    expect(name.status).toBe(200);
    expect(name.body.displayName).toBe("Sam Probe (geändert)");
  });

  it("platform endpoints are closed for tenant users", async () => {
    for (const c of [cookies.emp1A, cookies.ownerA]) {
      expect((await t.call("GET", "/api/platform/tenants", { cookie: c })).status).toBe(403);
      expect((await t.call("GET", "/api/platform/audit", { cookie: c })).status).toBe(403);
      expect((await t.call("POST", "/api/platform/tenants", { cookie: c, body: { name: "Firma X", slug: "firma-x", plan: "standard", isDemo: true, ownerEmail: "x@firma-x.example" } })).status).toBe(403);
      expect((await t.call("PUT", `/api/platform/tenants/${A}/license`, { cookie: c, body: { plan: "enterprise" } })).status).toBe(403);
      expect((await t.call("POST", `/api/platform/tenants/${A}/status`, { cookie: c, body: { status: "suspended", reason: "Test" } })).status).toBe(403);
    }
  });
});

describe("manager scope", () => {
  it("a manager reads the whole tenant", async () => {
    const c = cookies.managerA;
    const emps = await t.call("GET", `/api/tenants/${A}/employees`, { cookie: c });
    expect(emps.status).toBe(200);
    expect(emps.body.length).toBeGreaterThanOrEqual(4);
    const entries = await t.call("GET", `/api/tenants/${A}/time-entries?from=2026-09-01&to=2026-10-31`, { cookie: c });
    expect(entries.status).toBe(200);
    expect(new Set(entries.body.map((e: { tenantId: string }) => e.tenantId))).toEqual(new Set([A]));
    expect(entries.body.length).toBe(6);
    expect((await t.call("GET", `/api/employees/${E.emp2A}/time-entries?month=2026-10`, { cookie: c })).status).toBe(200);
    expect((await t.call("GET", `/api/tenants/${A}/audit?limit=5`, { cookie: c })).status).toBe(200);
  });

  it("a manager corrects other people's entries only with a reason (source 'correction')", async () => {
    const c = cookies.managerA;
    const noReason = await t.call("PATCH", `/api/employees/${E.emp2A}/time-entries/demo-a04-20261001`, { cookie: c, body: { patch: { note: "Korrektur" }, expectedVersion: 1 } });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.message).toMatch(/Begründung/);
    const ok = await t.call("PATCH", `/api/employees/${E.emp2A}/time-entries/demo-a04-20261001`, { cookie: c, body: { patch: { note: "Korrektur" }, expectedVersion: 1, reason: "Uhrzeit laut Fahrtenbuch" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ note: "Korrektur", version: 2, source: "correction" });
    const audit = (await t.db.admin.query("select reason from public.audit_log where action = 'time_entry.correction' order by created_at desc limit 1")).rows[0];
    expect(audit.reason).toBe("Uhrzeit laut Fahrtenbuch");
  });

  it("a manager cannot change owner-only things", async () => {
    const c = cookies.managerA;
    expect((await t.call("PATCH", `/api/tenants/${A}/branding`, { cookie: c, body: { slogan: "Leitung" } })).status).toBe(403);
    expect((await t.call("PATCH", `/api/tenants/${A}/settings`, { cookie: c, body: { breakPolicy: { maxShiftMinutes: 600 } } })).status).toBe(403);
    expect((await t.call("PATCH", `/api/employees/${E.emp1A}`, { cookie: c, body: { role: "manager" } })).status).toBe(403);
    expect((await t.call("PUT", `/api/tenants/${A}/support-grant`, { cookie: c, body: { hours: 1 } })).status).toBe(403);
    // since 0017 nobody returns an approved statement (re-opening is POST …/reopen, tested in entries/corrections)
    expect((await t.call("POST", `/api/statements/${statementA}/return`, { cookie: c, body: { reason: "Wieder öffnen" } })).status).toBe(409);
  });
});

describe("platform staff", () => {
  it("super_admin sees tenant metadata and counts", async () => {
    const r = await t.call("GET", "/api/platform/tenants", { cookie: cookies.superAdmin });
    expect(r.status).toBe(200);
    const a = r.body.find((o: { tenant: { id: string } }) => o.tenant.id === A);
    expect(a).toMatchObject({ tenant: { slug: "demo-krankentransporte" }, license: { plan: "pilot_free", priceCents: 0 } });
    expect(a.employeeCount).toBeGreaterThanOrEqual(4);
    expect((await t.call("GET", "/api/platform/tenants", { cookie: cookies.support })).status).toBe(200);
  });

  it("super_admin sees no personal data without a grant", async () => {
    const c = cookies.superAdmin;
    expect((await t.call("GET", `/api/tenants/${A}/time-entries?from=2026-09-01&to=2026-10-31`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/employees/${E.emp1A}/time-entries?month=2026-10`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/employees`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/statements?month=2026-09`, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", `/api/employees/${E.emp1A}/allocations`, { cookie: c })).status).toBe(403);
    const audit = await t.call("GET", `/api/tenants/${A}/audit`, { cookie: c });
    expect(audit.status).toBe(200);
    expect(audit.body.every((e: { entity: string }) => ["tenant", "license", "support_access_grant"].includes(e.entity))).toBe(true);
  });

  it("with an owner grant, platform staff can read (not write) that tenant only", async () => {
    const grant = await t.call("PUT", `/api/tenants/${A}/support-grant`, { cookie: cookies.ownerA, body: { hours: 2, reason: "Supportfall Test" } });
    expect(grant.status).toBe(200);
    expect(grant.body.tenantId).toBe(A);
    expect((await t.call("GET", `/api/tenants/${A}/support-grant`, { cookie: cookies.superAdmin })).body.tenantId).toBe(A);

    const c = cookies.support;
    const read = await t.call("GET", `/api/tenants/${A}/time-entries?from=2026-09-01&to=2026-10-31`, { cookie: c });
    expect(read.status).toBe(200);
    expect(read.body.length).toBeGreaterThan(0);
    expect((await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, { cookie: c, body: { id: "support-001", date: "2026-10-22", start: "08:00", end: "10:00", pauseMinutes: 0, note: "" } })).status).toBe(403);
    expect((await t.call("PATCH", `/api/employees/${E.emp1A}/time-entries/demo-a03-20261001`, { cookie: c, body: { patch: { note: "x" }, expectedVersion: 1, reason: "Supportänderung" } })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${IDS.tenantB}/time-entries?from=2026-09-01&to=2026-10-31`, { cookie: c })).status).toBe(403);

    const revoke = await t.call("PUT", `/api/tenants/${A}/support-grant`, { cookie: cookies.ownerA, body: { hours: 0 } });
    expect(revoke.status).toBe(200);
    expect(revoke.body).toBeNull();
    expect((await t.call("GET", `/api/tenants/${A}/time-entries?from=2026-09-01&to=2026-10-31`, { cookie: c })).status).toBe(403);
  });

  it("platform staff cannot change a tenant's company profile – not even with a support grant (QA B3)", async () => {
    const before = (await t.db.admin.query("select branding, contact from public.tenants where id = $1", [A])).rows[0];
    const attempts = async () => {
      for (const c of [cookies.superAdmin, cookies.support]) {
        const b = await t.call("PATCH", `/api/tenants/${A}/branding`, { cookie: c, body: { slogan: "Plattform" } });
        expect(b.status).toBe(403);
        expect(b.body.error.message).toBe("Firmendaten darf nur der Inhaber ändern.");
        expect((await t.call("PATCH", `/api/tenants/${A}/contact`, { cookie: c, body: { city: "Plattformstadt" } })).status).toBe(403);
        expect((await t.call("PATCH", `/api/tenants/${A}/settings`, { cookie: c, body: { breakPolicy: { maxShiftMinutes: 600 } } })).status).toBe(403);
      }
    };
    await attempts();
    expect((await t.call("PUT", `/api/tenants/${A}/support-grant`, { cookie: cookies.ownerA, body: { hours: 1, reason: "Supportfall Branding" } })).status).toBe(200);
    try {
      await attempts();
    } finally {
      await t.call("PUT", `/api/tenants/${A}/support-grant`, { cookie: cookies.ownerA, body: { hours: 0 } });
    }
    const after = (await t.db.admin.query("select branding, contact from public.tenants where id = $1", [A])).rows[0];
    expect(after).toEqual(before);
  });

  it("only super_admin creates tenants and changes licences", async () => {
    const body = { name: "Neue Testfirma", slug: "neue-testfirma", plan: "pilot_free", isDemo: true, ownerEmail: "chef@neue-testfirma.example" };
    expect((await t.call("POST", "/api/platform/tenants", { cookie: cookies.support, body })).status).toBe(403);
    const before = t.mails.length;
    const created = await t.call("POST", "/api/platform/tenants", { cookie: cookies.superAdmin, body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ tenant: { slug: "neue-testfirma", isDemo: true, status: "active" }, license: { plan: "pilot_free", billing: "none" }, employeeCount: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.mails.slice(before).map((m) => m.to)).toEqual(["chef@neue-testfirma.example"]);
    const dup = await t.call("POST", "/api/platform/tenants", { cookie: cookies.superAdmin, body });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe("Dieser Kurzname ist bereits vergeben.");

    const lic = await t.call("PUT", `/api/platform/tenants/${created.body.tenant.id}/license`, { cookie: cookies.superAdmin, body: { plan: "business", maxEmployees: 40, note: "Test" } });
    expect(lic.status).toBe(200);
    expect(lic.body).toMatchObject({ plan: "business", billing: "manual", maxEmployees: 40, priceCents: 0 });
    expect((await t.call("PUT", `/api/platform/tenants/${created.body.tenant.id}/license`, { cookie: cookies.support, body: { plan: "enterprise" } })).status).toBe(403);

    const st = await t.call("POST", `/api/platform/tenants/${created.body.tenant.id}/status`, { cookie: cookies.superAdmin, body: { status: "suspended", reason: "Testsperre" } });
    expect(st.status).toBe(200);
    expect(st.body.status).toBe("suspended");
    const pa = await t.call("GET", "/api/platform/audit?limit=20", { cookie: cookies.superAdmin });
    expect(pa.status).toBe(200);
    expect(pa.body.some((e: { entity: string; tenantId: string }) => e.entity === "license" && e.tenantId === created.body.tenant.id)).toBe(true);
  });
});

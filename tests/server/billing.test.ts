/**
 * Price model through the HTTP API (migration 0012): tenant billing with names for
 * leadership, numbers only for platform staff, default price, conditions, billing
 * status, employee lock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS, IDS, PASSWORD, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "emp1A", "ownerB", "superAdmin", "support"] as const) cookies[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

const A = IDS.tenantA;
const B = IDS.tenantB;
const E = IDS.employees;

describe("tenant billing (owner / manager)", () => {
  it("returns the month with billable persons and reasons", async () => {
    const r = await t.call("GET", `/api/tenants/${A}/billing?month=2026-10`, { cookie: cookies.managerA });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tenantId: A, month: "2026-10", condition: "pilot_free", billableCount: 3, amountCents: 0, currency: "EUR", status: "open", final: false });
    expect(r.body.lines.map((l: { displayName: string; reason: string }) => `${l.displayName}:${l.reason}`).sort())
      .toEqual(["Jo Demo:employee", "Robin Leitung:leader_with_time", "Sam Probe:employee"]);
    const b = await t.call("GET", `/api/tenants/${B}/billing?month=2026-10`, { cookie: cookies.ownerB });
    // 0023: no plan chosen → monthly plan (6,50 €)
    expect(b.body).toMatchObject({ condition: "monthly", unitPriceCents: 650, billableCount: 1, amountCents: 650, interval: "monthly", trialEndsOn: null });
  });

  it("history lists months back to the tenant's creation month", async () => {
    const r = await t.call("GET", `/api/tenants/${B}/billing/history?limit=3`, { cookie: cookies.ownerB });
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(1);
    expect(r.body[0]).toEqual(expect.objectContaining({ status: "open", final: false, unitPriceCents: 650 }));
  });

  it("denies foreign tenants, employees and platform staff; validates the month", async () => {
    expect((await t.call("GET", `/api/tenants/${B}/billing?month=2026-10`, { cookie: cookies.ownerA })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/billing?month=2026-10`, { cookie: cookies.emp1A })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/billing/history`, { cookie: cookies.ownerB })).status).toBe(403);
    for (const who of ["superAdmin", "support"]) {
      expect((await t.call("GET", `/api/tenants/${A}/billing?month=2026-10`, { cookie: cookies[who] })).status).toBe(403);
    }
    expect((await t.call("GET", `/api/tenants/${A}/billing?month=2026-13`, { cookie: cookies.ownerA })).status).toBe(400);
    expect((await t.call("GET", `/api/tenants/${A}/billing?month=2099-01`, { cookie: cookies.ownerA })).status).toBe(400);
    expect((await t.call("GET", `/api/tenants/${A}/billing?month=2026-10`)).status).toBe(401);
  });
});

describe("platform revenue (numbers only)", () => {
  it("lists all tenants with counts and amounts, without names; payment provider 'none'", async () => {
    for (const who of ["superAdmin", "support"]) {
      const r = await t.call("GET", "/api/platform/billing?month=2026-10", { cookie: cookies[who] });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ month: "2026-10", defaultPriceCents: 500, paymentProvider: "none" });
      const rowB = r.body.rows.find((x: { tenantId: string }) => x.tenantId === B);
      expect(rowB).toMatchObject({ tenantName: "Muster Pflegedienst GmbH", billableCount: 1, amountCents: 650, isDemo: true, status: "open",
        condition: "monthly", interval: "monthly", trialEndsOn: null });
      expect(r.body.totals).toMatchObject({ demoAmountCents: 650 });
      const text = JSON.stringify(r.body);
      for (const name of ["Sam Probe", "Jo Demo", "Robin Leitung", "Charlie Test", "employeeId"]) expect(text).not.toContain(name);
    }
    expect((await t.call("GET", "/api/platform/billing?month=2026-10", { cookie: cookies.ownerA })).status).toBe(403);
  });

  it("default price (12-month subscription): super-admin only, reason required, audited", async () => {
    expect((await t.call("GET", "/api/platform/billing/settings", { cookie: cookies.support })).body).toEqual({
      defaultPriceCents: 500, monthlyPriceCents: 650, trialWindowFrom: null, trialWindowUntil: null, trialMonths: 3, cancelNoticeDays: 0,
      welcomePromoCodeId: null, welcomePromoCode: null, currency: "EUR",
    });
    expect((await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.support, body: { defaultPriceCents: 600, reason: "Test" } })).status).toBe(403);
    expect((await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { defaultPriceCents: 600 } })).status).toBe(400);
    expect((await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { defaultPriceCents: 5.5, reason: "Test" } })).status).toBe(400);
    const ok = await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { defaultPriceCents: 600, reason: "Preisanpassung" } });
    expect(ok.body).toMatchObject({ defaultPriceCents: 600, monthlyPriceCents: 650 });
    // tenant B is in the monthly plan: the 12-month price does not change its month
    const b = await t.call("GET", `/api/tenants/${B}/billing?month=2026-10`, { cookie: cookies.ownerB });
    expect(b.body).toMatchObject({ condition: "monthly", unitPriceCents: 650, amountCents: 650 });
    const audit = await t.call("GET", "/api/platform/audit?limit=20", { cookie: cookies.support });
    const entry = audit.body.find((e: { action: string }) => e.action === "billing_settings.update");
    expect(entry).toMatchObject({ reason: "Preisanpassung" });
    expect(entry.before).toMatchObject({ defaultPriceCents: 500 });
    expect(entry.after).toMatchObject({ defaultPriceCents: 600 });
    await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { defaultPriceCents: 500, reason: "Zurück" } });
  });

  it("special conditions through the licence route", async () => {
    const r = await t.call("PUT", `/api/platform/tenants/${B}/license`, {
      cookie: cookies.superAdmin,
      body: { plan: "standard", employeePriceCents: 350, conditionNote: "Einführungsrabatt", conditionValidFrom: "2026-10-01", conditionValidUntil: "2026-12-31", reason: "Vertrag Test" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ employeePriceCents: 350, freeOfCharge: false, conditionNote: "Einführungsrabatt", conditionValidFrom: "2026-10-01", conditionValidUntil: "2026-12-31" });
    expect((await t.call("GET", `/api/tenants/${B}/billing?month=2026-10`, { cookie: cookies.ownerB })).body).toMatchObject({ condition: "special", unitPriceCents: 350 });
    const free = await t.call("PUT", `/api/platform/tenants/${B}/license`, { cookie: cookies.superAdmin, body: { plan: "standard", freeOfCharge: true } });
    expect(free.body.freeOfCharge).toBe(true);
    expect((await t.call("GET", `/api/tenants/${B}/billing?month=2026-10`, { cookie: cookies.ownerB })).body).toMatchObject({ condition: "free", amountCents: 0 });
    expect((await t.call("PUT", `/api/platform/tenants/${B}/license`, { cookie: cookies.superAdmin, body: { plan: "standard", conditionValidFrom: "2026-12-01", conditionValidUntil: "2026-11-01" } })).status).toBe(400);
    expect((await t.call("PUT", `/api/platform/tenants/${B}/license`, { cookie: cookies.superAdmin, body: { plan: "standard", employeePriceCents: -1 } })).status).toBe(400);
    expect((await t.call("PUT", `/api/platform/tenants/${B}/license`, { cookie: cookies.support, body: { plan: "standard", freeOfCharge: false } })).status).toBe(403);
    const reset = await t.call("PUT", `/api/platform/tenants/${B}/license`, {
      cookie: cookies.superAdmin, body: { plan: "standard", freeOfCharge: false, employeePriceCents: null, conditionNote: null, conditionValidFrom: null, conditionValidUntil: null },
    });
    expect(reset.body).toMatchObject({ employeePriceCents: null, freeOfCharge: false, conditionValidFrom: null });
    const audit = (await t.db.admin.query("select reason from public.audit_log where entity = 'license' and tenant_id = $1 and reason is not null", [B])).rows;
    expect(audit.map((x) => x.reason)).toContain("Vertrag Test");
  });

  it("billing status of a past month: super-admin only, frozen numbers for the tenant", async () => {
    const path = `/api/platform/tenants/${A}/billing/2026-09`;
    expect((await t.call("PUT", path, { cookie: cookies.support, body: { status: "invoiced" } })).status).toBe(403);
    expect((await t.call("PUT", path, { cookie: cookies.ownerA, body: { status: "invoiced" } })).status).toBe(403);
    expect((await t.call("PUT", path, { cookie: cookies.superAdmin, body: { status: "storniert" } })).status).toBe(400);
    expect((await t.call("PUT", path, { cookie: cookies.superAdmin, body: { status: "waived" } })).status).toBe(400);
    const ok = await t.call("PUT", path, { cookie: cookies.superAdmin, body: { status: "invoiced", note: "RE-2026-09-A" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ month: "2026-09", status: "invoiced", final: true, condition: "pilot_free" });
    const current = (await t.db.admin.query("select to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM') m")).rows[0].m;
    expect((await t.call("PUT", `/api/platform/tenants/${A}/billing/${current}`, { cookie: cookies.superAdmin, body: { status: "invoiced" } })).status).toBe(409);
    const own = await t.call("GET", `/api/tenants/${A}/billing?month=2026-09`, { cookie: cookies.ownerA });
    expect(own.body).toMatchObject({ status: "invoiced", final: true });
    expect(own.body.lines.length).toBe(own.body.billableCount);
  });
});

describe("employee lock", () => {
  it("leadership locks: login fails like a wrong password, existing sessions end; unlock restores access", async () => {
    const session = await t.login("emp2A");
    const lock = await t.call("POST", `/api/employees/${E.emp2A}/status`, { cookie: cookies.managerA, body: { status: "locked", reason: "Gerät verloren" } });
    expect(lock.status).toBe(200);
    expect(lock.body.status).toBe("locked");
    expect((await t.call("GET", `/api/employees/${E.emp2A}/time-entries?month=2026-10`, { cookie: session })).status).toBe(403);
    const login = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.emp2A, password: PASSWORD } });
    expect(login.status).toBe(401);
    expect((await t.call("POST", `/api/employees/${E.emp2A}/status`, { cookie: cookies.managerA, body: { status: "locked", reason: "Doppelt" } })).status).toBe(409);
    expect((await t.call("POST", `/api/employees/${E.emp2A}/status`, { cookie: cookies.managerA, body: { status: "gesperrt", reason: "Falsch" } })).status).toBe(400);
    const unlock = await t.call("POST", `/api/employees/${E.emp2A}/status`, { cookie: cookies.managerA, body: { status: "active", reason: "Neues Gerät" } });
    expect(unlock.body.status).toBe("active");
    t.resetRateLimits();
    expect(await t.login("emp2A")).toBeTruthy();
  });
});

/**
 * Subscription through the HTTP API (migration 0023): reading, plan choice, cancellation with
 * confirmation mail, withdrawal, contract conclusion of a new tenant (welcome code in the
 * invitation mail), billing settings patch, and the billing job (reminders, monthly invoices).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMO_TERMS_NOTE } from "../../platform/src/core/subscription.ts";
import { runBillingJobs } from "../../server/src/subscription.ts";
import type { Mail } from "../../server/src/mailer.ts";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "emp1A", "ownerB", "empB", "superAdmin", "support"] as const) cookies[who] = await t.login(who);
  // Tenant B here like a customer that started after 0023 (no legacy months): monthly plan since 10/2026.
  await t.db.admin.query("update public.tenant_subscriptions set terms_from = null where tenant_id = $1", [IDS.tenantB]);
  await t.db.admin.query("update public.subscription_terms set starts_on = '2026-10-01' where tenant_id = $1", [IDS.tenantB]);
});
afterAll(async () => {
  await t?.close();
});

const A = IDS.tenantA;
const B = IDS.tenantB;
const NOT_UNLOCKED = "Die Firma ist noch nicht freigeschaltet: Der Inhaber muss zuerst den Nutzungsbedingungen zustimmen.";

describe("subscription of an existing tenant", () => {
  it("leadership and platform staff read; employees and other tenants do not", async () => {
    const r = await t.call("GET", `/api/tenants/${B}/subscription`, { cookie: cookies.ownerB });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tenantId: B, trialEndsOn: null, current: { interval: "monthly", startsOn: "2026-10-01" }, annualPriceCents: 500, monthlyPriceCents: 650,
      contract: { termsVersion: "bestand" } });
    expect((await t.call("GET", `/api/tenants/${A}/subscription`, { cookie: cookies.managerA })).status).toBe(200);
    expect((await t.call("GET", `/api/tenants/${A}/subscription`, { cookie: cookies.support })).status).toBe(200);
    expect((await t.call("GET", `/api/tenants/${A}/subscription`, { cookie: cookies.emp1A })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/subscription`, { cookie: cookies.ownerB })).status).toBe(403);
  });

  it("choose: owner only, validated; annual from the next month", async () => {
    expect((await t.call("POST", `/api/tenants/${A}/subscription/choose`, { cookie: cookies.managerA, body: { interval: "annual" } })).status).toBe(403);
    expect((await t.call("POST", `/api/tenants/${B}/subscription/choose`, { cookie: cookies.ownerB, body: { interval: "jährlich" } })).status).toBe(400);
    const same = await t.call("POST", `/api/tenants/${B}/subscription/choose`, { cookie: cookies.ownerB, body: { interval: "monthly" } });
    expect(same).toMatchObject({ status: 409, body: { error: { message: "Der Monatstarif läuft bereits." } } });
    const r = await t.call("POST", `/api/tenants/${B}/subscription/choose`, { cookie: cookies.ownerB, body: { interval: "annual" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ current: { interval: "monthly" }, next: { interval: "annual", endsOn: null } });
    expect(r.body.current.endsOn).toBeTruthy();
  });

  it("cancel sends a confirmation to all owners; withdraw restores the plan", async () => {
    t.mails.length = 0;
    expect((await t.call("POST", `/api/tenants/${B}/subscription/cancel`, { cookie: cookies.empB, body: { thenMonthly: false } })).status).toBe(403);
    const r = await t.call("POST", `/api/tenants/${B}/subscription/cancel`, { cookie: cookies.ownerB, body: { thenMonthly: true, reason: "Nur Test" } });
    expect(r.status).toBe(200);
    expect(r.body.next).toMatchObject({ interval: "monthly" });
    expect(r.body.withdrawable).toMatchObject({ interval: "annual", thenMonthly: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(t.mails).toHaveLength(1);
    expect(t.mails[0]).toMatchObject({ to: "inhaberin@muster-pflegedienst.example", subject: "Kündigungsbestätigung – Muster Pflegedienst GmbH" });
    expect(t.mails[0]!.text).toContain("Monatstarif (6,50 €");
    expect(t.mails[0]!.text).toMatch(/läuft bis einschließlich \d{2}\.\d{2}\.\d{4}/);
    const w = await t.call("POST", `/api/tenants/${B}/subscription/withdraw`, { cookie: cookies.ownerB, body: {} });
    expect(w.status).toBe(200);
    expect(w.body.next).toMatchObject({ interval: "annual", endsOn: null });
    expect((await t.call("POST", `/api/tenants/${B}/subscription/withdraw`, { cookie: cookies.ownerB, body: {} })).status).toBe(409);
    expect(w.body.withdrawable).toBeNull();
    // cancelling the planned switch (annual not started yet) undoes it: the monthly plan runs on
    t.mails.length = 0;
    const undo = await t.call("POST", `/api/tenants/${B}/subscription/cancel`, { cookie: cookies.ownerB, body: { thenMonthly: false } });
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ current: { interval: "monthly", endsOn: null }, next: null, contractEndsOn: null, withdrawable: null });
    await new Promise((res) => setTimeout(res, 20));
    expect(t.mails).toEqual([expect.objectContaining({ to: "inhaberin@muster-pflegedienst.example", subject: "Tarifwechsel zurückgenommen – Muster Pflegedienst GmbH" })]);
    expect(t.mails[0]!.text).toContain("Tarifwechsel zurückgenommen, Monatstarif läuft weiter.");
    expect(t.mails[0]!.text).not.toContain("läuft bis einschließlich");
    const audit = await t.call("GET", `/api/tenants/${B}/audit`, { cookie: cookies.ownerB });
    expect(audit.body.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["subscription.choose", "subscription.cancel", "subscription.withdraw"]));
    const platform = await t.call("GET", "/api/platform/audit?limit=50", { cookie: cookies.support });
    expect(platform.body.map((e: { action: string }) => e.action)).toContain("subscription.cancel");
  });
});

describe("billing settings (patch)", () => {
  it("super admin changes several fields; old body {defaultPriceCents, reason} still works", async () => {
    expect((await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.support, body: { monthlyPriceCents: 700, reason: "Test" } })).status).toBe(403);
    expect((await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { reason: "Nichts" } })).status).toBe(400);
    expect((await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { trialWindowFrom: "2026-11-01", reason: "Test" } })).status).toBe(400);
    expect((await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { trialMonths: 0, reason: "Test" } })).status).toBe(400);
    const today = (await t.db.admin.query("select private.berlin_today()::text as d")).rows[0].d as string;
    const r = await t.call("PUT", "/api/platform/billing/settings", {
      cookie: cookies.superAdmin, body: { trialWindowFrom: today, trialWindowUntil: today, trialMonths: 3, cancelNoticeDays: 7, reason: "Einführungsangebot" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ trialWindowFrom: today, trialWindowUntil: today, trialMonths: 3, cancelNoticeDays: 7, defaultPriceCents: 500 });
    const old = await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { defaultPriceCents: 500, reason: "Unverändert" } });
    expect(old.status).toBe(200);
  });
});

describe("new tenant: welcome code, contract conclusion", () => {
  let tenantId = "";
  let owner = "";

  it("the owner invitation contains the welcome code with its terms", async () => {
    const code = await t.call("POST", "/api/platform/promo-codes", { cookie: cookies.superAdmin, body: { code: "WILLKOMMEN-10", discountPercent: 10 } });
    await t.call("PUT", "/api/platform/billing/settings", { cookie: cookies.superAdmin, body: { welcomePromoCodeId: code.body.id, reason: "Willkommenscode" } });
    t.mails.length = 0;
    const r = await t.call("POST", "/api/platform/tenants", {
      cookie: cookies.superAdmin, body: { name: "Abo Neu GmbH", slug: "abo-neu", plan: "standard", ownerEmail: "inhaber@abo-neu.example", ownerName: "Inhaber Neu" },
    });
    expect(r.status).toBe(201);
    tenantId = r.body.tenant.id;
    await new Promise((res) => setTimeout(res, 20));
    const mail = t.mails.find((m) => m.to === "inhaber@abo-neu.example")!;
    expect(mail.text).toContain("Aktionscode WILLKOMMEN-10 (−10 %)");
    expect(mail.text).toContain("Chef-Portal unter „Abrechnung“");
    expect(mail.text).toContain(PROMO_TERMS_NOTE);
    const token = decodeURIComponent(/#token=([^\s]+)/.exec(mail.text)![1]!);
    const acc = await t.call("POST", "/api/auth/invitation/accept", { body: { token, password: "Neues-Passwort-Abo-1" } });
    expect(acc.status).toBe(200);
    const login = await t.call("POST", "/api/auth/login", { body: { email: "inhaber@abo-neu.example", password: "Neues-Passwort-Abo-1" } });
    expect(login.status).toBe(200);
    owner = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    // without a code (ended) the mail has no code paragraph
    await t.call("POST", `/api/platform/promo-codes/${code.body.id}/end`, { cookie: cookies.superAdmin, body: { reason: "Aktion vorbei" } });
    t.mails.length = 0;
    await t.call("POST", "/api/platform/tenants", {
      cookie: cookies.superAdmin, body: { name: "Ohne Code GmbH", slug: "ohne-code", plan: "standard", ownerEmail: "inhaber@ohne-code.example" },
    });
    await new Promise((res) => setTimeout(res, 20));
    expect(t.mails[0]!.text).not.toContain("Aktionscode");
  });

  it("before the contract: writes are refused with a clear message; reading works", async () => {
    const s = await t.call("GET", `/api/tenants/${tenantId}/subscription`, { cookie: owner });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ contract: null, inTrial: true });
    const emp = await t.call("POST", `/api/tenants/${tenantId}/employees`, { cookie: owner, body: { displayName: "Neu", personnelNumber: "N-1", email: null, role: "employee" } });
    expect(emp).toMatchObject({ status: 409, body: { error: { message: NOT_UNLOCKED } } });
    const ownEmployee = (await t.db.admin.query("select id from public.employees where tenant_id = $1 and role = 'owner'", [tenantId])).rows[0].id;
    const today = (await t.db.admin.query("select private.berlin_today()::text as d")).rows[0].d as string;
    const entry = await t.call("POST", `/api/employees/${ownEmployee}/time-entries`, {
      cookie: owner, body: { id: "abo-neu-0001", date: today, start: "08:00", end: "12:00", pauseMinutes: 0, note: "" },
    });
    expect(entry).toMatchObject({ status: 409, body: { error: { message: NOT_UNLOCKED } } });
    const choose = await t.call("POST", `/api/tenants/${tenantId}/subscription/choose`, { cookie: owner, body: { interval: "annual" } });
    expect(choose).toMatchObject({ status: 409, body: { error: { message: NOT_UNLOCKED } } });
  });

  it("accept: both confirmations required; once; then the tenant can be used", async () => {
    const path = `/api/tenants/${tenantId}/subscription/accept`;
    for (const body of [{ entrepreneur: false, termsAccepted: true, interval: "monthly" }, { entrepreneur: true, termsAccepted: "ja", interval: "monthly" },
      { entrepreneur: true, termsAccepted: true, interval: "weekly" }]) {
      expect((await t.call("POST", path, { cookie: owner, body })).status).toBe(400);
    }
    expect((await t.call("POST", path, { cookie: cookies.superAdmin, body: { entrepreneur: true, termsAccepted: true, interval: "monthly" } })).status).toBe(403);
    const r = await t.call("POST", path, { cookie: owner, body: { entrepreneur: true, termsAccepted: true, interval: "monthly" } });
    expect(r.status).toBe(200);
    expect(r.body.contract).toMatchObject({ interval: "monthly", acceptedByName: "Inhaber Neu" });
    expect(r.body.contract.termsVersion).toContain("AGB");
    expect(r.body.current).toMatchObject({ interval: "monthly" });
    expect((await t.call("POST", path, { cookie: owner, body: { entrepreneur: true, termsAccepted: true, interval: "annual" } })))
      .toMatchObject({ status: 409, body: { error: { message: "Der Vertrag wurde bereits abgeschlossen." } } });
    const emp = await t.call("POST", `/api/tenants/${tenantId}/employees`, { cookie: owner, body: { displayName: "Neu", personnelNumber: "N-1", email: null, role: "employee" } });
    expect(emp.status).toBe(201);
  });
});

describe("billing job (run once)", () => {
  it("sends the trial reminder once and issues/mails the monthly invoice once", async () => {
    const today = (await t.db.admin.query("select private.berlin_today()::text as d")).rows[0].d as string;
    const tenant = (await t.db.admin.query("select id from public.tenants where slug = 'abo-neu'")).rows[0].id as string;
    // the server job always works with today: let the trial of the new tenant end in 14 days
    await t.db.admin.query("update public.tenant_subscriptions set trial_ends_on = $2::date + 14 where tenant_id = $1", [tenant, today]);
    await t.db.admin.query("update public.subscription_terms set starts_on = date_trunc('month', $2::date + 14)::date where tenant_id = $1", [tenant, today]);
    const sent: Mail[] = [];
    const r = await runBillingJobs(t.pool, (m) => sent.push(...m));
    expect(r.reminders).toBe(1);
    expect(sent[0]).toMatchObject({ to: "inhaber@abo-neu.example" });
    expect(sent[0]!.subject).toContain("Ihre kostenlose Testphase endet am");
    expect(sent[0]!.text).toContain("Ab dem Folgemonat wird der Monatstarif (6,50 € je abrechenbarem Mitarbeiter und Monat, inkl. gesetzlicher USt.) berechnet.");
    expect((await runBillingJobs(t.pool, () => undefined)).reminders).toBe(0);
    if (Number(today.slice(8, 10)) < 2) return; // monthly invoices start on the 2nd

    // monthly invoice: tenant B as a real customer since June with complete data
    await t.db.admin.query("update public.tenants set created_at = '2026-06-01 00:00 Europe/Berlin', is_demo = false where id = $1", [B]);
    await t.db.admin.query("update public.employee_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
    await t.db.admin.query("update public.tenant_status_history set valid_from = '2026-06-01 00:00 Europe/Berlin' where tenant_id = $1", [B]);
    await t.db.admin.query("update public.subscription_terms set starts_on = '2026-06-01' where tenant_id = $1 and starts_on = '2026-10-01'", [B]);
    await t.call("PUT", "/api/platform/invoice-settings", {
      cookie: cookies.superAdmin,
      body: { issuerName: "Beispiel Software GmbH (Testdaten)", issuerStreet: "Musterstraße 1", issuerPostalCode: "52062", issuerCity: "Aachen", vatId: "DE123456789", reason: "Absender" },
    });
    const mails: Mail[] = [];
    const run = await runBillingJobs(t.pool, (m) => mails.push(...m));
    expect(run.invoices.issued).toEqual([expect.objectContaining({ tenantId: B, grossCents: 650 })]);
    const inv = run.invoices.issued[0]!;
    expect(mails).toEqual([expect.objectContaining({ to: "inhaberin@muster-pflegedienst.example", subject: expect.stringMatching(new RegExp(`^Neue Rechnung ${inv.number} für \\S+ \\d{4}$`)) })]);
    expect(mails[0]!.text).toContain("6,50 €");
    expect(mails[0]!.text).toContain("Chef-Portal unter „Abrechnung“");
    const again = await runBillingJobs(t.pool, () => undefined);
    expect(again.invoices.issued).toEqual([]);
    const own = await t.call("GET", `/api/tenants/${B}/invoices`, { cookie: cookies.ownerB });
    expect(own.body.map((i: { number: string }) => i.number)).toEqual([inv.number]);
  });
});

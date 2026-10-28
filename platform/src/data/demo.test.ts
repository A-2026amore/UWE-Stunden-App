import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, ConflictError, TwoFactorRequiredError } from "./repository";
import { base32Decode, hotp, timeStep } from "../security/totp";
import { DEMO_PASSWORD, DEMO_TENANT_IDS, createDemoRepository, demoMonths, memoryStorage } from "./demo";

const NOW = new Date("2026-10-26T10:00:00");
const ANNA = "30000000-0000-4000-8000-000000000101";
const BEN = "30000000-0000-4000-8000-000000000102";
const MIA = "30000000-0000-4000-8000-000000000201";

function setup() {
  const storage = memoryStorage();
  const repo = createDemoRepository(storage, { now: NOW });
  return { storage, repo };
}

async function as(email: string) {
  const ctx = setup();
  await ctx.repo.signIn(email, DEMO_PASSWORD);
  return ctx;
}

describe("demo repository – authentication", () => {
  it("rejects wrong passwords and accepts demo logins", async () => {
    const { repo } = setup();
    await expect(repo.signIn("anna@demo-kt.example", "falsch")).rejects.toThrow("E-Mail-Adresse oder Passwort ist falsch.");
    const s = await repo.signIn("ANNA@demo-kt.example", DEMO_PASSWORD);
    expect(s.tenantId).toBe(DEMO_TENANT_IDS.kt);
    expect(s.role).toBe("employee");
    expect(await repo.currentSession()).not.toBeNull();
    await repo.signOut();
    expect(await repo.currentSession()).toBeNull();
  });

  it("denies login for deactivated employees", async () => {
    const { repo } = setup();
    await expect(repo.signIn("emil@demo-kt.example", DEMO_PASSWORD)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("seeds two separate tenants with a pilot_free licence", async () => {
    const { repo } = await as("admin@plattform.example");
    const tenants = await repo.listTenants();
    expect(tenants.map((t) => t.tenant.name)).toEqual(["Demo Krankentransporte", "Muster Pflegedienst GmbH"]);
    const pilot = tenants.find((t) => t.license?.plan === "pilot_free")!.license!;
    expect(pilot.priceCents).toBe(0);
    expect(pilot.billing).toBe("none");
    expect(pilot.validUntil).toBeNull();
    expect(pilot.maxEmployees).toBeNull();
  });
});

describe("demo repository – tenant isolation", () => {
  it("denies cross-tenant reads for managers", async () => {
    const { repo } = await as("chef@demo-kt.example");
    await expect(repo.getTenant(DEMO_TENANT_IDS.pflege)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listEmployees(DEMO_TENANT_IDS.pflege)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listTimeEntries(MIA, demoMonths(NOW).previous)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listTenantTimeEntries(DEMO_TENANT_IDS.pflege, "2026-01-01", "2026-12-31")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listAudit(DEMO_TENANT_IDS.pflege)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("denies cross-tenant writes", async () => {
    const { repo } = await as("leitung@muster-pflege.example");
    await expect(repo.updateBranding(DEMO_TENANT_IDS.kt, { primaryColor: "#000000" })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.setEmployeeStatus(ANNA, "deactivated", "Test Grund")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.createTimeEntry(ANNA, { id: "x1", date: "2026-10-20", start: "08:00", end: "10:00", pauseMinutes: 0, note: "" })).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("only the owner changes the company profile and settings – not managers (like the API, QA B3)", async () => {
    const manager = await as("dispo@demo-kt.example");
    await expect(manager.repo.updateBranding(DEMO_TENANT_IDS.kt, { primaryColor: "#000000" })).rejects.toThrow("Firmendaten darf nur der Inhaber ändern.");
    await expect(manager.repo.updateContact(DEMO_TENANT_IDS.kt, { city: "Leitungsstadt" })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(manager.repo.updateSettings(DEMO_TENANT_IDS.kt, { workAccount: { enabled: false } as never })).rejects.toThrow("Einstellungen darf nur der Inhaber ändern.");
    expect((await manager.repo.getTenant(DEMO_TENANT_IDS.kt)).branding.primaryColor).not.toBe("#000000");

    const owner = await as("chef@demo-kt.example");
    expect((await owner.repo.updateBranding(DEMO_TENANT_IDS.kt, { primaryColor: "#112233" })).branding.primaryColor).toBe("#112233");
    expect((await owner.repo.updateContact(DEMO_TENANT_IDS.kt, { city: "Aachen" })).contact.city).toBe("Aachen");
  });

  it("lets employees see only their own data", async () => {
    const { repo } = await as("anna@demo-kt.example");
    const list = await repo.listEmployees(DEMO_TENANT_IDS.kt);
    expect(list.map((e) => e.id)).toEqual([ANNA]);
    await expect(repo.listTimeEntries(BEN, demoMonths(NOW).previous)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listTenantTimeEntries(DEMO_TENANT_IDS.kt, "2026-01-01", "2026-12-31")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listStatements(DEMO_TENANT_IDS.kt, "2026-09")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listTenants()).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("platform admins see no personal time data without a tenant grant", async () => {
    const { repo, storage } = await as("admin@plattform.example");
    await expect(repo.listTimeEntries(ANNA, "2026-09")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listEmployees(DEMO_TENANT_IDS.kt)).rejects.toBeInstanceOf(AccessDeniedError);
    // Owner grants support access → read access possible, writes still denied.
    const owner = createDemoRepository(storage, { now: NOW, sessionKey: "owner" });
    await owner.signIn("chef@demo-kt.example", DEMO_PASSWORD);
    await owner.setSupportGrant(DEMO_TENANT_IDS.kt, 24);
    expect((await repo.listTimeEntries(ANNA, "2026-09")).length).toBeGreaterThan(0);
    await expect(repo.createTimeEntry(ANNA, { id: "s1", date: "2026-10-20", start: "20:00", end: "21:00", pauseMinutes: 0, note: "" })).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("demo repository – time entries", () => {
  const base = { date: "2026-10-31", start: "08:00", end: "10:00", pauseMinutes: 0, note: "" };

  it("creates idempotently and rejects overlaps, >12 h and missing breaks", async () => {
    const { repo } = await as("anna@demo-kt.example");
    const a = await repo.createTimeEntry(ANNA, { ...base, id: "e-1" });
    const again = await repo.createTimeEntry(ANNA, { ...base, id: "e-1" });
    expect(again.id).toBe(a.id);
    expect((await repo.listTimeEntries(ANNA, "2026-10")).filter((e) => e.id === "e-1")).toHaveLength(1);
    await expect(repo.createTimeEntry(ANNA, { ...base, id: "e-2", start: "09:00", end: "11:00" })).rejects.toThrow(/überschneidet/);
    await expect(repo.createTimeEntry(ANNA, { ...base, id: "e-3", date: "2026-11-02", start: "06:00", end: "18:30", pauseMinutes: 45 })).rejects.toThrow(/12 Stunden/);
    await expect(repo.createTimeEntry(ANNA, { ...base, id: "e-4", date: "2026-11-03", start: "06:00", end: "13:00", pauseMinutes: 0 })).rejects.toThrow(/30 Minuten Pause/);
    await expect(repo.createTimeEntry(ANNA, { ...base, id: "e-5", date: "2026-11-03", start: "06:00", end: "13:00", pauseMinutes: 30 })).resolves.toBeTruthy();
  });

  it("detects version conflicts and soft-deletes", async () => {
    const { repo } = await as("anna@demo-kt.example");
    const e = await repo.createTimeEntry(ANNA, { ...base, id: "v-1" });
    const updated = await repo.updateTimeEntry(e.id, { end: "10:30" }, 1);
    expect(updated.version).toBe(2);
    await expect(repo.updateTimeEntry(e.id, { end: "11:00" }, 1)).rejects.toBeInstanceOf(ConflictError);
    await repo.deleteTimeEntry(e.id, 2);
    expect((await repo.listTimeEntries(ANNA, "2026-10")).some((x) => x.id === e.id)).toBe(false);
  });

  it("requires a reason for manager corrections and logs before/after", async () => {
    const ctx = await as("anna@demo-kt.example");
    const e = await ctx.repo.createTimeEntry(ANNA, { ...base, id: "c-1" });
    const chef = createDemoRepository(ctx.storage, { now: NOW, sessionKey: "chef" });
    await chef.signIn("chef@demo-kt.example", DEMO_PASSWORD);
    await expect(chef.updateTimeEntry(e.id, { end: "09:30" }, 1)).rejects.toThrow(/Begründung/);
    await chef.updateTimeEntry(e.id, { end: "09:30" }, 1, "Laut Dienstplan korrigiert");
    const audit = await chef.listAudit(DEMO_TENANT_IDS.kt);
    const ev = audit.find((x) => x.entityId === e.id && x.action === "time_entry.corrected")!;
    expect(ev.reason).toBe("Laut Dienstplan korrigiert");
    expect((ev.before as { end: string }).end).toBe("10:00");
    expect((ev.after as { end: string }).end).toBe("09:30");
  });
});

describe("demo repository – statements, work account, platform", () => {
  it("submits a statement and locks the month for the employee; return needs a reason", async () => {
    const ctx = await as("deniz@demo-kt.example");
    const DENIZ = "30000000-0000-4000-8000-000000000104";
    const { previous } = demoMonths(NOW);
    const st = await ctx.repo.submitStatement(DENIZ, previous);
    expect(st.status).toBe("submitted");
    expect(st.workedMinutes).toBeGreaterThan(0);
    await expect(ctx.repo.createTimeEntry(DENIZ, { id: "l-1", date: `${previous}-29`, start: "20:00", end: "21:00", pauseMinutes: 0, note: "" })).rejects.toThrow(/eingereicht/);
    const chef = createDemoRepository(ctx.storage, { now: NOW, sessionKey: "chef" });
    await chef.signIn("chef@demo-kt.example", DEMO_PASSWORD);
    await expect(chef.returnStatement(st.id, "")).rejects.toThrow(/begründen/);
    const ret = await chef.returnStatement(st.id, "Bitte Pause am 3. prüfen");
    expect(ret.status).toBe("returned");
  });

  it("validates allocations with the core work-account rules", async () => {
    const { repo } = await as("anna@demo-kt.example");
    const { current } = demoMonths(NOW);
    await expect(repo.setAllocation(ANNA, current, 999 * 60)).rejects.toThrow(/höchstens/);
    const a = await repo.setAllocation(ANNA, current, 60);
    expect(a.status).toBe("proposed"); // demo tenant requires approval
  });

  it("only super admins manage tenants and licences; changes are audited", async () => {
    const { repo } = await as("support@plattform.example");
    await expect(repo.createTenant({ name: "X GmbH", slug: "x-gmbh", plan: "pilot_free", isDemo: true, ownerEmail: "x@x.example" })).rejects.toBeInstanceOf(AccessDeniedError);
    const admin = (await as("admin@plattform.example")).repo;
    const created = await admin.createTenant({ name: "Neu GmbH", slug: "neu-gmbh", plan: "pilot_free", isDemo: true, ownerEmail: "inhaber@neu.example" });
    expect(created.license?.plan).toBe("pilot_free");
    await expect(admin.setTenantStatus(created.tenant.id, "suspended", "")).rejects.toThrow();
    await admin.setTenantStatus(created.tenant.id, "suspended", "Testweise gesperrt");
    const lic = await admin.setLicense(created.tenant.id, "standard", { maxEmployees: 10 });
    expect(lic.maxEmployees).toBe(10);
    const audit = await admin.listPlatformAudit();
    expect(audit.some((e) => e.action === "tenant.status_suspended" && e.reason === "Testweise gesperrt")).toBe(true);
    expect(audit.some((e) => e.action === "license.updated")).toBe(true);
  });

  it("blocks sign-in for suspended tenants", async () => {
    const ctx = await as("admin@plattform.example");
    await ctx.repo.setTenantStatus(DEMO_TENANT_IDS.pflege, "suspended", "Zahlungsklärung (Demo)");
    const user = createDemoRepository(ctx.storage, { now: NOW, sessionKey: "u" });
    await expect(user.signIn("mia@muster-pflege.example", DEMO_PASSWORD)).rejects.toThrow(/gesperrt/);
  });
});

describe("demo repository – two-factor authentication", () => {
  // Fixed clock in the middle of a 30-second step: no step change during a test.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:15Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const codeAt = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offsetSteps);

  it("enrols with a real TOTP code, then signs in in two steps (no replay, recovery codes once)", async () => {
    const { repo, storage } = await as("anna@demo-kt.example");
    expect(await repo.getTwoFactorStatus()).toMatchObject({ enabled: false, required: false });
    const setup = await repo.startTwoFactorSetup();
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    await expect(repo.confirmTwoFactorSetup(codeAt(setup.secret, 3))).rejects.toThrow("Der Code stimmt nicht");
    const { recoveryCodes } = await repo.confirmTwoFactorSetup(codeAt(setup.secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(await repo.getTwoFactorStatus()).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });

    await repo.signOut();
    await expect(repo.signIn("anna@demo-kt.example", DEMO_PASSWORD)).rejects.toBeInstanceOf(TwoFactorRequiredError);
    expect(await repo.currentSession()).toBeNull();
    // The code used for the setup is already consumed (replay protection); the demo helper offers the next one.
    await expect(repo.verifyTwoFactor({ code: codeAt(setup.secret) })).rejects.toThrow("Der Code ist ungültig");
    const next = await repo.demoTwoFactorCode();
    expect(next).toBe(codeAt(setup.secret, 1));
    const s = await repo.verifyTwoFactor({ code: next! });
    expect(s.email).toBe("anna@demo-kt.example");

    await repo.signOut();
    await expect(repo.signIn("anna@demo-kt.example", DEMO_PASSWORD)).rejects.toBeInstanceOf(TwoFactorRequiredError);
    const viaRecovery = await repo.verifyTwoFactor({ recoveryCode: recoveryCodes[0]!.toLowerCase() });
    expect(viaRecovery.recoveryCodesRemaining).toBe(9);
    await repo.signOut();
    await expect(repo.signIn("anna@demo-kt.example", DEMO_PASSWORD)).rejects.toBeInstanceOf(TwoFactorRequiredError);
    await expect(repo.verifyTwoFactor({ recoveryCode: recoveryCodes[0]! })).rejects.toThrow("bereits verwendet");
    await repo.verifyTwoFactor({ recoveryCode: recoveryCodes[1]! });

    // Disable needs password + code.
    await expect(repo.disableTwoFactor("falsch", { recoveryCode: recoveryCodes[2]! })).rejects.toThrow("Passwort oder Code ist falsch.");
    expect(await repo.disableTwoFactor(DEMO_PASSWORD, { recoveryCode: recoveryCodes[3]! })).toEqual({ setupRequired: false });
    await repo.signOut();
    expect((await repo.signIn("anna@demo-kt.example", DEMO_PASSWORD)).email).toBe("anna@demo-kt.example");
    expect(storage.getItem("stundenwerk_demo_session_2fa_pending")).toBeNull();
  });

  it("owner requirement: only with own 2FA; managers then see only the setup", async () => {
    const owner = await as("chef@demo-kt.example");
    await expect(owner.repo.setTwoFactorRequirement(DEMO_TENANT_IDS.kt, true)).rejects.toThrow("zuerst für dein eigenes Konto");
    const setup = await owner.repo.startTwoFactorSetup();
    await owner.repo.confirmTwoFactorSetup(codeAt(setup.secret));
    const t = await owner.repo.setTwoFactorRequirement(DEMO_TENANT_IDS.kt, true);
    expect(t.requireTwoFactorForManagers).toBe(true);

    const manager = createDemoRepository(owner.storage, { now: NOW, sessionKey: "dispo" });
    const s = await manager.signIn("dispo@demo-kt.example", DEMO_PASSWORD);
    expect(s.twoFactorSetupRequired).toBe(true);
    await expect(manager.listEmployees(DEMO_TENANT_IDS.kt)).rejects.toThrow("vorgeschrieben");
    expect(await manager.getTwoFactorStatus()).toMatchObject({ required: true, requiredBy: "tenant" });
    const ms = await manager.startTwoFactorSetup();
    await manager.confirmTwoFactorSetup(codeAt(ms.secret));
    expect((await manager.currentSession())?.twoFactorSetupRequired).toBeUndefined();
    expect((await manager.listEmployees(DEMO_TENANT_IDS.kt)).length).toBeGreaterThan(3);

    // Employees are not affected.
    const anna = createDemoRepository(owner.storage, { now: NOW, sessionKey: "anna" });
    expect((await anna.signIn("anna@demo-kt.example", DEMO_PASSWORD)).twoFactorSetupRequired).toBeUndefined();
    await expect(anna.setTwoFactorRequirement(DEMO_TENANT_IDS.kt, false)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("demo repository – price model (billing)", () => {
  const DISPO = "30000000-0000-4000-8000-000000000107";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("owner sees the own month with names: pilot is free, leadership without own times is free", async () => {
    const { repo } = await as("chef@demo-kt.example");
    const b = await repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-10");
    expect(b).toMatchObject({ condition: "pilot_free", unitPriceCents: 0, amountCents: 0, billableCount: 4, isCurrentMonth: true, final: false, status: "open" });
    expect(b.lines.map((l) => l.displayName)).toEqual(["Anna Beispiel", "Ben Muster", "Carla Probe", "Deniz Test"]);
    // Emil left on 21 September: billed in September, not in October.
    const sept = await repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-09");
    expect(sept.lines.map((l) => l.displayName)).toContain("Emil Platzhalter");
    await expect(repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-12")).rejects.toThrow("zukünftige");
    const hist = await repo.listTenantBillingHistory(DEMO_TENANT_IDS.kt);
    expect(hist.map((h) => h.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
  });

  it("standard customer: 3 employees × 5,00 € = 15,00 € net", async () => {
    const { repo } = await as("leitung@muster-pflege.example");
    expect(await repo.getTenantBilling(DEMO_TENANT_IDS.pflege, "2026-10")).toMatchObject({ condition: "standard", unitPriceCents: 500, billableCount: 3, amountCents: 1500 });
  });

  it("no foreign billing, no billing for employees", async () => {
    const chef = await as("chef@demo-kt.example");
    await expect(chef.repo.getTenantBilling(DEMO_TENANT_IDS.pflege, "2026-10")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(chef.repo.getPlatformRevenue("2026-10")).rejects.toBeInstanceOf(AccessDeniedError);
    const anna = await as("anna@demo-kt.example");
    await expect(anna.repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-10")).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("locking: no sign-in, still billed for the month of the lock, not for the next one; unlock works", async () => {
    const { repo, storage } = await as("chef@demo-kt.example");
    await repo.setEmployeeStatus(ANNA, "locked", "Diensthandy verloren");
    await expect(repo.setEmployeeStatus(ANNA, "locked", "nochmal")).rejects.toThrow("Nur aktive");
    const other = createDemoRepository(storage, { now: NOW, sessionKey: "other" });
    await expect(other.signIn("anna@demo-kt.example", DEMO_PASSWORD)).rejects.toThrow("gesperrt");
    expect((await repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-10")).lines.map((l) => l.displayName)).toContain("Anna Beispiel");
    vi.setSystemTime(new Date("2026-11-05T10:00:00"));
    expect((await repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-11")).lines.map((l) => l.displayName)).not.toContain("Anna Beispiel");
    await repo.setEmployeeStatus(ANNA, "active", "Neues Handy");
    expect((await repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-11")).lines.map((l) => l.displayName)).toContain("Anna Beispiel");
    expect((await repo.listAudit(DEMO_TENANT_IDS.kt)).map((e) => e.action)).toEqual(expect.arrayContaining(["employee.locked", "employee.unlocked"]));
  });

  it("leadership with own time entries in the month is billable", async () => {
    const { repo } = await as("dispo@demo-kt.example");
    await repo.createTimeEntry(DISPO, { id: "dispo-1", date: "2026-10-20", start: "08:00", end: "12:00", pauseMinutes: 0, note: "" });
    const b = await repo.getTenantBilling(DEMO_TENANT_IDS.kt, "2026-10");
    expect(b.lines.find((l) => l.employeeId === DISPO)?.reason).toBe("leader_with_time");
    expect(b.billableCount).toBe(5);
  });

  it("platform: revenue numbers without names, frozen months, default price and special price", async () => {
    const { repo } = await as("admin@plattform.example");
    const rev = await repo.getPlatformRevenue("2026-09");
    expect(rev.paymentProvider).toBe("none");
    expect(JSON.stringify(rev)).not.toMatch(/Anna|Mia|Emil/);
    expect(rev.rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)).toMatchObject({ billableCount: 3, amountCents: 1500, status: "open" });
    expect(rev.totals).toMatchObject({ amountCents: 0, demoAmountCents: 1500 }); // both seed tenants are demo tenants

    await expect(repo.setBillingStatus(DEMO_TENANT_IDS.pflege, "2026-10", "invoiced")).rejects.toThrow("Monatsende");
    await expect(repo.setBillingStatus(DEMO_TENANT_IDS.pflege, "2026-09", "waived")).rejects.toThrow("Grund");
    expect(await repo.setBillingStatus(DEMO_TENANT_IDS.pflege, "2026-09", "invoiced", "RE-1")).toMatchObject({ status: "invoiced", final: true, amountCents: 1500 });

    await repo.setDefaultPrice(600, "Preisanpassung Test");
    expect((await repo.getBillingSettings()).defaultPriceCents).toBe(600);
    const after = await repo.getPlatformRevenue("2026-09");
    expect(after.rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)?.amountCents).toBe(1500); // frozen
    expect((await repo.getPlatformRevenue("2026-10")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)?.amountCents).toBe(1800);

    await repo.setLicense(DEMO_TENANT_IDS.pflege, "standard", { employeePriceCents: 400, conditionNote: "Rabatt", conditionValidFrom: "2026-10-01" });
    expect((await repo.getPlatformRevenue("2026-10")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)).toMatchObject({ condition: "special", amountCents: 1200 });
    await repo.setLicense(DEMO_TENANT_IDS.pflege, "standard", { freeOfCharge: true });
    expect((await repo.getPlatformRevenue("2026-10")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)).toMatchObject({ condition: "free", amountCents: 0 });

    const actions = (await repo.listPlatformAudit()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["billing_period.status", "billing_settings.default_price", "license.updated"]));

    const support = await as("support@plattform.example");
    expect((await support.repo.getPlatformRevenue("2026-10")).rows).toHaveLength(2);
    await expect(support.repo.setBillingStatus(DEMO_TENANT_IDS.kt, "2026-09", "paid")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(support.repo.setDefaultPrice(1, "Test")).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

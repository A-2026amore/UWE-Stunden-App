import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, ConflictError, TwoFactorRequiredError } from "./repository";
import { base32Decode, hotp, timeStep } from "../security/totp";
import { DEMO_PASSWORD, DEMO_TENANT_IDS, createDemoRepository, demoMonths, memoryStorage } from "./demo";
import { DPA_VERSION, TERMS_VERSION } from "../core/subscription";

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

  it("break rule: UWE replica strict, generic tenant statutory; owner switches, laxer than §4 ArbZG is rejected", async () => {
    const owner = await as("chef@demo-kt.example");
    const kt = await owner.repo.getTenant(DEMO_TENANT_IDS.kt);
    expect(kt.settings.breakPolicy.thresholds).toEqual([{ minGrossMinutes: 360, minPauseMinutes: 30 }, { minGrossMinutes: 540, minPauseMinutes: 45 }]);
    const statutory = [{ minGrossMinutes: 361, minPauseMinutes: 30 }, { minGrossMinutes: 541, minPauseMinutes: 45 }];
    const t = await owner.repo.updateSettings(DEMO_TENANT_IDS.kt, { breakPolicy: { ...kt.settings.breakPolicy, thresholds: statutory } });
    expect(t.settings.breakPolicy).toMatchObject({ thresholds: statutory, maxShiftMinutes: 720 });
    // 6:00 exactly without pause is now accepted for this tenant.
    await owner.repo.createTimeEntry(ANNA, { id: "rule-1", date: "2026-10-04", start: "08:00", end: "14:00", pauseMinutes: 0, note: "" });
    await expect(owner.repo.updateSettings(DEMO_TENANT_IDS.kt, {
      breakPolicy: { ...kt.settings.breakPolicy, thresholds: [{ minGrossMinutes: 400, minPauseMinutes: 30 }, { minGrossMinutes: 541, minPauseMinutes: 45 }] },
    })).rejects.toThrow("§ 4 Arbeitszeitgesetz");
    const mia = await as("leitung@muster-pflege.example");
    expect((await mia.repo.getTenant(DEMO_TENANT_IDS.pflege)).settings.breakPolicy.thresholds).toEqual(statutory);
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

describe("demo repository – chef portal and super-admin polish", () => {
  it("invites with a one-time link (or e-mail placeholder); a new link is only possible while invited", async () => {
    const { repo } = await as("chef@demo-kt.example");
    const viaLink = await repo.inviteEmployee(DEMO_TENANT_IDS.kt, { displayName: "Lena Neu", personnelNumber: "777", email: "lena@demo-kt.example", role: "employee", invitation: "link" });
    expect(viaLink.invitation?.delivery).toBe("link");
    expect(viaLink.invitation?.link).toMatch(/\/einladung\/#token=demo-[0-9a-f]{32}$/);
    expect(Date.parse(viaLink.invitation!.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    const viaMail = await repo.inviteEmployee(DEMO_TENANT_IDS.kt, { displayName: "Max Neu", personnelNumber: "778", email: "max@demo-kt.example", role: "employee" });
    expect(viaMail.invitation).toMatchObject({ delivery: "demo" });
    expect(viaMail.invitation?.link).toBeUndefined();
    const again = await repo.createInvitation(viaLink.id, "link");
    expect(again.link).not.toBe(viaLink.invitation?.link);
    await expect(repo.createInvitation(ANNA, "link")).rejects.toThrow("bereits ein Benutzerkonto");
    const noMail = await repo.inviteEmployee(DEMO_TENANT_IDS.kt, { displayName: "Ohne Mail", personnelNumber: "779", email: null, role: "employee" });
    expect("invitation" in noMail).toBe(false);
    await expect(repo.createInvitation(noMail.id, "link")).rejects.toThrow("E-Mail-Adresse");
    expect((await repo.listAudit(DEMO_TENANT_IDS.kt)).some((e) => e.action === "invitation.created")).toBe(true);
    // Employees and other tenants cannot create invitations.
    const emp = (await as("anna@demo-kt.example")).repo;
    await expect(emp.createInvitation(viaLink.id, "link")).rejects.toBeInstanceOf(AccessDeniedError);
    const other = (await as("leitung@muster-pflege.example")).repo;
    await expect(other.createInvitation(viaLink.id, "link")).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("owner renames the company; managers and employees cannot", async () => {
    const { repo } = await as("chef@demo-kt.example");
    const t = await repo.renameTenant(DEMO_TENANT_IDS.kt, "  Demo Krankentransporte GmbH ");
    expect(t.name).toBe("Demo Krankentransporte GmbH");
    await expect(repo.renameTenant(DEMO_TENANT_IDS.kt, "x")).rejects.toThrow("Firmennamen");
    await expect(repo.renameTenant(DEMO_TENANT_IDS.pflege, "Fremd GmbH")).rejects.toBeInstanceOf(AccessDeniedError);
    const emp = (await as("anna@demo-kt.example")).repo;
    await expect(emp.renameTenant(DEMO_TENANT_IDS.kt, "Neu GmbH")).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("creates a free test customer in one step", async () => {
    const admin = (await as("admin@plattform.example")).repo;
    const o = await admin.createTenant({
      name: "Test Fahrdienst", slug: "test-fahrdienst", plan: "standard", isDemo: false, ownerEmail: "inhaber@test-fahrdienst.example",
      freeOfCharge: true, conditionNote: "Testzeitraum", conditionValidUntil: "2026-12-31",
    });
    expect(o.license).toMatchObject({ plan: "standard", freeOfCharge: true, conditionNote: "Testzeitraum", conditionValidUntil: "2026-12-31" });
    const pilot = await admin.createTenant({ name: "Pilot GmbH", slug: "pilot-gmbh", plan: "pilot_free", isDemo: false, ownerEmail: "p@pilot.example" });
    expect(pilot.license?.plan).toBe("pilot_free");
  });

  it("deactivates a tenant without deleting data; sign-in is refused with a clear text, reactivation works", async () => {
    const ctx = await as("admin@plattform.example");
    const before = (await ctx.repo.listTenants()).find((t) => t.tenant.id === DEMO_TENANT_IDS.pflege)!;
    await ctx.repo.setTenantStatus(DEMO_TENANT_IDS.pflege, "deactivated", "Vertrag beendet");
    const after = (await ctx.repo.listTenants()).find((t) => t.tenant.id === DEMO_TENANT_IDS.pflege)!;
    expect(after.tenant.status).toBe("deactivated");
    expect(after.employeeCount).toBe(before.employeeCount);
    const user = createDemoRepository(ctx.storage, { now: NOW, sessionKey: "u" });
    await expect(user.signIn("mia@muster-pflege.example", DEMO_PASSWORD)).rejects.toThrow("Der Firmenzugang ist deaktiviert.");
    expect((await ctx.repo.listPlatformAudit()).some((e) => e.action === "tenant.status_deactivated" && e.reason === "Vertrag beendet")).toBe(true);
    await ctx.repo.setTenantStatus(DEMO_TENANT_IDS.pflege, "active", "Neuer Vertrag");
    await expect(user.signIn("mia@muster-pflege.example", DEMO_PASSWORD)).resolves.toMatchObject({ tenantId: DEMO_TENANT_IDS.pflege });
  });

  it("system overview: platform staff only, no secrets", async () => {
    const support = (await as("support@plattform.example")).repo;
    const o = await support.getSystemOverview();
    expect(o).toMatchObject({ paymentProvider: "none", lastBackupAt: null, mail: { configured: false } });
    expect(o.tenants.active).toBe(2);
    const chef = (await as("chef@demo-kt.example")).repo;
    await expect(chef.getSystemOverview()).rejects.toBeInstanceOf(AccessDeniedError);
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

  it("standard customer without plan choice: monthly plan, 3 employees × 6,50 € = 19,50 € gross", async () => {
    // Since 0023 existing tenants have a monthly term from the month of creation (no trial).
    const { repo } = await as("leitung@muster-pflege.example");
    expect(await repo.getTenantBilling(DEMO_TENANT_IDS.pflege, "2026-10")).toMatchObject({ condition: "monthly", unitPriceCents: 650, billableCount: 3, amountCents: 1950, interval: "monthly", trialEndsOn: null });
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
    expect(rev.rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)).toMatchObject({ billableCount: 3, amountCents: 1950, status: "open", interval: "monthly" });
    expect(rev.totals).toMatchObject({ amountCents: 0, demoAmountCents: 1950 }); // both seed tenants are demo tenants

    await expect(repo.setBillingStatus(DEMO_TENANT_IDS.pflege, "2026-10", "invoiced")).rejects.toThrow("Monatsende");
    await expect(repo.setBillingStatus(DEMO_TENANT_IDS.pflege, "2026-09", "waived")).rejects.toThrow("Grund");
    expect(await repo.setBillingStatus(DEMO_TENANT_IDS.pflege, "2026-09", "invoiced", "RE-1")).toMatchObject({ status: "invoiced", final: true, amountCents: 1950 });

    await repo.setDefaultPrice(600, "Preisanpassung Test");
    expect((await repo.getBillingSettings()).defaultPriceCents).toBe(600);
    const after = await repo.getPlatformRevenue("2026-09");
    // The default price is the 12-month price: the monthly plan of the tenant is unchanged.
    expect((await repo.getPlatformRevenue("2026-10")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)?.amountCents).toBe(1950);
    await repo.updateBillingSettings({ monthlyPriceCents: 700, reason: "Preisanpassung Test" });
    expect(after.rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)?.amountCents).toBe(1950); // frozen
    expect((await repo.getPlatformRevenue("2026-09")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)).toMatchObject({ amountCents: 1950, interval: "monthly" }); // frozen
    expect((await repo.getPlatformRevenue("2026-10")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)?.amountCents).toBe(2100);

    await repo.setLicense(DEMO_TENANT_IDS.pflege, "standard", { employeePriceCents: 400, conditionNote: "Rabatt", conditionValidFrom: "2026-10-01" });
    expect((await repo.getPlatformRevenue("2026-10")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)).toMatchObject({ condition: "special", amountCents: 1200 });
    await repo.setLicense(DEMO_TENANT_IDS.pflege, "standard", { freeOfCharge: true });
    expect((await repo.getPlatformRevenue("2026-10")).rows.find((r) => r.tenantId === DEMO_TENANT_IDS.pflege)).toMatchObject({ condition: "free", amountCents: 0 });

    const actions = (await repo.listPlatformAudit()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["billing_period.status", "billing_settings.default_price", "billing_settings.update", "license.updated"]));

    const support = await as("support@plattform.example");
    expect((await support.repo.getPlatformRevenue("2026-10")).rows).toHaveLength(2);
    await expect(support.repo.setBillingStatus(DEMO_TENANT_IDS.kt, "2026-09", "paid")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(support.repo.setDefaultPrice(1, "Test")).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("demo repository – subscription (0023)", () => {
  const PFLEGE = DEMO_TENANT_IDS.pflege;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00+01:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("existing tenant: monthly from the month of creation; owner switches to annual from the next month, cancels and withdraws", async () => {
    const { repo, storage } = await as("leitung@muster-pflege.example");
    let sub = await repo.getTenantSubscription(PFLEGE);
    expect(sub).toMatchObject({ trialEndsOn: null, inTrial: false, ended: false, annualPriceCents: 500, monthlyPriceCents: 650, cancelNoticeDays: 0 });
    expect(sub.current).toMatchObject({ interval: "monthly", endsOn: null });
    expect(sub.next).toBeNull();

    sub = await repo.chooseSubscription(PFLEGE, "annual");
    expect(sub.current).toMatchObject({ interval: "monthly", endsOn: "2026-11-30" });
    expect(sub.next).toMatchObject({ interval: "annual", startsOn: "2026-12-01", endsOn: null, currentTermEndsOn: "2027-11-30" });
    await expect(repo.chooseSubscription(PFLEGE, "monthly")).rejects.toThrow("nur zum Ende der Laufzeit");
    expect((await repo.getTenantBilling(PFLEGE, "2026-11"))).toMatchObject({ condition: "monthly", unitPriceCents: 650 });

    // Annual not started yet: cancelling costs nothing (never runs); with "then monthly" the monthly plan simply continues.
    sub = await repo.cancelSubscription(PFLEGE, { thenMonthly: true, reason: "Test" });
    expect(sub.next).toMatchObject({ interval: "monthly", startsOn: "2026-12-01", endsOn: null });
    sub = await repo.withdrawCancellation(PFLEGE);
    expect(sub.next).toMatchObject({ interval: "annual", startsOn: "2026-12-01", endsOn: null, cancelledAt: null });

    // In December the annual term runs: price 5,00 €; cancel → end 30.11.2027, monthly afterwards.
    vi.setSystemTime(new Date("2026-12-10T10:00:00+01:00"));
    const other = createDemoRepository(storage, { now: NOW });
    await other.signIn("leitung@muster-pflege.example", DEMO_PASSWORD);
    expect(await other.getTenantBilling(PFLEGE, "2026-12")).toMatchObject({ condition: "standard", unitPriceCents: 500, interval: "annual" });
    sub = await other.cancelSubscription(PFLEGE, { thenMonthly: true });
    expect(sub.current).toMatchObject({ interval: "annual", endsOn: "2027-11-30", thenMonthly: true });
    expect(sub.next).toMatchObject({ interval: "monthly", startsOn: "2027-12-01", endsOn: null });
    expect(sub.contractEndsOn).toBeNull();
    sub = await other.withdrawCancellation(PFLEGE);
    expect(sub.current).toMatchObject({ interval: "annual", endsOn: null, currentTermEndsOn: "2027-11-30" });
    expect(sub.next).toBeNull();
    await expect(other.withdrawCancellation(PFLEGE)).rejects.toThrow("keine Kündigung");

    const actions = (await other.listAudit(PFLEGE, 50)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["subscription.choose", "subscription.cancel", "subscription.withdraw"]));
  });

  it("monthly cancellation ends with the month; after the end nothing is billed and a new plan can be chosen", async () => {
    const { repo, storage } = await as("leitung@muster-pflege.example");
    const sub = await repo.cancelSubscription(PFLEGE, {});
    expect(sub.current).toMatchObject({ interval: "monthly", endsOn: "2026-11-30" });
    expect(sub.contractEndsOn).toBe("2026-11-30");
    vi.setSystemTime(new Date("2026-12-03T10:00:00+01:00"));
    const other = createDemoRepository(storage, { now: NOW });
    await other.signIn("leitung@muster-pflege.example", DEMO_PASSWORD);
    expect(await other.getTenantSubscription(PFLEGE)).toMatchObject({ ended: true, current: null });
    expect(await other.getTenantBilling(PFLEGE, "2026-12")).toMatchObject({ condition: "ended", unitPriceCents: 0, amountCents: 0 });
    const again = await other.chooseSubscription(PFLEGE, "annual");
    expect(again.current).toMatchObject({ interval: "annual", startsOn: "2026-12-01" });
  });

  it("only the owner changes; managers and platform staff read", async () => {
    const dispo = await as("dispo@demo-kt.example");
    expect((await dispo.repo.getTenantSubscription(DEMO_TENANT_IDS.kt)).current?.interval).toBe("monthly");
    await expect(dispo.repo.chooseSubscription(DEMO_TENANT_IDS.kt, "annual")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(dispo.repo.getTenantSubscription(PFLEGE)).rejects.toBeInstanceOf(AccessDeniedError);
    const support = await as("support@plattform.example");
    expect((await support.repo.getTenantSubscription(PFLEGE)).current?.interval).toBe("monthly");
    await expect(support.repo.updateBillingSettings({ trialMonths: 2, reason: "Test" })).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("super admin: trial window and welcome code; a new tenant inside the window gets the trial", async () => {
    const { repo } = await as("admin@plattform.example");
    await expect(repo.updateBillingSettings({ trialWindowFrom: "2026-11-01", reason: "Test" })).rejects.toThrow("Beginn und Ende");
    await expect(repo.updateBillingSettings({ trialWindowFrom: "2026-12-01", trialWindowUntil: "2026-11-01", reason: "Test" })).rejects.toThrow("nicht vor dem Beginn");
    await expect(repo.updateBillingSettings({ trialMonths: 3 } as never)).rejects.toThrow("Grund");
    const code = await repo.createPromoCode({ code: "WILLKOMMEN-10", discountPercent: 10, note: null, maxRedemptions: null, redeemableUntil: null });
    const st = await repo.updateBillingSettings({ trialWindowFrom: "2026-11-01", trialWindowUntil: "2026-12-31", trialMonths: 3, welcomePromoCodeId: code.id, reason: "Aktion Winter" });
    expect(st).toMatchObject({ defaultPriceCents: 500, monthlyPriceCents: 650, trialWindowFrom: "2026-11-01", trialWindowUntil: "2026-12-31", trialMonths: 3, welcomePromoCodeId: code.id, welcomePromoCode: "WILLKOMMEN-10" });
    const o = await repo.createTenant({ name: "Test Fahrdienst", slug: "test-fahrdienst", plan: "standard", isDemo: true, ownerEmail: "inhaber@test-fahrdienst.example" });
    const sub = await repo.getTenantSubscription(o.tenant.id);
    // 20.11.2026 + 3 months − 1 day = 19.02.2027 → trial until the end of February; March is the first paid month.
    expect(sub).toMatchObject({ trialEndsOn: "2027-02-28", inTrial: true, firstPaidMonth: "2027-03" });
    expect(sub.current).toMatchObject({ interval: "monthly", startsOn: "2027-03-01" });
    expect((await repo.getPlatformRevenue("2026-11")).rows.find((r) => r.tenantId === o.tenant.id)).toMatchObject({ condition: "trial", unitPriceCents: 0, trialEndsOn: "2027-02-28" });
    expect((await repo.listPlatformAudit()).map((e) => e.action)).toContain("billing_settings.update");
    expect(sub.contract).toBeNull();
  });

  it("contract conclusion: new tenants first accept AGB/AVV as entrepreneur; existing demo tenants are accepted", async () => {
    const { repo, storage } = await as("admin@plattform.example");
    expect((await repo.getTenantSubscription(PFLEGE)).contract).toMatchObject({ termsVersion: "bestand", dpaVersion: "bestand", interval: "monthly" });
    await repo.updateBillingSettings({ trialWindowFrom: "2026-11-01", trialWindowUntil: "2026-12-31", reason: "Aktion" });
    const o = await repo.createTenant({ name: "Test Fahrdienst", slug: "test-fahrdienst", plan: "standard", isDemo: true, ownerEmail: "inhaber@test-fahrdienst.example" });
    const owner = createDemoRepository(storage, { now: NOW, sessionKey: "owner" });
    await owner.signIn("inhaber@test-fahrdienst.example", DEMO_PASSWORD);
    await expect(owner.acceptContract(o.tenant.id, { entrepreneur: false, termsAccepted: true, interval: "monthly" } as never)).rejects.toThrow("Unternehmer");
    await expect(owner.acceptContract(o.tenant.id, { entrepreneur: true, termsAccepted: false, interval: "monthly" } as never)).rejects.toThrow("AGB");
    // Employees of a tenant without contract cannot sign in yet.
    await owner.inviteEmployee(o.tenant.id, { displayName: "Test Person", personnelNumber: "2", email: "person@test-fahrdienst.example", role: "employee" });
    const employee = createDemoRepository(storage, { now: NOW, sessionKey: "employee" });
    await expect(employee.signIn("person@test-fahrdienst.example", DEMO_PASSWORD)).rejects.toThrow("noch nicht freigeschaltet");
    const sub = await owner.acceptContract(o.tenant.id, { entrepreneur: true, termsAccepted: true, interval: "annual" });
    expect(sub.contract).toMatchObject({ termsVersion: TERMS_VERSION, dpaVersion: DPA_VERSION, interval: "annual", acceptedByName: "Inhaber/in" });
    // Annual from the first paid month after the trial (like chooseSubscription).
    expect(sub.current).toMatchObject({ interval: "annual", startsOn: "2027-03-01" });
    await expect(owner.acceptContract(o.tenant.id, { entrepreneur: true, termsAccepted: true, interval: "monthly" })).rejects.toThrow("bereits");
    expect((await owner.listAudit(o.tenant.id, 20)).map((e) => e.action)).toContain("subscription.accept");
    await employee.signIn("person@test-fahrdienst.example", DEMO_PASSWORD);
  });
});

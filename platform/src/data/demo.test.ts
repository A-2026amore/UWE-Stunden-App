import { describe, expect, it } from "vitest";
import { AccessDeniedError, ConflictError } from "./repository";
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

/**
 * Demo repository: data protection functions behave like the API (0016).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "./repository";
import { DEMO_PASSWORD, DEMO_TENANT_IDS, createDemoRepository, memoryStorage } from "./demo";

const NOW = new Date("2026-10-26T10:00:00");
const ANNA = "30000000-0000-4000-8000-000000000101";
const EMIL = "30000000-0000-4000-8000-000000000105"; // deactivated in the seed
const KT = DEMO_TENANT_IDS.kt;

function repoWith(storage = memoryStorage()) {
  return createDemoRepository(storage, { now: NOW });
}
async function as(email: string, storage = memoryStorage()) {
  const repo = repoWith(storage);
  await repo.signIn(email, DEMO_PASSWORD);
  return repo;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("demo – data export", () => {
  it("employee exports own data incl. account; owner without account; others denied", async () => {
    const storage = memoryStorage();
    const anna = await as("anna@demo-kt.example", storage);
    const own = await anna.exportPersonalData(ANNA);
    expect(own.requestedBy).toBe("self");
    expect(own.person.displayName).toBe("Anna Beispiel");
    expect(own.account?.email).toBe("anna@demo-kt.example");
    expect(own.timeEntries.length).toBeGreaterThan(0);
    expect(own.timeEntries.every((e) => e.employeeId === ANNA)).toBe(true);
    await expect(anna.exportPersonalData(EMIL)).rejects.toBeInstanceOf(AccessDeniedError);

    const chef = await as("chef@demo-kt.example", storage);
    const viaOwner = await chef.exportPersonalData(ANNA);
    expect(viaOwner.requestedBy).toBe("owner");
    expect(viaOwner.account).toBeNull();
    expect((await chef.listAudit(KT)).filter((a) => a.action === "employee.data_export")).toHaveLength(2);

    const dispo = await as("dispo@demo-kt.example", storage);
    await expect(dispo.exportPersonalData(ANNA)).rejects.toBeInstanceOf(AccessDeniedError);
    const foreign = await as("leitung@muster-pflege.example", storage);
    await expect(foreign.exportPersonalData(ANNA)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("tenant export only for the owner of that tenant", async () => {
    const chef = await as("chef@demo-kt.example");
    const all = await chef.exportTenantData(KT);
    expect(all.tenant.id).toBe(KT);
    expect(all.employees.some((e) => e.displayName === "Anna Beispiel")).toBe(true);
    expect(JSON.stringify(all)).not.toContain("muster-pflege.example");
    await expect(chef.exportTenantData(DEMO_TENANT_IDS.pflege)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect((await as("dispo@demo-kt.example")).exportTenantData(KT)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("demo – anonymisation", () => {
  it("needs the retention period, its end, the personnel number and a deactivated person", async () => {
    const storage = memoryStorage();
    const chef = await as("chef@demo-kt.example", storage);
    await expect(chef.anonymizeEmployee(EMIL, "1005")).rejects.toThrow(/Aufbewahrungsfrist nach dem Austritt festlegen/);
    await expect((await as("dispo@demo-kt.example")).setRetentionPolicy(KT, 12)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(chef.setRetentionPolicy(KT, 0)).rejects.toThrow(/1 bis 600/);
    expect((await chef.setRetentionPolicy(KT, 24)).retentionMonthsAfterExit).toBe(24);
    await expect(chef.anonymizeEmployee(EMIL, "1005")).rejects.toThrow(/läuft noch bis zum/);
    await expect(chef.anonymizeEmployee(ANNA, "1001")).rejects.toThrow(/Nur deaktivierte/);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2029-12-01T10:00:00Z"));
    await expect(chef.anonymizeEmployee(EMIL, "9999")).rejects.toThrow(/Personalnummer/);
    const anon = await chef.anonymizeEmployee(EMIL, "1005");
    expect(anon.displayName).toMatch(/^Anonymisiert /);
    expect(anon).toMatchObject({ email: null, status: "deactivated" });
    expect(anon.anonymizedAt).toBeTruthy();
    const all = await chef.exportTenantData(KT);
    expect(JSON.stringify(all)).not.toContain("Emil Platzhalter");
    expect(JSON.stringify(all)).not.toContain("emil@demo-kt.example");
    await expect(chef.updateEmployee(EMIL, { displayName: "Emil" })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(chef.setEmployeeStatus(EMIL, "active", "zurück")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(chef.anonymizeEmployee(EMIL, anon.personnelNumber)).rejects.toThrow(/bereits anonymisiert/);
    // The login is gone (not only deactivated).
    await expect(repoWith(storage).signIn("emil@demo-kt.example", DEMO_PASSWORD)).rejects.toThrow("E-Mail-Adresse oder Passwort ist falsch.");
  });
});

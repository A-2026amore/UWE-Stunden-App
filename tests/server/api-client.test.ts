/**
 * platform/src/data/api.ts (createApiRepository) against the running server.
 * Node's fetch has no cookie jar and sends no Origin, so a small wrapper does
 * what the browser does with credentials: "include".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRepository, ApiError } from "../../platform/src/data/api.ts";
import { AccessDeniedError, ConflictError } from "../../platform/src/data/repository.ts";
import { EMAILS, IDS, ORIGIN, PASSWORD, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(async () => {
  await t?.close();
});

function browserLikeFetch(): typeof fetch {
  let cookie: string | null = null;
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", ORIGIN);
    if (cookie) headers.set("Cookie", cookie);
    expect(init.credentials).toBe("include");
    const res = await fetch(input, { ...init, headers });
    const set = res.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0]!;
      cookie = /Max-Age=0/.test(set) ? null : pair;
    }
    return res;
  };
}

describe("createApiRepository against the real API", () => {
  it("covers sign-in, reads, idempotent create, conflicts, access errors and sign-out", async () => {
    const repo = createApiRepository(`${t.url}/`, { fetch: browserLikeFetch() });
    expect(await repo.currentSession()).toBeNull();
    await expect(repo.signIn(EMAILS.emp1A, "falsches-passwort")).rejects.toMatchObject({ name: "ApiError", status: 401, message: "E-Mail-Adresse oder Passwort ist falsch." });

    const session = await repo.signIn(EMAILS.emp1A, PASSWORD);
    expect(session).toMatchObject({ tenantId: IDS.tenantA, employeeId: IDS.employees.emp1A, role: "employee" });
    expect((await repo.currentSession())?.userId).toBe(IDS.users.emp1A);

    const tenant = await repo.getTenant(IDS.tenantA);
    expect(tenant.settings.breakPolicy.thresholds[0]).toEqual({ minGrossMinutes: 360, minPauseMinutes: 30 });
    const entries = await repo.listTimeEntries(IDS.employees.emp1A, "2026-10");
    expect(entries.length).toBe(2);

    const input = { id: "api-client-0001", date: "2026-10-23", start: "08:00", end: "12:00", pauseMinutes: 0, note: "API" };
    const created = await repo.createTimeEntry(IDS.employees.emp1A, input);
    expect(await repo.createTimeEntry(IDS.employees.emp1A, input)).toEqual(created);

    const updated = await repo.updateTimeEntry(created.id, { note: "geändert" }, created.version);
    expect(updated).toMatchObject({ note: "geändert", version: 2 });
    await expect(repo.updateTimeEntry(created.id, { note: "alt" }, 1)).rejects.toBeInstanceOf(ConflictError);
    await expect(repo.createTimeEntry(IDS.employees.emp1A, { ...input, id: "api-client-0002", start: "09:00" })).rejects.toMatchObject({ status: 409, code: "overlap" });
    await expect(repo.createTimeEntry(IDS.employees.emp1A, { ...input, id: "api-client-0003", date: "2026-10-24", end: "15:00" }))
      .rejects.toMatchObject({ status: 400, code: "break_rule" });

    await expect(repo.getTenant(IDS.tenantB)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listTimeEntries(IDS.employees.emp2A, "2026-10")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.listTenants()).rejects.toBeInstanceOf(AccessDeniedError);

    const migrated = await repo.createTimeEntry(IDS.employees.emp1A, { id: "legacy-api-0001", date: "2026-10-25", start: "08:00", end: "10:00", pauseMinutes: 0, note: "", source: "migration" });
    expect(migrated.source).toBe("migration");
    await expect(repo.createTimeEntry(IDS.employees.emp1A, { id: "legacy-api-0002", date: "2026-10-26", start: "08:00", end: "10:00", pauseMinutes: 0, note: "", source: "correction" as "app" }))
      .rejects.toMatchObject({ status: 400 });

    await repo.deleteTimeEntry(created.id, updated.version);
    expect((await repo.listTimeEntries(IDS.employees.emp1A, "2026-10")).map((e) => e.id)).not.toContain(created.id);

    await repo.signOut();
    expect(await repo.currentSession()).toBeNull();
    await expect(repo.getTenant(IDS.tenantA)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("manager and platform methods", async () => {
    const chef = createApiRepository(t.url, { fetch: browserLikeFetch() });
    await chef.signIn(EMAILS.ownerA, PASSWORD);
    const emps = await chef.listEmployees(IDS.tenantA);
    expect(emps.length).toBeGreaterThanOrEqual(4);
    const stmts = await chef.listStatements(IDS.tenantA, "2026-09");
    expect(stmts[0]).toMatchObject({ status: "approved", employeeId: IDS.employees.emp1A });
    expect(await chef.getSupportGrant(IDS.tenantA)).toBeNull();
    expect((await chef.listAudit(IDS.tenantA, 5)).length).toBeLessThanOrEqual(5);
    await expect(chef.returnStatement(stmts[0]!.id, "")).rejects.toBeInstanceOf(ApiError);

    const admin = createApiRepository(t.url, { fetch: browserLikeFetch() });
    await admin.signIn(EMAILS.superAdmin, PASSWORD);
    const list = await admin.listTenants();
    expect(list.map((o) => o.tenant.slug).sort()).toEqual(["demo-krankentransporte", "muster-pflegedienst"]);
    const lic = await admin.setLicense(IDS.tenantB, "standard", { maxEmployees: 60 });
    expect(lic.maxEmployees).toBe(60);
    await expect(admin.listTenantTimeEntries(IDS.tenantA, "2026-10-01", "2026-10-31")).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("reports network failures as ApiError status 0", async () => {
    const repo = createApiRepository("http://127.0.0.1:1");
    await expect(repo.currentSession()).rejects.toMatchObject({ status: 0, code: "network" });
  });
});

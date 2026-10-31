/**
 * Employment contract data over HTTP (migration 0025): save, read (leadership / the person),
 * validation, permissions, delete.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const c: Record<string, string> = {};
const E = IDS.employees;
const A = IDS.tenantA;

beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "emp1A", "emp2A", "ownerB"] as const) c[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

const path = (emp: string, month?: string) => `/api/employees/${emp}/employment-contracts${month ? `/${month}` : ""}`;
const minijob = { employmentType: "minijob", hourlyWageCents: 1400, monthlyTargetMinutes: 2580, carryOverMinutes: 0 };

describe("employment contracts API", () => {
  it("leadership saves a version; the person and the leadership read it", async () => {
    const r = await t.call("PUT", path(E.emp1A, "2026-10"), { cookie: c.managerA, body: minijob });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ employeeId: E.emp1A, tenantId: A, validFrom: "2026-10", ...minijob });
    const open = await t.call("PUT", path(E.emp1A, "2026-12"), { cookie: c.ownerA, body: { employmentType: "offen", hourlyWageCents: null, monthlyTargetMinutes: null } });
    expect(open.body).toMatchObject({ monthlyTargetMinutes: null, hourlyWageCents: null, carryOverMinutes: 0 });

    const own = await t.call("GET", path(E.emp1A), { cookie: c.emp1A });
    expect(own.status).toBe(200);
    expect(own.body.map((x: { validFrom: string }) => x.validFrom)).toEqual(["2026-10", "2026-12"]);
    const tenant = await t.call("GET", `/api/tenants/${A}/employment-contracts`, { cookie: c.managerA });
    expect(tenant.body).toHaveLength(2);
  });

  it("refuses colleagues, employees, other tenants and invalid input", async () => {
    expect((await t.call("GET", path(E.emp1A), { cookie: c.emp2A })).status).toBe(403);
    expect((await t.call("GET", `/api/tenants/${A}/employment-contracts`, { cookie: c.emp1A })).status).toBe(403);
    expect((await t.call("PUT", path(E.emp1A, "2026-11"), { cookie: c.emp1A, body: minijob })).status).toBe(403);
    expect((await t.call("PUT", path(E.emp1A, "2026-11"), { cookie: c.ownerB, body: minijob })).status).toBe(403);
    expect((await t.call("PUT", path(E.managerA, "2026-11"), { cookie: c.managerA, body: minijob })).status).toBe(403);
    for (const body of [{ ...minijob, employmentType: "werkvertrag" }, { ...minijob, hourlyWageCents: 0 }, { ...minijob, monthlyTargetMinutes: 99999 }, { ...minijob, extra: 1 }]) {
      expect((await t.call("PUT", path(E.emp1A, "2026-11"), { cookie: c.managerA, body })).status).toBe(400);
    }
    expect((await t.call("PUT", path(E.emp1A, "2026-13"), { cookie: c.managerA, body: minijob })).status).toBe(400);
  });

  it("leadership deletes a version", async () => {
    expect((await t.call("DELETE", path(E.emp1A, "2026-12"), { cookie: c.emp1A })).status).toBe(403);
    expect((await t.call("DELETE", path(E.emp1A, "2026-12"), { cookie: c.managerA })).status).toBe(204);
    expect((await t.call("DELETE", path(E.emp1A, "2026-12"), { cookie: c.managerA })).status).toBe(400);
    const own = await t.call("GET", path(E.emp1A), { cookie: c.emp1A });
    expect(own.body.map((x: { validFrom: string }) => x.validFrom)).toEqual(["2026-10"]);
  });
});

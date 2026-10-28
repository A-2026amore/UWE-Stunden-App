/**
 * Platform staff and the tenant audit trail (security review 2026-10-28, hint from the
 * super-admin tenant page): without an active support grant super-admins and support see
 * only platform-level events of a tenant (tenant, licence, support grant, billing) – never
 * before/after values of people or working times. With a grant they see the full trail
 * of that tenant (time-limited, logged), and only of that tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

const A = IDS.tenantA;
const B = IDS.tenantB;
const E = IDS.employees;
const PLATFORM_ENTITIES = ["tenant", "license", "support_access_grant", "billing_period", "billing_settings"];
const MARKER = "Geheimname Audit-4711";

let t: TestServer;
const c: Record<string, string> = {};
beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "emp1A", "superAdmin", "support"] as const) c[who] = await t.login(who);
  // Personal events in tenant A: renamed employee, corrected working time.
  expect((await t.call("PATCH", `/api/employees/${E.emp2A}`, { cookie: c.managerA, body: { displayName: MARKER } })).status).toBe(200);
  const entry = await t.call("POST", `/api/employees/${E.emp1A}/time-entries`, {
    cookie: c.emp1A, body: { id: "audit-sicht-1", date: "2026-10-21", start: "08:00", end: "12:00", pauseMinutes: 0, note: `${MARKER} Notiz` },
  });
  expect(entry.status).toBe(201);
});
afterAll(async () => {
  await t?.close();
});

async function auditOf(tenant: string, who: string) {
  const r = await t.call("GET", `/api/tenants/${tenant}/audit?limit=1000`, { cookie: c[who] });
  expect(r.status).toBe(200);
  return r.body as Array<{ entity: string; action: string }>;
}

describe("tenant audit trail for platform staff", () => {
  it("leadership sees the personal events (reference)", async () => {
    const rows = await auditOf(A, "managerA");
    expect(rows.some((r) => r.entity === "employee")).toBe(true);
    expect(JSON.stringify(rows)).toContain(MARKER);
  });

  it("without a support grant: only platform-level events, no personal values", async () => {
    for (const who of ["superAdmin", "support"]) {
      const rows = await auditOf(A, who);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => !PLATFORM_ENTITIES.includes(r.entity)).map((r) => `${who}: ${r.action}`)).toEqual([]);
      expect(JSON.stringify(rows)).not.toContain(MARKER);
      expect(JSON.stringify(rows)).not.toContain("Jo Demo");
      const platform = await t.call("GET", "/api/platform/audit?limit=1000", { cookie: c[who] });
      expect(platform.status).toBe(200);
      expect(JSON.stringify(platform.body)).not.toContain(MARKER);
    }
  });

  it("with an active grant of tenant A: the full trail of A, still nothing personal of B", async () => {
    expect((await t.call("PUT", `/api/tenants/${A}/support-grant`, { cookie: c.ownerA, body: { hours: 1, reason: "Fehlersuche Audit" } })).status).toBe(200);
    const rows = await auditOf(A, "support");
    expect(JSON.stringify(rows)).toContain(MARKER);
    const other = await auditOf(B, "support");
    expect(other.filter((r) => !PLATFORM_ENTITIES.includes(r.entity))).toEqual([]);
    // Revoking ends it immediately.
    expect((await t.call("PUT", `/api/tenants/${A}/support-grant`, { cookie: c.ownerA, body: { hours: 0 } })).status).toBe(200);
    expect(JSON.stringify(await auditOf(A, "support"))).not.toContain(MARKER);
  });
});

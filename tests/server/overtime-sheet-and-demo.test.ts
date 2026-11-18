/**
 * Settings "Überstundenzettel" (core/overtime.ts) and the demo flag of a tenant (0031) over the API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["ownerA", "managerA", "superAdmin", "support"] as const) cookies[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
});

const A = IDS.tenantA;

describe("overtime sheet setting", () => {
  it("the owner switches it; other settings keep it; it can be switched off again", async () => {
    const on = await t.call("PATCH", `/api/tenants/${A}/settings`, { cookie: cookies.ownerA, body: { overtimeSheet: true } });
    expect(on.status).toBe(200);
    expect(on.body.settings.overtimeSheet).toBe(true);
    const other = await t.call("PATCH", `/api/tenants/${A}/settings`, { cookie: cookies.ownerA, body: { breakPolicy: { maxShiftMinutes: 600 } } });
    expect(other.body.settings.overtimeSheet).toBe(true);
    expect((await t.call("PATCH", `/api/tenants/${A}/settings`, { cookie: cookies.ownerA, body: { overtimeSheet: "ja" } })).status).toBe(400);
    expect((await t.call("PATCH", `/api/tenants/${A}/settings`, { cookie: cookies.managerA, body: { overtimeSheet: false } })).status).toBe(403);
    const off = await t.call("PATCH", `/api/tenants/${A}/settings`, { cookie: cookies.ownerA, body: { overtimeSheet: false } });
    expect(off.body.settings.overtimeSheet).toBeUndefined();
  });
});

describe("demo flag", () => {
  it("only a super admin switches it, with a reason", async () => {
    expect((await t.call("PUT", `/api/platform/tenants/${A}/demo`, { cookie: cookies.support, body: { isDemo: false, reason: "Echte Firma" } })).status).toBe(403);
    expect((await t.call("PUT", `/api/platform/tenants/${A}/demo`, { cookie: cookies.superAdmin, body: { isDemo: false, reason: "" } })).status).toBe(400);
    const r = await t.call("PUT", `/api/platform/tenants/${A}/demo`, { cookie: cookies.superAdmin, body: { isDemo: false, reason: "Echte Firma" } });
    expect(r.status).toBe(200);
    expect(r.body.isDemo).toBe(false);
    const back = await t.call("PUT", `/api/platform/tenants/${A}/demo`, { cookie: cookies.superAdmin, body: { isDemo: true, reason: "Zurück (Test)" } });
    expect(back.body.isDemo).toBe(true);
  });
});

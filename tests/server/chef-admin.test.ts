/**
 * Chef-Portal / Super-Admin polish through the HTTP API: invitation links for
 * sharing (copy / WhatsApp), company name, free test customers, tenant
 * deactivation (migration 0015) and the technical system overview.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS, IDS, ORIGIN, PASSWORD, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const cookies: Record<string, string> = {};
const dir = mkdtempSync(join(tmpdir(), "backup-status-"));
const backupFile = join(dir, "last-backup");

beforeAll(async () => {
  writeFileSync(backupFile, "2026-11-20T02:15:00Z\n");
  t = await startTestServer({
    APP_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    BACKUP_STATUS_FILE: backupFile,
  });
  for (const who of ["ownerA", "managerA", "emp1A", "ownerB", "superAdmin", "support"] as const) cookies[who] = await t.login(who);
});
afterAll(async () => {
  await t?.close();
  rmSync(dir, { recursive: true, force: true });
});

const A = IDS.tenantA;
const B = IDS.tenantB;
const tokenOf = (link: string) => decodeURIComponent(/#token=([A-Za-z0-9_%-]+)$/.exec(link)![1]!);

describe("invitation links for sharing", () => {
  it("creates the employee with a one-time link instead of an e-mail; the link works exactly once", async () => {
    const mails = t.mails.length;
    const r = await t.call("POST", `/api/tenants/${A}/employees`, {
      cookie: cookies.managerA,
      body: { displayName: "Lena Link", personnelNumber: "A-701", email: "lena.link@demo-krankentransporte.example", role: "employee", invitation: "link" },
    });
    expect(r.status).toBe(201);
    expect(r.body.invitation).toMatchObject({ delivery: "link" });
    expect(r.body.invitation.link.startsWith(`${ORIGIN}/einladung#token=`)).toBe(true);
    expect(Date.parse(r.body.invitation.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    await new Promise((res) => setTimeout(res, 50));
    expect(t.mails.length).toBe(mails); // nothing mailed

    const token = tokenOf(r.body.invitation.link);
    const accept = await t.call("POST", "/api/auth/invitation/accept", { body: { token, password: "Link-Passwort-1234" } });
    expect(accept.status).toBe(200);
    const again = await t.call("POST", "/api/auth/invitation/accept", { body: { token, password: "Link-Passwort-1234" } });
    expect(again.status).toBe(400);
    const login = await t.call("POST", "/api/auth/login", { body: { email: "lena.link@demo-krankentransporte.example", password: "Link-Passwort-1234" } });
    expect(login.status).toBe(200);
  });

  it("a new link revokes the previous one; only leadership of the tenant gets links", async () => {
    const r = await t.call("POST", `/api/tenants/${A}/employees`, {
      cookie: cookies.ownerA,
      body: { displayName: "Paul Zweit", personnelNumber: "A-702", email: "paul.zweit@demo-krankentransporte.example", role: "employee" },
    });
    expect(r.status).toBe(201);
    expect(r.body.invitation.link).toBeUndefined(); // e-mail delivery never returns the link
    const first = await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie: cookies.managerA, body: { channel: "link" } });
    expect(first.status).toBe(200);
    expect(first.body.delivery).toBe("link");
    const second = await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie: cookies.managerA, body: { channel: "link" } });
    expect(second.body.link).not.toBe(first.body.link);
    expect((await t.call("POST", "/api/auth/invitation/accept", { body: { token: tokenOf(first.body.link), password: "Alt-Passwort-12345" } })).status).toBe(400);

    expect((await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie: cookies.emp1A, body: { channel: "link" } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie: cookies.ownerB, body: { channel: "link" } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie: cookies.superAdmin, body: { channel: "link" } })).status).toBe(403);
    expect((await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie: cookies.managerA, body: { channel: "sms" } })).status).toBe(400);
    // Already active accounts get no link.
    expect((await t.call("POST", `/api/employees/${IDS.employees.emp1A}/invitation`, { cookie: cookies.managerA, body: { channel: "link" } })).status).toBeGreaterThanOrEqual(400);

    const ok = await t.call("POST", "/api/auth/invitation/accept", { body: { token: tokenOf(second.body.link), password: "Neu-Passwort-12345" } });
    expect(ok.status).toBe(200);
    const audit = await t.db.admin.query("select count(*)::int n from public.audit_log where entity = 'invitation' and tenant_id = $1 and action = 'invitation.insert'", [A]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
  });
});

describe("invitation link for an address with an existing account", () => {
  it("is never handed to the manager: the server mails it to the address instead", async () => {
    const mails = t.mails.length;
    const r = await t.call("POST", `/api/tenants/${B}/employees`, {
      cookie: cookies.ownerB,
      body: { displayName: "Fahrer Zweitjob", personnelNumber: "P-901", email: EMAILS.emp2A, role: "employee", invitation: "link" },
    });
    expect(r.status).toBe(201);
    expect(r.body.invitation).toMatchObject({ existingAccount: true, delivery: "log" });
    expect(r.body.invitation.link).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("#token=");
    await new Promise((res) => setTimeout(res, 50));
    expect(t.mails.slice(mails).some((m) => m.to === EMAILS.emp2A)).toBe(true);
    const again = await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie: cookies.ownerB, body: { channel: "link" } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existingAccount: true });
    expect(again.body.link).toBeUndefined();
  });
});

describe("company name", () => {
  it("owner renames the company; manager, employee and platform staff cannot", async () => {
    const r = await t.call("PATCH", `/api/tenants/${A}/name`, { cookie: cookies.ownerA, body: { name: "Demo Krankentransporte GmbH" } });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Demo Krankentransporte GmbH");
    for (const who of ["managerA", "emp1A", "ownerB", "superAdmin"]) {
      expect((await t.call("PATCH", `/api/tenants/${A}/name`, { cookie: cookies[who], body: { name: "Fremd GmbH" } })).status, who).toBe(403);
    }
    expect((await t.call("PATCH", `/api/tenants/${A}/name`, { cookie: cookies.ownerA, body: { name: "x" } })).status).toBe(400);
    expect((await t.call("PATCH", `/api/tenants/${A}/name`, { cookie: cookies.ownerA, body: { name: "Demo Krankentransporte", slug: "x" } })).status).toBe(400);
    await t.call("PATCH", `/api/tenants/${A}/name`, { cookie: cookies.ownerA, body: { name: "Demo Krankentransporte" } });
  });
});

describe("free test customer in one step", () => {
  it("super_admin creates a standard tenant with the free condition; support may not", async () => {
    const body = {
      name: "Test Fahrdienst", slug: "test-fahrdienst", plan: "standard", isDemo: false, ownerEmail: "inhaber@test-fahrdienst.example",
      freeOfCharge: true, conditionNote: "Testzeitraum", conditionValidUntil: "2026-12-31",
    };
    expect((await t.call("POST", "/api/platform/tenants", { cookie: cookies.support, body })).status).toBe(403);
    const r = await t.call("POST", "/api/platform/tenants", { cookie: cookies.superAdmin, body });
    expect(r.status).toBe(201);
    expect(r.body.license).toMatchObject({ plan: "standard", freeOfCharge: true, conditionNote: "Testzeitraum", conditionValidUntil: "2026-12-31" });
    const bad = await t.call("POST", "/api/platform/tenants", { cookie: cookies.superAdmin, body: { ...body, slug: "test-fahrdienst-2", ownerEmail: "x2@test.example", conditionValidUntil: "2026-02-30" } });
    expect(bad.status).toBe(400);
  });
});

describe("tenant deactivation", () => {
  it("blocks sign-in and existing sessions with a clear text; data stays; reactivation", async () => {
    const empB = await t.login("empB");
    expect((await t.call("POST", `/api/platform/tenants/${B}/status`, { cookie: cookies.support, body: { status: "deactivated", reason: "Vertrag beendet" } })).status).toBe(403);
    const r = await t.call("POST", `/api/platform/tenants/${B}/status`, { cookie: cookies.superAdmin, body: { status: "deactivated", reason: "Vertrag beendet" } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("deactivated");
    try {
      const me = await t.call("GET", `/api/tenants/${B}`, { cookie: empB });
      expect(me.status).toBe(403);
      expect(me.body.error).toMatchObject({ code: "tenant_suspended", message: "Der Firmenzugang ist deaktiviert. Bitte wende dich an deinen Arbeitgeber." });
      // Without 2FA a blocked account answers like a wrong password (QA B4).
      expect((await t.call("POST", "/api/auth/login", { body: { email: EMAILS.empB, password: PASSWORD } })).status).toBe(401);
      const list = await t.call("GET", "/api/platform/tenants", { cookie: cookies.superAdmin });
      expect(list.body.find((x: { tenant: { id: string } }) => x.tenant.id === B)).toMatchObject({ tenant: { status: "deactivated" }, employeeCount: expect.any(Number) });
      const audit = await t.call("GET", "/api/platform/audit", { cookie: cookies.superAdmin });
      expect(audit.body.some((e: { entity: string; reason: string; after: { status?: string } }) => e.entity === "tenant" && e.reason === "Vertrag beendet" && e.after?.status === "deactivated")).toBe(true);
    } finally {
      await t.call("POST", `/api/platform/tenants/${B}/status`, { cookie: cookies.superAdmin, body: { status: "active", reason: "Reaktiviert" } });
    }
    t.resetRateLimits();
    expect((await t.call("GET", `/api/tenants/${B}`, { cookie: await t.login("empB") })).status).toBe(200);
  });
});

describe("system overview", () => {
  it("super_admin and support see version, database, migrations, sessions, mail, payment and backup – no secrets", async () => {
    for (const who of ["superAdmin", "support"]) {
      const r = await t.call("GET", "/api/platform/system", { cookie: cookies[who] });
      expect(r.status, who).toBe(200);
      expect(r.body).toMatchObject({
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        commit: "0123456789abcdef0123456789abcdef01234567",
        database: { reachable: true },
        mail: { configured: false, delivery: "log" },
        paymentProvider: "none",
        lastBackupAt: "2026-11-20T02:15:00.000Z",
        production: false,
      });
      expect(r.body.activeSessions).toBeGreaterThan(0);
      expect(r.body.tenants.active).toBeGreaterThanOrEqual(2);
      const text = JSON.stringify(r.body);
      for (const secret of ["nur-fuer-tests", "postgres://", "TOTP", "password"]) expect(text).not.toContain(secret);
    }
  });

  it("is refused for tenant users and anonymous callers", async () => {
    for (const who of ["ownerA", "managerA", "emp1A"]) expect((await t.call("GET", "/api/platform/system", { cookie: cookies[who] })).status, who).toBe(403);
    expect((await t.call("GET", "/api/platform/system")).status).toBe(401);
  });
});

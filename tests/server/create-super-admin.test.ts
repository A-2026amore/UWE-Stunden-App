/**
 * Operator command create-super-admin (server/src/superadmin.ts): first platform account of a fresh
 * production installation. The account signs in through the real API and must set up two-factor sign-in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SuperAdminRefused, createSuperAdmin } from "../../server/src/superadmin.ts";
import { startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
beforeAll(async () => { t = await startTestServer(); });
afterAll(async () => { await t?.close(); });

describe("create-super-admin", () => {
  it("creates a super admin who signs in and is asked to set up two-factor sign-in", async () => {
    const r = await createSuperAdmin(t.db.url, "  Betreiber@Schichtklar24.example ", "Erstes-Admin-Passwort-1");
    expect(r.email).toBe("betreiber@schichtklar24.example");
    const login = await t.call("POST", "/api/auth/login", { body: { email: "betreiber@schichtklar24.example", password: "Erstes-Admin-Passwort-1" } });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.platformRole).toBe("super_admin");
    expect(login.body.twoFactorSetupRequired).toBe(true);
  });

  it("refuses an address that already has an account, a weak password and an invalid address", async () => {
    await expect(createSuperAdmin(t.db.url, "betreiber@schichtklar24.example", "Noch-ein-Passwort-12")).rejects.toThrow(SuperAdminRefused);
    await expect(createSuperAdmin(t.db.url, "neu@schichtklar24.example", "kurz")).rejects.toThrow(/mindestens 10 Zeichen/);
    await expect(createSuperAdmin(t.db.url, "keine-adresse", "Langes-Passwort-123")).rejects.toThrow(/gültige E-Mail/);
  });
});

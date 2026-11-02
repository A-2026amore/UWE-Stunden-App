/**
 * Regression for the pre-registered account takeover (security review 01.11.2026, migration 0026):
 * a manager of tenant A creates an "employee" with a foreign address via the link channel and sets her
 * own password for it. When the platform later creates tenant C with that address as owner, the
 * invitation must NOT be linked to the pre-registered account by merely holding the mailed link.
 * Only a signed-in session of exactly that account links it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
const c: Record<string, string> = {};
beforeAll(async () => {
  t = await startTestServer();
  for (const who of ["managerA", "superAdmin"] as const) c[who] = await t.login(who);
});
afterAll(async () => { await t?.close(); });
const tokenOf = (s: string) => decodeURIComponent(/#token=([A-Za-z0-9_%-]+)/.exec(s)![1]!);

describe("invitation for an address with a pre-registered account (0026)", () => {
  it("is not linked without a session of that account, so a manager cannot collect a foreign owner role", async () => {
    const victim = "chefin@neue-firma-c.example";
    const attackerPassword = "Angreifer-Passwort-1";
    // 1. manager of tenant A creates an "employee" with a foreign address, link channel
    const r = await t.call("POST", `/api/tenants/${IDS.tenantA}/employees`, {
      cookie: c.managerA, body: { displayName: "X", personnelNumber: "X-1", email: victim, role: "employee", invitation: "link" } });
    expect(r.status).toBe(201);
    // 2. she accepts the link herself and sets HER password for the foreign address
    const acc = await t.call("POST", "/api/auth/invitation/accept", { body: { token: tokenOf(r.body.invitation.link), password: attackerPassword } });
    expect(acc.status).toBe(200);
    // 3. later the platform creates tenant C with exactly that owner address
    const before = t.mails.length;
    const ten = await t.call("POST", "/api/platform/tenants", { cookie: c.superAdmin,
      body: { name: "Neue Firma C", slug: "neue-firma-c", plan: "standard", ownerEmail: victim, ownerName: "Chefin C" } });
    expect(ten.status, JSON.stringify(ten.body)).toBe(201);
    await new Promise((res) => setTimeout(res, 100));
    const mail = t.mails.slice(before).find((m) => m.to === victim)!;
    const token = tokenOf(mail.text);
    // 4. the real owner clicks the mailed link without being signed in: nothing is linked
    const anon = await t.call("POST", "/api/auth/invitation/accept", { body: { token, password: "egal-egal-egal" } });
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe("existing_account_login_required");
    // ... also not with the session of another account
    const foreign = await t.call("POST", "/api/auth/invitation/accept", { cookie: c.managerA, body: { token } });
    expect(foreign.status).toBe(401);
    // 5. the attacker's account has no membership in tenant C
    const login = await t.call("POST", "/api/auth/login", { body: { email: victim, password: attackerPassword } });
    expect(login.status).toBe(200);
    expect(login.body.memberships.some((m: { tenantName: string }) => m.tenantName === "Neue Firma C")).toBe(false);
    // 6. the real owner takes the address back via password reset (she owns the mailbox) and signs in
    const resetBefore = t.mails.length;
    expect((await t.call("POST", "/api/auth/password-reset", { body: { email: victim } })).status).toBeLessThan(300);
    await new Promise((res) => setTimeout(res, 100));
    const resetMail = t.mails.slice(resetBefore).find((m) => m.to === victim)!;
    const ownerPassword = "Echte-Chefin-Passwort-1";
    expect((await t.call("POST", "/api/auth/password-reset/confirm", { body: { token: tokenOf(resetMail.text), password: ownerPassword } })).status).toBe(204);
    expect((await t.call("POST", "/api/auth/login", { body: { email: victim, password: attackerPassword } })).status).toBe(401);
    const owner = await t.login(victim, ownerPassword);
    // 7. now the invitation links, in her own session
    const ok = await t.call("POST", "/api/auth/invitation/accept", { cookie: owner, body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.body.existingAccount).toBe(true);
    const again = await t.call("POST", "/api/auth/login", { body: { email: victim, password: ownerPassword } });
    expect(again.body.memberships.some((m: { tenantName: string; role: string }) => m.tenantName === "Neue Firma C" && m.role === "owner")).toBe(true);
  });
});

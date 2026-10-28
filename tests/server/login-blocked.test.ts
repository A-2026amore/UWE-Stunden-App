/**
 * Blocked accounts and the second factor (QA 2026-10-28, finding B4):
 * with 2FA the password step of a blocked account (tenant suspended or
 * employee deactivated) looks exactly like that of an active account; the
 * block is only reported after the second factor. Without 2FA a blocked
 * account answers exactly like a wrong password (401, same text, same rate
 * limit) and no session is created.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS, IDS, PASSWORD, cookieFrom, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
let admin: string;
let ownerA: string;
beforeAll(async () => {
  t = await startTestServer();
  admin = await t.login("superAdmin"); // enrols automatically (mandatory for platform staff)
  ownerA = await t.login("ownerA");
  // Two accounts with 2FA: emp1A (tenant A) and ownerB (tenant B).
  await t.enrollTwoFactor(await t.login("emp1A"), EMAILS.emp1A);
  await t.enrollTwoFactor(await t.login("ownerB"), EMAILS.ownerB);
});
afterAll(async () => {
  await t?.close();
});

const passwordStep = (email: string, password = PASSWORD) => t.call("POST", "/api/auth/login", { body: { email, password } });
const sessions = async (email: string) => (await t.db.admin.query(
  "select count(*)::int as n from auth.sessions s join auth.users u on u.id = s.user_id where u.email = $1 and s.revoked_at is null", [email])).rows[0].n as number;

/** Status, body and cookie names of a password step (cookie values differ per request). */
async function shape(email: string, password = PASSWORD) {
  const r = await passwordStep(email, password);
  return { status: r.status, body: r.body, cookies: r.headers.getSetCookie().map((c) => c.split("=")[0]) };
}

describe("tenant suspended, account with 2FA", () => {
  it("password step is indistinguishable from an active account; the block follows after the code", async () => {
    expect((await t.call("POST", `/api/platform/tenants/${IDS.tenantB}/status`, { cookie: admin, body: { status: "suspended", reason: "Test B4" } })).status).toBe(200);
    try {
      const active = await shape(EMAILS.emp1A);
      const suspended = await shape(EMAILS.ownerB);
      expect(active).toEqual({ status: 200, body: { twoFactorRequired: true }, cookies: ["__Host-tfa", "__Host-sid"] });
      expect(suspended).toEqual(active);
      // Wrong password: the generic 401, same as for an unknown account.
      const wrong = await shape(EMAILS.ownerB, "falsch-falsch-falsch");
      const unknown = await shape("niemand@nirgendwo.example", "falsch-falsch-falsch");
      expect(wrong.status).toBe(401);
      expect(wrong).toEqual(unknown);
      // Same tenant, account WITHOUT 2FA (empB): right password looks like a wrong one.
      const empBRight = await shape(EMAILS.empB);
      const empBWrong = await shape(EMAILS.empB, "falsch-falsch-falsch");
      expect(empBRight).toEqual({ status: 401, body: unknown.body, cookies: [] });
      expect(empBRight).toEqual(empBWrong);

      const before = await sessions(EMAILS.ownerB);
      const step = await passwordStep(EMAILS.ownerB);
      const v = await t.call("POST", "/api/auth/2fa/verify", { cookie: cookieFrom(step.headers), body: { code: await t.twoFactorCode(EMAILS.ownerB) } });
      expect(v.status).toBe(403);
      expect(v.body.error.code).toBe("tenant_suspended");
      expect(v.headers.getSetCookie().some((c) => c.startsWith("__Host-sid=") && !c.startsWith("__Host-sid=;"))).toBe(false);
      expect(await sessions(EMAILS.ownerB)).toBe(before);
      // A wrong code stays a wrong code (no hint about the block).
      const step2 = await passwordStep(EMAILS.ownerB);
      const bad = await t.call("POST", "/api/auth/2fa/verify", { cookie: cookieFrom(step2.headers), body: { code: "000000" } });
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe("invalid_code");
    } finally {
      await t.call("POST", `/api/platform/tenants/${IDS.tenantB}/status`, { cookie: admin, body: { status: "active", reason: "Test B4 Ende" } });
    }
    t.resetRateLimits();
    expect((await t.login("ownerB")).length).toBeGreaterThan(0);
  });
});

describe("employee deactivated", () => {
  it("with 2FA: challenge first, 403 only after the correct code", async () => {
    expect((await t.call("POST", `/api/employees/${IDS.employees.emp1A}/status`, { cookie: ownerA, body: { status: "deactivated", reason: "Test B4" } })).status).toBe(200);
    try {
      const step = await passwordStep(EMAILS.emp1A);
      expect(step.status).toBe(200);
      expect(step.body).toEqual({ twoFactorRequired: true });
      const v = await t.call("POST", "/api/auth/2fa/verify", { cookie: cookieFrom(step.headers), body: { code: await t.twoFactorCode(EMAILS.emp1A) } });
      expect(v.status).toBe(403);
      expect(v.body.error.code).toBe("forbidden");
    } finally {
      await t.call("POST", `/api/employees/${IDS.employees.emp1A}/status`, { cookie: ownerA, body: { status: "active", reason: "Test B4 Ende" } });
    }
  });

  it("without 2FA: the right password answers exactly like a wrong one, no session is created", async () => {
    expect((await t.call("POST", `/api/employees/${IDS.employees.emp2A}/status`, { cookie: ownerA, body: { status: "deactivated", reason: "Test B4" } })).status).toBe(200);
    try {
      t.resetRateLimits();
      const before = await sessions(EMAILS.emp2A);
      const r = await passwordStep(EMAILS.emp2A);
      const wrong = await passwordStep(EMAILS.emp2A, "falsch-falsch-falsch");
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "E-Mail-Adresse oder Passwort ist falsch." } });
      expect(r.body).toEqual(wrong.body);
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(await sessions(EMAILS.emp2A)).toBe(before);
      const all = (await t.db.admin.query(
        "select count(*)::int as n from auth.sessions s join auth.users u on u.id = s.user_id where u.email = $1", [EMAILS.emp2A])).rows[0].n;
      expect(all).toBe(before); // not even a revoked one
      // The right password counts towards the lock-out like a wrong one (no reset):
      // 2 attempts above + 3 more = 5, the 6th is blocked.
      for (let i = 0; i < 3; i++) expect((await passwordStep(EMAILS.emp2A)).status).toBe(401);
      const locked = await passwordStep(EMAILS.emp2A);
      expect(locked.status).toBe(429);
      expect(locked.headers.get("retry-after")).not.toBeNull();
    } finally {
      t.resetRateLimits();
      await t.call("POST", `/api/employees/${IDS.employees.emp2A}/status`, { cookie: ownerA, body: { status: "active", reason: "Test B4 Ende" } });
    }
  });
});

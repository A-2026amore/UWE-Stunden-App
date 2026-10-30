import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS, IDS, ORIGIN, PASSWORD, cookieFrom, startTestServer, tokenFromMail, type TestServer } from "./support/server.ts";

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(async () => {
  await t?.close();
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("login, session, logout", () => {
  it("signs in and returns the Session shape of repository.ts", async () => {
    const r = await t.call("POST", "/api/auth/login", { body: { email: "  Fahrer1@Demo-Krankentransporte.example ", password: PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      userId: IDS.users.emp1A,
      email: EMAILS.emp1A,
      tenantId: IDS.tenantA,
      employeeId: IDS.employees.emp1A,
      role: "employee",
      platformRole: null,
    });
  });

  it("sets a hardened session cookie and stores only the token hash", async () => {
    const r = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.managerA, password: PASSWORD } });
    const set = r.headers.get("set-cookie")!;
    expect(set).toMatch(/^__Host-sid=[A-Za-z0-9_-]{43}; /);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set).not.toMatch(/Domain=/i);
    expect(set).toMatch(/Max-Age=4319\d/); // 12 h
    const token = cookieFrom(r.headers).split("=")[1]!;
    const rows = (await t.db.admin.query("select * from auth.sessions where user_id = $1", [IDS.users.managerA])).rows;
    expect(rows.some((s) => s.token_hash === sha(token))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("GET /api/auth/session returns the session with cookie and null without", async () => {
    const cookie = await t.login("emp1A");
    const withCookie = await t.call("GET", "/api/auth/session", { cookie });
    expect(withCookie.status).toBe(200);
    expect(withCookie.body.employeeId).toBe(IDS.employees.emp1A);
    const without = await t.call("GET", "/api/auth/session");
    expect(without.status).toBe(200);
    expect(without.body).toBeNull();
    const garbage = await t.call("GET", "/api/auth/session", { cookie: "__Host-sid=abc" });
    expect(garbage.body).toBeNull();
  });

  it("platform operators get platformRole and no tenant", async () => {
    const r = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.superAdmin, password: PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ platformRole: "super_admin", tenantId: null, employeeId: null, role: null, twoFactorSetupRequired: true });
  });

  it("wrong password and unknown e-mail give the same generic 401", async () => {
    const wrong = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.emp2A, password: "falsch-falsch-falsch" } });
    const unknown = await t.call("POST", "/api/auth/login", { body: { email: "niemand@nirgendwo.example", password: "falsch-falsch-falsch" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.message).toBe("E-Mail-Adresse oder Passwort ist falsch.");
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("logout revokes the session and clears the cookie", async () => {
    const cookie = await t.login("emp2A");
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}`, { cookie })).status).toBe(200);
    const out = await t.call("POST", "/api/auth/logout", { cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await t.call("GET", "/api/auth/session", { cookie })).body).toBeNull();
    const after = await t.call("GET", `/api/tenants/${IDS.tenantA}`, { cookie });
    expect(after.status).toBe(401);
    expect(after.body.error.message).toBe("Bitte melde dich an.");
  });

  it("ends sessions after the idle timeout and after expiry", async () => {
    const idle = await t.login("emp1A");
    const idleHash = sha(idle.split("=")[1]!);
    await t.db.admin.query("update auth.sessions set last_seen_at = now() - interval '3 hours' where token_hash = $1", [idleHash]);
    expect((await t.call("GET", "/api/auth/session", { cookie: idle })).body).toBeNull();
    const revoked = (await t.db.admin.query("select revoked_at from auth.sessions where token_hash = $1", [idleHash])).rows[0];
    expect(revoked.revoked_at).not.toBeNull();

    const expired = await t.login("emp1A");
    await t.db.admin.query(
      "update auth.sessions set created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' where token_hash = $1",
      [sha(expired.split("=")[1]!)],
    );
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}`, { cookie: expired })).status).toBe(401);
  });

  it("refuses sign-in for a deactivated employee like a wrong password (no session created, QA B4)", async () => {
    const owner = await t.login("ownerA");
    const r = await t.call("POST", `/api/employees/${IDS.employees.emp2A}/status`, { cookie: owner, body: { status: "deactivated", reason: "Test Deaktivierung" } });
    expect(r.status).toBe(200);
    const login = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.emp2A, password: PASSWORD } });
    expect(login.status).toBe(401);
    expect(login.body.error).toEqual({ code: "unauthenticated", message: "E-Mail-Adresse oder Passwort ist falsch." });
    expect(login.headers.get("set-cookie")).toBeNull();
    await t.call("POST", `/api/employees/${IDS.employees.emp2A}/status`, { cookie: owner, body: { status: "active", reason: "Test Reaktivierung" } });
  });
});

describe("rate limiting (in-memory, per IP + e-mail)", () => {
  it("blocks after 5 failed logins with 429 + Retry-After, even with the right password", async () => {
    const email = EMAILS.empB;
    for (let i = 0; i < 5; i++) {
      const r = await t.call("POST", "/api/auth/login", { body: { email, password: `falsch-${i}-xxxxxxxx` } });
      expect(r.status).toBe(401);
    }
    const blocked = await t.call("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.body.error.message).toMatch(/Zu viele Anmeldeversuche/);
    // other accounts from the same IP are not affected
    expect((await t.call("POST", "/api/auth/login", { body: { email: EMAILS.ownerB, password: PASSWORD } })).status).toBe(200);
  });

  it("limits password-reset requests per e-mail (also for unknown addresses)", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await t.call("POST", "/api/auth/password-reset", { body: { email: "unbekannt-rl@nirgendwo.example" } })).status).toBe(204);
    }
    expect((await t.call("POST", "/api/auth/password-reset", { body: { email: "unbekannt-rl@nirgendwo.example" } })).status).toBe(429);
  });
});

describe("CSRF and security headers", () => {
  it("sets security headers on API responses", async () => {
    const r = await t.call("GET", "/api/auth/session");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("rejects state-changing requests without JSON content type", async () => {
    const cookie = await t.login("ownerA");
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
      const r = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/branding`, { cookie, contentType: ct, rawBody: '{"slogan":"CSRF"}' });
      expect(r.status).toBe(415);
    }
    const login = await t.call("POST", "/api/auth/login", { contentType: "text/plain", rawBody: JSON.stringify({ email: EMAILS.ownerA, password: PASSWORD }) });
    expect(login.status).toBe(415);
  });

  it("rejects a foreign or missing Origin", async () => {
    const cookie = await t.login("ownerA");
    const foreign = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/branding`, { cookie, origin: "https://angreifer.example", body: { slogan: "CSRF" } });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.message).toBe("Ungültige Herkunft der Anfrage.");
    const missing = await t.call("PATCH", `/api/tenants/${IDS.tenantA}/branding`, { cookie, origin: null, body: { slogan: "CSRF" } });
    expect(missing.status).toBe(403);
    const tenant = await t.call("GET", `/api/tenants/${IDS.tenantA}`, { cookie });
    expect(tenant.body.branding.slogan).not.toBe("CSRF");
  });

  it("answers CORS preflights only for the configured origin", async () => {
    const ok = await fetch(`${t.url}/api/auth/login`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const bad = await fetch(`${t.url}/api/auth/login`, { method: "OPTIONS", headers: { Origin: "https://angreifer.example", "Access-Control-Request-Method": "POST" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const opaque = await fetch(`${t.url}/api/auth/login`, { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "POST" } });
    expect(opaque.status).toBe(403);
    expect(opaque.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects oversized bodies with 413", async () => {
    const r = await t.call("POST", "/api/auth/login", { rawBody: JSON.stringify({ email: "x@y.example", password: "a".repeat(40_000) }) });
    expect(r.status).toBe(413);
  });
});

describe("password reset (no account enumeration)", () => {
  it("answers identically for known and unknown addresses; only known ones get a mail", async () => {
    const before = t.mails.length;
    const known = await t.call("POST", "/api/auth/password-reset", { body: { email: EMAILS.emp2A } });
    const unknown = await t.call("POST", "/api/auth/password-reset", { body: { email: "gibt-es-nicht@nirgendwo.example" } });
    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(known.body).toEqual(unknown.body);
    await new Promise((r) => setTimeout(r, 50));
    const sent = t.mails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(EMAILS.emp2A);
    expect(sent[0]!.text).toContain(`${ORIGIN}/passwort-neu#token=`);
  });

  it("confirms with the one-time token, ends old sessions and rejects reuse", async () => {
    const oldSession = await t.login("emp2A");
    const before = t.mails.length;
    await t.call("POST", "/api/auth/password-reset", { body: { email: EMAILS.emp2A } });
    await new Promise((r) => setTimeout(r, 50));
    const token = tokenFromMail(t.mails[t.mails.length - 1]!);
    expect(t.mails.length).toBe(before + 1);

    const weak = await t.call("POST", "/api/auth/password-reset/confirm", { body: { token, password: "kurz" } });
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toMatch(/mindestens 10 Zeichen/);

    const ok = await t.call("POST", "/api/auth/password-reset/confirm", { body: { token, password: "Neues-Passwort-2026" } });
    expect(ok.status).toBe(204);
    expect((await t.call("GET", "/api/auth/session", { cookie: oldSession })).body).toBeNull();
    expect((await t.call("POST", "/api/auth/login", { body: { email: EMAILS.emp2A, password: PASSWORD } })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/login", { body: { email: EMAILS.emp2A, password: "Neues-Passwort-2026" } })).status).toBe(200);

    const reuse = await t.call("POST", "/api/auth/password-reset/confirm", { body: { token, password: "Noch-ein-Passwort-1" } });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.message).toBe("Der Link ist ungültig oder abgelaufen.");
    // restore for other tests
    const { setPasswordViaReset } = await import("../../server/src/auth.ts");
    await setPasswordViaReset(t.pool, EMAILS.emp2A, PASSWORD);
  });
});

describe("invitations", () => {
  it("accepts the seeded invitation (sets password, activates employee) without auto sign-in", async () => {
    const r = await t.call("POST", "/api/auth/invitation/accept", { body: { token: IDS.invitationTokenB, password: "Einladung-Passwort-1" } });
    expect(r.status).toBe(200);
    expect(r.body.existingAccount).toBe(false);
    expect(r.headers.get("set-cookie")).toBeNull();
    const login = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.invitedB, password: "Einladung-Passwort-1" } });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ tenantId: IDS.tenantB, employeeId: IDS.employees.invitedB, role: "employee" });
    const again = await t.call("POST", "/api/auth/invitation/accept", { body: { token: IDS.invitationTokenB, password: "Einladung-Passwort-1" } });
    expect(again.status).toBe(400);
  });

  it("invites a new employee by e-mail; the link activates the account", async () => {
    const manager = await t.login("managerA");
    const before = t.mails.length;
    const r = await t.call("POST", `/api/tenants/${IDS.tenantA}/employees`, {
      cookie: manager,
      body: { displayName: "Neu Testperson", personnelNumber: "A-900", email: "Neu.Person@Demo-Krankentransporte.example", role: "employee" },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tenantId: IDS.tenantA, status: "invited", email: "neu.person@demo-krankentransporte.example" });
    await new Promise((res) => setTimeout(res, 50));
    expect(t.mails.length).toBe(before + 1);
    const mail = t.mails[t.mails.length - 1]!;
    expect(mail.to).toBe("neu.person@demo-krankentransporte.example");
    expect(mail.text).toContain(`${ORIGIN}/einladung#token=`);
    const accept = await t.call("POST", "/api/auth/invitation/accept", { body: { token: tokenFromMail(mail), password: "Erstes-Passwort-99" } });
    expect(accept.status).toBe(200);
    const login = await t.call("POST", "/api/auth/login", { body: { email: "neu.person@demo-krankentransporte.example", password: "Erstes-Passwort-99" } });
    expect(login.status).toBe(200);
    expect(login.body.employeeId).toBe(r.body.id);
  });

  it("an existing account is linked without changing its password, and the user is told so", async () => {
    const ownerB = await t.login("ownerB");
    const before = t.mails.length;
    const r = await t.call("POST", `/api/tenants/${IDS.tenantB}/employees`, {
      cookie: ownerB,
      body: { displayName: "Sam Zweitjob", personnelNumber: "P-50", email: EMAILS.emp1A, role: "employee" },
    });
    expect(r.status).toBe(201);
    await new Promise((res) => setTimeout(res, 50));
    const token = tokenFromMail(t.mails[before]!);
    const accept = await t.call("POST", "/api/auth/invitation/accept", { body: { token, password: "Wird-nicht-verwendet-1" } });
    expect(accept.status).toBe(200);
    expect(accept.body.existingAccount).toBe(true);
    expect(accept.body.message).toMatch(/bisherigen Passwort an/);
    expect((await t.call("POST", "/api/auth/login", { body: { email: EMAILS.emp1A, password: "Wird-nicht-verwendet-1" } })).status).toBe(401);
    const login = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.emp1A, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.body.memberships.map((m: { tenantId: string }) => m.tenantId).sort()).toEqual([IDS.tenantA, IDS.tenantB].sort());
    expect((await t.call("POST", "/api/auth/invitation/accept", { body: { token } })).status).toBe(400);
  });

  it("a new account needs a password", async () => {
    const owner = await t.login("ownerA");
    const before = t.mails.length;
    await t.call("POST", `/api/tenants/${IDS.tenantA}/employees`, {
      cookie: owner, body: { displayName: "Ohne Passwort", personnelNumber: "A-902", email: "ohne.passwort@demo-krankentransporte.example", role: "employee" },
    });
    await new Promise((res) => setTimeout(res, 50));
    const r = await t.call("POST", "/api/auth/invitation/accept", { body: { token: tokenFromMail(t.mails[before]!) } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Passwort/);
  });

  it("a manager cannot invite a manager (owner only)", async () => {
    const manager = await t.login("managerA");
    const r = await t.call("POST", `/api/tenants/${IDS.tenantA}/employees`, {
      cookie: manager,
      body: { displayName: "Leitung Zwei", personnelNumber: "A-901", email: null, role: "manager" },
    });
    expect(r.status).toBe(403);
  });
});

describe("suspended tenant", () => {
  it("an existing session of a member stops working with a clear message; login is refused like a wrong password", async () => {
    const emp = await t.login("ownerB"); // empB is rate-limited by an earlier test
    expect((await t.call("GET", `/api/employees/${IDS.employees.ownerB}/time-entries?month=2026-10`, { cookie: emp })).status).toBe(200);
    const admin = await t.login("superAdmin");
    expect((await t.call("POST", `/api/platform/tenants/${IDS.tenantB}/status`, { cookie: admin, body: { status: "suspended", reason: "Test Sperre" } })).status).toBe(200);
    try {
      for (const path of [`/api/employees/${IDS.employees.ownerB}/time-entries?month=2026-10`, `/api/tenants/${IDS.tenantB}`]) {
        const r = await t.call("GET", path, { cookie: emp });
        expect(r.status).toBe(403);
        expect(r.body.error).toEqual({ code: "tenant_suspended", message: "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber." });
      }
      expect((await t.call("GET", "/api/auth/session", { cookie: emp })).body).toBeNull();
      const login = await t.call("POST", "/api/auth/login", { body: { email: EMAILS.ownerB, password: PASSWORD } });
      // Without 2FA a new sign-in does not reveal the block (QA B4): generic 401.
      expect(login.status).toBe(401);
      expect(login.body.error.code).toBe("unauthenticated");
      // platform staff keep working
      expect((await t.call("GET", "/api/platform/tenants", { cookie: admin })).status).toBe(200);
    } finally {
      await t.call("POST", `/api/platform/tenants/${IDS.tenantB}/status`, { cookie: admin, body: { status: "active", reason: "Test Ende" } });
    }
    expect((await t.call("GET", `/api/tenants/${IDS.tenantB}`, { cookie: emp })).status).toBe(200);
  });
});

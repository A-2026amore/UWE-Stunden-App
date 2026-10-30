/**
 * Two-factor authentication (TOTP) against the real API + PostgreSQL:
 * enrolment, two-step sign-in, replay protection, recovery codes, disable,
 * mandatory 2FA for platform staff and per tenant, rate limits, encryption.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, timeStep } from "../../platform/src/security/totp.ts";
import { loadConfig, parseTotpKey } from "../../server/src/config.ts";
import { createTwoFactorService, decryptSecret, encryptSecret, nodeHmacSha1, TotpKeyError } from "../../server/src/twoFactor.ts";
import { EMAILS, IDS, PASSWORD, TOTP_TEST_KEY, cookieFrom, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(async () => {
  await t?.close();
});

const code = (secret: string, step: number) => hotp(base32Decode(secret), step, 6, nodeHmacSha1);
const stepNow = () => timeStep(t.now());

async function passwordStep(email: string, password = PASSWORD) {
  return t.call("POST", "/api/auth/login", { body: { email, password } });
}
async function verify(challengeCookie: string, body: Record<string, unknown>) {
  return t.call("POST", "/api/auth/2fa/verify", { cookie: challengeCookie, body });
}
async function auditActions(userId: string): Promise<Array<{ action: string; tenant_id: string | null }>> {
  return (await t.db.admin.query(
    "select action, tenant_id from public.audit_log where entity = 'user' and entity_id = $1 order by created_at, action", [userId])).rows;
}

describe("enrolment", () => {
  let cookie: string;
  let secret: string;

  it("starts with 2FA off and returns an otpauth URI plus the secret once", async () => {
    cookie = await t.login("emp1A");
    const st = await t.call("GET", "/api/auth/2fa", { cookie });
    expect(st.body).toEqual({ enabled: false, enrolledAt: null, pending: false, required: false, requiredBy: null, recoveryCodesRemaining: 0 });
    const r = await t.call("POST", "/api/auth/2fa/setup", { cookie });
    expect(r.status).toBe(200);
    secret = r.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(r.body).toMatchObject({ issuer: "Schichtklar24", account: EMAILS.emp1A });
    expect(r.body.otpauthUri).toBe(`otpauth://totp/Schichtklar24:${encodeURIComponent(EMAILS.emp1A)}?secret=${secret}&issuer=Schichtklar24&algorithm=SHA1&digits=6&period=30`);
    expect((await t.call("GET", "/api/auth/2fa", { cookie })).body).toMatchObject({ enabled: false, pending: true });
  });

  it("stores the secret only encrypted (AES-256-GCM, bound to the user)", async () => {
    const row = (await t.db.admin.query("select * from auth.totp_factors where user_id = $1", [IDS.users.emp1A])).rows[0];
    expect(row.enrolled_at).toBeNull();
    expect(row.secret_ciphertext).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(row.secret_ciphertext).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret.slice(0, 12));
    const cfg = loadConfig({ DATABASE_URL: "postgres://x", TOTP_ENCRYPTION_KEY: TOTP_TEST_KEY }).twoFactor;
    expect(base32Encode(decryptSecret(cfg, IDS.users.emp1A, row.secret_ciphertext).secret)).toBe(secret);
    // Copied to another user it does not decrypt (additional authenticated data = user id).
    expect(() => decryptSecret(cfg, IDS.users.emp2A, row.secret_ciphertext)).toThrow(TotpKeyError);
  });

  it("rejects a wrong confirmation code, accepts the current one and returns 10 recovery codes", async () => {
    const bad = await t.call("POST", "/api/auth/2fa/setup/confirm", { cookie, body: { code: code(secret, stepNow() + 3) } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_code");
    // A second (password-only) session of the same user ends with the activation.
    const other = await t.login("emp1A");
    const ok = await t.call("POST", "/api/auth/2fa/setup/confirm", { cookie, body: { code: code(secret, stepNow()) } });
    expect(ok.status).toBe(200);
    const codes: string[] = ok.body.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    t.secrets.set(EMAILS.emp1A, secret);

    expect((await t.call("GET", "/api/auth/session", { cookie })).body.userId).toBe(IDS.users.emp1A);
    expect((await t.call("GET", "/api/auth/session", { cookie: other })).body).toBeNull();

    const stored = (await t.db.admin.query("select code_hash, used_at from auth.totp_recovery_codes where user_id = $1", [IDS.users.emp1A])).rows;
    expect(stored).toHaveLength(10);
    const dump = JSON.stringify(stored);
    for (const c of codes) {
      expect(dump).not.toContain(c);
      expect(dump).not.toContain(c.replace(/-/g, ""));
    }
    expect((await t.call("GET", "/api/auth/2fa", { cookie })).body).toMatchObject({ enabled: true, pending: false, recoveryCodesRemaining: 10 });
    expect((await t.call("POST", "/api/auth/2fa/setup", { cookie })).status).toBe(409);

    const audit = await auditActions(IDS.users.emp1A);
    expect(audit).toEqual([
      { action: "two_factor.enabled", tenant_id: IDS.tenantA },
      { action: "two_factor.recovery_codes_created", tenant_id: IDS.tenantA },
    ]);
    // Visible to the tenant's managers, not to other tenants.
    const managerView = await t.call("GET", `/api/tenants/${IDS.tenantA}/audit?limit=50`, { cookie: await t.login("managerA") });
    expect(managerView.body.some((e: { action: string }) => e.action === "two_factor.enabled")).toBe(true);
  });

  it("rejects unknown fields and malformed codes", async () => {
    const r = await t.call("POST", "/api/auth/2fa/setup/confirm", { cookie, body: { code: "123456", secret: "x" } });
    expect(r.status).toBe(400);
  });
});

describe("sign-in with a second factor", () => {
  it("password step: no session yet, only a short-lived HttpOnly challenge cookie", async () => {
    const r = await passwordStep(EMAILS.emp1A);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ twoFactorRequired: true });
    const [challenge, cleared] = r.headers.getSetCookie();
    expect(challenge).toMatch(/^__Host-tfa=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=300$/);
    expect(cleared).toMatch(/^__Host-sid=; .*Max-Age=0/);
    const token = challenge!.split(";")[0]!.split("=")[1]!;
    const rows = (await t.db.admin.query("select token_hash, expires_at - created_at as ttl, attempts from auth.two_factor_challenges where user_id = $1 and used_at is null", [IDS.users.emp1A])).rows;
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows.at(-1)).toMatchObject({ attempts: 0 });
    // The challenge cookie is no session.
    const c = cookieFrom(r.headers);
    expect((await t.call("GET", "/api/auth/session", { cookie: c })).body).toBeNull();
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}`, { cookie: c })).status).toBe(401);
  });

  it("wrong password for an enrolled account looks exactly like an unknown account", async () => {
    const wrong = await passwordStep(EMAILS.emp1A, "falsch-falsch-falsch");
    const unknown = await passwordStep("niemand@nirgendwo.example", "falsch-falsch-falsch");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("verify: no challenge → 401, wrong code → 401, right code → session; the challenge is single use", async () => {
    const none = await t.call("POST", "/api/auth/2fa/verify", { body: { code: "123456" } });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe("two_factor_expired");

    const r = await passwordStep(EMAILS.emp1A);
    const challenge = cookieFrom(r.headers);
    const good = await t.twoFactorCode(EMAILS.emp1A);
    const wrong = await verify(challenge, { code: good === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toEqual({ code: "invalid_code", message: "Der Code ist ungültig oder abgelaufen. Bitte den aktuellen Code aus der Authenticator-App eingeben." });
    const malformed = await verify(challenge, { code: "12ab56" });
    expect(malformed.status).toBe(401);

    const ok = await verify(challenge, { code: good });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ userId: IDS.users.emp1A, employeeId: IDS.employees.emp1A, role: "employee" });
    const [sessionCookie, clearedChallenge] = ok.headers.getSetCookie();
    expect(sessionCookie).toMatch(/^__Host-sid=/);
    expect(clearedChallenge).toMatch(/^__Host-tfa=; .*Max-Age=0/);
    const session = cookieFrom(ok.headers);
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}`, { cookie: session })).status).toBe(200);

    const again = await verify(challenge, { code: await t.twoFactorCode(EMAILS.emp1A) });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("two_factor_expired");
  });

  it("rejects a replayed code and codes outside the ±1 step window", async () => {
    const step = stepNow();
    const secret = t.secrets.get(EMAILS.emp1A)!;
    const last = Number((await t.db.admin.query("select last_used_step from auth.totp_factors where user_id = $1", [IDS.users.emp1A])).rows[0].last_used_step);
    t.advanceClock((last + 1 - step) * 30_000 + 30_000); // well past every used step
    const now = stepNow();

    const c1 = cookieFrom((await passwordStep(EMAILS.emp1A)).headers);
    expect((await verify(c1, { code: code(secret, now + 2) })).status).toBe(401); // too far ahead
    expect((await verify(c1, { code: code(secret, now - 2) })).status).toBe(401); // too old
    const ok = await verify(c1, { code: code(secret, now) });
    expect(ok.status).toBe(200);

    // The same code again (still valid by time) is a replay.
    const c2 = cookieFrom((await passwordStep(EMAILS.emp1A)).headers);
    const replay = await verify(c2, { code: code(secret, now) });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("invalid_code");
    // An older step that is still in the window is rejected as well.
    expect((await verify(c2, { code: code(secret, now - 1) })).status).toBe(401);
    // The next step's code works.
    expect((await verify(c2, { code: code(secret, now + 1) })).status).toBe(200);
    expect(Number((await t.db.admin.query("select last_used_step from auth.totp_factors where user_id = $1", [IDS.users.emp1A])).rows[0].last_used_step)).toBe(now + 1);
  });

  it("a challenge allows at most 5 attempts", async () => {
    const c = cookieFrom((await passwordStep(EMAILS.emp1A)).headers);
    for (let i = 0; i < 4; i++) expect((await verify(c, { code: "000000" === (await t.twoFactorCode(EMAILS.emp1A)) ? "111111" : "000000" })).status).toBe(401);
    // 5th attempt is still counted …
    expect((await verify(c, { code: "99999" })).status).toBe(401);
    // … the 6th is refused even with the right code.
    const sixth = await verify(c, { code: await t.twoFactorCode(EMAILS.emp1A) });
    expect(sixth.status).toBe(401);
    expect(sixth.body.error.code).toBe("two_factor_expired");
    t.resetRateLimits(); // 5 failures also reached the per-account limit
  });
});

describe("recovery codes", () => {
  let codes: string[];
  let cookie: string;

  it("regenerating needs password + code and invalidates the old codes", async () => {
    cookie = await t.login("emp1A");
    const noPw = await t.call("POST", "/api/auth/2fa/recovery-codes", { cookie, body: { password: "falsch-falsch-falsch", code: await t.twoFactorCode(EMAILS.emp1A) } });
    expect(noPw.status).toBe(400);
    expect(noPw.body.error).toEqual({ code: "invalid_code", message: "Passwort oder Code ist falsch." });
    const old = (await t.db.admin.query("select code_hash from auth.totp_recovery_codes where user_id = $1", [IDS.users.emp1A])).rows.map((r) => r.code_hash);
    const r = await t.call("POST", "/api/auth/2fa/recovery-codes", { cookie, body: { password: PASSWORD, code: await t.twoFactorCode(EMAILS.emp1A) } });
    expect(r.status).toBe(200);
    codes = r.body.recoveryCodes;
    expect(codes).toHaveLength(10);
    const now = (await t.db.admin.query("select code_hash from auth.totp_recovery_codes where user_id = $1", [IDS.users.emp1A])).rows.map((r) => r.code_hash);
    expect(now.filter((h) => old.includes(h))).toEqual([]);
  });

  it("signs in once with a recovery code (case and hyphens do not matter), never twice", async () => {
    const typed = codes[3]!.toLowerCase().replace(/-/g, " ");
    const c1 = cookieFrom((await passwordStep(EMAILS.emp1A)).headers);
    const ok = await verify(c1, { recoveryCode: typed });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ userId: IDS.users.emp1A, recoveryCodesRemaining: 9 });
    const used = (await t.db.admin.query("select count(*)::int as n from auth.totp_recovery_codes where user_id = $1 and used_at is not null", [IDS.users.emp1A])).rows[0].n;
    expect(used).toBe(1);

    const c2 = cookieFrom((await passwordStep(EMAILS.emp1A)).headers);
    const reuse = await verify(c2, { recoveryCode: codes[3] });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.message).toBe("Der Wiederherstellungscode ist ungültig oder wurde bereits verwendet.");
    // Code and recovery code at the same time is not allowed.
    expect((await verify(c2, { code: "123456", recoveryCode: codes[4] })).status).toBe(401);
    expect((await verify(c2, { recoveryCode: codes[4] })).status).toBe(200);

    const audit = await auditActions(IDS.users.emp1A);
    expect(audit.filter((a) => a.action === "two_factor.recovery_code_used")).toHaveLength(2);
    expect((await t.call("GET", "/api/auth/2fa", { cookie })).body.recoveryCodesRemaining).toBe(8);
  });
});

describe("disable", () => {
  it("requires password and code; removes secret and recovery codes; sign-in is one step again", async () => {
    const cookie = await t.login("emp1A");
    const wrongCode = await t.call("POST", "/api/auth/2fa/disable", { cookie, body: { password: PASSWORD, code: "000000" === (await t.twoFactorCode(EMAILS.emp1A)) ? "111111" : "000000" } });
    expect(wrongCode.status).toBe(400);
    const noCode = await t.call("POST", "/api/auth/2fa/disable", { cookie, body: { password: PASSWORD } });
    expect(noCode.status).toBe(400);
    const ok = await t.call("POST", "/api/auth/2fa/disable", { cookie, body: { password: PASSWORD, code: await t.twoFactorCode(EMAILS.emp1A) } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ setupRequired: false });
    expect((await t.db.admin.query("select count(*)::int as n from auth.totp_factors where user_id = $1", [IDS.users.emp1A])).rows[0].n).toBe(0);
    expect((await t.db.admin.query("select count(*)::int as n from auth.totp_recovery_codes where user_id = $1", [IDS.users.emp1A])).rows[0].n).toBe(0);
    expect((await auditActions(IDS.users.emp1A)).at(-1)).toEqual({ action: "two_factor.disabled", tenant_id: IDS.tenantA });
    t.secrets.delete(EMAILS.emp1A);
    const r = await passwordStep(EMAILS.emp1A);
    expect(r.body).toMatchObject({ userId: IDS.users.emp1A });
    expect(r.body.twoFactorRequired).toBeUndefined();
    expect((await t.call("POST", "/api/auth/2fa/disable", { cookie: cookieFrom(r.headers), body: { password: PASSWORD, code: "123456" } })).status).toBe(409);
  });
});

describe("mandatory 2FA for platform staff", () => {
  it("support can sign in, but only reaches the 2FA setup until enrolled", async () => {
    const r = await passwordStep(EMAILS.support);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ platformRole: "support", twoFactorSetupRequired: true });
    const cookie = cookieFrom(r.headers);
    const blocked = await t.call("GET", "/api/platform/tenants", { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toEqual({ code: "two_factor_setup_required", message: "Für dein Konto ist die Zwei-Faktor-Anmeldung vorgeschrieben. Bitte richte sie zuerst ein." });
    expect((await t.call("GET", "/api/platform/audit", { cookie })).status).toBe(403);
    expect((await t.call("GET", "/api/auth/session", { cookie })).body).toMatchObject({ platformRole: "support", twoFactorSetupRequired: true });
    expect((await t.call("GET", "/api/auth/2fa", { cookie })).body).toMatchObject({ enabled: false, required: true, requiredBy: "platform" });

    await t.enrollTwoFactor(cookie, EMAILS.support);
    expect((await t.call("GET", "/api/platform/tenants", { cookie })).status).toBe(200);
    expect((await t.call("GET", "/api/auth/session", { cookie })).body.twoFactorSetupRequired).toBeUndefined();
    const audit = await auditActions(IDS.users.support);
    expect(audit[0]).toEqual({ action: "two_factor.enabled", tenant_id: null });

    // Disabling (e.g. new phone) sends the account straight back to the setup.
    const off = await t.call("POST", "/api/auth/2fa/disable", { cookie, body: { password: PASSWORD, code: await t.twoFactorCode(EMAILS.support) } });
    expect(off.body).toEqual({ setupRequired: true });
    expect((await t.call("GET", "/api/platform/tenants", { cookie })).status).toBe(403);
    await t.enrollTwoFactor(cookie, EMAILS.support);
    expect((await t.call("GET", "/api/platform/tenants", { cookie })).status).toBe(200);
  });

  it("an enrolled super_admin signs in with password + code", async () => {
    const cookie = await t.login("superAdmin"); // enrols on first sign-in
    expect(t.secrets.has(EMAILS.superAdmin)).toBe(true);
    expect((await t.call("GET", "/api/platform/tenants", { cookie })).status).toBe(200);
    const r = await passwordStep(EMAILS.superAdmin);
    expect(r.body).toEqual({ twoFactorRequired: true });
    const ok = await verify(cookieFrom(r.headers), { code: await t.twoFactorCode(EMAILS.superAdmin) });
    expect(ok.body).toMatchObject({ platformRole: "super_admin" });
    expect((await t.call("GET", "/api/platform/tenants", { cookie: cookieFrom(ok.headers) })).status).toBe(200);
  });
});

describe("tenant requirement for managers", () => {
  it("only the owner switches it on, and only with own 2FA", async () => {
    const manager = await t.login("managerA");
    const m = await t.call("PUT", `/api/tenants/${IDS.tenantA}/two-factor-policy`, { cookie: manager, body: { requireTwoFactorForManagers: true } });
    expect(m.status).toBe(403);
    const owner = await t.login("ownerA");
    const noOwn = await t.call("PUT", `/api/tenants/${IDS.tenantA}/two-factor-policy`, { cookie: owner, body: { requireTwoFactorForManagers: true } });
    expect(noOwn.status).toBe(409);
    expect(noOwn.body.error.message).toBe("Bitte richte zuerst für dein eigenes Konto die Zwei-Faktor-Anmeldung ein.");
    expect((await t.call("PUT", `/api/tenants/${IDS.tenantA}/two-factor-policy`, { cookie: owner, body: { requireTwoFactorForManagers: "ja" } })).status).toBe(400);
    // Platform staff cannot switch it either (owner of tenant A only).
    const admin = await t.login("superAdmin");
    expect((await t.call("PUT", `/api/tenants/${IDS.tenantA}/two-factor-policy`, { cookie: admin, body: { requireTwoFactorForManagers: true } })).status).toBe(403);
  });

  it("applies to managers/owners of that tenant immediately, not to employees or other tenants", async () => {
    const owner = await t.login("ownerA");
    await t.enrollTwoFactor(owner, EMAILS.ownerA);
    const manager = await t.login("managerA");
    const employee = await t.login("emp2A");
    const ownerB = await t.login("ownerB");
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}/employees`, { cookie: manager })).status).toBe(200);

    const on = await t.call("PUT", `/api/tenants/${IDS.tenantA}/two-factor-policy`, { cookie: owner, body: { requireTwoFactorForManagers: true } });
    expect(on.status).toBe(200);
    expect(on.body.requireTwoFactorForManagers).toBe(true);
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}`, { cookie: owner })).body.requireTwoFactorForManagers).toBe(true);

    // The manager's running session now only reaches the setup.
    const blocked = await t.call("GET", `/api/tenants/${IDS.tenantA}/employees`, { cookie: manager });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("two_factor_setup_required");
    expect((await t.call("GET", "/api/auth/2fa", { cookie: manager })).body).toMatchObject({ required: true, requiredBy: "tenant" });
    const fresh = await passwordStep(EMAILS.managerA);
    expect(fresh.body).toMatchObject({ role: "manager", twoFactorSetupRequired: true });
    // Employees and the other tenant are not affected.
    expect((await t.call("GET", `/api/employees/${IDS.employees.emp2A}/time-entries?month=2026-10`, { cookie: employee })).status).toBe(200);
    expect((await t.call("GET", `/api/tenants/${IDS.tenantB}/employees`, { cookie: ownerB })).status).toBe(200);
    // The owner (enrolled) keeps working.
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}/employees`, { cookie: owner })).status).toBe(200);

    await t.enrollTwoFactor(manager, EMAILS.managerA);
    expect((await t.call("GET", `/api/tenants/${IDS.tenantA}/employees`, { cookie: manager })).status).toBe(200);

    const audit = (await t.db.admin.query(
      "select before ->> 'require_two_factor_for_managers' as b, after ->> 'require_two_factor_for_managers' as a from public.audit_log where entity = 'tenant' and entity_id = $1 and action = 'tenant.update' order by created_at desc limit 1",
      [IDS.tenantA])).rows[0];
    expect(audit).toEqual({ b: "false", a: "true" });

    const off = await t.call("PUT", `/api/tenants/${IDS.tenantA}/two-factor-policy`, { cookie: owner, body: { requireTwoFactorForManagers: false } });
    expect(off.body.requireTwoFactorForManagers).toBe(false);
  });
});

describe("rate limit", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({ RATE_LIMIT_2FA_PER_ACCOUNT: "3" });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("blocks an account after 3 wrong codes across challenges with 429 + Retry-After, even with the right code", async () => {
    const cookie = await s.login("emp2A");
    await s.enrollTwoFactor(cookie, EMAILS.emp2A);
    const wrong = async (c: string) => {
      const good = await s.twoFactorCode(EMAILS.emp2A);
      return s.call("POST", "/api/auth/2fa/verify", { cookie: c, body: { code: good === "000000" ? "111111" : "000000" } });
    };
    const c1 = cookieFrom((await s.call("POST", "/api/auth/login", { body: { email: EMAILS.emp2A, password: PASSWORD } })).headers);
    expect((await wrong(c1)).status).toBe(401);
    expect((await wrong(c1)).status).toBe(401);
    const c2 = cookieFrom((await s.call("POST", "/api/auth/login", { body: { email: EMAILS.emp2A, password: PASSWORD } })).headers);
    expect((await wrong(c2)).status).toBe(401);
    const blocked = await s.call("POST", "/api/auth/2fa/verify", { cookie: c2, body: { code: await s.twoFactorCode(EMAILS.emp2A) } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Disabling is limited by the same counter.
    const dis = await s.call("POST", "/api/auth/2fa/disable", { cookie, body: { password: PASSWORD, code: await s.twoFactorCode(EMAILS.emp2A) } });
    expect(dis.status).toBe(429);
    // Other accounts are not affected.
    expect(await s.login("emp1A")).toMatch(/^__Host-sid=/);
  });
});

describe("encryption key and rotation", () => {
  const OLD = TOTP_TEST_KEY;
  const NEW = "b".repeat(64);

  it("parses keys and refuses production without a key", () => {
    const base = { DATABASE_URL: "postgres://x", NODE_ENV: "production", PUBLIC_ORIGIN: "https://zeit.example" };
    expect(() => loadConfig(base)).toThrow(/TOTP_ENCRYPTION_KEY fehlt/);
    expect(() => loadConfig({ ...base, TOTP_ENCRYPTION_KEY: "zu-kurz" })).toThrow(/32-Byte-Schlüssel/);
    expect(() => loadConfig({ ...base, TOTP_ENCRYPTION_KEY: NEW, TOTP_ENCRYPTION_KEY_PREVIOUS: "kaputt" })).toThrow(/TOTP_ENCRYPTION_KEY_PREVIOUS/);
    expect(() => loadConfig({ ...base, TOTP_ENCRYPTION_KEY: NEW, TOTP_ISSUER: "a:b" })).toThrow(/TOTP_ISSUER/);
    const cfg = loadConfig({ ...base, TOTP_ENCRYPTION_KEY: NEW, TOTP_ENCRYPTION_KEY_PREVIOUS: `${OLD}, ${NEW}` }).twoFactor;
    expect(cfg.keys.map((k) => k.id)).toEqual([parseTotpKey(NEW, "x").id, parseTotpKey(OLD, "x").id]);
    expect(cfg.developmentKey).toBe(false);
    const dev = loadConfig({ DATABASE_URL: "postgres://x" }).twoFactor;
    expect(dev.developmentKey).toBe(true);
    expect(dev.keys).toHaveLength(1);
    // Ciphertexts differ every time (random IV) and fail with a manipulated tag.
    const secret = new Uint8Array(20).fill(7);
    const a = encryptSecret(cfg, "u1", secret);
    expect(a).not.toBe(encryptSecret(cfg, "u1", secret));
    const parts = a.split(".");
    parts[3] = (parts[3]![0] === "A" ? "B" : "A") + parts[3]!.slice(1);
    expect(() => decryptSecret(cfg, "u1", parts.join("."))).toThrow(TotpKeyError);
  });

  it("decrypts with the previous key and re-encrypts with the new key on the next use", async () => {
    const cookie = await t.login("emp1A");
    await t.enrollTwoFactor(cookie, EMAILS.emp1A);
    const before = (await t.db.admin.query("select secret_ciphertext from auth.totp_factors where user_id = $1", [IDS.users.emp1A])).rows[0].secret_ciphertext as string;
    const oldId = parseTotpKey(OLD, "x").id;
    expect(before.split(".")[1]).toBe(oldId);

    const rotated = loadConfig({ DATABASE_URL: "postgres://x", TOTP_ENCRYPTION_KEY: NEW, TOTP_ENCRYPTION_KEY_PREVIOUS: OLD }).twoFactor;
    const svc = createTwoFactorService(t.pool, rotated, t.now);
    expect(await svc.verify(IDS.users.emp1A, { kind: "totp", code: await t.twoFactorCode(EMAILS.emp1A) })).toEqual({ ok: true });
    const after = (await t.db.admin.query("select secret_ciphertext from auth.totp_factors where user_id = $1", [IDS.users.emp1A])).rows[0].secret_ciphertext as string;
    expect(after.split(".")[1]).toBe(parseTotpKey(NEW, "x").id);
    expect(base32Encode(decryptSecret(rotated, IDS.users.emp1A, after).secret)).toBe(t.secrets.get(EMAILS.emp1A));

    // Without the new key the secret is unreadable – the API answers 500 and logs only the key id.
    const r = await passwordStep(EMAILS.emp1A);
    const v = await verify(cookieFrom(r.headers), { code: await t.twoFactorCode(EMAILS.emp1A) });
    expect(v.status).toBe(500);
    // Put the test key back for the remaining tests.
    const back = createTwoFactorService(t.pool, loadConfig({ DATABASE_URL: "postgres://x", TOTP_ENCRYPTION_KEY: OLD, TOTP_ENCRYPTION_KEY_PREVIOUS: NEW }).twoFactor, t.now);
    expect(await back.verify(IDS.users.emp1A, { kind: "totp", code: await t.twoFactorCode(EMAILS.emp1A) })).toEqual({ ok: true });
  });
});

import { describe, expect, it } from "vitest";
import { ApiError, SessionExpiredError, TenantSuspendedError, TwoFactorSetupRequiredError, createApiRepository, type AuthFailure } from "./api";
import { isNetworkError } from "./sync";
import { AccessDeniedError, ConflictError, TwoFactorRequiredError } from "./repository";

interface Call { url: string; init: RequestInit }

function fakeFetch(responses: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const fn = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { status: 204 };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? null), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

const err = (code: string, message: string) => ({ error: { code, message } });

describe("createApiRepository (fetch mocked)", () => {
  it("sends credentials and JSON for writes, none for reads", async () => {
    const f = fakeFetch([{ status: 200, body: null }, { status: 204 }]);
    const repo = createApiRepository("https://zeit.example/", { fetch: f.fn });
    await repo.currentSession();
    await repo.requestPasswordReset("a@b.example");
    expect(f.calls[0]).toMatchObject({ url: "https://zeit.example/api/auth/session", init: { method: "GET", credentials: "include" } });
    expect(f.calls[0]!.init.body).toBeUndefined();
    expect(f.calls[1]!.init).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ email: "a@b.example" }) });
    expect((f.calls[1]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("maps 403 → AccessDeniedError, 409 version → ConflictError, others → ApiError", async () => {
    const f = fakeFetch([
      { status: 403, body: err("forbidden", "Kein Zugriff auf diese Daten.") },
      { status: 409, body: err("version_conflict", "Der Eintrag wurde zwischenzeitlich geändert.") },
      { status: 409, body: err("overlap", "Einsätze überschneiden sich.") },
      { status: 401, body: err("unauthenticated", "Bitte melde dich an.") },
      { status: 401, body: err("unauthenticated", "E-Mail-Adresse oder Passwort ist falsch.") },
    ]);
    const repo = createApiRepository("https://zeit.example", { fetch: f.fn });
    await expect(repo.getTenant("t")).rejects.toBeInstanceOf(AccessDeniedError);
    const conflict = repo.updateTimeEntry("e-1", { note: "x" }, 1);
    await expect(conflict).rejects.toBeInstanceOf(ConflictError);
    await expect(repo.createTimeEntry("emp", { id: "e-2", date: "2026-10-01", start: "08:00", end: "09:00", pauseMinutes: 0, note: "" }))
      .rejects.toEqual(new ApiError(409, "overlap", "Einsätze überschneiden sich."));
    await expect(repo.listEmployees("t")).rejects.toBeInstanceOf(AccessDeniedError);
    const login = repo.signIn("a@b.example", "x");
    await expect(login).rejects.toBeInstanceOf(ApiError);
    await expect(login).rejects.toMatchObject({ message: "E-Mail-Adresse oder Passwort ist falsch." });
  });

  it("addresses known entries through their employee, unknown ones by id only", async () => {
    const entry = { id: "e-1", employeeId: "emp-1", version: 1 };
    const f = fakeFetch([{ status: 200, body: [entry] }, { status: 204 }, { status: 204 }]);
    const repo = createApiRepository("https://zeit.example", { fetch: f.fn });
    await repo.listTimeEntries("emp-1", "2026-10");
    await repo.deleteTimeEntry("e-1", 1, "Grund");
    await repo.deleteTimeEntry("e-9", 3);
    expect(f.calls[1]).toMatchObject({ url: "https://zeit.example/api/employees/emp-1/time-entries/e-1", init: { method: "DELETE", body: JSON.stringify({ expectedVersion: 1, reason: "Grund" }) } });
    expect(f.calls[2]!.url).toBe("https://zeit.example/api/time-entries/e-9");
  });

  it("401 → SessionExpiredError, 403 tenant_suspended → TenantSuspendedError, both reported to onAuthFailure", async () => {
    const f = fakeFetch([
      { status: 401, body: err("unauthenticated", "Bitte melde dich an.") },
      { status: 403, body: err("tenant_suspended", "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber.") },
      { status: 403, body: err("tenant_suspended", "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber.") },
    ]);
    const failures: AuthFailure[] = [];
    const repo = createApiRepository("", { fetch: f.fn, onAuthFailure: (x) => failures.push(x) });
    const expired = repo.listEmployees("t");
    await expect(expired).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(expired).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(repo.getTenant("t")).rejects.toBeInstanceOf(TenantSuspendedError);
    // At sign-in the message is shown in the form – no extra notification.
    await expect(repo.signIn("a@b.example", "x")).rejects.toMatchObject({ message: "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber." });
    expect(failures).toEqual([
      { kind: "expired", message: "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an." },
      { kind: "suspended", message: "Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber." },
    ]);
  });

  it("no connection → ApiError that the sync layer treats as network error (change stays queued)", async () => {
    const failing = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const repo = createApiRepository("", { fetch: failing });
    const e = await repo.listTimeEntries("emp", "2026-11").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).network).toBe(true);
    expect(isNetworkError(e)).toBe(true);
    expect(isNetworkError(new ApiError(400, "invalid", "x"))).toBe(false);
  });

  it("returns the invitation delivery info of the server", async () => {
    const f = fakeFetch([
      { status: 201, body: { id: "e-1", displayName: "X", invitation: { expiresAt: "2026-11-01T10:00:00.000Z", delivery: "email" } } },
      { status: 200, body: { invitationId: "i", expiresAt: "2026-11-02T10:00:00.000Z", delivery: "none" } },
    ]);
    const repo = createApiRepository("", { fetch: f.fn });
    const emp = await repo.inviteEmployee("t", { displayName: "X", personnelNumber: "1", email: "x@y.example", role: "employee" });
    expect(emp.invitation).toEqual({ expiresAt: "2026-11-01T10:00:00.000Z", delivery: "email" });
    expect(await repo.resendInvitation("e-1")).toEqual({ expiresAt: "2026-11-02T10:00:00.000Z", delivery: "none" });
  });

  it("two-factor: password step → TwoFactorRequiredError, verify without auth-failure callback, setup-required mapping", async () => {
    const failures: AuthFailure[] = [];
    const session = { userId: "u", email: "a@b.example", tenantId: null, employeeId: null, role: null, platformRole: "support" };
    const f = fakeFetch([
      { status: 200, body: { twoFactorRequired: true } },
      { status: 401, body: err("invalid_code", "Der Code ist ungültig oder abgelaufen.") },
      { status: 200, body: session },
      { status: 403, body: err("two_factor_setup_required", "Für dein Konto ist die Zwei-Faktor-Anmeldung vorgeschrieben.") },
      { status: 200, body: { recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] } },
      { status: 200, body: { setupRequired: true } },
    ]);
    const repo = createApiRepository("", { fetch: f.fn, onAuthFailure: (x) => failures.push(x) });
    await expect(repo.signIn("a@b.example", "pw")).rejects.toBeInstanceOf(TwoFactorRequiredError);
    await expect(repo.verifyTwoFactor({ code: "000000" })).rejects.toMatchObject({ status: 401, code: "invalid_code" });
    expect(failures).toEqual([]); // a wrong code is no expired session
    expect(await repo.verifyTwoFactor({ recoveryCode: "AAAA-BBBB-CCCC-DDDD" })).toEqual(session);
    await expect(repo.listTenants()).rejects.toBeInstanceOf(TwoFactorSetupRequiredError);
    expect(failures.map((x) => x.kind)).toEqual(["two_factor_setup"]);
    expect(await repo.confirmTwoFactorSetup("123456")).toEqual({ recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] });
    expect(await repo.disableTwoFactor("pw", { code: "123456" })).toEqual({ setupRequired: true });
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/auth/login", "POST /api/auth/2fa/verify", "POST /api/auth/2fa/verify", "GET /api/platform/tenants",
      "POST /api/auth/2fa/setup/confirm", "POST /api/auth/2fa/disable",
    ]);
    expect(f.calls[2]!.init.body).toBe(JSON.stringify({ recoveryCode: "AAAA-BBBB-CCCC-DDDD" }));
    expect(f.calls[5]!.init.body).toBe(JSON.stringify({ password: "pw", code: "123456" }));
  });
});

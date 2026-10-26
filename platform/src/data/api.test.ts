import { describe, expect, it } from "vitest";
import { ApiError, createApiRepository } from "./api";
import { AccessDeniedError, ConflictError } from "./repository";

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
});

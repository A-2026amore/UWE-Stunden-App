import { describe, expect, it } from "vitest";
import { loadLegacy } from "./support/load-legacy";

interface AccessApi {
  check(eid: string, force?: boolean): Promise<boolean>;
  clear(): void;
  isFresh(eid: string): boolean;
}

function setup(responder: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const fetch = async (url: unknown) => {
    calls.push(String(url));
    const { status, body } = responder(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const api = loadLegacy(["uwe-access-check.js"], { fetch }).window.UweAccessControl as AccessApi;
  return { api, calls };
}

describe("UweAccessControl (revocation list check)", () => {
  it("allows a non-revoked employee and caches the result briefly", async () => {
    const { api, calls } = setup(() => ({ status: 200, body: { version: 1, revoked: ["E0001"] } }));
    await expect(api.check("E1001")).resolves.toBe(true);
    expect(api.isFresh("E1001")).toBe(true);
    await api.check("E1001");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/uwe-access-control\.json\?_check=\d+/);
    await api.check("E1001", true);
    expect(calls).toHaveLength(2);
  });

  it("rejects a revoked employee case-insensitively with code UWE_REVOKED", async () => {
    const { api } = setup(() => ({ status: 200, body: { version: 1, revoked: ["e1001"] } }));
    await expect(api.check("E1001")).rejects.toMatchObject({ code: "UWE_REVOKED" });
    expect(api.isFresh("E1001")).toBe(false);
  });

  it("treats an invalid list as an error, not as 'nobody revoked'", async () => {
    const { api } = setup(() => ({ status: 200, body: { version: 2, revoked: [] } }));
    await expect(api.check("E1001")).rejects.toMatchObject({ code: "CHECK_ERROR" });
  });

  it("fails closed when offline", async () => {
    const api = loadLegacy(["uwe-access-check.js"]).window.UweAccessControl as AccessApi;
    await expect(api.check("E1001")).rejects.toMatchObject({ code: "CHECK_OFFLINE" });
  });

  it("falls back to the GitHub contents API on 404", async () => {
    const content = Buffer.from(JSON.stringify({ version: 1, revoked: ["E1001"] })).toString("base64");
    const { api, calls } = setup((url) =>
      new URL(url).hostname === "api.github.com" ? { status: 200, body: { content } } : { status: 404, body: null },
    );
    await expect(api.check("E1001")).rejects.toMatchObject({ code: "UWE_REVOKED" });
    expect(calls[1]).toMatch(/^https:\/\/api\.github\.com\/repos\/.+uwe-access-control\.json/);
  });

  it("rejects malformed personnel numbers before any network call", async () => {
    const { api, calls } = setup(() => ({ status: 200, body: { version: 1, revoked: [] } }));
    await expect(api.check("E 1")).rejects.toMatchObject({ code: "CHECK_ERROR" });
    expect(calls).toHaveLength(0);
  });
});

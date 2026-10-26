/**
 * STATIC_DIR: the API serves the built frontend; /api stays the API.
 * Also: invitation responses tell the chef how the mail was delivered (never the link).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, ORIGIN, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
let dir: string;
let outside: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "static-root-"));
  outside = mkdtempSync(join(tmpdir(), "static-outside-"));
  writeFileSync(join(outside, "secret.txt"), "geheim");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Start</title>");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "index.html"), "<!doctype html><title>App</title>");
  writeFileSync(join(dir, "app", "sw.js"), "self.addEventListener('fetch', () => {});");
  mkdirSync(join(dir, "passwort-neu"));
  writeFileSync(join(dir, "passwort-neu", "index.html"), "<!doctype html><title>Reset</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "employee-C9h7_Rzi.js"), "console.log(1);");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  t = await startTestServer({ STATIC_DIR: dir });
});

afterAll(async () => {
  await t?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const get = (path: string, init: RequestInit = {}) => fetch(t.url + path, { redirect: "manual", ...init });

describe("STATIC_DIR", () => {
  it("serves pages with a strict CSP and revalidation", async () => {
    const r = await get("/app/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>App</title>");
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get("/")).status).toBe(200);
    expect((await get("/app/sw.js")).headers.get("cache-control")).toBe("no-cache");
  });

  it("hashed assets are immutable", async () => {
    const r = await get("/assets/employee-C9h7_Rzi.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("redirects e-mail link paths to the directory (the #token fragment stays in the browser)", async () => {
    const r = await get("/passwort-neu");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/passwort-neu/");
    expect((await get("/passwort-neu/")).status).toBe(200);
  });

  it("never serves hidden files, traversal or symlinks out of the root", async () => {
    expect((await get("/.env")).status).toBe(404);
    expect((await get("/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
    expect((await get("/app/%2e%2e%2f%2e%2e%2fetc/passwd")).status).toBe(404);
    expect((await get("/link.txt")).status).toBe(404);
    expect((await get("/fehlt.html")).status).toBe(404);
    expect((await get("/app/", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" })).status).toBe(405);
  });

  it("/api stays the API with its own headers", async () => {
    const r = await get("/api/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await get("/api/gibt-es-nicht")).status).toBe(404);
  });
});

describe("invitation delivery info", () => {
  it("new employee with e-mail: expiry and delivery, but no token or link in the response", async () => {
    const cookie = await t.login("ownerA");
    const r = await t.call("POST", `/api/tenants/${IDS.tenantA}/employees`, {
      cookie, body: { displayName: "Statisch Test", personnelNumber: "S-1", email: "statisch@demo-krankentransporte.example", role: "employee" },
    });
    expect(r.status).toBe(201);
    expect(r.body.invitation.delivery).toBe("log");
    expect(Date.parse(r.body.invitation.expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(r.body)).not.toMatch(/token|#/);
    const again = await t.call("POST", `/api/employees/${r.body.id}/invitation`, { cookie, body: {} });
    expect(again.status).toBe(200);
    expect(again.body.delivery).toBe("log");
    expect(JSON.stringify(again.body)).not.toMatch(/token/);

    const noMail = await t.call("POST", `/api/tenants/${IDS.tenantA}/employees`, {
      cookie, body: { displayName: "Ohne Mail", personnelNumber: "S-2", email: null, role: "employee" },
    });
    expect(noMail.status).toBe(201);
    expect(noMail.body.invitation).toBeUndefined();
  });
});

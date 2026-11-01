/**
 * Account-wide rate limits (security review 2026-10-28): failed logins and
 * password-reset requests are also counted per e-mail address across all
 * client IPs, so a distributed attack (many IPs, one account) is throttled.
 * Unknown addresses are limited the same way (no account enumeration).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS, ORIGIN, PASSWORD, startTestServer, type TestServer } from "./support/server.ts";

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer({
    // The test client is the proxy: X-Forwarded-For names a different client IP per request.
    TRUST_PROXY: "1",
    RATE_LIMIT_LOGIN_PER_EMAIL: "3",
    RATE_LIMIT_RESET_PER_EMAIL: "2",
  });
});
afterAll(async () => {
  await t?.close();
});

let ipCounter = 10;
async function from(path: string, body: unknown): Promise<number> {
  const r = await fetch(t.url + path, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${ipCounter++}` },
    body: JSON.stringify(body),
  });
  await r.arrayBuffer();
  return r.status;
}

describe("login, per e-mail across IPs", () => {
  it("blocks the account after the limit even when every attempt comes from a new IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push(await from("/api/auth/login", { email: EMAILS.emp1A, password: `falsch-${i}-xxxxxxxx` }));
    expect(statuses).toEqual([401, 401, 401, 429]);
    // Also the correct password is refused while the block lasts (no guessing around it).
    expect(await from("/api/auth/login", { email: EMAILS.emp1A, password: PASSWORD })).toBe(429);
    // Other accounts are not affected.
    expect(await from("/api/auth/login", { email: EMAILS.emp2A, password: PASSWORD })).toBe(200);
  });

  it("treats unknown addresses the same way (no enumeration)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push(await from("/api/auth/login", { email: "niemand@unbekannt.example", password: "falsch-xxxxxxxx" }));
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it("the block ends with the window (reset of the limiter)", async () => {
    t.resetRateLimits();
    expect(await from("/api/auth/login", { email: EMAILS.emp1A, password: PASSWORD })).toBe(200);
  });
});

describe("password reset, per e-mail across IPs", () => {
  it("limits mails to one address", async () => {
    const before = t.mails.length;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push(await from("/api/auth/password-reset", { email: EMAILS.emp2A }));
    expect(statuses).toEqual([204, 204, 429]);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.mails.length - before).toBe(2);
  });
});

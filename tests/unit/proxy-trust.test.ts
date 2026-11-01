import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config.ts";
import { clientIp, createProxyMatcher } from "../../server/src/http.ts";

function req(remoteAddress: string, xff?: string): IncomingMessage {
  return { socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } } as unknown as IncomingMessage;
}

describe("X-Forwarded-For trust (TRUST_PROXY / TRUST_PROXY_CIDRS)", () => {
  it("ignores X-Forwarded-For without TRUST_PROXY", () => {
    expect(clientIp(req("172.18.0.5", "203.0.113.9"), false)).toBe("172.18.0.5");
  });

  it("keeps the previous behaviour with TRUST_PROXY=1 and no networks", () => {
    expect(clientIp(req("172.18.0.5", "198.51.100.1, 203.0.113.9"), true)).toBe("203.0.113.9");
  });

  it("only trusts peers inside the configured networks", () => {
    const nets = ["172.18.0.0/16", "fd00::/8"];
    expect(clientIp(req("172.18.0.5", "203.0.113.9"), true, nets)).toBe("203.0.113.9");
    expect(clientIp(req("::ffff:172.18.3.4", "203.0.113.9"), true, nets)).toBe("203.0.113.9");
    expect(clientIp(req("fd00::2", "203.0.113.9"), true, nets)).toBe("203.0.113.9");
    // A container in another network cannot pick an arbitrary address (rate-limit bypass).
    expect(clientIp(req("172.19.0.7", "203.0.113.9"), true, nets)).toBe("172.19.0.7");
    expect(clientIp(req("10.0.0.1", "203.0.113.9"), true, nets)).toBe("10.0.0.1");
  });

  it("matches single addresses and rejects invalid networks", () => {
    const m = createProxyMatcher(["10.1.2.3"]);
    expect(m("10.1.2.3")).toBe(true);
    expect(m("10.1.2.4")).toBe(false);
    expect(m(undefined)).toBe(false);
    for (const bad of ["172.18.0.0/33", "abc", "10.0.0.0/8/1", "10.0.0.0/x"]) {
      expect(() => createProxyMatcher([bad])).toThrow(/TRUST_PROXY_CIDRS/);
    }
  });

  it("is read from the environment and validated at start", () => {
    const base = { DATABASE_URL: "postgres://x" };
    expect(loadConfig(base).trustedProxies).toEqual([]);
    expect(loadConfig({ ...base, TRUST_PROXY: "1", TRUST_PROXY_CIDRS: " 172.18.0.0/16, 10.0.0.1 " }).trustedProxies).toEqual(["172.18.0.0/16", "10.0.0.1"]);
    expect(() => loadConfig({ ...base, TRUST_PROXY_CIDRS: "kaputt" })).toThrow(/TRUST_PROXY_CIDRS/);
  });
});

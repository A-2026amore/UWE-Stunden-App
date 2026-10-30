import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base32Decode, base32Encode, constantTimeEqual, formatRecoveryCode, generateRecoveryCode, groupSecret, hmacSha1, hotp,
  matchTotpStep, normalizeRecoveryCode, normalizeTotpCode, otpauthUri, RECOVERY_ALPHABET, sha1, timeStep, totp,
} from "./totp";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const nodeHmac = (key: Uint8Array, msg: Uint8Array) => new Uint8Array(createHmac("sha1", key).update(msg).digest());

describe("Base32 (RFC 4648, section 10 test vectors)", () => {
  const vectors: Array<[string, string]> = [
    ["", ""], ["f", "MY======"], ["fo", "MZXQ===="], ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI======"],
  ];
  it.each(vectors)("%j ↔ %s", (plain, encoded) => {
    expect(base32Encode(enc(plain), true)).toBe(encoded);
    expect(base32Encode(enc(plain))).toBe(encoded.replace(/=+$/, ""));
    expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain);
  });

  it("decodes case-insensitively and ignores spaces/hyphens; rejects other characters", () => {
    expect(new TextDecoder().decode(base32Decode("mzxw 6ytb-oi"))).toBe("foobar");
    expect(() => base32Decode("MZXW1")).toThrow("Base32");
    expect(() => base32Decode("MZ=XW")).toThrow();
  });

  it("round-trips random secrets", () => {
    for (let i = 0; i < 50; i++) {
      const b = new Uint8Array(randomBytes(1 + (i % 32)));
      expect(hex(base32Decode(base32Encode(b)))).toBe(hex(b));
    }
  });
});

describe("SHA-1 and HMAC-SHA-1 (pure JS)", () => {
  it("matches the FIPS 180 examples and Node's crypto", () => {
    expect(hex(sha1(enc("abc")))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(hex(sha1(enc("")))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(hex(sha1(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      const m = new Uint8Array(randomBytes(n));
      expect(hex(sha1(m))).toBe(createHash("sha1").update(m).digest("hex"));
    }
  });

  it("HMAC matches RFC 2202 and Node's crypto (incl. keys longer than a block)", () => {
    expect(hex(hmacSha1(new Uint8Array(20).fill(0x0b), enc("Hi There")))).toBe("b617318655057264e28bc0b6fb378c8ef146be00");
    expect(hex(hmacSha1(enc("Jefe"), enc("what do ya want for nothing?")))).toBe("effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    for (const n of [1, 20, 64, 65, 100]) {
      const k = new Uint8Array(randomBytes(n));
      const m = new Uint8Array(randomBytes(n * 3));
      expect(hex(hmacSha1(k, m))).toBe(hex(nodeHmac(k, m)));
    }
  });
});

describe("HOTP (RFC 4226, appendix D)", () => {
  const key = enc("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it.each(expected.map((c, i) => [i, c] as const))("counter %i → %s", (counter, code) => {
    expect(hotp(key, counter)).toBe(code);
    expect(hotp(key, counter, 6, nodeHmac)).toBe(code);
  });
});

describe("TOTP (RFC 6238, appendix B, SHA-1)", () => {
  const key = enc("12345678901234567890");
  const vectors: Array<[number, string, string]> = [
    [59, "0000000000000001", "94287082"],
    [1111111109, "00000000023523EC", "07081804"],
    [1111111111, "00000000023523ED", "14050471"],
    [1234567890, "000000000273EF07", "89005924"],
    [2000000000, "0000000003F940AA", "69279037"],
    [20000000000, "0000000027BC86AA", "65353130"],
  ];
  it.each(vectors)("T=%i (step %s) → %s", (seconds, stepHex, code) => {
    expect(timeStep(seconds * 1000)).toBe(parseInt(stepHex, 16));
    expect(totp(key, seconds * 1000, { digits: 8 })).toBe(code);
    expect(totp(key, seconds * 1000, { digits: 8, hmac: nodeHmac })).toBe(code);
    // 6-digit codes are the last six digits of the same truncated value.
    expect(totp(key, seconds * 1000)).toBe(code.slice(2));
  });

  it("accepts the previous, current and next step – nothing else", () => {
    const now = 1_800_000_000_000;
    const step = timeStep(now);
    expect(matchTotpStep(key, hotp(key, step), now)).toBe(step);
    expect(matchTotpStep(key, hotp(key, step - 1), now)).toBe(step - 1);
    expect(matchTotpStep(key, hotp(key, step + 1), now)).toBe(step + 1);
    expect(matchTotpStep(key, hotp(key, step - 2), now)).toBeNull();
    expect(matchTotpStep(key, hotp(key, step + 2), now)).toBeNull();
    expect(matchTotpStep(key, "000000", now, { window: 0 }) === step).toBe(hotp(key, step) === "000000");
  });

  it("rejects invalid counters and digit counts", () => {
    expect(() => hotp(key, -1)).toThrow();
    expect(() => hotp(key, 1.5)).toThrow();
    expect(() => hotp(key, 1, 5)).toThrow();
  });
});

describe("codes and provisioning", () => {
  it("normalises 6-digit codes", () => {
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
    expect(normalizeTotpCode("123-456")).toBe("123456");
    for (const bad of ["12345", "1234567", "12345a", "", null, 123456, "1".repeat(30)]) expect(normalizeTotpCode(bad)).toBeNull();
  });

  it("generates unbiased recovery codes in groups of four and normalises input", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateRecoveryCode((n) => new Uint8Array(randomBytes(n)));
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const ch of c.replace(/-/g, "")) expect(RECOVERY_ALPHABET).toContain(ch);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
    // Bytes ≥ 240 are skipped (no modulo bias): 255 would map to "Z" otherwise.
    let calls = 0;
    const c = generateRecoveryCode((n) => { calls++; return new Uint8Array(n).fill(calls === 1 ? 255 : 0); });
    expect(c).toBe("AAAA-AAAA-AAAA-AAAA");
    expect(calls).toBe(2);
    expect(normalizeRecoveryCode("abcd efgh-jkmn pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeRecoveryCode("ABCD-EFGH-JKMN-PQR0")).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRecoveryCode("ABCD-EFGH")).toBeNull();
    expect(formatRecoveryCode("ABCDEFGHJKMNPQRS")).toBe("ABCD-EFGH-JKMN-PQRS");
  });

  it("builds the otpauth URI and groups the secret", () => {
    const uri = otpauthUri({ issuer: "Schichtklar24", account: "chef+test@demo.example", secret: "JBSWY3DPEHPK3PXP" });
    expect(uri).toBe("otpauth://totp/Schichtklar24:chef%2Btest%40demo.example?secret=JBSWY3DPEHPK3PXP&issuer=Schichtklar24&algorithm=SHA1&digits=6&period=30");
    expect(groupSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  });

  it("compares in constant time (semantics)", () => {
    expect(constantTimeEqual("123456", "123456")).toBe(true);
    expect(constantTimeEqual("123456", "123457")).toBe(false);
    expect(constantTimeEqual("12345", "123456")).toBe(false);
  });
});

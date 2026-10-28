/**
 * Time-based one-time passwords (TOTP, RFC 6238 on top of HOTP, RFC 4226)
 * and the helpers around them – shared by the Node API (server/src/twoFactor.ts)
 * and the in-browser demo repository.
 *
 * Fixed parameters (what every authenticator app understands):
 * HMAC-SHA-1, 6 digits, 30-second steps, accepted window ±1 step.
 *
 * No dependencies: Base32 (RFC 4648) and SHA-1/HMAC are implemented here so
 * the demo also works without Web Crypto. The server passes Node's
 * crypto.createHmac as `hmac` instead of the pure-JS version.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accepted clock drift in steps (±1 → previous, current and next code). */
export const TOTP_WINDOW = 1;
/** 160-bit secrets as recommended by RFC 4226. */
export const TOTP_SECRET_BYTES = 20;
export const RECOVERY_CODE_COUNT = 10;

export type HmacSha1 = (key: Uint8Array, message: Uint8Array) => Uint8Array;

// ------------------------------------------------------------------ Base32 (RFC 4648)

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 without padding by default (otpauth:// URIs omit "="). */
export function base32Encode(bytes: Uint8Array, padding = false): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  if (padding) while (out.length % 8 !== 0) out += "=";
  return out;
}

/** Case-insensitive; spaces, hyphens and trailing "=" are ignored. Throws on other characters. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B32_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("Ungültiges Base32-Zeichen.");
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------ SHA-1 / HMAC (pure JS)

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

/** SHA-1 (FIPS 180-4). Only used for HMAC in TOTP, where SHA-1 is still secure. */
export function sha1(message: Uint8Array): Uint8Array {
  const ml = message.length;
  const withPadding = ((ml + 9 + 63) >> 6) << 6;
  const data = new Uint8Array(withPadding);
  data.set(message);
  data[ml] = 0x80;
  const view = new DataView(data.buffer);
  const bitLen = ml * 8;
  view.setUint32(withPadding - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(withPadding - 4, bitLen >>> 0);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPadding; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h >>> 0));
  return out;
}

/** HMAC-SHA-1 (RFC 2104). */
export const hmacSha1: HmacSha1 = (key, message) => {
  const block = 64;
  let k = key.length > block ? sha1(key) : key;
  const padded = new Uint8Array(block);
  padded.set(k);
  k = padded;
  const inner = new Uint8Array(block + message.length);
  const outer = new Uint8Array(block + 20);
  for (let i = 0; i < block; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(message, block);
  outer.set(sha1(inner), block);
  return sha1(outer);
};

// ------------------------------------------------------------------ HOTP / TOTP

/** HOTP value (RFC 4226) for a counter, as zero-padded decimal string. */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS, hmac: HmacSha1 = hmacSha1): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Ungültiger Zähler.");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error("Ungültige Stellenzahl.");
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const mac = hmac(key, msg);
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Time step for a point in time (milliseconds since the epoch). */
export function timeStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  hmac?: HmacSha1;
}

/** TOTP value (RFC 6238) at a point in time. */
export function totp(key: Uint8Array, nowMs: number, o: TotpOptions = {}): string {
  return hotp(key, timeStep(nowMs, o.period ?? TOTP_PERIOD_SECONDS), o.digits ?? TOTP_DIGITS, o.hmac ?? hmacSha1);
}

/**
 * Finds the step (current ±window) whose code matches. All candidates are
 * always computed and compared with `equal` (constant time on the server) –
 * the result does not depend on which candidate matched first.
 */
export function matchTotpStep(
  key: Uint8Array, code: string, nowMs: number,
  o: { window?: number; hmac?: HmacSha1; equal?: (a: string, b: string) => boolean } = {},
): number | null {
  const window = o.window ?? TOTP_WINDOW;
  const equal = o.equal ?? constantTimeEqual;
  const now = timeStep(nowMs);
  let found: number | null = null;
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (step < 0) continue;
    const ok = equal(hotp(key, step, TOTP_DIGITS, o.hmac ?? hmacSha1), code);
    if (ok && found === null) found = step;
  }
  return found;
}

/** Constant-time string comparison for equal-length ASCII strings (browser fallback). */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ------------------------------------------------------------------ input normalisation

/** "123 456" / "123-456" → "123456"; null when it is not a 6-digit code. */
export function normalizeTotpCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 20) return null;
  const s = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(s) ? s : null;
}

/** Recovery codes: 16 characters without easily confused ones (no 0/O, 1/I/L, U). */
export const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const RECOVERY_LENGTH = 16;

/** Builds one recovery code from a source of random bytes (rejection sampling, no modulo bias). */
export function generateRecoveryCode(randomBytes: (n: number) => Uint8Array): string {
  let raw = "";
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  while (raw.length < RECOVERY_LENGTH) {
    for (const b of randomBytes(RECOVERY_LENGTH * 2)) {
      if (b < limit && raw.length < RECOVERY_LENGTH) raw += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    }
  }
  return formatRecoveryCode(raw);
}

/** "ABCDEFGHJKMNPQRS" → "ABCD-EFGH-JKMN-PQRS". */
export function formatRecoveryCode(raw: string): string {
  return raw.match(/.{1,4}/g)!.join("-");
}

/** Accepts lower case, spaces and hyphens; null when it cannot be a recovery code. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const s = input.replace(/[\s-]/g, "").toUpperCase();
  if (s.length !== RECOVERY_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}

// ------------------------------------------------------------------ provisioning

/**
 * otpauth:// URI (Key Uri Format used by Google Authenticator, Microsoft
 * Authenticator, FreeOTP, Aegis, 1Password, …).
 */
export function otpauthUri(o: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  const params = [
    `secret=${o.secret}`,
    `issuer=${encodeURIComponent(o.issuer)}`,
    "algorithm=SHA1",
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ];
  return `otpauth://totp/${label}?${params.join("&")}`;
}

/** Secret for manual entry in groups of four: "ABCD EFGH …". */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(" ");
}

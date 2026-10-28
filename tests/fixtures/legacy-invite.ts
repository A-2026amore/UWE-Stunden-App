/**
 * Test-only re-implementation of the legacy invite signing (chef-mobil.js → signCredential)
 * and the employee-side PIN hash. Uses freshly generated TEST keys only – never the production key.
 *
 * Code format:  base64url(JSON payload) + "." + base64url(ECDSA P-256 / SHA-256 signature over the first part)
 * Payload:      { v: 1, eid, name, exp: "YYYY-MM-DD", salt: base64url(16 bytes), pinHash: hex(PBKDF2-SHA-256, 100000 it., 256 bit) }
 */
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export interface TestKeyPair {
  privateKey: webcrypto.CryptoKey;
  publicJwk: webcrypto.JsonWebKey;
  privateJwk: webcrypto.JsonWebKey;
}

export async function generateTestKeyPair(): Promise<TestKeyPair> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    privateKey: pair.privateKey,
    publicJwk: await subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function importPrivateJwk(jwk: webcrypto.JsonWebKey): Promise<webcrypto.CryptoKey> {
  return subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function pinHash(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface InviteInput {
  eid: string;
  name: string;
  pin: string;
  /** Expiry date YYYY-MM-DD (the legacy app compares it with the local date as a string). */
  exp: string;
  /** Optional fixed salt for reproducible fixtures. */
  salt?: Uint8Array<ArrayBuffer>;
}

/** Builds a signed invite code exactly like chef-mobil.js signCredential (without its input guards). */
export async function signInvite(privateKey: webcrypto.CryptoKey, input: InviteInput): Promise<string> {
  const salt = input.salt ?? webcrypto.getRandomValues(new Uint8Array(16));
  const payload = { v: 1, eid: input.eid, name: input.name, exp: input.exp, salt: b64url(salt), pinHash: await pinHash(input.pin, salt) };
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(body));
  return body + "." + b64url(signature);
}

export function inviteLink(origin: string, code: string): string {
  return new URL("./index.html", origin + "/").href + "?code=" + encodeURIComponent(code);
}

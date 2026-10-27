/**
 * Server configuration, read exclusively from environment variables.
 * Secrets (database password, SMTP password, TOTP key) are never logged.
 */
import { createHash } from "node:crypto";
import { createProxyMatcher } from "./http.ts";

export interface SmtpConfig {
  host: string;
  port: number;
  /** "implicit" = TLS from the start (port 465), "starttls" = upgrade (port 587), "none" = plain text (local relay/tests only). */
  tls: "implicit" | "starttls" | "none";
  user: string | null;
  password: string | null;
  from: string;
  /** Skip certificate verification – never in production. */
  rejectUnauthorized: boolean;
}

export interface RateLimitConfig {
  windowMs: number;
  /** Failed logins per IP + e-mail within the window. */
  loginPerKey: number;
  /** Login attempts per IP within the window (all e-mails). */
  loginPerIp: number;
  /** Password-reset requests per IP + e-mail within the window. */
  resetPerKey: number;
  /** Password-reset / invitation token submissions per IP within the window. */
  tokenPerIp: number;
  /** Wrong two-factor codes per account within the window (sign-in, setup, disable). */
  twoFactorPerAccount: number;
  /** Two-factor code submissions per IP within the window. */
  twoFactorPerIp: number;
}

export interface TotpKey {
  /** First 8 hex chars of SHA-256 over the key – stored with every ciphertext. */
  id: string;
  key: Buffer;
}

export interface TwoFactorConfig {
  /** keys[0] encrypts; all keys decrypt (rotation: TOTP_ENCRYPTION_KEY_PREVIOUS). */
  keys: TotpKey[];
  /** True when no key was configured outside production (fixed development key). */
  developmentKey: boolean;
  /** Name shown in the authenticator app. */
  issuer: string;
}

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  production: boolean;
  /** Allowed browser origins (CORS + CSRF origin check). The first one is used for links in e-mails. */
  publicOrigins: string[];
  secureCookies: boolean;
  /** Trust the X-Forwarded-For header of the local reverse proxy (Caddy). */
  trustProxy: boolean;
  /** TRUST_PROXY_CIDRS: only peers from these networks may set X-Forwarded-For (empty = any peer). */
  trustedProxies: string[];
  sessionTtlHours: number;
  sessionIdleMinutes: number;
  smtp: SmtpConfig | null;
  /** Path appended to the public origin for password-reset links; the token follows as URL fragment. */
  resetLinkPath: string;
  inviteLinkPath: string;
  rateLimit: RateLimitConfig;
  /** Built frontend (platform/dist) served by the API itself; null = API only (e.g. Caddy serves the files). */
  staticDir: string | null;
  twoFactor: TwoFactorConfig;
}

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Umgebungsvariable ${name} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return n;
}

function parseOrigin(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`PUBLIC_ORIGIN enthält keine gültige Adresse: ${value}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("PUBLIC_ORIGIN muss mit http:// oder https:// beginnen.");
  return u.origin;
}

/** 32-byte key as base64 (44 characters) or hex (64 characters). */
export function parseTotpKey(raw: string, name: string): TotpKey {
  const v = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) key = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!key || key.length !== 32) {
    throw new Error(`${name} muss ein 32-Byte-Schlüssel sein (64 Hex-Zeichen oder Base64), z. B. erzeugt mit: openssl rand -base64 32`);
  }
  return { id: totpKeyId(key), key };
}

export function totpKeyId(key: Buffer): string {
  return createHash("sha256").update("stundenwerk-totp-key-id:").update(key).digest("hex").slice(0, 8);
}

/** Fixed key for local development and tests only – never accepted in production. */
const DEVELOPMENT_TOTP_KEY = createHash("sha256").update("stundenwerk-entwicklung-totp-schluessel-NICHT-PRODUKTIV").digest();

function loadTwoFactor(env: NodeJS.ProcessEnv, production: boolean): TwoFactorConfig {
  const raw = env.TOTP_ENCRYPTION_KEY ?? "";
  let keys: TotpKey[];
  let developmentKey = false;
  if (raw) keys = [parseTotpKey(raw, "TOTP_ENCRYPTION_KEY")];
  else if (production) throw new Error("TOTP_ENCRYPTION_KEY fehlt (32 Byte, z. B. openssl rand -base64 32). Ohne Schlüssel ist keine Zwei-Faktor-Anmeldung möglich.");
  else {
    keys = [{ id: totpKeyId(DEVELOPMENT_TOTP_KEY), key: DEVELOPMENT_TOTP_KEY }];
    developmentKey = true;
  }
  for (const part of (env.TOTP_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const k = parseTotpKey(part, "TOTP_ENCRYPTION_KEY_PREVIOUS");
    if (!keys.some((x) => x.id === k.id)) keys.push(k);
  }
  const issuer = (env.TOTP_ISSUER ?? "Stundenwerk").trim();
  if (!/^[^:]{1,40}$/.test(issuer)) throw new Error("TOTP_ISSUER: 1–40 Zeichen, ohne Doppelpunkt.");
  return { keys, developmentKey, issuer };
}

function parseTrustedProxies(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  createProxyMatcher(list); // validates, throws with a German message
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL fehlt (Verbindung als Rolle app_api).");

  const originsRaw = env.PUBLIC_ORIGIN ?? (production ? "" : "http://localhost:5173");
  if (!originsRaw) throw new Error("PUBLIC_ORIGIN fehlt (z. B. https://zeit.example.de).");
  const publicOrigins = originsRaw.split(",").map((s) => s.trim()).filter(Boolean).map(parseOrigin);
  if (production && publicOrigins.some((o) => !o.startsWith("https://"))) {
    throw new Error("In Produktion muss PUBLIC_ORIGIN mit https:// beginnen.");
  }

  let smtp: SmtpConfig | null = null;
  if (env.SMTP_HOST) {
    const tls = (env.SMTP_TLS ?? "starttls") as SmtpConfig["tls"];
    if (!["implicit", "starttls", "none"].includes(tls)) throw new Error("SMTP_TLS muss implicit, starttls oder none sein.");
    if (tls === "none" && production) throw new Error("SMTP_TLS=none ist in Produktion nicht erlaubt.");
    const from = env.SMTP_FROM ?? "";
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(from)) throw new Error("SMTP_FROM muss eine E-Mail-Adresse sein.");
    smtp = {
      host: env.SMTP_HOST,
      port: int(env, "SMTP_PORT", tls === "implicit" ? 465 : 587, 1, 65535),
      tls,
      user: env.SMTP_USER || null,
      password: env.SMTP_PASSWORD || null,
      from,
      rejectUnauthorized: production || env.SMTP_INSECURE_TLS !== "1",
    };
  }

  return {
    databaseUrl,
    host: env.HOST ?? "127.0.0.1",
    port: int(env, "PORT", 3000, 0, 65535),
    production,
    publicOrigins,
    secureCookies: production || publicOrigins[0]!.startsWith("https://"),
    trustProxy: env.TRUST_PROXY === "1",
    trustedProxies: parseTrustedProxies(env.TRUST_PROXY_CIDRS),
    sessionTtlHours: int(env, "SESSION_TTL_HOURS", 12, 1, 24 * 30),
    sessionIdleMinutes: int(env, "SESSION_IDLE_MINUTES", 120, 5, 24 * 60),
    smtp,
    staticDir: env.STATIC_DIR ? env.STATIC_DIR : null,
    resetLinkPath: env.RESET_LINK_PATH ?? "/passwort-neu",
    inviteLinkPath: env.INVITE_LINK_PATH ?? "/einladung",
    rateLimit: {
      windowMs: int(env, "RATE_LIMIT_WINDOW_MINUTES", 15, 1, 24 * 60) * 60_000,
      loginPerKey: int(env, "RATE_LIMIT_LOGIN_PER_ACCOUNT", 5, 1, 1000),
      loginPerIp: int(env, "RATE_LIMIT_LOGIN_PER_IP", 100, 1, 100000),
      resetPerKey: int(env, "RATE_LIMIT_RESET_PER_ACCOUNT", 3, 1, 1000),
      tokenPerIp: int(env, "RATE_LIMIT_TOKEN_PER_IP", 20, 1, 100000),
      twoFactorPerAccount: int(env, "RATE_LIMIT_2FA_PER_ACCOUNT", 5, 1, 1000),
      twoFactorPerIp: int(env, "RATE_LIMIT_2FA_PER_IP", 50, 1, 100000),
    },
    twoFactor: loadTwoFactor(env, production),
  };
}

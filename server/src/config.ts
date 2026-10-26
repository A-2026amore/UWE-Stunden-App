/**
 * Server configuration, read exclusively from environment variables.
 * Secrets (database password, SMTP password) are never logged.
 */

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
  sessionTtlHours: number;
  sessionIdleMinutes: number;
  smtp: SmtpConfig | null;
  /** Path appended to the public origin for password-reset links; the token follows as URL fragment. */
  resetLinkPath: string;
  inviteLinkPath: string;
  rateLimit: RateLimitConfig;
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
    sessionTtlHours: int(env, "SESSION_TTL_HOURS", 12, 1, 24 * 30),
    sessionIdleMinutes: int(env, "SESSION_IDLE_MINUTES", 120, 5, 24 * 60),
    smtp,
    resetLinkPath: env.RESET_LINK_PATH ?? "/passwort-neu",
    inviteLinkPath: env.INVITE_LINK_PATH ?? "/einladung",
    rateLimit: {
      windowMs: int(env, "RATE_LIMIT_WINDOW_MINUTES", 15, 1, 24 * 60) * 60_000,
      loginPerKey: int(env, "RATE_LIMIT_LOGIN_PER_ACCOUNT", 5, 1, 1000),
      loginPerIp: int(env, "RATE_LIMIT_LOGIN_PER_IP", 100, 1, 100000),
      resetPerKey: int(env, "RATE_LIMIT_RESET_PER_ACCOUNT", 3, 1, 1000),
      tokenPerIp: int(env, "RATE_LIMIT_TOKEN_PER_IP", 20, 1, 100000),
    },
  };
}

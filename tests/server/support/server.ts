/**
 * Starts the real API on a random port against a throwaway PostgreSQL
 * (tests/db/support/harness.ts: initdb cluster or DATABASE_URL), with
 * migrations + seed applied and demo passwords set through the regular auth
 * functions (create_password_reset + reset_password). Mails are captured.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { setupTestDb, IDS, type TestDb } from "../../db/support/harness.ts";
import { createApp } from "../../../server/src/app.ts";
import { loadConfig } from "../../../server/src/config.ts";
import { createPool } from "../../../server/src/db.ts";
import { setPasswordViaReset } from "../../../server/src/auth.ts";
import type { Mail } from "../../../server/src/mailer.ts";
import { nodeHmacSha1 } from "../../../server/src/twoFactor.ts";
import { base32Decode, hotp, timeStep } from "../../../platform/src/security/totp.ts";

export { IDS };
export const ORIGIN = "https://zeit.test.example";
/** Test-only TOTP key (32 bytes, base64). */
export const TOTP_TEST_KEY = "bnVyLWZ1ZXItdGVzdHMtdG90cC1zY2hsdWVzc2VsISE=";
export const PASSWORD = "Demo-Passwort-nur-Test-1";

export const EMAILS = {
  ownerA: "inhaber@demo-krankentransporte.example",
  managerA: "leitung@demo-krankentransporte.example",
  emp1A: "fahrer1@demo-krankentransporte.example",
  emp2A: "fahrer2@demo-krankentransporte.example",
  ownerB: "inhaberin@muster-pflegedienst.example",
  empB: "pflege1@muster-pflegedienst.example",
  invitedB: "pflege2@muster-pflegedienst.example",
  superAdmin: "superadmin@plattform.example",
  support: "support@plattform.example",
} as const;
export type Who = Exclude<keyof typeof EMAILS, "invitedB">;

export interface CallOptions {
  body?: unknown;
  cookie?: string | null;
  /** null = send no Origin header. */
  origin?: string | null;
  contentType?: string | null;
  rawBody?: string;
}

/** Response bodies are asserted field by field in the tests, so they are typed loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBody = any;

export interface CallResult<T = AnyBody> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestServer {
  url: string;
  db: TestDb;
  pool: pg.Pool;
  mails: Mail[];
  call<T = AnyBody>(method: string, path: string, o?: CallOptions): Promise<CallResult<T>>;
  /**
   * Signs in and returns "name=value" of the session cookie. Handles 2FA:
   * enrolled accounts get a code from the stored secret; accounts that must
   * set up 2FA (platform staff) are enrolled automatically unless
   * `enroll: false`.
   */
  login(who: Who | string, password?: string, opts?: { enroll?: boolean }): Promise<string>;
  /** TOTP secrets (base32) of the accounts enrolled through this server, by e-mail. */
  secrets: Map<string, string>;
  /** Enrols the signed-in account via the API; stores the secret. */
  enrollTwoFactor(cookie: string, email: string): Promise<{ secret: string; recoveryCodes: string[] }>;
  /** Next unused valid code for an enrolled e-mail (advances the server clock by 30 s when needed). */
  twoFactorCode(email: string): Promise<string>;
  /** The server's TOTP clock (ms). */
  now(): number;
  advanceClock(ms: number): void;
  /** Clears the in-memory rate limiters (tests that hit a limit on purpose). */
  resetRateLimits(): void;
  close(): Promise<void>;
}

export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const db = await setupTestDb();
  await db.admin.query("alter role app_api login password 'nur-fuer-tests'");
  const a = db.admin as unknown as { host: string; port: number; database: string };
  const dbUrl = `postgres://app_api:nur-fuer-tests@${a.host}:${a.port}/${a.database}`;
  const pool = createPool(dbUrl, 5);
  for (const email of Object.values(EMAILS)) {
    if (email !== EMAILS.invitedB) await setPasswordViaReset(pool, email, PASSWORD);
  }

  const mails: Mail[] = [];
  const config = loadConfig({ DATABASE_URL: dbUrl, PUBLIC_ORIGIN: ORIGIN, PORT: "0", TOTP_ENCRYPTION_KEY: TOTP_TEST_KEY, ...env });
  // TOTP clock of the server: frozen in the middle of the current 30-second step and
  // moved only by advanceClock/twoFactorCode – no flaky step changes during a test.
  let clockOffset = 0;
  const frozen = (Math.floor(Date.now() / 30_000) * 30 + 15) * 1000;
  const now = () => frozen + clockOffset;
  const { handler, limiters } = createApp({
    config,
    pool,
    mailer: { async send(m) { mails.push(m); } },
    log: () => undefined,
    now,
  });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: TestServer["call"] = async (method, path, o = {}) => {
    const headers: Record<string, string> = {};
    const origin = o.origin === undefined ? ORIGIN : o.origin;
    if (origin) headers.Origin = origin;
    if (o.cookie) headers.Cookie = o.cookie;
    let body: string | undefined;
    if (method !== "GET") {
      const ct = o.contentType === undefined ? "application/json" : o.contentType;
      if (ct) headers["Content-Type"] = ct;
      body = o.rawBody ?? JSON.stringify(o.body ?? {});
    }
    const res = await fetch(url + path, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as AnyBody, headers: res.headers };
  };

  const secrets = new Map<string, string>();

  const twoFactorCode: TestServer["twoFactorCode"] = async (email) => {
    const secret = secrets.get(email);
    if (!secret) throw new Error(`no TOTP secret for ${email}`);
    const row = (await db.admin.query(
      "select f.last_used_step from auth.totp_factors f join auth.users u on u.id = f.user_id where u.email = $1", [email])).rows[0];
    const last = row?.last_used_step == null ? -1 : Number(row.last_used_step);
    let step = timeStep(now());
    if (step <= last) {
      // Current step already used (replay protection): move the server clock on.
      clockOffset += (last + 1 - step) * 30_000;
      step = timeStep(now());
    }
    return hotp(base32Decode(secret), step, 6, nodeHmacSha1);
  };

  const enrollTwoFactor: TestServer["enrollTwoFactor"] = async (cookie, email) => {
    const start = await call("POST", "/api/auth/2fa/setup", { cookie });
    if (start.status !== 200) throw new Error(`2fa setup ${email}: ${start.status} ${JSON.stringify(start.body)}`);
    secrets.set(email, start.body.secret);
    const code = hotp(base32Decode(start.body.secret), timeStep(now()), 6, nodeHmacSha1);
    const confirm = await call("POST", "/api/auth/2fa/setup/confirm", { cookie, body: { code } });
    if (confirm.status !== 200) throw new Error(`2fa confirm ${email}: ${confirm.status} ${JSON.stringify(confirm.body)}`);
    return { secret: start.body.secret, recoveryCodes: confirm.body.recoveryCodes };
  };

  const login: TestServer["login"] = async (who, password = PASSWORD, opts = {}) => {
    const email = who in EMAILS ? EMAILS[who as Who] : who;
    const r = await call("POST", "/api/auth/login", { body: { email, password } });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
    if (r.body?.twoFactorRequired) {
      const v = await call("POST", "/api/auth/2fa/verify", { cookie: cookieFrom(r.headers), body: { code: await twoFactorCode(email) } });
      if (v.status !== 200) throw new Error(`2fa verify ${email} failed: ${v.status} ${JSON.stringify(v.body)}`);
      return cookieFrom(v.headers);
    }
    const cookie = cookieFrom(r.headers);
    if (r.body?.twoFactorSetupRequired && opts.enroll !== false) await enrollTwoFactor(cookie, email);
    return cookie;
  };

  return {
    url, db, pool, mails, call, login, secrets, enrollTwoFactor, twoFactorCode,
    now,
    advanceClock(ms) { clockOffset += ms; },
    resetRateLimits() {
      for (const l of Object.values(limiters)) (l as unknown as { hits: Map<string, unknown> }).hits.clear();
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
      await db.close();
    },
  };
}

/** "name=value" of the first cookie set by the response (session cookie, or the 2FA challenge cookie). */
export function cookieFrom(headers: Headers): string {
  const set = headers.getSetCookie()[0];
  if (!set) throw new Error("no Set-Cookie header");
  return set.split(";")[0]!;
}

export function tokenFromMail(mail: Mail): string {
  const m = /#token=([A-Za-z0-9_%-]+)/.exec(mail.text);
  if (!m) throw new Error("no token in mail");
  return decodeURIComponent(m[1]!);
}

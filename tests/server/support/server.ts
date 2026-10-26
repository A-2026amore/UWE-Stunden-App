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

export { IDS };
export const ORIGIN = "https://zeit.test.example";
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
  login(who: Who | string, password?: string): Promise<string>;
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
  const config = loadConfig({ DATABASE_URL: dbUrl, PUBLIC_ORIGIN: ORIGIN, PORT: "0", ...env });
  const { handler } = createApp({
    config,
    pool,
    mailer: { async send(m) { mails.push(m); } },
    log: () => undefined,
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

  const login: TestServer["login"] = async (who, password = PASSWORD) => {
    const email = who in EMAILS ? EMAILS[who as Who] : who;
    const r = await call("POST", "/api/auth/login", { body: { email, password } });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return cookieFrom(r.headers);
  };

  return {
    url, db, pool, mails, call, login,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
      await db.close();
    },
  };
}

/** "name=value" of the session cookie from a Set-Cookie header. */
export function cookieFrom(headers: Headers): string {
  const set = headers.get("set-cookie");
  if (!set) throw new Error("no Set-Cookie header");
  return set.split(";")[0]!;
}

export function tokenFromMail(mail: Mail): string {
  const m = /#token=([A-Za-z0-9_%-]+)/.exec(mail.text);
  if (!m) throw new Error("no token in mail");
  return decodeURIComponent(m[1]!);
}

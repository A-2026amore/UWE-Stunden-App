/**
 * Worker fixture "stack": throwaway PostgreSQL 16 (tests/db/support/harness.ts:
 * migrations + seed), demo passwords set with the documented operator command
 * (server/src/cli.ts set-password), and the real API started as its own process
 * exactly as in production (node + type stripping), serving the api-mode build
 * via STATIC_DIR. Mails are captured from the development mailer's log output
 * (no SMTP configured → "DEV-E-Mail" lines with recipient, subject and text).
 *
 * Two-factor authentication: the API gets a fixed test key (TOTP_ENCRYPTION_KEY);
 * signIn() completes the second step itself – it decrypts the stored secret
 * with that key and computes the next unused code (RFC 6238), or runs the
 * mandatory setup through the UI for platform accounts.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type pg from "pg";

const ROOT = resolve(process.cwd());

// The harness computes the repository root from __dirname (CommonJS / vitest).
// Playwright loads it as an ES module, so provide the value it expects.
const g = globalThis as { __dirname?: string };
g.__dirname ??= resolve(ROOT, "tests/db/support");
const harness = await import("../../../db/support/harness.ts");
const totp = await import("../../../../platform/src/security/totp.ts");
const tf = await import("../../../../server/src/twoFactor.ts");
const serverConfig = await import("../../../../server/src/config.ts");
export const IDS = harness.IDS;

/** Test-only key (32 bytes, base64) – never used anywhere else. */
export const TOTP_TEST_KEY = "ZnVsbHN0YWNrLW51ci10ZXN0LXRvdHAtc2NobHVlc3M=";
const twoFactorConfig = serverConfig.loadConfig({ DATABASE_URL: "postgres://unused", TOTP_ENCRYPTION_KEY: TOTP_TEST_KEY }).twoFactor;

export const PASSWORD = "Fullstack-Test-Passwort-1";

export const USERS = {
  ownerA: "inhaber@demo-krankentransporte.example",
  managerA: "leitung@demo-krankentransporte.example",
  emp1A: "fahrer1@demo-krankentransporte.example",
  emp2A: "fahrer2@demo-krankentransporte.example",
  ownerB: "inhaberin@muster-pflegedienst.example",
  empB: "pflege1@muster-pflegedienst.example",
  superAdmin: "superadmin@plattform.example",
  support: "support@plattform.example",
} as const;

export interface CapturedMail { to: string; subject: string; text: string }

export interface Stack {
  /** Origin of the API, which also serves the frontend ("http://127.0.0.1:<port>"). */
  url: string;
  /** Superuser connection to the test database (assertions only). */
  db: pg.Client;
  mails: CapturedMail[];
  /** Waits for the newest mail to `to` and returns it with the link it contains. */
  mailTo(to: string, subject?: RegExp): Promise<CapturedMail & { link: string }>;
  output: string[];
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

const NODE_ARGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs"];

async function setPassword(databaseUrl: string, email: string, password: string): Promise<void> {
  const child = execFile(process.execPath, [...NODE_ARGS, "server/src/cli.ts", "set-password", email], {
    cwd: ROOT, env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl },
  });
  child.stdin!.end(password + "\n");
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  if (code !== 0) throw new Error(`set-password ${email} failed (${code})`);
}

export const test = base.extend<{ cspGuard: void }, { stack: Stack }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture without dependencies
  stack: [async ({}, use) => {
    const dist = process.env.FULLSTACK_DIST;
    if (!dist) throw new Error("FULLSTACK_DIST fehlt (globalSetup).");
    const db = await harness.setupTestDb();
    await db.admin.query("alter role app_api login password 'nur-fuer-tests'");
    const a = db.admin as unknown as { host: string; port: number; database: string };
    const databaseUrl = `postgres://app_api:nur-fuer-tests@${a.host}:${a.port}/${a.database}`;
    await Promise.all(Object.values(USERS).map((email) => setPassword(databaseUrl, email, PASSWORD)));

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const output: string[] = [];
    const mails: CapturedMail[] = [];
    const child: ChildProcess = spawn(process.execPath, [...NODE_ARGS, "server/src/main.ts"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, PORT: String(port), PUBLIC_ORIGIN: url, STATIC_DIR: dist, TOTP_ENCRYPTION_KEY: TOTP_TEST_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    child.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        output.push(line);
        if (line.includes("DEV-E-Mail")) {
          try {
            const m = JSON.parse(line) as CapturedMail;
            mails.push({ to: m.to, subject: m.subject, text: m.text });
          } catch { /* not a JSON log line */ }
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => output.push(d.toString("utf8")));
    for (let i = 0; i < 200 && !output.some((l) => l.includes("API gestartet")); i++) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!output.some((l) => l.includes("API gestartet"))) throw new Error("API startet nicht:\n" + output.join("\n"));

    const mailTo: Stack["mailTo"] = async (to, subject) => {
      let found: CapturedMail | undefined;
      await expect.poll(() => {
        found = [...mails].reverse().find((m) => m.to === to && (!subject || subject.test(m.subject)));
        return !!found;
      }, { message: `Mail an ${to}` }).toBe(true);
      const link = /(https?:\/\/\S+#token=[A-Za-z0-9_%-]+)/.exec(found!.text)?.[1];
      if (!link) throw new Error("Kein Link in der Mail: " + found!.text);
      return { ...found!, link };
    };

    currentDb = db.admin;
    await use({ url, db: db.admin, mails, mailTo, output });
    currentDb = null;

    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
    await db.close();
  }, { scope: "worker", timeout: 120000 }],

  baseURL: async ({ stack }, use) => use(stack.url),

  // The pages run under the API's strict CSP: any violation fails the test.
  cspGuard: [async ({ page }, use) => {
    const violations: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    await use();
    expect(violations, "CSP-Verstöße").toEqual([]);
  }, { auto: true }],
});

export { expect };

// ------------------------------------------------------------------ two-factor helpers

let currentDb: pg.Client | null = null;

export const CODE_LABEL = "Bestätigungscode aus der Authenticator-App";

interface FactorRow { user_id: string; secret_ciphertext: string | null; enrolled: boolean; last_used_step: string | null; required_by: string | null }

async function factorOf(email: string): Promise<FactorRow> {
  if (!currentDb) throw new Error("stack fixture not active");
  const r = await currentDb.query<FactorRow>(
    `select u.id as user_id, f.secret_ciphertext, f.enrolled_at is not null as enrolled, f.last_used_step,
            auth.two_factor_requirement(u.id) as required_by
       from auth.users u left join auth.totp_factors f on f.user_id = u.id where u.email = $1`, [email]);
  if (!r.rows[0]) throw new Error(`unknown user ${email}`);
  return r.rows[0];
}

/** TOTP code for a base32 secret at a step offset from now. */
export function codeFor(secret: string, offsetSteps = 0): string {
  return totp.hotp(totp.base32Decode(secret), totp.timeStep(Date.now()) + offsetSteps, 6, tf.nodeHmacSha1);
}

/**
 * Next code the server accepts for an enrolled account: decrypts the stored
 * secret with the test key, skips steps that were already used (replay
 * protection) and waits for the next 30-second step if necessary.
 */
export async function nextCode(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const f = await factorOf(email);
    if (!f.enrolled || !f.secret_ciphertext) throw new Error(`${email} has no 2FA`);
    const { secret } = tf.decryptSecret(twoFactorConfig, f.user_id, f.secret_ciphertext);
    const now = totp.timeStep(Date.now());
    const step = Math.max(now, f.last_used_step === null ? 0 : Number(f.last_used_step) + 1);
    if (step <= now + 1) return totp.hotp(secret, step, 6, tf.nodeHmacSha1);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("no unused TOTP step");
}

/** Setup form (settings card or mandatory screen): reads the secret, confirms with a code, acknowledges the recovery codes. */
export async function completeTwoFactorSetup(page: Page): Promise<{ secret: string; recoveryCodes: string[] }> {
  const secretBox = page.getByTestId("totp-secret");
  await expect(secretBox).toBeVisible();
  const secret = (await secretBox.innerText()).replace(/\s/g, "");
  await page.getByLabel(CODE_LABEL).fill(codeFor(secret));
  await page.getByRole("button", { name: "Bestätigen und aktivieren" }).click();
  const list = page.getByRole("list", { name: "Wiederherstellungscodes" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const recoveryCodes = (await list.getByRole("listitem").allInnerTexts()).map((x) => x.trim());
  await page.getByLabel("Ich habe die Wiederherstellungscodes sicher gespeichert.").check();
  await page.getByRole("button", { name: "Fertig" }).click();
  return { secret, recoveryCodes };
}

// ------------------------------------------------------------------ UI helpers

/**
 * Signs in through the login form. Accounts with 2FA get the code step filled
 * automatically; accounts that must set up 2FA (platform staff, managers of a
 * tenant that requires it) are enrolled through the setup screen.
 */
export async function signIn(page: Page, path: "/app/" | "/chef/" | "/admin/", email: string, password = PASSWORD): Promise<void> {
  const before = currentDb ? await factorOf(email).catch(() => null) : null;
  await page.goto(path);
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  if (!before) return;
  const failed = page.getByRole("alert").filter({ hasText: "E-Mail-Adresse oder Passwort ist falsch." });
  if (before.enrolled) {
    const field = page.getByLabel(CODE_LABEL);
    await expect(field.or(failed)).toBeVisible();
    if (await failed.isVisible()) return;
    await field.fill(await nextCode(email));
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
    await expect(field).toHaveCount(0);
  } else if (before.required_by) {
    const gate = page.getByRole("heading", { level: 1, name: "Zwei-Faktor-Anmeldung einrichten" });
    await expect(gate.or(failed)).toBeVisible();
    if (await failed.isVisible()) return;
    await completeTwoFactorSetup(page);
    await expect(gate).toHaveCount(0);
  }
}

/** Hash navigation inside the loaded app (no reload). */
export async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { location.hash = h; }, hash);
}

export async function fillEntry(page: Page, e: { start: string; end: string; pause?: string; note?: string }): Promise<void> {
  await page.getByLabel("Arbeitsbeginn", { exact: true }).fill(e.start);
  await page.getByLabel("Arbeitsende", { exact: true }).fill(e.end);
  if (e.pause !== undefined) await page.getByLabel("Pause", { exact: true }).fill(e.pause);
  if (e.note !== undefined) await page.getByLabel("Bemerkung", { exact: false }).fill(e.note);
}

export async function saveEntry(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Arbeitszeit speichern" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Arbeitszeit gespeichert." }).last()).toBeVisible();
}

/** GET from inside the page (with the session cookie) → HTTP status. */
export async function apiStatus(page: Page, path: string): Promise<number> {
  return page.evaluate(async (p) => (await fetch(p, { credentials: "include" })).status, path);
}

export async function rows<T = Record<string, unknown>>(db: pg.Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}


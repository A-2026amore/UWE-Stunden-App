/**
 * Worker fixture "stack": throwaway PostgreSQL 16 (tests/db/support/harness.ts:
 * migrations + seed), demo passwords set with the documented operator command
 * (server/src/cli.ts set-password), and the real API started as its own process
 * exactly as in production (node + type stripping), serving the api-mode build
 * via STATIC_DIR. Mails are captured from the development mailer's log output
 * (no SMTP configured → "DEV-E-Mail" lines with recipient, subject and text).
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
export const IDS = harness.IDS;

export const PASSWORD = "Fullstack-Test-Passwort-1";

export const USERS = {
  ownerA: "inhaber@demo-krankentransporte.example",
  managerA: "leitung@demo-krankentransporte.example",
  emp1A: "fahrer1@demo-krankentransporte.example",
  emp2A: "fahrer2@demo-krankentransporte.example",
  ownerB: "inhaberin@muster-pflegedienst.example",
  empB: "pflege1@muster-pflegedienst.example",
  superAdmin: "superadmin@plattform.example",
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
      env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, PORT: String(port), PUBLIC_ORIGIN: url, STATIC_DIR: dist },
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

    await use({ url, db: db.admin, mails, mailTo, output });

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

// ------------------------------------------------------------------ UI helpers

export async function signIn(page: Page, path: "/app/" | "/chef/" | "/admin/", email: string, password = PASSWORD): Promise<void> {
  await page.goto(path);
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
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


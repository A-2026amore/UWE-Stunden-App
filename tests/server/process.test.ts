/**
 * Starts the server exactly as documented (node + type stripping + resolve
 * hook) as a child process and talks to it over HTTP.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "../db/support/harness.ts";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
let db: TestDb;
let child: ChildProcess;
let base = "";
const output: string[] = [];

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

beforeAll(async () => {
  db = await setupTestDb();
  await db.admin.query("alter role app_api login password 'nur-fuer-tests'");
  const a = db.admin as unknown as { host: string; port: number; database: string };
  const url = `postgres://app_api:nur-fuer-tests@${a.host}:${a.port}/${a.database}`;
  // documented operator command: password via stdin
  const cli = execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs",
    "server/src/cli.ts", "set-password", "fahrer2@demo-krankentransporte.example"], {
    cwd: ROOT, env: { PATH: process.env.PATH, DATABASE_URL: url }, input: "Prozess-Test-Passwort\n",
  }).toString();
  expect(cli).toContain("Passwort gesetzt");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs", "server/src/main.ts"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, DATABASE_URL: url, PORT: String(port), PUBLIC_ORIGIN: ORIGIN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => output.push(String(d)));
  child.stderr!.on("data", (d) => output.push(String(d)));
  for (let i = 0; i < 100; i++) {
    if (output.join("").includes("API gestartet")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await exited;
  }
  await db?.close();
});

describe("node server/src/main.ts", () => {
  it("serves health, login and a time entry (core break rules loaded)", async () => {
    expect(output.join("")).toContain("API gestartet");
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fahrer2@demo-krankentransporte.example", password: "Prozess-Test-Passwort" }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^sid=/); // http origin in development → no __Host- prefix, no Secure
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";")[0]!;
    const session = (await login.json()) as { employeeId: string };
    const r = await fetch(`${base}/api/employees/${session.employeeId}/time-entries`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ id: "process-0001", date: "2026-10-27", start: "06:00", end: "13:00", pauseMinutes: 0, note: "" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("break_rule");
    // request log lines never contain the password or the cookie token
    const logs = output.join("");
    expect(logs).not.toContain("Prozess-Test-Passwort");
    expect(logs).not.toContain(cookie.split("=")[1]!);
  });
});

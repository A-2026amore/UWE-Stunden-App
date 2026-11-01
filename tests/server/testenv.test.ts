/**
 * Test environment accounts (server/src/testenv.ts, `cli.ts seed-test-env`): fictitious
 * companies (free + paying) with owner, manager and three employees, a super-admin with
 * mandatory 2FA, random passwords only on stdout; refuses on databases with real tenants.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "../../server/src/auth.ts";
import { migrate } from "../../server/src/migrate.ts";
import { setupTestDb, type TestDb } from "../db/support/harness.ts";

const ROOT = resolve(__dirname, "../..");
let db: TestDb;
let server: string;
const created: string[] = [];

async function freshDb(): Promise<string> {
  const name = `uwe_testenv_${process.pid}_${created.length}_${Date.now().toString(36)}`;
  await db.admin.query(`create database ${name}`);
  created.push(name);
  const url = `${server}/${name}`;
  await migrate({ url });
  return url;
}

function cli(args: string[], url: string) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs",
    "server/src/cli.ts", "seed-test-env", ...args], {
    cwd: ROOT, env: { PATH: process.env.PATH, MIGRATION_DATABASE_URL: url }, encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await setupTestDb({ seed: false });
  const a = db.admin as unknown as { host: string; port: number; user: string; password?: string };
  server = `postgres://${a.password ? `${a.user}:${encodeURIComponent(a.password)}` : a.user}@${a.host}:${a.port}`;
});
afterAll(async () => {
  for (const name of created) await db.admin.query(`drop database if exists ${name} with (force)`);
  await db?.close();
});

describe("seed-test-env", () => {
  it("creates both test companies and the super-admin; passwords only on stdout and valid", async () => {
    const url = await freshDb();
    const r = cli(["--confirm-test-environment", "--domain=stunden-test.example"], url);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const rows = r.stdout.split("\n").filter((l) => l.includes("@stunden-test.example"));
    expect(rows).toHaveLength(11);
    const creds = rows.map((l) => {
      const parts = l.trim().split(/\s{2,}/);
      return { email: parts[2]!, password: parts[3]! };
    });
    expect(new Set(creds.map((c) => c.password)).size).toBe(11);
    for (const c of creds) expect(c.password).toMatch(/^[A-Za-z0-9_-]{24}$/);

    await withClient(url, async (c) => {
      const tenants = (await c.query(
        `select t.slug, t.is_demo, t.status, l.plan, l.free_of_charge,
                (select array_agg(e.role order by e.personnel_number) from public.employees e where e.tenant_id = t.id and e.status = 'active') as roles
           from public.tenants t join public.licenses l on l.tenant_id = t.id and l.status = 'active' order by t.slug`)).rows;
      expect(tenants).toEqual([
        { slug: "test-gratis", is_demo: true, status: "active", plan: "pilot_free", free_of_charge: true, roles: ["owner", "manager", "employee", "employee", "employee"] },
        { slug: "test-zahlend", is_demo: true, status: "active", plan: "standard", free_of_charge: false, roles: ["owner", "manager", "employee", "employee", "employee"] },
      ]);
      for (const cred of creds) {
        const u = (await c.query("select password_hash from auth.users where email = $1", [cred.email])).rows[0];
        expect(await verifyPassword(cred.password, u.password_hash)).toBe(true);
      }
      // Platform staff must set up 2FA at the first login.
      const admin = (await c.query(
        `select pa.role, auth.two_factor_requirement(u.id) as req from auth.users u join public.platform_admins pa on pa.user_id = u.id
          where u.email = 'superadmin@stunden-test.example'`)).rows;
      expect(admin).toEqual([{ role: "super_admin", req: "platform" }]);
    });

    // Second run: nothing is overwritten.
    const again = cli(["--confirm-test-environment", "--domain=stunden-test.example"], url);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("bereits angelegt");
  }, 120_000);

  it("refuses without confirmation and on a database with real tenants", async () => {
    const url = await freshDb();
    const r = cli([], url);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--confirm-test-environment");
    await withClient(url, (c) => c.query(
      `insert into public.tenants (slug, name, status, is_demo, contact)
       values ('echte-firma', 'Echte Firma', 'active', false, '{"legalName": "Echte Firma", "street": "", "postalCode": "", "city": ""}')`));
    const refused = cli(["--confirm-test-environment"], url);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("keine reine Testumgebung");
    expect(refused.stdout).not.toMatch(/@/);
    await withClient(url, async (c) => {
      expect((await c.query("select count(*)::int as n from auth.users")).rows[0].n).toBe(0);
    });
  }, 120_000);
});

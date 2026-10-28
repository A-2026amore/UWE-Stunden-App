/**
 * Operator commands export-tenant / delete-tenant (migration 0020, end of
 * contract). Runs the CLI exactly as documented against a test database.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, setupTestDb, type TestDb } from "../db/support/harness.ts";

const ROOT = resolve(__dirname, "../..");
const SLUG_A = "demo-krankentransporte";
const SLUG_B = "muster-pflegedienst";

let db: TestDb;
let work: string;
beforeAll(async () => {
  db = await setupTestDb();
  work = mkdtempSync(join(tmpdir(), "offboarding-"));
});
afterAll(async () => {
  await db?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

function cli(args: string[], env: Record<string, string | undefined> = { MIGRATION_DATABASE_URL: db.url }) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs",
    "server/src/cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const count = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows[0].c as number;

describe("cli.ts export-tenant", () => {
  it("needs the owner connection and valid arguments", () => {
    expect(cli(["export-tenant", SLUG_A, "--out", join(work, "x")], {}).status).toBe(2);
    expect(cli(["export-tenant", SLUG_A]).status).toBe(2);
    expect(cli(["export-tenant", SLUG_A, "--out", join(work, "x"), "--unbekannt"]).status).toBe(2);
  });

  it("writes JSON, CSV and checksums of a suspended tenant (owner cannot sign in) and audits it", async () => {
    await db.admin.query("update public.tenants set status = 'suspended' where id = $1", [IDS.tenantA]);
    const out = join(work, "export-a");
    const r = cli(["export-tenant", SLUG_A, "--out", out]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Status: suspended");
    expect((statSync(out).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(join(out, "firmendaten.json")).mode & 0o777).toString(8)).toBe("600");
    const json = readFileSync(join(out, "firmendaten.json"));
    const data = JSON.parse(json.toString("utf8"));
    expect(data.tenant).toMatchObject({ id: IDS.tenantA, slug: SLUG_A, status: "suspended" });
    const entries = await count("select count(*)::int as c from public.time_entries where tenant_id = $1", [IDS.tenantA]);
    expect(data.employees.reduce((n: number, e: { timeEntries: unknown[] }) => n + e.timeEntries.length, 0)).toBe(entries);
    const csv = readFileSync(join(out, "arbeitszeiten.csv"), "utf8");
    expect(csv.trim().split("\r\n")).toHaveLength(entries + 1);
    const hash = createHash("sha256").update(json).digest("hex");
    expect(readFileSync(join(out, "SHA256SUMS"), "utf8")).toContain(`${hash}  firmendaten.json`);
    expect(r.stdout).toContain(hash);
    expect(await count("select count(*)::int as c from public.audit_log where tenant_id = $1 and action = 'tenant.operator_export'", [IDS.tenantA])).toBe(1);

    // never overwrites an existing export
    const again = cli(["export-tenant", SLUG_A, "--out", out]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/nicht leer/);
  });

  it("unknown tenant → exit 1", () => {
    const r = cli(["export-tenant", "gibt-es-nicht", "--out", join(work, "none")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Kein Mandant/);
  });
});

describe("cli.ts delete-tenant", () => {
  it("refuses: missing export choice, wrong confirmation, not deactivated, foreign or manipulated export", async () => {
    const out = join(work, "export-a");
    expect(cli(["delete-tenant", SLUG_A, "--confirm", SLUG_A]).status).toBe(1);
    expect(cli(["delete-tenant", SLUG_A, "--confirm", SLUG_A, "--after-export", out, "--without-export"]).status).toBe(1);
    expect(cli(["delete-tenant", SLUG_A, "--after-export", out]).status).toBe(2);
    const wrong = cli(["delete-tenant", SLUG_A, "--confirm", "falsch", "--after-export", out]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/Bestätigung/);
    const suspended = cli(["delete-tenant", SLUG_A, "--confirm", SLUG_A, "--after-export", out]);
    expect(suspended.status).toBe(1);
    expect(suspended.stderr).toMatch(/nur deaktivierte/);
    const foreign = cli(["delete-tenant", SLUG_B, "--confirm", SLUG_B, "--after-export", out]);
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toMatch(/gehört zu "demo-krankentransporte"/);

    const bad = join(work, "manipuliert");
    cli(["export-tenant", SLUG_A, "--out", bad]);
    writeFileSync(join(bad, "firmendaten.json"), readFileSync(join(bad, "firmendaten.json"), "utf8").replace("Sam Probe", "Sam Anders"));
    await db.admin.query("update public.tenants set status = 'deactivated' where id = $1", [IDS.tenantA]);
    const tampered = cli(["delete-tenant", SLUG_A, "--confirm", SLUG_A, "--after-export", bad]);
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toMatch(/Prüfsumme/);
    expect(await count("select count(*)::int as c from public.employees where tenant_id = $1", [IDS.tenantA])).toBeGreaterThan(0);
  });

  it("deletes the deactivated tenant after the export; tenant B untouched; second run finds nothing", async () => {
    const out = join(work, "export-a");
    const bEmployees = await count("select count(*)::int as c from public.employees where tenant_id = $1", [IDS.tenantB]);
    const bEntries = await count("select count(*)::int as c from public.time_entries where tenant_id = $1", [IDS.tenantB]);
    const r = cli(["delete-tenant", SLUG_A, "--confirm", SLUG_A, "--after-export", out]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Mandant ${IDS.tenantA} gelöscht.`);
    expect(r.stdout).toMatch(/gelöscht public\.time_entries: \d+/);
    expect(await count("select count(*)::int as c from public.employees where tenant_id = $1", [IDS.tenantA])).toBe(0);
    expect(await count("select count(*)::int as c from public.tenants where id = $1", [IDS.tenantA])).toBe(0);
    expect(await count("select count(*)::int as c from public.employees where tenant_id = $1", [IDS.tenantB])).toBe(bEmployees);
    expect(await count("select count(*)::int as c from public.time_entries where tenant_id = $1", [IDS.tenantB])).toBe(bEntries);
    const hash = createHash("sha256").update(readFileSync(join(out, "firmendaten.json"))).digest("hex");
    const audit = (await db.admin.query("select tenant_id, after from public.audit_log where action = 'tenant.deleted'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].tenant_id).toBeNull();
    expect(audit[0].after.exportSha256).toBe(hash);

    const again = cli(["delete-tenant", SLUG_A, "--confirm", SLUG_A, "--after-export", out]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/Kein Mandant|bereits gelöscht/);
  });
});

/**
 * deploy/prod-bereitstellen.sh (production install/update): guard checks that run without Docker,
 * plus the rules that must stay in the script (only tested commits from signed packages, no demo data,
 * backup before updates, own secrets).
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = resolve(__dirname, "../../deploy/prod-bereitstellen.sh");
const text = readFileSync(SCRIPT, "utf8");

async function sh(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await run("bash", [SCRIPT, ...args], { timeout: 20_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

describe("deploy/prod-bereitstellen.sh", () => {
  it("is valid bash", async () => {
    await run("bash", ["-n", SCRIPT]);
  });

  it("refuses without a full commit SHA", async () => {
    for (const args of [[], ["main"], ["abc123"]]) {
      const r = await sh(args);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/40-stelliger Commit/);
    }
  });

  it("refuses --super-admin without an e-mail address", async () => {
    const r = await sh(["--super-admin"]);
    expect(r.code).not.toBe(0);
  });

  it("deploys only the commit running on the test environment, from a signed package", () => {
    expect(text).toContain("/var/lib/stunden-test/deployed-commit");
    expect(text).toContain('show-ref --verify --quiet "refs/pakete/$COMMIT"');
    expect(text).not.toMatch(/github\.com/);
  });

  it("starts with an empty database and keeps its own secrets", () => {
    expect(text).not.toMatch(/seed-test-env|MIGRATE_SEED=1|db\/seed\.sql\b(?! is never)/);
    expect(text).toContain('print "STAGE=prod"');
    expect(text).toContain("openssl rand -hex 32");
    expect(text).toContain("chmod 600 deploy/.env");
    expect(text).toContain("/root/.stunden-prod-backup-pass");
  });

  it("backs up the running production before an update and takes the production lock", () => {
    expect(text).toContain("/run/stunden-prod.lock");
    const backup = text.indexOf("Sicherung der laufenden Produktion vor dem Update");
    expect(backup).toBeGreaterThan(0);
    expect(backup).toBeLessThan(text.indexOf("checkout --quiet --detach"));
  });

  it("restores the Caddyfile when Caddy rejects the new block", () => {
    expect(text).toContain("caddy validate");
    expect(text).toMatch(/cp -p "\$BK" "\$CF"/);
  });
});

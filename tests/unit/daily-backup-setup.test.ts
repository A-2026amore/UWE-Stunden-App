/**
 * Daily backup of the test environment (deploy/taegliche-sicherung-einrichten.sh, deploy/sicherung.sh):
 * the installer writes the systemd timer/service and the entry point; the entry point only runs the backup
 * from the approved AND deployed commit. Runs the scripts for real in a temporary root (STUNDEN_ROOT),
 * with deploy/sicherung.sh replaced by a stub in a throwaway git checkout.
 */
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(__dirname, "../..");
let root: string;
let checkout: string;
let head: string;

async function sh(file: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const r = await run("bash", [file], { env: { ...process.env, ...env }, timeout: 30_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

async function sh2(file: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const r = await run("bash", [file, ...args], { env: { ...process.env, ...env }, timeout: 30_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "daily-backup-"));
  mkdirSync(join(root, "run"));
  mkdirSync(join(root, "etc/stunden-test"), { recursive: true });
  mkdirSync(join(root, "var/lib/stunden-test"), { recursive: true });
  // throwaway checkout whose deploy/sicherung.sh only leaves a marker
  checkout = join(root, "srv");
  mkdirSync(join(checkout, "deploy"), { recursive: true });
  writeFileSync(join(checkout, "deploy/sicherung.sh"), `#!/usr/bin/env bash\necho ran > "${root}/marker"\n`);
  chmodSync(join(checkout, "deploy/sicherung.sh"), 0o755);
  const git = (...a: string[]) => run("git", ["-C", checkout, "-c", "user.email=t@example.com", "-c", "user.name=t", ...a]);
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-qm", "test");
  head = (await git("rev-parse", "HEAD")).stdout.trim();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("daily backup setup", () => {
  it("writes a nightly timer (caught up after downtime) and a service without secrets", async () => {
    const r = await sh(join(ROOT, "deploy/taegliche-sicherung-einrichten.sh"), { STUNDEN_ROOT: root });
    expect(r.code, r.out).toBe(0);
    const timer = readFileSync(join(root, "etc/systemd/system/stunden-test-backup.timer"), "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 03:30:00");
    expect(timer).toContain("Persistent=true");
    const service = readFileSync(join(root, "etc/systemd/system/stunden-test-backup.service"), "utf8");
    expect(service).toContain("ExecStart=/usr/local/lib/stunden-test/daily-backup");
    expect(service).toContain("Environment=BACKUP_PASSPHRASE_FILE=/root/.stunden-test-backup-pass");
    expect(existsSync(join(root, "usr/local/lib/stunden-test/daily-backup"))).toBe(true);
  });

  const entry = () => join(root, "usr/local/lib/stunden-test/daily-backup");
  const env = () => ({ STUNDEN_ROOT: root, STUNDEN_DIR: checkout });
  const reset = () => rmSync(join(root, "marker"), { force: true });

  it("refuses without an approved commit", async () => {
    reset();
    const r = await sh(entry(), env());
    expect(r.code).toBe(1);
    expect(existsSync(join(root, "marker"))).toBe(false);
  });

  it("waits when the approved commit is not deployed yet", async () => {
    reset();
    writeFileSync(join(root, "etc/stunden-test/approved-commit"), `${head}\n`);
    writeFileSync(join(root, "var/lib/stunden-test/deployed-commit"), `${"a".repeat(40)}\n`);
    const r = await sh(entry(), env());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/noch nicht bereitgestellt/);
    expect(existsSync(join(root, "marker"))).toBe(false);
  });

  it("refuses when the working tree is not the approved commit", async () => {
    reset();
    const other = "b".repeat(40);
    writeFileSync(join(root, "etc/stunden-test/approved-commit"), `${other}\n`);
    writeFileSync(join(root, "var/lib/stunden-test/deployed-commit"), `${other}\n`);
    const r = await sh(entry(), env());
    expect(r.code).toBe(1);
    expect(existsSync(join(root, "marker"))).toBe(false);
  });

  it("runs deploy/sicherung.sh from the approved and deployed commit", async () => {
    reset();
    writeFileSync(join(root, "etc/stunden-test/approved-commit"), `${head}\n`);
    writeFileSync(join(root, "var/lib/stunden-test/deployed-commit"), `${head}\n`);
    const r = await sh(entry(), env());
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(root, "marker"), "utf8").trim()).toBe("ran");
  });

  it("deploy/pull-deploy.sh uses the same backup script and lock", () => {
    const deploy = readFileSync(join(ROOT, "deploy/pull-deploy.sh"), "utf8");
    expect(deploy).toContain("bash deploy/sicherung.sh");
    expect(deploy).toContain("/run/stunden-test.lock");
    const entryText = readFileSync(entry(), "utf8");
    expect(entryText).toContain("STAGE=test");
    expect(entryText).toContain("/run/stunden-$STAGE.lock");
  });

  it("sets up the production environment separately (own units, 02:30, own paths)", async () => {
    const r = await sh2(join(ROOT, "deploy/taegliche-sicherung-einrichten.sh"), ["prod"], { STUNDEN_ROOT: root });
    expect(r.code, r.out).toBe(0);
    const timer = readFileSync(join(root, "etc/systemd/system/stunden-prod-backup.timer"), "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 02:30:00");
    const service = readFileSync(join(root, "etc/systemd/system/stunden-prod-backup.service"), "utf8");
    expect(service).toContain("ExecStart=/usr/local/lib/stunden-prod/daily-backup");
    expect(service).toContain("BACKUP_PASSPHRASE_FILE=/root/.stunden-prod-backup-pass");
    expect(service).toContain("WorkingDirectory=/srv/stunden-prod");
    expect(readFileSync(join(root, "usr/local/lib/stunden-prod/daily-backup"), "utf8")).toContain("STAGE=prod");
    expect((await sh2(join(ROOT, "deploy/taegliche-sicherung-einrichten.sh"), ["staging"], { STUNDEN_ROOT: root })).code).toBe(2);
  });
});

describe("deploy/sicherung.sh", () => {
  // copy of the real script next to stubbed backup.sh / restore-test.sh
  const setup = (backupOk: boolean, restoreOk: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "sicherung-"));
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "backups"));
    copyFileSync(join(ROOT, "deploy/sicherung.sh"), join(dir, "deploy/sicherung.sh"));
    writeFileSync(join(dir, "deploy/backup.sh"), backupOk
      ? '#!/usr/bin/env bash\necho x > "$BACKUP_DIR/stunden-test-1.tar.gpg"\n'
      : "#!/usr/bin/env bash\nexit 3\n");
    writeFileSync(join(dir, "deploy/restore-test.sh"), `#!/usr/bin/env bash\nexit ${restoreOk ? 0 : 1}\n`);
    for (const f of ["sicherung.sh", "backup.sh", "restore-test.sh"]) chmodSync(join(dir, "deploy", f), 0o755);
    const env = { STATE_DIR: join(dir, "state"), BACKUP_DIR: join(dir, "backups"), RESTIC_ENV: join(dir, "none.env") };
    return { dir, env, status: () => readFileSync(join(dir, "state/status.txt"), "utf8") };
  };

  it("backs up and runs the restore probe; without Storage Box it says so", async () => {
    const t = setup(true, true);
    const r = await sh(join(t.dir, "deploy/sicherung.sh"), t.env);
    expect(r.code, r.out).toBe(0);
    expect(t.status()).toMatch(/OK: Sicherung \+ Wiederherstellungsprobe bestanden \(Quelle: lokal\)/);
    expect(t.status()).toMatch(/Storage Box nicht eingebunden/);
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("fails visibly when the backup or the restore probe fails", async () => {
    for (const [b, rp, text] of [[false, true, "Sicherung fehlgeschlagen"], [true, false, "Wiederherstellungsprobe fehlgeschlagen"]] as const) {
      const t = setup(b, rp);
      const r = await sh(join(t.dir, "deploy/sicherung.sh"), t.env);
      expect(r.code).toBe(1);
      expect(t.status()).toContain(`FEHLER: ${text}`);
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Backups (deploy/backup.sh) and the restore test (deploy/restore-test.sh) for real:
 * a migrated database with demo data is dumped, encrypted (passphrase and public key),
 * restored into a fresh throwaway database and checked (counts, migration state, RLS).
 * Tampered archives, a wrong passphrase and missing encryption are refused.
 *
 * Target of the restore: locally an own initdb cluster (--local); in CI the PostgreSQL
 * service (--server-url, throwaway database restore_test_…).
 */
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../server/src/migrate.ts";
import { setupTestDb, type TestDb } from "../db/support/harness.ts";

const run = promisify(execFile);
const ROOT = resolve(__dirname, "../..");
const BACKUP = join(ROOT, "deploy", "backup.sh");
const RESTORE = join(ROOT, "deploy", "restore-test.sh");

let db: TestDb;
let work: string;
let sourceUrl: string;
let dbName: string;
let serverUrl: string;
const env = (extra: Record<string, string>) => ({ ...process.env, STAGE: "test", BACKUP_KEEP_LOCAL: "0", ...extra });

async function sh(cmd: string, args: string[], extra: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const r = await run(cmd, args, { env: env(extra), timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}
const target = () => (process.env.DATABASE_URL ? ["--server-url", process.env.DATABASE_URL] : ["--local"]);

beforeAll(async () => {
  db = await setupTestDb({ seed: false });
  const a = db.admin as unknown as { host: string; port: number; user: string; password?: string };
  const auth = a.password ? `${a.user}:${encodeURIComponent(a.password)}` : a.user;
  serverUrl = `postgres://${auth}@${a.host}:${a.port}`;
  dbName = `uwe_backup_${process.pid}_${Date.now().toString(36)}`;
  await db.admin.query(`create database ${dbName}`);
  sourceUrl = `${serverUrl}/${dbName}`;
  await migrate({ url: sourceUrl, seed: true });
  work = mkdtempSync(join(tmpdir(), "uwe-backup-"));
  writeFileSync(join(work, "pass"), "nur-fuer-tests-passphrase\n", { mode: 0o600 });
}, 120_000);

afterAll(async () => {
  await db?.admin.query(`drop database if exists ${dbName} with (force)`);
  await db?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

function archiveIn(dir: string): string {
  const f = readdirSync(dir).find((x) => x.endsWith(".tar.gpg"));
  if (!f) throw new Error(`no archive in ${dir}`);
  return join(dir, f);
}

describe("backup with passphrase", () => {
  let archive: string;

  it("writes an encrypted archive with checksum – no plain data on disk", async () => {
    const out = join(work, "sym");
    const r = await sh(BACKUP, ["--url", sourceUrl, "--out", out], { BACKUP_PASSPHRASE_FILE: join(work, "pass") });
    expect(r.out).toContain("fertig:");
    expect(r.code).toBe(0);
    archive = archiveIn(out);
    expect(readdirSync(out).sort()).toEqual([archive.split("/").pop(), `${archive.split("/").pop()}.sha256`]);
    const bytes = readFileSync(archive);
    expect(bytes.includes(Buffer.from("Demo Krankentransporte"))).toBe(false);
    expect(bytes.includes(Buffer.from("PGDMP"))).toBe(false);
    expect(readFileSync(`${archive}.sha256`, "utf8")).toMatch(/^[0-9a-f]{64} {2}stunden-test-\d{8}T\d{6}Z\.tar\.gpg\n$/);
  }, 120_000);

  it("restores into a throwaway database and all checks pass", async () => {
    const r = await sh(RESTORE, [...target(), "--migrations", join(ROOT, "db", "migrations"), archive], { BACKUP_PASSPHRASE_FILE: join(work, "pass") });
    expect(r.out).toContain("ERGEBNIS: Wiederherstellung erfolgreich geprüft.");
    expect(r.code).toBe(0);
    for (const line of [
      "OK      Prüfsumme (SHA-256) stimmt",
      "OK      pg_restore ohne Fehler",
      "OK      Zeilen public.tenants: 2",
      "OK      Migrationsstand passt zum Code",
      "OK      RLS-Richtlinien vollständig",
      "(RLS greift)",
    ]) expect(r.out).toContain(line);
    expect(r.out).toMatch(/OK {6}Zeilen public\.time_entries: [1-9]\d*/);
    expect(r.out).not.toContain("FEHLER");
  }, 180_000);

  it("refuses a tampered archive and a wrong passphrase", async () => {
    const dir = join(work, "tampered");
    rmSync(dir, { recursive: true, force: true });
    const copy = join(work, "copy");
    rmSync(copy, { recursive: true, force: true });
    for (const d of [dir, copy]) {
      await run("mkdir", ["-p", d]);
      for (const f of readdirSync(join(work, "sym"))) copyFileSync(join(work, "sym", f), join(d, f));
    }
    const t = archiveIn(dir);
    const bytes = readFileSync(t);
    const i = bytes.length - 100;
    bytes[i] = bytes[i]! ^ 0xff;
    writeFileSync(t, bytes);
    const bad = await sh(RESTORE, [...target(), t], { BACKUP_PASSPHRASE_FILE: join(work, "pass") });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("Prüfsumme stimmt nicht");

    writeFileSync(join(work, "wrong"), "falsche-passphrase\n", { mode: 0o600 });
    const wrong = await sh(RESTORE, [...target(), archiveIn(copy)], { BACKUP_PASSPHRASE_FILE: join(work, "wrong") });
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain("Entschlüsseln/Entpacken fehlgeschlagen");
  }, 120_000);

  it("refuses to write unencrypted backups", async () => {
    const r = await sh(BACKUP, ["--url", sourceUrl, "--out", join(work, "none")], {});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Keine Verschlüsselung angegeben");
  });
});

describe("backup with a public key (private key only where restored)", () => {
  it("encrypts for the recipient; restore with the private key works", async () => {
    const gnupg = mkdtempSync(join(tmpdir(), "uwe-gnupg-"));
    try {
      const gpgEnv = { env: { ...process.env, GNUPGHOME: gnupg } };
      await run("gpg", ["--batch", "--passphrase", "", "--quick-gen-key", "Backup Test <backup-test@stundenwerk.example>", "ed25519", "default", "1d"], gpgEnv);
      const keys = await run("gpg", ["--batch", "--with-colons", "--list-keys", "backup-test@stundenwerk.example"], gpgEnv);
      const fpr = String(keys.stdout).split("\n").find((l) => l.startsWith("fpr:"))?.split(":")[9] ?? "";
      expect(fpr).toMatch(/^[0-9A-F]{40}$/);
      await run("gpg", ["--batch", "--quick-add-key", "--passphrase", "", fpr, "cv25519", "encr", "1d"], gpgEnv);
      const out = join(work, "asym");
      const b = await sh(BACKUP, ["--url", sourceUrl, "--out", out], { GNUPGHOME: gnupg, BACKUP_GPG_RECIPIENT: "backup-test@stundenwerk.example" });
      expect(b.code).toBe(0);
      const r = await sh(RESTORE, [...target(), archiveIn(out)], { GNUPGHOME: gnupg });
      expect(r.out).toContain("ERGEBNIS: Wiederherstellung erfolgreich geprüft.");
      expect(r.code).toBe(0);
    } finally {
      rmSync(gnupg, { recursive: true, force: true });
    }
  }, 180_000);
});

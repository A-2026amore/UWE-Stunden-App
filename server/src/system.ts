/**
 * Technical system overview for platform staff (GET /api/platform/system).
 * Only states and counts – never secrets (no SMTP host/user/password, no
 * database URL, no keys) and no personal data.
 */
import { readFile, stat } from "node:fs/promises";
import type { SystemOverview } from "../../platform/src/data/repository.ts";
import type { Config } from "./config.ts";
import type { Queryable } from "./db.ts";


let cachedVersion: string | null | undefined;

async function appVersion(): Promise<string | null> {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    cachedVersion = typeof pkg.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(pkg.version) ? pkg.version : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/**
 * Time of the last successful backup: the backup job writes an ISO timestamp
 * into BACKUP_STATUS_FILE (or simply touches it – then its modification time
 * counts). Anything unreadable means "nicht bekannt".
 */
export async function lastBackupAt(file: string | null): Promise<string | null> {
  if (!file) return null;
  try {
    const text = (await readFile(file, "utf8")).trim().slice(0, 64);
    const parsed = Date.parse(text);
    if (text && Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return (await stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}

interface DbOverview {
  databaseTime: string;
  migrations: { count: number; latest: string | null; appliedAt: string | null } | null;
  activeSessions: number;
  tenants: Record<string, number>;
}

export async function systemOverview(
  config: Config, mailDelivery: "email" | "log" | "none", q: Queryable,
): Promise<SystemOverview> {
  const row = (await q.query<{ o: DbOverview }>("select public.platform_system_overview() as o")).rows[0]!.o;
  return {
    version: await appVersion(),
    commit: config.system.commit,
    serverTime: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    production: config.production,
    database: { reachable: true, time: row.databaseTime ? new Date(row.databaseTime).toISOString() : null },
    migrations: row.migrations
      ? { count: Number(row.migrations.count), latest: row.migrations.latest ?? null, appliedAt: row.migrations.appliedAt ? new Date(row.migrations.appliedAt).toISOString() : null }
      : null,
    activeSessions: Number.isFinite(Number(row.activeSessions)) ? Number(row.activeSessions) : null,
    tenants: row.tenants ?? {},
    mail: { configured: config.smtp !== null, delivery: mailDelivery },
    paymentProvider: config.paymentProvider,
    lastBackupAt: await lastBackupAt(config.system.backupStatusFile),
  };
}

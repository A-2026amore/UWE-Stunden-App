/**
 * End of contract (migration 0020, docs/betrieb.md "Vertragsende"): export and
 * deletion of a whole tenant by the operator. Used only by server/src/cli.ts on
 * the server console – never reachable over HTTP. Connects as the database
 * owner (MIGRATION_DATABASE_URL), because only the owner may execute
 * private.operator_export_tenant / private.operator_delete_tenant.
 *
 * export-tenant writes a directory (mode 0700, files 0600):
 *   firmendaten.json   complete export (format stundenwerk.tenant-data.v1)
 *   arbeitszeiten.csv  all time entries (Excel, semicolon, UTF-8 with BOM)
 *   SHA256SUMS         checksums (sha256sum -c SHA256SUMS)
 * The files are written before the transaction commits: if writing fails, the
 * audit entry of the export is rolled back as well.
 *
 * delete-tenant checks the export (format, slug, tenant id, checksum) and then
 * runs the deletion in one database transaction.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { tenantTimeEntriesCsv, type TenantDataExport } from "../../platform/src/core/privacy.ts";

export const EXPORT_JSON = "firmendaten.json";
export const EXPORT_CSV = "arbeitszeiten.csv";
export const EXPORT_SUMS = "SHA256SUMS";

/** Expected refusal (German text for the console); exit code 1. */
export class OffboardingRefused extends Error {}

export interface ExportResult {
  dir: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  employees: number;
  timeEntries: number;
  sha256: string;
}

export interface DeleteResult {
  tenantId: string;
  tenantRow: "deleted" | "tombstone";
  deletedRows: Record<string, number>;
  retainedRows: Record<string, number>;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Business errors of the database functions (German messages) become refusals. */
function refusal(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code && ["22023", "55000", "P0002", "42501"].includes(err.code)) throw new OffboardingRefused(err.message);
  throw e;
}

async function withOwnerTx<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: "uwe-zeit-cli" });
  await c.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

export async function exportTenant(url: string, slug: string, outDir: string): Promise<ExportResult> {
  if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) {
    throw new OffboardingRefused(`Das Ziel ${outDir} existiert bereits und ist nicht leer. Bitte ein neues Verzeichnis angeben.`);
  }
  return withOwnerTx(url, async (c) => {
    let data: TenantDataExport;
    try {
      data = (await c.query<{ d: TenantDataExport }>("select private.operator_export_tenant($1) as d", [slug])).rows[0]!.d;
    } catch (e) {
      refusal(e);
    }
    const json = JSON.stringify(data, null, 2) + "\n";
    const csv = tenantTimeEntriesCsv(data);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    chmodSync(outDir, 0o700);
    const files: Array<[string, string]> = [[EXPORT_JSON, json], [EXPORT_CSV, csv]];
    for (const [name, content] of files) writeFileSync(join(outDir, name), content, { mode: 0o600, flag: "wx" });
    const sums = files.map(([name, content]) => `${sha256(content)}  ${name}`).join("\n") + "\n";
    writeFileSync(join(outDir, EXPORT_SUMS), sums, { mode: 0o600, flag: "wx" });
    return {
      dir: outDir,
      tenantId: data.tenant.id,
      tenantName: data.tenant.name,
      tenantStatus: String(data.tenant.status ?? ""),
      employees: data.employees.length,
      timeEntries: data.employees.reduce((n, e) => n + e.timeEntries.length, 0),
      sha256: sha256(json),
    };
  });
}

/**
 * Reads and checks an export (directory of export-tenant or its firmendaten.json):
 * format, slug, checksum from SHA256SUMS. Returns tenant id and SHA-256 of the JSON.
 */
export function verifyExport(path: string, slug: string): { tenantId: string; sha256: string } {
  if (!existsSync(path)) throw new OffboardingRefused(`Export ${path} nicht gefunden.`);
  const dir = statSync(path).isDirectory() ? path : null;
  const file = dir ? join(dir, EXPORT_JSON) : path;
  if (!existsSync(file)) throw new OffboardingRefused(`In ${path} fehlt ${EXPORT_JSON}.`);
  const raw = readFileSync(file);
  let data: Partial<TenantDataExport>;
  try {
    data = JSON.parse(raw.toString("utf8")) as Partial<TenantDataExport>;
  } catch {
    throw new OffboardingRefused(`${file} ist kein gültiger Export (kein JSON).`);
  }
  if (data.format !== "stundenwerk.tenant-data.v1" || !data.tenant?.id) {
    throw new OffboardingRefused(`${file} ist kein Firmen-Gesamtexport.`);
  }
  if (data.tenant.slug !== slug) {
    throw new OffboardingRefused(`Der Export gehört zu "${data.tenant.slug}", nicht zu "${slug}".`);
  }
  const hash = sha256(raw);
  const sumsFile = join(dir ?? join(file, ".."), EXPORT_SUMS);
  if (existsSync(sumsFile)) {
    const line = readFileSync(sumsFile, "utf8").split("\n").find((l) => l.endsWith(`  ${EXPORT_JSON}`));
    if (!line || line.slice(0, 64) !== hash) throw new OffboardingRefused(`Die Prüfsumme von ${EXPORT_JSON} stimmt nicht mit ${EXPORT_SUMS} überein.`);
  }
  return { tenantId: data.tenant.id, sha256: hash };
}

export async function deleteTenant(
  url: string,
  input: { slug: string; confirm: string; afterExport: string | null; withoutExport: boolean },
): Promise<DeleteResult> {
  if (input.withoutExport === (input.afterExport !== null)) {
    throw new OffboardingRefused("Bitte entweder --after-export <export> oder ausdrücklich --without-export angeben.");
  }
  const checked = input.afterExport !== null ? verifyExport(input.afterExport, input.slug) : null;
  return withOwnerTx(url, async (c) => {
    if (checked) {
      const id = (await c.query<{ id: string }>("select id from public.tenants where slug = $1", [input.slug])).rows[0]?.id;
      if (id && id !== checked.tenantId) throw new OffboardingRefused("Der Export gehört zu einem anderen Mandanten (andere Kennung).");
    }
    try {
      return (await c.query<{ r: DeleteResult }>("select private.operator_delete_tenant($1, $2, $3, $4) as r",
        [input.slug, input.confirm, checked?.sha256 ?? null, input.withoutExport])).rows[0]!.r;
    } catch (e) {
      refusal(e);
    }
  });
}

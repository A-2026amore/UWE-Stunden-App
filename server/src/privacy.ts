/**
 * Data protection endpoints (migration 0016, docs/datenschutz.md):
 *
 *   GET  /api/employees/:employeeId/data-export[?format=csv]  the person themself or the owner
 *   GET  /api/tenants/:tenantId/data-export[?format=csv]      owner (export on termination)
 *   PUT  /api/tenants/:tenantId/privacy                       owner: retention period after exit
 *   POST /api/employees/:employeeId/anonymize                 owner: anonymise a former employee
 *
 * Access checks, audit entries and the anonymisation itself happen in the
 * SECURITY DEFINER functions of 0016 – the API only validates input and
 * formats the download. Responses are never cached (Cache-Control: no-store
 * from the HTTP layer) and are sent as attachments.
 */
import { personalDataCsv, tenantTimeEntriesCsv, exportFileSlug, type PersonalDataExport, type TenantDataExport } from "../../platform/src/core/privacy.ts";
import type { AppContext } from "./app.ts";
import { badRequest, forbidden } from "./errors.ts";
import type { Reply, RequestContext, Router } from "./http.ts";
import { toEmployee, toTenant } from "./mappers.ts";
import * as v from "./validate.ts";

type Format = "json" | "csv";

function formatParam(ctx: RequestContext): Format {
  const raw = ctx.query.get("format");
  if (raw === null || raw === "json") return "json";
  if (raw === "csv") return "csv";
  throw badRequest('format muss "json" oder "csv" sein.');
}

function download(name: string, format: Format, data: unknown, csv: () => string): Reply {
  const day = new Date().toISOString().slice(0, 10);
  const file = `${name}-${day}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${file}"` };
  if (format === "csv") return { status: 200, raw: csv(), headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } };
  return { status: 200, body: data, headers };
}

export function registerPrivacyRoutes(router: Router, app: AppContext): void {
  router.add("GET", "/api/employees/:employeeId/data-export", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const format = formatParam(ctx);
    const data = await app.asUser(ctx, async (q) =>
      (await q.query<{ d: PersonalDataExport }>("select public.export_personal_data($1) as d", [id])).rows[0]!.d);
    app.log({ level: "info", msg: "personal data export", requestId: ctx.requestId, employeeId: id, requestedBy: data.requestedBy });
    return download(`datenauskunft-${exportFileSlug(data.person.personnelNumber)}`, format, data, () => personalDataCsv(data));
  });

  router.add("GET", "/api/tenants/:tenantId/data-export", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const format = formatParam(ctx);
    const data = await app.asUser(ctx, async (q) =>
      (await q.query<{ d: TenantDataExport }>("select public.export_tenant_data($1) as d", [id])).rows[0]!.d);
    app.log({ level: "info", msg: "tenant data export", requestId: ctx.requestId, tenantId: id });
    return download(`firmendaten-${exportFileSlug(data.tenant.slug)}`, format, data, () => tenantTimeEntriesCsv(data));
  });

  router.add("PUT", "/api/tenants/:tenantId/privacy", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["retentionMonthsAfterExit"]);
    const months = b.retentionMonthsAfterExit === null ? null : v.int(b.retentionMonthsAfterExit, "Aufbewahrungsfrist (Monate)", 1, 600);
    return app.asUser(ctx, async (q) => {
      const owner = (await q.query("select private.is_owner($1) as ok", [id])).rows[0];
      if (!owner?.ok) throw forbidden("Die Aufbewahrungsfrist legt nur der Inhaber fest.");
      const r = (await q.query("update public.tenants set retention_months_after_exit = $2 where id = $1 returning *", [id, months])).rows[0];
      if (!r) throw forbidden("Die Aufbewahrungsfrist legt nur der Inhaber fest.");
      return { status: 200, body: toTenant(r) };
    });
  });

  router.add("POST", "/api/employees/:employeeId/anonymize", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const b = v.object(ctx.body, ["confirmPersonnelNumber"]);
    const confirm = v.str(b.confirmPersonnelNumber, { label: "die Personalnummer zur Bestätigung", max: 30, min: 1 });
    return app.asUser(ctx, async (q) => {
      const r = (await q.query("select * from public.anonymize_employee($1, $2)", [id, confirm])).rows[0];
      app.log({ level: "info", msg: "employee anonymised", requestId: ctx.requestId, employeeId: id });
      return { status: 200, body: toEmployee(r) };
    });
  });
}

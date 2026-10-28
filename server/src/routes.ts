/**
 * REST endpoints for every Repository method (platform/src/data/repository.ts).
 *
 * All queries run as app_user under Row Level Security. Explicit access
 * checks below only turn "no rows" into a clear 403 – they call the same
 * private.* helper functions the RLS policies use, so the database stays the
 * security boundary. Pause rules (6 h/9 h thresholds, daily sum) are checked
 * here with platform/src/core and the tenant's breakPolicy; the database
 * enforces the hard limits (overlap, 12 h, pause < duration, locked months).
 */
import type { BreakPolicy, TenantSettings, WorkAccountPolicy } from "../../platform/src/core/types.ts";
import type { TenantOverview } from "../../platform/src/data/repository.ts";
import { errorsForMonth, evaluateDay, issueForDay, validateBreakPolicy } from "../../platform/src/core/breaks.ts";
import { addDays, findOverlapAcrossDays } from "../../platform/src/core/time.ts";
import type { AppContext } from "./app.ts";
import type { Queryable } from "./db.ts";
import { HttpError, badRequest, forbidden } from "./errors.ts";
import type { Router } from "./http.ts";
import type { Mail } from "./mailer.ts";
import {
  STATEMENT_SELECT, TIME_ENTRY_COLUMNS, toAllocation, toAudit, toCorrectionRequest, toEmployee, toLicense, toRevision, toStatement,
  toTenant, toTimeEntry,
} from "./mappers.ts";
import * as v from "./validate.ts";

const BRANDING_BODY_LIMIT = 1_200_000; // two images of max. 300 KB as base64 + JSON
const HEX = /^#[0-9A-Fa-f]{6}$/;
const ROLES = ["employee", "manager", "owner"] as const;
const PLANS = ["pilot_free", "standard", "business", "enterprise"] as const;

type Row = Record<string, unknown>;

async function one(q: Queryable, sql: string, params: unknown[] = []): Promise<Row | undefined> {
  return (await q.query(sql, params)).rows[0] as Row | undefined;
}
async function all(q: Queryable, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await q.query(sql, params)).rows as Row[];
}
async function check(q: Queryable, sql: string, params: unknown[], message?: string): Promise<void> {
  const r = await one(q, `select (${sql}) as ok`, params);
  if (!r?.ok) throw forbidden(message);
}

/** Employee row visible to the caller (self, manager of the tenant, support with grant) – else 403. */
async function visibleEmployee(q: Queryable, employeeId: string): Promise<{ tenantId: string }> {
  const r = await one(q, "select tenant_id from public.employees where id = $1", [employeeId]);
  if (!r) throw forbidden();
  return { tenantId: String(r.tenant_id) };
}

async function isSelf(q: Queryable, employeeId: string): Promise<boolean> {
  const r = await one(q, "select exists (select 1 from public.employees e where e.id = $1 and e.user_id = auth.uid()) as self", [employeeId]);
  return Boolean(r?.self);
}

/** Serialises writes per employee so the pause check sees a consistent day. */
async function lockEmployee(q: Queryable, employeeId: string): Promise<void> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 727))", [employeeId]);
}

async function breakPolicyOf(q: Queryable, employeeId: string): Promise<BreakPolicy | null> {
  const r = await one(q,
    `select t.settings -> 'breakPolicy' as bp from public.employees e
     join public.tenants t on t.id = e.tenant_id where e.id = $1`, [employeeId]);
  return (r?.bp as BreakPolicy | undefined) ?? null;
}

async function shiftsOf(q: Queryable, employeeId: string, from: string, to: string) {
  const rows = await all(q,
    `select id, to_char(work_date, 'YYYY-MM-DD') as date, to_char(start_time, 'HH24:MI') as start,
            to_char(end_time, 'HH24:MI') as "end", pause_minutes
       from public.time_entries
      where employee_id = $1 and work_date between $2::date and $3::date and deleted_at is null`,
    [employeeId, from, to]);
  return rows.map((r) => ({ id: String(r.id), date: String(r.date), start: String(r.start), end: String(r.end), pause: Number(r.pause_minutes) }));
}

/** Pause rules of the tenant for one day of the employee (after the write, inside the same transaction). */
async function assertBreakRules(q: Queryable, employeeId: string, date: string): Promise<void> {
  const policy = await breakPolicyOf(q, employeeId);
  if (!policy) return;
  const shifts = await shiftsOf(q, employeeId, date, date);
  const problem = issueForDay(evaluateDay(shifts, date, policy), policy);
  if (problem) throw new HttpError(400, "break_rule", problem);
}

function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}

function limitParam(raw: string | null, def: number, max: number): number {
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`limit muss zwischen 1 und ${max} liegen.`);
  return n;
}

// ------------------------------------------------------------------ time-entry input

type EntryPatch = Partial<{ date: string; start: string; end: string; pauseMinutes: number; note: string }>;

function entryPatch(raw: unknown): EntryPatch {
  const p = v.object(raw, ["date", "start", "end", "pauseMinutes", "note"], "Änderung");
  const out: EntryPatch = {};
  if (p.date !== undefined) out.date = v.date(p.date);
  if (p.start !== undefined) out.start = v.clock(p.start, "Arbeitsbeginn");
  if (p.end !== undefined) out.end = v.clock(p.end, "Arbeitsende");
  if (p.pauseMinutes !== undefined) out.pauseMinutes = v.int(p.pauseMinutes, "Pause (Minuten)", 0, 719);
  if (p.note !== undefined) out.note = v.str(p.note, { label: "Die Bemerkung", max: 500 });
  return out;
}

async function updateEntry(q: Queryable, employeeId: string, id: string, body: unknown) {
  const b = v.object(body, ["patch", "expectedVersion", "reason"]);
  const patch = entryPatch(b.patch ?? {});
  const expected = v.int(b.expectedVersion, "Version", 1, 2_147_483_647);
  await lockEmployee(q, employeeId);
  const cur = await one(q, "select 1 from public.time_entries where employee_id = $1 and id = $2", [employeeId, id]);
  if (!cur) throw forbidden("Eintrag nicht gefunden oder kein Zugriff.");
  let row: Row | undefined;
  if (await isSelf(q, employeeId)) {
    row = await one(q, "select * from public.update_time_entry($1, $2, $3::jsonb, $4, $5)",
      [employeeId, id, JSON.stringify(patch), expected, v.optReason(b.reason)]);
  } else {
    // Changes to someone else's entry are corrections (leadership, reason, audit).
    const reason = v.reason(b.reason, 5, "Korrekturen durch Vorgesetzte benötigen eine Begründung (mind. 5 Zeichen).");
    row = await one(q, "select * from public.correct_time_entry($1, $2, $3::jsonb, $4, $5)",
      [employeeId, id, JSON.stringify(patch), expected, reason]);
  }
  if (!row) throw forbidden("Eintrag nicht gefunden oder kein Zugriff.");
  if (!row.deleted_at) await assertBreakRules(q, employeeId, String(row.work_date));
  return toTimeEntry(row);
}

async function deleteEntry(q: Queryable, employeeId: string, id: string, body: unknown) {
  const b = v.object(body, ["expectedVersion", "reason"]);
  const expected = v.int(b.expectedVersion, "Version", 1, 2_147_483_647);
  await lockEmployee(q, employeeId);
  const cur = await one(q, "select 1 from public.time_entries where employee_id = $1 and id = $2", [employeeId, id]);
  if (!cur) throw forbidden("Eintrag nicht gefunden oder kein Zugriff.");
  if (await isSelf(q, employeeId)) {
    await q.query("select 1 from public.delete_time_entry($1, $2, $3, $4)", [employeeId, id, expected, v.optReason(b.reason)]);
  } else {
    const reason = v.reason(b.reason, 5, "Löschungen durch Vorgesetzte benötigen eine Begründung (mind. 5 Zeichen).");
    await q.query("select 1 from public.correct_time_entry($1, $2, $3::jsonb, $4, $5)",
      [employeeId, id, JSON.stringify({ deleted: true }), expected, reason]);
  }
}

/** Entry addressed only by its client id (Repository.updateTimeEntry): resolve the employee under RLS. */
async function resolveEntryEmployee(q: Queryable, id: string): Promise<string> {
  const rows = await all(q, "select employee_id from public.time_entries where id = $1 and deleted_at is null limit 2", [id]);
  if (rows.length === 0) throw forbidden("Eintrag nicht gefunden oder kein Zugriff.");
  if (rows.length > 1) {
    throw new HttpError(409, "ambiguous", "Die Eintrags-ID ist nicht eindeutig. Bitte den Eintrag über den Mitarbeiter aufrufen.");
  }
  return String(rows[0]!.employee_id);
}

// ------------------------------------------------------------------ correction requests

const CORRECTION_SELECT = `select r.*, d.display_name as decided_by_name
  from public.correction_requests r
  left join public.employees d on d.user_id = r.decided_by and d.tenant_id = r.tenant_id`;

type Values = { date: string; start: string; end: string; pauseMinutes: number; note: string };
type CorrectionInput = { kind: "change" | "delete" | "add"; entryId: string | null; proposed: EntryPatch | null; reason: string };

function correctionInput(raw: unknown): CorrectionInput {
  const b = v.object(raw, ["kind", "entryId", "proposed", "reason"], "Korrekturanfrage");
  const kind = v.oneOf(b.kind, ["change", "delete", "add"] as const, "Art der Korrekturanfrage");
  const reason = v.reason(b.reason, 5, "Bitte begründe die Korrekturanfrage (mind. 5 Zeichen).");
  if (kind === "add") {
    if (b.entryId !== undefined && b.entryId !== null) throw badRequest("Für einen fehlenden Eintrag bitte keine Eintrags-ID angeben.");
    const p = entryPatch(b.proposed ?? {});
    if (p.date === undefined || p.start === undefined || p.end === undefined || p.pauseMinutes === undefined) {
      throw badRequest("Bitte Datum, Beginn, Ende und Pause angeben.");
    }
    return { kind, entryId: null, proposed: { note: "", ...p }, reason };
  }
  const entryId = v.entryId(b.entryId);
  if (kind === "delete") {
    if (b.proposed !== undefined && b.proposed !== null) throw badRequest("Eine Löschung enthält keine neuen Werte.");
    return { kind, entryId, proposed: null, reason };
  }
  const p = entryPatch(b.proposed ?? {});
  if (Object.keys(p).length === 0) throw badRequest("Bitte die gewünschten Werte angeben.");
  return { kind, entryId, proposed: p, reason };
}

/**
 * Same checks as for a new entry, before the request is stored: overlaps with
 * other entries and the tenant's break rules for the requested day. (The
 * database repeats the hard limits and the API the break rules on acceptance.)
 */
async function assertPlausible(q: Queryable, employeeId: string, entryId: string | null, values: Values): Promise<void> {
  const around = (await shiftsOf(q, employeeId, addDays(values.date, -1), addDays(values.date, 1))).filter((x) => x.id !== entryId);
  const candidate = { id: entryId ?? "", date: values.date, start: values.start, end: values.end, pause: values.pauseMinutes };
  const overlap = findOverlapAcrossDays(candidate, around);
  if (overlap) throw new HttpError(409, "overlap", `Der Einsatz überschneidet sich mit ${overlap.start}–${overlap.end} Uhr. Bitte die Zeiten prüfen.`);
  const policy = await breakPolicyOf(q, employeeId);
  if (!policy) return;
  const problem = issueForDay(evaluateDay([...around.filter((x) => x.date === values.date), candidate], values.date, policy), policy);
  if (problem) throw new HttpError(400, "break_rule", problem);
}

// ------------------------------------------------------------------ tenant input

function brandingPatch(raw: unknown): Record<string, unknown> {
  const b = v.object(raw, ["logoUrl", "markUrl", "primaryColor", "secondaryColor", "accentColor", "slogan"], "Branding-Angabe");
  const out: Record<string, unknown> = {};
  for (const k of ["primaryColor", "secondaryColor", "accentColor"] as const) {
    if (b[k] !== undefined) out[k] = v.str(b[k], { label: "Farbe", max: 7, pattern: HEX, patternMessage: "Farben bitte im Format #RRGGBB angeben." });
  }
  if (b.logoUrl !== undefined) out.logoUrl = v.imageUrl(b.logoUrl, "Logo");
  if (b.markUrl !== undefined) out.markUrl = v.imageUrl(b.markUrl, "Bildmarke");
  if (b.slogan !== undefined) out.slogan = v.optStr(b.slogan, { label: "Der Slogan", max: 160 });
  return out;
}

function contactPatch(raw: unknown): Record<string, unknown> {
  const c = v.object(raw, ["legalName", "street", "postalCode", "city", "phone", "whatsapp", "email", "website", "contactPerson"], "Kontaktangabe");
  const out: Record<string, unknown> = {};
  if (c.legalName !== undefined) out.legalName = v.str(c.legalName, { label: "den Firmennamen", max: 200, min: 1 });
  if (c.street !== undefined) out.street = v.str(c.street, { label: "Die Straße", max: 200 });
  if (c.postalCode !== undefined) out.postalCode = v.str(c.postalCode, { label: "Die Postleitzahl", max: 10, pattern: /^[0-9A-Za-z -]*$/ });
  if (c.city !== undefined) out.city = v.str(c.city, { label: "Der Ort", max: 120 });
  if (c.phone !== undefined) out.phone = v.optStr(c.phone, { label: "Die Telefonnummer", max: 40, pattern: /^[0-9 +()/-]+$/, patternMessage: "Telefonnummer: nur Ziffern, Leerzeichen und + ( ) / -." });
  if (c.whatsapp !== undefined) out.whatsapp = v.optStr(c.whatsapp, { label: "Die WhatsApp-Nummer", max: 15, pattern: /^[1-9][0-9]{7,14}$/, patternMessage: "WhatsApp-Nummer bitte nur als Ziffern mit Ländervorwahl angeben, z. B. 492411234567." });
  if (c.email !== undefined) out.email = c.email === null || c.email === "" ? null : v.email(c.email);
  if (c.website !== undefined) out.website = v.optStr(c.website, { label: "Die Website", max: 300, pattern: /^https?:\/\/[^\s"<>]+$/, patternMessage: "Die Website muss mit https:// beginnen." });
  if (c.contactPerson !== undefined) out.contactPerson = v.optStr(c.contactPerson, { label: "Die Ansprechperson", max: 200 });
  return out;
}

function mergeSettings(current: TenantSettings, raw: unknown): TenantSettings {
  const s = v.object(raw, ["breakPolicy", "workAccount"], "Einstellung");
  const next: TenantSettings = { breakPolicy: { ...current.breakPolicy }, workAccount: { ...current.workAccount } };
  if (s.breakPolicy !== undefined) {
    const bp = v.object(s.breakPolicy, ["thresholds", "maxShiftMinutes", "minPauseSegmentMinutes"], "Pausenregel");
    if (bp.maxShiftMinutes !== undefined) next.breakPolicy.maxShiftMinutes = v.int(bp.maxShiftMinutes, "Maximale Einsatzdauer (Minuten)", 60, 720);
    if (bp.minPauseSegmentMinutes !== undefined) next.breakPolicy.minPauseSegmentMinutes = v.int(bp.minPauseSegmentMinutes, "Mindestdauer eines Pausenabschnitts", 0, 60);
    if (bp.thresholds !== undefined) {
      if (!Array.isArray(bp.thresholds) || bp.thresholds.length > 10) throw badRequest("Pausenschwellen: Liste mit höchstens 10 Einträgen erwartet.");
      let prev = 0;
      next.breakPolicy.thresholds = bp.thresholds.map((t: unknown) => {
        const o = v.object(t, ["minGrossMinutes", "minPauseMinutes"], "Pausenschwelle");
        const g = v.int(o.minGrossMinutes, "Schwelle (Minuten)", 1, 720);
        if (g <= prev) throw badRequest("Pausenschwellen müssen aufsteigend sortiert sein.");
        prev = g;
        return { minGrossMinutes: g, minPauseMinutes: v.int(o.minPauseMinutes, "Pause (Minuten)", 0, 180) };
      });
    }
    const problems = validateBreakPolicy(next.breakPolicy);
    if (problems.length) throw badRequest(problems[0]!);
  }
  if (s.workAccount !== undefined) {
    const wa = v.object(s.workAccount, ["enabled", "model", "openingMinutes", "federalState", "startMonth", "approvalRequired"], "Kontoeinstellung");
    const w: WorkAccountPolicy = next.workAccount;
    if (wa.enabled !== undefined) w.enabled = v.bool(wa.enabled, "Arbeitszeitkonto aktiv");
    if (wa.approvalRequired !== undefined) w.approvalRequired = v.bool(wa.approvalRequired, "Freigabe erforderlich");
    if (wa.model !== undefined) w.model = v.oneOf(wa.model, ["school-year", "calendar-year"] as const, "Kontomodell");
    if (wa.openingMinutes !== undefined) w.openingMinutes = v.int(wa.openingMinutes, "Startsaldo (Minuten)", -600000, 600000);
    if (wa.federalState !== undefined) {
      w.federalState = wa.federalState === null ? null
        : v.oneOf(wa.federalState, ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"] as const, "Bundesland");
    }
    if (wa.startMonth !== undefined) w.startMonth = v.month(wa.startMonth);
    if (w.model === "school-year" && !w.federalState) throw badRequest("Für das Schuljahr-Modell bitte ein Bundesland wählen.");
  }
  return next;
}

// ------------------------------------------------------------------ routes

export function registerDomainRoutes(router: Router, app: AppContext): void {
  const json = (status: number, body: unknown) => ({ status, body });

  function invitationMail(email: string, token: string, tenantName: string): Mail {
    return {
      to: email,
      subject: `Einladung zur Zeiterfassung – ${tenantName}`,
      text: `Hallo,\n\ndu wurdest zur Zeiterfassung von ${tenantName} eingeladen. Über diesen Link legst du dein Passwort fest:\n\n${app.link("invite", token)}\n\nDer Link ist begrenzt gültig. Wenn du diese Einladung nicht erwartet hast, kannst du die E-Mail ignorieren.\n`,
    };
  }

  // ---------------------------------------------------------------- tenant
  router.add("GET", "/api/tenants/:tenantId", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    return app.asUser(ctx, async (q) => {
      const r = await one(q, "select * from public.tenants where id = $1", [id]);
      if (!r) throw forbidden();
      return json(200, toTenant(r));
    });
  });

  router.add("PATCH", "/api/tenants/:tenantId/branding", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const patch = brandingPatch(ctx.body);
    return app.asUser(ctx, async (q) => {
      // Owner only – platform staff neither (also not with a support grant; RLS tenants_update since 0011).
      await check(q, "private.is_owner($1)", [id], "Firmendaten darf nur der Inhaber ändern.");
      const r = await one(q, "update public.tenants set branding = branding || $2::jsonb where id = $1 returning *", [id, JSON.stringify(patch)]);
      if (!r) throw forbidden("Firmendaten darf nur der Inhaber ändern.");
      return json(200, toTenant(r));
    });
  }, { bodyLimit: BRANDING_BODY_LIMIT });

  router.add("PATCH", "/api/tenants/:tenantId/contact", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const patch = contactPatch(ctx.body);
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_owner($1)", [id], "Firmendaten darf nur der Inhaber ändern.");
      const r = await one(q, "update public.tenants set contact = contact || $2::jsonb where id = $1 returning *", [id, JSON.stringify(patch)]);
      if (!r) throw forbidden("Firmendaten darf nur der Inhaber ändern.");
      return json(200, toTenant(r));
    });
  });

  router.add("PATCH", "/api/tenants/:tenantId/settings", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_owner($1)", [id], "Einstellungen darf nur der Inhaber ändern.");
      const cur = await one(q, "select settings from public.tenants where id = $1 for update", [id]);
      if (!cur) throw forbidden();
      const next = mergeSettings(cur.settings as TenantSettings, ctx.body);
      const r = await one(q, "update public.tenants set settings = $2::jsonb where id = $1 returning *", [id, JSON.stringify(next)]);
      if (!r) throw forbidden("Einstellungen darf nur der Inhaber ändern.");
      return json(200, toTenant(r));
    });
  });

  // Owner: managers and owners of the tenant must use two-factor authentication.
  // Switching it on requires the owner's own 2FA first (otherwise the owner
  // would immediately be sent to the setup).
  router.add("PUT", "/api/tenants/:tenantId/two-factor-policy", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["requireTwoFactorForManagers"]);
    if (typeof b.requireTwoFactorForManagers !== "boolean") throw badRequest("requireTwoFactorForManagers muss true oder false sein.");
    const required = b.requireTwoFactorForManagers;
    return app.asUser(ctx, async (q, s) => {
      await check(q, "private.is_owner($1)", [id], "Die Zwei-Faktor-Pflicht kann nur der Inhaber ändern.");
      if (required && !s.twoFactorEnrolled) {
        throw new HttpError(409, "invalid_state", "Bitte richte zuerst für dein eigenes Konto die Zwei-Faktor-Anmeldung ein.");
      }
      const r = await one(q, "update public.tenants set require_two_factor_for_managers = $2 where id = $1 returning *", [id, required]);
      if (!r) throw forbidden("Die Zwei-Faktor-Pflicht kann nur der Inhaber ändern.");
      return json(200, toTenant(r));
    });
  });

  // Support access (owner grants; manager and platform staff can see it).
  router.add("GET", "/api/tenants/:tenantId/support-grant", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_manager($1) or private.is_platform_admin()", [id]);
      const r = await one(q,
        `select tenant_id, expires_at, granted_by from public.support_access_grants
          where tenant_id = $1 and revoked_at is null and starts_at <= now() and expires_at > now()
          order by expires_at desc limit 1`, [id]);
      return json(200, r ? { tenantId: r.tenant_id, grantedUntil: (r.expires_at as Date).toISOString(), grantedBy: r.granted_by } : null);
    });
  });

  router.add("PUT", "/api/tenants/:tenantId/support-grant", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["hours", "reason"]);
    const hours = v.int(b.hours, "Dauer (Stunden)", 0, 168);
    const reason = b.reason === undefined ? "Supportzugriff über die Einstellungen freigegeben" : v.reason(b.reason, 5, "Bitte den Anlass der Freigabe angeben (mind. 5 Zeichen).");
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_owner($1)", [id], "Nur der Inhaber kann dem Support Zugriff gewähren.");
      const active = await all(q, "select id from public.support_access_grants where tenant_id = $1 and revoked_at is null and expires_at > now()", [id]);
      for (const g of active) await q.query("select 1 from public.revoke_support_access($1)", [g.id]);
      if (hours === 0) return json(200, null);
      const r = await one(q, "select * from public.grant_support_access($1, $2, $3, null)", [id, hours, reason]);
      return json(200, { tenantId: r!.tenant_id, grantedUntil: (r!.expires_at as Date).toISOString(), grantedBy: r!.granted_by });
    });
  });

  // ---------------------------------------------------------------- employees
  router.add("GET", "/api/tenants/:tenantId/employees", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_member($1) or private.has_support_access($1)", [id]);
      const rows = await all(q, "select * from public.employees where tenant_id = $1 order by display_name, id", [id]);
      return json(200, rows.map(toEmployee));
    });
  });

  router.add("POST", "/api/tenants/:tenantId/employees", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["displayName", "personnelNumber", "email", "role"]);
    const displayName = v.str(b.displayName, { label: "den Namen", max: 120, min: 1 });
    const personnelNumber = v.str(b.personnelNumber, { label: "die Personalnummer", max: 30, min: 1, pattern: /^[A-Za-z0-9_-]{1,30}$/, patternMessage: "Personalnummer: 1–30 Zeichen, nur Buchstaben, Ziffern, - und _." });
    const email = b.email === null || b.email === undefined || b.email === "" ? null : v.email(b.email);
    const role = v.oneOf(b.role ?? "employee", ROLES, "Rolle");
    const mails: Mail[] = [];
    const result = await app.asUser(ctx, async (q) => {
      await check(q, "private.is_manager($1)", [id], "Mitarbeitende dürfen nur Vorgesetzte anlegen.");
      const r = await one(q,
        `insert into public.employees (tenant_id, personnel_number, display_name, email, role, status)
         values ($1, $2, $3, $4, $5, 'invited') returning *`, [id, personnelNumber, displayName, email, role]);
      if (email) {
        const inv = await one(q, "select public.create_invitation($1, 7) as inv", [r!.id]);
        const t = await one(q, "select name from public.tenants where id = $1", [id]);
        const data = inv!.inv as { token: string; expiresAt: string };
        mails.push(invitationMail(email, String(data.token), String(t?.name ?? "")));
        // The link itself is never returned: only the invited address receives it.
        return json(201, { ...toEmployee(r!), invitation: { expiresAt: data.expiresAt, delivery: app.mailDelivery } });
      }
      return json(201, toEmployee(r!));
    });
    app.sendLater(mails);
    return result;
  });

  router.add("POST", "/api/employees/:employeeId/invitation", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const mails: Mail[] = [];
    const result = await app.asUser(ctx, async (q) => {
      const inv = await one(q, "select public.create_invitation($1, 7) as inv", [id]);
      const e = await one(q, "select e.email, t.name from public.employees e join public.tenants t on t.id = e.tenant_id where e.id = $1", [id]);
      const data = inv!.inv as { invitationId: string; token: string; expiresAt: string };
      mails.push(invitationMail(String(e!.email), data.token, String(e!.name)));
      return json(200, { invitationId: data.invitationId, expiresAt: data.expiresAt, delivery: app.mailDelivery });
    });
    app.sendLater(mails);
    return result;
  });

  router.add("PATCH", "/api/employees/:employeeId", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const b = v.object(ctx.body, ["displayName", "personnelNumber", "email", "role"]);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (b.displayName !== undefined) add("display_name", v.str(b.displayName, { label: "den Namen", max: 120, min: 1 }));
    if (b.personnelNumber !== undefined) add("personnel_number", v.str(b.personnelNumber, { label: "die Personalnummer", max: 30, min: 1, pattern: /^[A-Za-z0-9_-]{1,30}$/, patternMessage: "Personalnummer: 1–30 Zeichen, nur Buchstaben, Ziffern, - und _." }));
    if (b.email !== undefined) add("email", b.email === null || b.email === "" ? null : v.email(b.email));
    if (b.role !== undefined) add("role", v.oneOf(b.role, ROLES, "Rolle"));
    return app.asUser(ctx, async (q) => {
      const r = sets.length
        ? await one(q, `update public.employees set ${sets.join(", ")} where id = $1 returning *`, params)
        : await one(q, "select * from public.employees where id = $1", [id]);
      if (!r) throw forbidden();
      return json(200, toEmployee(r));
    });
  });

  router.add("POST", "/api/employees/:employeeId/status", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const b = v.object(ctx.body, ["status", "reason"]);
    const status = v.oneOf(b.status, ["active", "deactivated"] as const, "Status");
    const reason = v.reason(b.reason, 3, "Bitte einen Grund für die Statusänderung angeben.");
    return app.asUser(ctx, async (q) => {
      const r = await one(q, "select * from public.set_employee_status($1, $2, $3)", [id, status, reason]);
      return json(200, toEmployee(r!));
    });
  });

  // ---------------------------------------------------------------- time entries
  router.add("GET", "/api/employees/:employeeId/time-entries", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const [from, to] = monthRange(v.month(ctx.query.get("month")));
    return app.asUser(ctx, async (q) => {
      await visibleEmployee(q, id);
      const rows = await all(q,
        `select ${TIME_ENTRY_COLUMNS} from public.time_entries
          where employee_id = $1 and work_date between $2::date and $3::date and deleted_at is null
          order by work_date, start_time, id`, [id, from, to]);
      return json(200, rows.map(toTimeEntry));
    });
  });

  router.add("GET", "/api/tenants/:tenantId/time-entries", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const from = v.date(ctx.query.get("from"), "Startdatum");
    const to = v.date(ctx.query.get("to"), "Enddatum");
    if (to < from) throw badRequest("Das Enddatum liegt vor dem Startdatum.");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) throw badRequest("Der Zeitraum darf höchstens 400 Tage umfassen.");
    return app.asUser(ctx, async (q) => {
      await check(q, "private.can_read_personal($1)", [id]);
      const rows = await all(q,
        `select ${TIME_ENTRY_COLUMNS} from public.time_entries
          where tenant_id = $1 and work_date between $2::date and $3::date and deleted_at is null
          order by work_date, start_time, employee_id, id`, [id, from, to]);
      return json(200, rows.map(toTimeEntry));
    });
  });

  // Idempotent: 201 for a new entry, 200 with the stored entry for a repeated id.
  router.add("POST", "/api/employees/:employeeId/time-entries", async (ctx) => {
    const employeeId = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const b = v.object(ctx.body, ["id", "date", "start", "end", "pauseMinutes", "note", "source"], "Eintrag");
    const entry = {
      id: v.entryId(b.id),
      date: v.date(b.date),
      start: v.clock(b.start, "Arbeitsbeginn"),
      end: v.clock(b.end, "Arbeitsende"),
      pauseMinutes: v.int(b.pauseMinutes ?? 0, "Pause (Minuten)", 0, 719),
      note: b.note === undefined ? "" : v.str(b.note, { label: "Die Bemerkung", max: 500 }),
      source: b.source === undefined ? "app" : v.oneOf(b.source, ["app", "migration"] as const, "Herkunft"),
    };
    return app.asUser(ctx, async (q) => {
      // "migration" marks entries taken over from the legacy app. The import runs in the employee
      // app for the signed-in person's own data only – nobody marks entries of others (QA B5).
      if (entry.source === "migration" && !(await isSelf(q, employeeId))) {
        throw forbidden("Altdaten können nur für das eigene Konto übernommen werden.");
      }
      await lockEmployee(q, employeeId);
      const existed = await one(q, "select 1 from public.time_entries where employee_id = $1 and id = $2", [employeeId, entry.id]);
      const row = await one(q, "select * from public.create_time_entry($1, $2::jsonb)", [employeeId, JSON.stringify(entry)]);
      if (!row || row.id === null) throw forbidden();
      if (existed) return json(200, toTimeEntry(row));
      await assertBreakRules(q, employeeId, entry.date);
      return json(201, toTimeEntry(row));
    });
  });

  router.add("PATCH", "/api/employees/:employeeId/time-entries/:entryId", async (ctx) => {
    const employeeId = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const id = v.entryId(ctx.params.entryId);
    return app.asUser(ctx, async (q) => json(200, await updateEntry(q, employeeId, id, ctx.body)));
  });

  router.add("DELETE", "/api/employees/:employeeId/time-entries/:entryId", async (ctx) => {
    const employeeId = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const id = v.entryId(ctx.params.entryId);
    return app.asUser(ctx, async (q) => {
      await deleteEntry(q, employeeId, id, ctx.body);
      return { status: 204 };
    });
  });

  router.add("PATCH", "/api/time-entries/:entryId", async (ctx) => {
    const id = v.entryId(ctx.params.entryId);
    return app.asUser(ctx, async (q) => json(200, await updateEntry(q, await resolveEntryEmployee(q, id), id, ctx.body)));
  });

  router.add("DELETE", "/api/time-entries/:entryId", async (ctx) => {
    const id = v.entryId(ctx.params.entryId);
    return app.asUser(ctx, async (q) => {
      await deleteEntry(q, await resolveEntryEmployee(q, id), id, ctx.body);
      return { status: 204 };
    });
  });

  // ---------------------------------------------------------------- work account
  router.add("GET", "/api/employees/:employeeId/allocations", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    return app.asUser(ctx, async (q) => {
      await visibleEmployee(q, id);
      const rows = await all(q, "select * from public.work_account_allocations where employee_id = $1 order by month", [id]);
      return json(200, rows.map(toAllocation));
    });
  });

  router.add("PUT", "/api/employees/:employeeId/allocations/:month", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const month = v.month(ctx.params.month);
    const b = v.object(ctx.body, ["minutes"]);
    const minutes = v.int(b.minutes, "Minuten", 0, 600000);
    return app.asUser(ctx, async (q) => {
      const r = await one(q, "select * from public.set_allocation($1, $2, $3)", [id, month, minutes]);
      return json(200, toAllocation(r!));
    });
  });

  router.add("POST", "/api/employees/:employeeId/allocations/:month/review", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const month = v.month(ctx.params.month);
    const b = v.object(ctx.body, ["decision", "reason"]);
    const decision = v.oneOf(b.decision, ["approved", "rejected"] as const, "Entscheidung");
    const reason = decision === "rejected"
      ? v.reason(b.reason, 3, "Für eine Ablehnung ist eine Begründung erforderlich.")
      : v.optReason(b.reason);
    return app.asUser(ctx, async (q) => {
      const r = await one(q, "select * from public.review_allocation($1, $2, $3, $4)", [id, month, decision, reason]);
      return json(200, toAllocation(r!));
    });
  });

  // ---------------------------------------------------------------- monthly statements
  router.add("GET", "/api/tenants/:tenantId/statements", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const month = v.month(ctx.query.get("month"));
    return app.asUser(ctx, async (q) => {
      await check(q, "private.can_read_personal($1)", [id]);
      const rows = await all(q, `${STATEMENT_SELECT} where s.tenant_id = $1 and s.month = $2 order by s.employee_id`, [id, month]);
      return json(200, rows.map(toStatement));
    });
  });

  router.add("GET", "/api/employees/:employeeId/statements/:month", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const month = v.month(ctx.params.month);
    return app.asUser(ctx, async (q) => {
      await visibleEmployee(q, id);
      const r = await one(q, `${STATEMENT_SELECT} where s.employee_id = $1 and s.month = $2`, [id, month]);
      return json(200, r ? toStatement(r) : null);
    });
  });

  router.add("POST", "/api/employees/:employeeId/statements/:month/submit", async (ctx) => {
    const id = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const month = v.month(ctx.params.month);
    v.object(ctx.body, []);
    return app.asUser(ctx, async (q) => {
      await visibleEmployee(q, id);
      const policy = await breakPolicyOf(q, id);
      if (policy) {
        const [from, to] = monthRange(month);
        const issues = errorsForMonth(await shiftsOf(q, id, from, to), month, policy);
        const first = issues[0];
        if (first) {
          const d = first.date;
          throw new HttpError(400, "break_rule", `Bitte zunächst die Pause korrigieren. ${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}: ${first.message}`);
        }
      }
      const r = await one(q, "select * from public.submit_statement($1, $2)", [id, month]);
      return json(200, toStatement(r!));
    });
  });

  router.add("POST", "/api/statements/:statementId/approve", async (ctx) => {
    const id = v.uuid(ctx.params.statementId, "Abrechnungs-ID");
    v.object(ctx.body, []);
    return app.asUser(ctx, async (q) => json(200, toStatement((await one(q, "select * from public.approve_statement($1)", [id]))!)));
  });

  router.add("POST", "/api/statements/:statementId/return", async (ctx) => {
    const id = v.uuid(ctx.params.statementId, "Abrechnungs-ID");
    const b = v.object(ctx.body, ["reason"]);
    const reason = v.reason(b.reason, 3, "Bitte einen Grund für die Rückgabe angeben.");
    return app.asUser(ctx, async (q) => json(200, toStatement((await one(q, "select * from public.return_statement($1, $2)", [id, reason]))!)));
  });

  // ---------------------------------------------------------------- correction requests
  router.add("GET", "/api/tenants/:tenantId/correction-requests", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const employeeId = ctx.query.get("employeeId");
    const status = ctx.query.get("status");
    const params: unknown[] = [id];
    let where = "r.tenant_id = $1";
    if (employeeId) {
      params.push(v.uuid(employeeId, "Mitarbeiter-ID"));
      where += ` and r.employee_id = $${params.length}`;
    }
    if (status) {
      params.push(v.oneOf(status, ["open", "accepted", "rejected", "withdrawn"] as const, "Status"));
      where += ` and r.status = $${params.length}`;
    }
    return app.asUser(ctx, async (q) => {
      // RLS: employees see only their own requests, leadership the tenant, platform staff only with a grant.
      await check(q, "private.is_member($1) or private.has_support_access($1)", [id]);
      const rows = await all(q, `${CORRECTION_SELECT} where ${where} order by r.created_at desc, r.id limit 500`, params);
      return json(200, rows.map(toCorrectionRequest));
    });
  });

  router.add("POST", "/api/employees/:employeeId/correction-requests", async (ctx) => {
    const employeeId = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const input = correctionInput(ctx.body);
    return app.asUser(ctx, async (q) => {
      if (!(await isSelf(q, employeeId))) throw forbidden("Korrekturanfragen können nur für eigene Einträge gestellt werden.");
      await lockEmployee(q, employeeId);
      if (input.kind !== "delete") {
        let values = input.proposed as Values;
        if (input.kind === "change") {
          const cur = await one(q, `select ${TIME_ENTRY_COLUMNS} from public.time_entries where employee_id = $1 and id = $2 and deleted_at is null`,
            [employeeId, input.entryId]);
          if (!cur) throw forbidden("Eintrag nicht gefunden oder bereits gelöscht.");
          const e = toTimeEntry(cur);
          values = { date: e.date, start: e.start, end: e.end, pauseMinutes: e.pauseMinutes, note: e.note, ...input.proposed };
        }
        await assertPlausible(q, employeeId, input.entryId, values);
      }
      const created = await one(q, "select id from public.create_correction_request($1, $2, $3, $4::jsonb, $5)",
        [employeeId, input.kind, input.entryId, input.proposed ? JSON.stringify(input.proposed) : null, input.reason]);
      const r = await one(q, `${CORRECTION_SELECT} where r.id = $1`, [created!.id]);
      return json(201, toCorrectionRequest(r!));
    });
  });

  router.add("POST", "/api/correction-requests/:requestId/withdraw", async (ctx) => {
    const id = v.uuid(ctx.params.requestId, "Anfrage-ID");
    v.object(ctx.body, []);
    return app.asUser(ctx, async (q) => {
      await q.query("select 1 from public.withdraw_correction_request($1)", [id]);
      return json(200, toCorrectionRequest((await one(q, `${CORRECTION_SELECT} where r.id = $1`, [id]))!));
    });
  });

  router.add("POST", "/api/correction-requests/:requestId/decide", async (ctx) => {
    const id = v.uuid(ctx.params.requestId, "Anfrage-ID");
    const b = v.object(ctx.body, ["decision", "note"]);
    const decision = v.oneOf(b.decision, ["accepted", "rejected"] as const, "Entscheidung");
    const note = decision === "rejected" ? v.reason(b.note, 3, "Bitte begründe die Ablehnung.") : v.optReason(b.note);
    return app.asUser(ctx, async (q) => {
      const cur = await one(q, "select employee_id from public.correction_requests where id = $1", [id]);
      if (!cur) throw forbidden("Korrekturanfrage nicht gefunden oder kein Zugriff.");
      const employeeId = String(cur.employee_id);
      await lockEmployee(q, employeeId);
      const decided = await one(q, "select * from public.decide_correction_request($1, $2, $3)", [id, decision, note]);
      if (decision === "accepted" && decided?.applied_entry_id) {
        // Statutory break rules of the tenant for the corrected day – rollback on a violation, like every correction.
        const e = await one(q, "select to_char(work_date, 'YYYY-MM-DD') as d, deleted_at from public.time_entries where employee_id = $1 and id = $2",
          [employeeId, decided.applied_entry_id]);
        if (e && !e.deleted_at) await assertBreakRules(q, employeeId, String(e.d));
      }
      return json(200, toCorrectionRequest((await one(q, `${CORRECTION_SELECT} where r.id = $1`, [id]))!));
    });
  });

  // Change history of one entry (time_entry_revisions under RLS; platform staff only with a grant).
  router.add("GET", "/api/employees/:employeeId/time-entries/:entryId/revisions", async (ctx) => {
    const employeeId = v.uuid(ctx.params.employeeId, "Mitarbeiter-ID");
    const entryId = v.entryId(ctx.params.entryId);
    return app.asUser(ctx, async (q) => {
      await visibleEmployee(q, employeeId);
      const rows = await all(q,
        `select r.*, c.display_name as changed_by_name
           from public.time_entry_revisions r
           left join public.employees c on c.user_id = r.changed_by and c.tenant_id = r.tenant_id
          where r.employee_id = $1 and r.entry_id = $2
          order by r.version, r.changed_at`, [employeeId, entryId]);
      if (rows.length === 0) throw forbidden("Eintrag nicht gefunden oder kein Zugriff.");
      return json(200, rows.map(toRevision));
    });
  });

  // ---------------------------------------------------------------- audit
  router.add("GET", "/api/tenants/:tenantId/audit", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const limit = limitParam(ctx.query.get("limit"), 200, 1000);
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_manager($1) or private.is_platform_admin()", [id]);
      const rows = await all(q, "select * from public.audit_log where tenant_id = $1 order by created_at desc, id limit $2", [id, limit]);
      return json(200, rows.map(toAudit));
    });
  });

  router.add("GET", "/api/platform/audit", async (ctx) => {
    const limit = limitParam(ctx.query.get("limit"), 100, 1000);
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_platform_admin()", [], "Nur für die Plattformverwaltung.");
      const rows = await all(q,
        `select * from public.audit_log
          where tenant_id is null or entity in ('tenant', 'license', 'support_access_grant')
          order by created_at desc, id limit $1`, [limit]);
      return json(200, rows.map(toAudit));
    });
  });

  // ---------------------------------------------------------------- platform administration
  async function overviews(q: Queryable, onlyTenant?: string): Promise<TenantOverview[]> {
    const list = await all(q, "select * from public.platform_list_tenants()");
    const tenants = await all(q, "select * from public.tenants");
    const licenses = await all(q, "select * from public.licenses where status = 'active'");
    const byId = new Map(tenants.map((t) => [String(t.id), t]));
    const licByTenant = new Map(licenses.map((l) => [String(l.tenant_id), l]));
    return list
      .filter((x) => !onlyTenant || x.tenant_id === onlyTenant)
      .filter((x) => byId.has(String(x.tenant_id)))
      .map((x) => {
        const lic = licByTenant.get(String(x.tenant_id));
        return {
          tenant: toTenant(byId.get(String(x.tenant_id))!),
          license: lic ? toLicense(lic) : null,
          employeeCount: Number(x.employee_count),
          activeEmployeeCount: Number(x.active_employee_count),
        };
      });
  }

  router.add("GET", "/api/platform/tenants", async (ctx) =>
    app.asUser(ctx, async (q) => json(200, await overviews(q))));

  router.add("POST", "/api/platform/tenants", async (ctx) => {
    const b = v.object(ctx.body, ["name", "slug", "plan", "isDemo", "ownerEmail", "ownerName"]);
    const name = v.str(b.name, { label: "den Firmennamen", max: 200, min: 2 });
    const slug = v.str(b.slug, { label: "den Kurznamen", max: 50, min: 3, pattern: /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, patternMessage: "Kurzname: 3–50 Zeichen, nur Kleinbuchstaben, Ziffern und Bindestriche." });
    const plan = v.oneOf(b.plan, PLANS, "Tarif");
    const isDemo = v.bool(b.isDemo ?? false, "Demo-Mandant");
    const ownerEmail = v.email(b.ownerEmail);
    const ownerName = b.ownerName === undefined ? "Inhaber/in" : v.str(b.ownerName, { label: "den Namen", max: 120, min: 1 });
    const mails: Mail[] = [];
    const result = await app.asUser(ctx, async (q) => {
      const r = await one(q, "select public.create_tenant($1, $2, $3, $4, $5, $6, null) as res", [name, slug, plan, isDemo, ownerEmail, ownerName]);
      const res = r!.res as { tenantId: string; invitationToken: string };
      mails.push(invitationMail(ownerEmail, res.invitationToken, name));
      const [ov] = await overviews(q, res.tenantId);
      return json(201, ov);
    });
    app.sendLater(mails);
    return result;
  });

  router.add("POST", "/api/platform/tenants/:tenantId/status", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["status", "reason"]);
    const status = v.oneOf(b.status, ["active", "suspended", "pending"] as const, "Status");
    const reason = v.reason(b.reason, 3, "Bitte einen Grund für die Statusänderung angeben.");
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_platform_admin(array['super_admin'])", [], "Nur Super-Admins dürfen den Mandantenstatus ändern.");
      const r = await one(q, "select * from public.set_tenant_status($1, $2, $3)", [id, status, reason]);
      return json(200, toTenant(r!));
    });
  });

  router.add("PUT", "/api/platform/tenants/:tenantId/license", async (ctx) => {
    const id = v.uuid(ctx.params.tenantId, "Mandanten-ID");
    const b = v.object(ctx.body, ["plan", "maxEmployees", "validUntil", "note", "features"]);
    const plan = v.oneOf(b.plan, PLANS, "Tarif");
    const maxEmployees = b.maxEmployees === undefined ? undefined : b.maxEmployees === null ? null : v.int(b.maxEmployees, "Maximale Mitarbeiterzahl", 1, 100000);
    const validUntil = b.validUntil === undefined ? undefined : b.validUntil === null ? null : v.date(b.validUntil, "Enddatum");
    const note = b.note === undefined ? undefined : v.optStr(b.note, { label: "Die Notiz", max: 2000 });
    let features: string[] | undefined;
    if (b.features !== undefined) {
      if (!Array.isArray(b.features) || b.features.length > 50) throw badRequest("Funktionen: Liste mit höchstens 50 Einträgen erwartet.");
      features = b.features.map((f: unknown) => v.str(f, { label: "Funktion", max: 50, min: 1, pattern: /^[a-z0-9_]+$/ }));
    }
    return app.asUser(ctx, async (q) => {
      await check(q, "private.is_platform_admin(array['super_admin'])", [], "Nur Super-Admins dürfen Lizenzen ändern.");
      const cur = await one(q, "select * from public.licenses where tenant_id = $1 and status = 'active' for update", [id]);
      const free = plan === "pilot_free";
      let r: Row | undefined;
      if (cur) {
        r = await one(q,
          `update public.licenses set plan = $2,
             price_cents = case when $3 then 0 else price_cents end,
             billing = case when $3 then 'none' when billing = 'none' then 'manual' else billing end,
             max_employees = case when $4 then $5::integer else max_employees end,
             valid_until = case when $6 then $7::date else valid_until end,
             note = case when $8 then $9::text else note end,
             features = coalesce($10::text[], features)
           where id = $1 returning *`,
          [cur.id, plan, free, maxEmployees !== undefined, maxEmployees ?? null, validUntil !== undefined, validUntil ?? null,
            note !== undefined, note ?? null, features ?? null]);
      } else {
        const t = await one(q, "select id from public.tenants where id = $1", [id]);
        if (!t) throw forbidden("Mandant nicht gefunden.");
        r = await one(q,
          `insert into public.licenses (tenant_id, plan, status, price_cents, billing, max_employees, valid_until, note, features)
           values ($1, $2, 'active', 0, $3, $4, $5, $6, coalesce($7::text[], '{}')) returning *`,
          [id, plan, free ? "none" : "manual", maxEmployees ?? null, validUntil ?? null, note ?? null, features ?? null]);
      }
      return json(200, toLicense(r!));
    });
  });
}

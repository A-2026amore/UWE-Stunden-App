/**
 * Data protection exports (GDPR access / portability) and the retention rule
 * for anonymising former employees.
 *
 * The JSON shape is produced by the database (public.export_personal_data /
 * public.export_tenant_data, migration 0016) and by the demo repository; the
 * CSV variants below turn it into a readable table for spreadsheet programs
 * (semicolon-separated, UTF-8 with BOM, formula-safe cells via csvRow).
 *
 * Legal periods are NOT defined here: the retention period after an employee
 * left is a tenant setting (retentionMonthsAfterExit) – to be checked legally.
 */
import { csvRow } from "./csv";
import { formatDateDE, formatHours } from "./time";

export interface ExportPerson {
  id: string;
  personnelNumber: string;
  displayName: string;
  email: string | null;
  role: string;
  status: string;
  createdAt: string;
  anonymizedAt: string | null;
}

export interface ExportTimeEntry {
  id: string;
  employeeId: string;
  date: string;
  start: string;
  end: string;
  pauseMinutes: number;
  durationMinutes: number;
  note: string;
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ExportAuditEvent {
  id: string;
  createdAt: string;
  action: string;
  entity: string;
  entityId: string | null;
  actorId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
}

/** Records of one person inside one tenant (both exports). */
export interface ExportRecords {
  statusHistory: Array<{ status: string; role: string; validFrom: string; validTo: string | null }>;
  timeEntries: ExportTimeEntry[];
  revisions: Array<{
    entryId: string; version: number; operation: string; isCorrection: boolean; changedAt: string;
    changedBy: string | null; changedByName: string | null; reason: string | null; snapshot: unknown;
  }>;
  allocations: Array<{ month: string; minutes: number; status: string; reviewedAt: string | null; reviewNote: string | null }>;
  statements: Array<{
    month: string; status: string; submittedAt: string | null; reviewedAt: string | null; reviewNote: string | null;
    workedMinutes: number; allocatedMinutes: number; billingMinutes: number;
  }>;
  correctionRequests: Array<{
    id: string; kind: string; entryId: string | null; before: unknown; proposed: unknown; reason: string;
    status: string; createdAt: string; decidedAt: string | null; decisionNote: string | null;
  }>;
  invitations: Array<{ email: string; createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }>;
  billingMonths: Array<{ month: string; reason: string }>;
  /** Contract data (0025); missing in exports from before. */
  employmentContracts?: Array<{
    validFrom: string; employmentType: string; hourlyWageCents: number | null; monthlyTargetMinutes: number | null;
    carryOverMinutes: number; updatedAt: string;
  }>;
}

export interface PersonalDataExport extends ExportRecords {
  format: "stundenwerk.personal-data.v1";
  generatedAt: string;
  /** "self" = the person exported their own data; "owner" = information requested through the owner. */
  requestedBy: "self" | "owner";
  tenant: { id: string; name: string; legalName: string | null };
  person: ExportPerson;
  /** Login account (only in the self-service export): sessions, two-factor state. */
  account: {
    email: string;
    createdAt: string;
    twoFactorEnabled: boolean;
    sessions: Array<{ createdAt: string; lastSeenAt: string | null; expiresAt: string; revokedAt: string | null; userAgent: string | null }>;
  } | null;
  auditLog: ExportAuditEvent[];
}

export interface TenantDataExport {
  format: "stundenwerk.tenant-data.v1";
  generatedAt: string;
  tenant: { id: string; slug: string; name: string } & Record<string, unknown>;
  licenses: unknown[];
  billingPeriods: unknown[];
  supportGrants: unknown[];
  employees: Array<ExportPerson & ExportRecords>;
  auditLog: ExportAuditEvent[];
}

const BOM = "﻿";
const EOL = "\r\n";

/** ISO timestamp → "28.10.2026 14:05" (Europe/Berlin); empty for null. */
export function formatTimestampDE(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}.${p("month")}.${p("year")} ${p("hour")}:${p("minute")}`;
}

const ROLE_DE: Record<string, string> = { employee: "Mitarbeiter/in", manager: "Leitung", owner: "Inhaber/in" };
const STATUS_DE: Record<string, string> = { invited: "eingeladen", active: "aktiv", locked: "gesperrt", deactivated: "deaktiviert (ausgeschieden)" };
const SOURCE_DE: Record<string, string> = { app: "App", migration: "Übernahme Alt-App", correction: "Korrektur" };

function section(lines: string[], title: string, header: string[], rows: Array<Array<string | number>>): void {
  lines.push("", csvRow([title]), csvRow(header));
  if (rows.length === 0) lines.push(csvRow(["(keine Einträge)"]));
  for (const r of rows) lines.push(csvRow(r));
}

function entryRows(entries: ExportTimeEntry[]): Array<Array<string | number>> {
  return entries.map((e) => [
    formatDateDE(e.date), e.start, e.end, e.pauseMinutes, formatHours(e.durationMinutes - e.pauseMinutes), e.note,
    SOURCE_DE[e.source] ?? e.source, e.version, formatTimestampDE(e.deletedAt),
  ]);
}
const ENTRY_HEADER = ["Datum", "Beginn", "Ende", "Pause (Min.)", "Arbeitszeit (Std.)", "Bemerkung", "Herkunft", "Version", "Gelöscht am"];

/** Readable CSV of a personal data export (all sections; full details stay in the JSON file). */
export function personalDataCsv(d: PersonalDataExport): string {
  const lines: string[] = [];
  lines.push(csvRow(["Datenauskunft (Art. 15 DSGVO) – Zeiterfassung"]));
  lines.push(csvRow(["Firma", d.tenant.legalName || d.tenant.name]));
  lines.push(csvRow(["Name", d.person.displayName]));
  lines.push(csvRow(["Personalnummer", d.person.personnelNumber]));
  lines.push(csvRow(["E-Mail", d.person.email ?? ""]));
  lines.push(csvRow(["Rolle", ROLE_DE[d.person.role] ?? d.person.role]));
  lines.push(csvRow(["Status", STATUS_DE[d.person.status] ?? d.person.status]));
  lines.push(csvRow(["Angelegt am", formatTimestampDE(d.person.createdAt)]));
  if (d.person.anonymizedAt) lines.push(csvRow(["Anonymisiert am", formatTimestampDE(d.person.anonymizedAt)]));
  lines.push(csvRow(["Erstellt am", formatTimestampDE(d.generatedAt)]));
  lines.push(csvRow(["Angefordert durch", d.requestedBy === "self" ? "die Person selbst" : "Inhaber/in der Firma"]));
  lines.push(csvRow(["Hinweis", "Vollständige Angaben (inkl. Protokolldetails) enthält der JSON-Export."]));

  if (d.account) {
    section(lines, "Benutzerkonto", ["Anmelde-E-Mail", "Konto angelegt", "Zwei-Faktor-Anmeldung"],
      [[d.account.email, formatTimestampDE(d.account.createdAt), d.account.twoFactorEnabled ? "eingerichtet" : "nicht eingerichtet"]]);
    section(lines, "Anmeldesitzungen", ["Angemeldet am", "Zuletzt aktiv", "Gültig bis", "Beendet am", "Browser"],
      d.account.sessions.map((s) => [formatTimestampDE(s.createdAt), formatTimestampDE(s.lastSeenAt), formatTimestampDE(s.expiresAt),
        formatTimestampDE(s.revokedAt), s.userAgent ?? ""]));
  }
  section(lines, "Arbeitszeiten", ENTRY_HEADER, entryRows(d.timeEntries));
  section(lines, "Arbeitszeitkonto (Übertragungen)", ["Monat", "Stunden", "Status", "Geprüft am", "Notiz der Leitung"],
    d.allocations.map((a) => [a.month, formatHours(a.minutes), a.status, formatTimestampDE(a.reviewedAt), a.reviewNote ?? ""]));
  section(lines, "Arbeitsvertrag (Angaben der Firma)", ["Gültig ab", "Art", "Stundenlohn (€)", "Soll-Stunden/Monat", "Übertrag (Std.)"],
    (d.employmentContracts ?? []).map((c) => [c.validFrom, c.employmentType,
      c.hourlyWageCents === null ? "" : (c.hourlyWageCents / 100).toFixed(2).replace(".", ","),
      c.monthlyTargetMinutes === null ? "offen" : formatHours(c.monthlyTargetMinutes), formatHours(c.carryOverMinutes)]));
  section(lines, "Monatsabschlüsse", ["Monat", "Status", "Eingereicht", "Geprüft", "Geleistet (Std.)", "Übertragen (Std.)", "Abrechnung (Std.)", "Notiz"],
    d.statements.map((s) => [s.month, s.status, formatTimestampDE(s.submittedAt), formatTimestampDE(s.reviewedAt),
      formatHours(s.workedMinutes), formatHours(s.allocatedMinutes), formatHours(s.billingMinutes), s.reviewNote ?? ""]));
  section(lines, "Korrekturanfragen", ["Gestellt am", "Art", "Eintrag", "Begründung", "Status", "Entschieden am", "Antwort der Leitung"],
    d.correctionRequests.map((c) => [formatTimestampDE(c.createdAt), c.kind, c.entryId ?? "", c.reason, c.status,
      formatTimestampDE(c.decidedAt), c.decisionNote ?? ""]));
  section(lines, "Änderungsverlauf der Einträge", ["Eintrag", "Version", "Vorgang", "Korrektur", "Geändert am", "Geändert von", "Begründung"],
    d.revisions.map((r) => [r.entryId, r.version, r.operation, r.isCorrection ? "ja" : "nein", formatTimestampDE(r.changedAt),
      r.changedByName ?? "", r.reason ?? ""]));
  section(lines, "Status und Rolle (Verlauf)", ["Status", "Rolle", "Gültig ab", "Gültig bis"],
    d.statusHistory.map((h) => [STATUS_DE[h.status] ?? h.status, ROLE_DE[h.role] ?? h.role, formatTimestampDE(h.validFrom), formatTimestampDE(h.validTo)]));
  section(lines, "Einladungen", ["E-Mail", "Erstellt", "Gültig bis", "Angenommen", "Widerrufen"],
    d.invitations.map((i) => [i.email, formatTimestampDE(i.createdAt), formatTimestampDE(i.expiresAt), formatTimestampDE(i.acceptedAt), formatTimestampDE(i.revokedAt)]));
  section(lines, "Abrechnungsmonate der Firma (Lizenz)", ["Monat", "Grund"], d.billingMonths.map((b) => [b.month, b.reason]));
  section(lines, "Protokoll (Audit)", ["Zeitpunkt", "Aktion", "Objekt", "Begründung"],
    d.auditLog.map((a) => [formatTimestampDE(a.createdAt), a.action, a.entity, a.reason ?? ""]));
  return BOM + lines.join(EOL) + EOL;
}

/** All working times of a tenant export as one table (one row per entry, incl. deleted ones). */
export function tenantTimeEntriesCsv(d: TenantDataExport): string {
  const lines = [csvRow(["Personalnummer", "Name", ...ENTRY_HEADER])];
  const people = [...d.employees].sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber, "de"));
  for (const p of people) {
    for (const r of entryRows(p.timeEntries)) lines.push(csvRow([p.personnelNumber, p.displayName, ...r]));
  }
  return BOM + lines.join(EOL) + EOL;
}

/** File name part: only letters, digits and dashes. */
export function exportFileSlug(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "export";
}

/**
 * Earliest moment the record of a former employee may be anonymised: exit (deactivation) plus the
 * tenant's retention period in months. null when no period is configured.
 */
export function retentionEndsAt(exitAt: string, retentionMonths: number | null | undefined): Date | null {
  if (retentionMonths == null) return null;
  const d = new Date(exitAt);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + retentionMonths);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

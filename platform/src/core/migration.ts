/**
 * Lossless migration of legacy UWE Stunden-App data (browser localStorage
 * snapshots and backup files v2–v4) into platform records.
 *
 * Guarantees:
 *  - pure: no I/O, nothing is deleted or modified at the source;
 *  - every legacy entry accepted by the legacy `valid()` maps 1:1 to a
 *    TimeEntry; its legacy id is kept, entries without a usable id get the
 *    deterministic legacy id (`legacy-<fnv1a>`, same algorithm as
 *    index.html `oldEntryId`) → re-running yields identical ids;
 *  - everything that cannot be migrated ends up in `report.invalid` with the
 *    raw value – NEVER silently dropped. Only exact duplicates (same id and
 *    same content, or same content without explicit id) are skipped, and
 *    they are counted in `report.duplicatesSkipped`.
 */
import type { ISOMonth, MonthAllocation, TimeEntry, UUID } from "./types";
import { errorsForMonth } from "./breaks";
import { findOverlap, isRealDate, isValidEntry, isValidMonth, legacyEntryId, legacyFingerprint } from "./time";

export const LEGACY_HOURS_PREFIX = "uwe_hours_2_";
export const LEGACY_ACCOUNT_PREFIX = "uwe_arbeitszeitkonto_v1_";
export const LEGACY_TEST_HOURS_KEY = "uwe_test_hours_v1_only";
export const LEGACY_HOLIDAY_CACHE_KEY = "uwe_nrw_sommerferien_v2";
/** Legacy opening balance; account records with another value were "beschädigt". */
export const LEGACY_OPENING_MINUTES = -6000;
/** First month the legacy account accepted allocations for. */
export const LEGACY_ACCOUNT_START_MONTH = "2026-09";

export interface InvalidLegacyItem {
  key: string;
  reason: string;
  raw: unknown;
}

export interface MigrationReport {
  /** Personnel numbers found in the data (sorted). */
  employees: string[];
  entriesRead: number;
  entriesMigrated: number;
  duplicatesSkipped: number;
  invalid: InvalidLegacyItem[];
  warnings: string[];
}

export interface MigrationResult {
  entries: TimeEntry[];
  allocations: MonthAllocation[];
  report: MigrationReport;
}

export interface MigrationOptions {
  tenantId: UUID;
  /** Personnel number (legacy eid) → platform employee id. */
  employeeIdByPersonnelNumber: Record<string, string>;
  /** Timestamp for createdAt/updatedAt; pass it for fully deterministic output. */
  now?: string;
}

const EID = /^[A-Za-z0-9_-]{1,30}$/;
const EXPLICIT_ID = /^[a-zA-Z0-9_-]{4,100}$/;

function isIgnoredKey(key: string): string | null {
  if (key === "uwe_session") return "Anmeldesitzung";
  if (key.startsWith("uwe_chef")) return "Chef-App-Daten";
  if (key === LEGACY_HOLIDAY_CACHE_KEY) return "Ferienkalender-Cache";
  return null;
}

/**
 * Converts a localStorage snapshot (key → raw string) of the legacy app.
 */
export function migrateLegacySnapshot(snapshot: Record<string, string>, opts: MigrationOptions): MigrationResult {
  const now = opts.now ?? new Date().toISOString();
  const report: MigrationReport = { employees: [], entriesRead: 0, entriesMigrated: 0, duplicatesSkipped: 0, invalid: [], warnings: [] };
  const entries: TimeEntry[] = [];
  const allocations: MonthAllocation[] = [];
  const employees = new Set<string>();

  // Deterministic order regardless of the snapshot's key order.
  const keys = Object.keys(snapshot).sort();
  for (const key of keys) {
    const raw = snapshot[key];
    if (key === LEGACY_TEST_HOURS_KEY) {
      let count = "unbekannt viele";
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (Array.isArray(parsed)) count = String(parsed.length);
      } catch { /* reported below anyway */ }
      report.warnings.push("Testdaten (" + key + ", " + count + " Einträge) wurden bewusst nicht übernommen.");
      continue;
    }
    const ignored = isIgnoredKey(key);
    if (ignored) {
      report.warnings.push("Schlüssel " + key + " (" + ignored + ") wird nicht migriert.");
      continue;
    }
    if (key.startsWith(LEGACY_HOURS_PREFIX)) {
      const eid = key.slice(LEGACY_HOURS_PREFIX.length);
      migrateHours(key, eid, raw, opts, now, report, entries, employees);
      continue;
    }
    if (key.startsWith(LEGACY_ACCOUNT_PREFIX)) {
      const eid = key.slice(LEGACY_ACCOUNT_PREFIX.length);
      migrateAccount(key, eid, raw, opts, report, allocations, employees);
      continue;
    }
    report.warnings.push("Unbekannter Schlüssel " + key + " wurde ignoriert.");
  }

  addPlausibilityWarnings(entries, report);
  report.employees = [...employees].sort();
  return { entries, allocations, report };
}

function parseJson(key: string, raw: unknown, report: MigrationReport): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== "string") {
    report.invalid.push({ key, reason: "Wert ist kein Text.", raw });
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    report.invalid.push({ key, reason: "Kein gültiges JSON – Daten beschädigt.", raw });
    return { ok: false };
  }
}

function invalidEntryReason(r: unknown): string {
  if (!r || typeof r !== "object") return "Eintrag ist kein Objekt.";
  return "Eintrag ungültig (Datum, Beginn, Ende oder Pause).";
}

function migrateHours(
  key: string, eid: string, raw: unknown, opts: MigrationOptions, now: string,
  report: MigrationReport, out: TimeEntry[], employees: Set<string>,
): void {
  if (!EID.test(eid)) {
    report.invalid.push({ key, reason: "Ungültige Personalnummer im Schlüssel.", raw });
    return;
  }
  employees.add(eid);
  const parsed = parseJson(key, raw, report);
  if (!parsed.ok) return;
  if (!Array.isArray(parsed.value)) {
    report.invalid.push({ key, reason: "Arbeitszeiten sind keine Liste.", raw });
    return;
  }
  const employeeId = opts.employeeIdByPersonnelNumber[eid];
  const items = parsed.value as unknown[];
  report.entriesRead += items.length;
  if (!employeeId) {
    items.forEach((item, index) =>
      report.invalid.push({ key: key + "[" + index + "]", reason: "Keine Zuordnung für Personalnummer " + eid + ".", raw: item }));
    return;
  }
  // Ids already used in this migration output (ids must be unique per tenant).
  const usedIds = new Set<string>(out.map((e) => e.id));
  const ownIds = new Set<string>();
  items.forEach((item, index) => {
    const itemKey = key + "[" + index + "]";
    if (!isValidEntry(item)) {
      report.invalid.push({ key: itemKey, reason: invalidEntryReason(item), raw: item });
      return;
    }
    const r = item as { id?: unknown; date: string; start: string; end: string; pause: unknown; note?: unknown };
    if (!isRealDate(r.date)) {
      // Legacy valid() accepted e.g. 2026-02-30 (Date.parse rolls over) –
      // such a date cannot be stored as a real date, so it is reported.
      report.invalid.push({ key: itemKey, reason: "Datum existiert nicht im Kalender (" + r.date + ").", raw: item });
      return;
    }
    const normalized = { date: r.date, start: r.start, end: r.end, pause: Number(r.pause), note: String(r.note || "") };
    const explicit = typeof r.id === "string" && EXPLICIT_ID.test(r.id);
    let id = explicit ? (r.id as string) : legacyEntryId(normalized);
    if (ownIds.has(id) && !explicit) {
      // Legacy normalizeEntries: same content without explicit id → same
      // deterministic id → the second copy is dropped. Counted, not silent.
      report.duplicatesSkipped++;
      return;
    }
    if (usedIds.has(id)) {
      // Explicit id used twice (legacy assigned a RANDOM new id and kept
      // both) or the same id already used by another employee. Derive a
      // deterministic id so a re-run stays idempotent.
      const original = id;
      const base = legacyEntryId(normalized) + "-" + eid;
      id = base;
      for (let n = 2; usedIds.has(id); n++) id = base + "-" + n;
      report.warnings.push("Doppelte Eintrags-ID " + original + " (" + eid + ", " + r.date + "): Eintrag erhält ID " + id + ".");
    }
    ownIds.add(id);
    usedIds.add(id);
    out.push({
      id,
      tenantId: opts.tenantId,
      employeeId,
      date: normalized.date,
      start: normalized.start,
      end: normalized.end,
      pauseMinutes: normalized.pause,
      note: normalized.note,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      source: "migration",
    });
    report.entriesMigrated++;
  });
}

function fingerprintOf(e: TimeEntry): string {
  return legacyFingerprint({ date: e.date, start: e.start, end: e.end, pause: e.pauseMinutes, note: e.note });
}

function migrateAccount(
  key: string, eid: string, raw: unknown, opts: MigrationOptions,
  report: MigrationReport, out: MonthAllocation[], employees: Set<string>,
): void {
  if (!EID.test(eid)) {
    report.invalid.push({ key, reason: "Ungültige Personalnummer im Schlüssel.", raw });
    return;
  }
  employees.add(eid);
  const parsed = parseJson(key, raw, report);
  if (!parsed.ok) return;
  migrateAccountObject(key, eid, parsed.value, raw, opts, report, out);
}

function migrateAccountObject(
  key: string, eid: string, data: unknown, raw: unknown, opts: MigrationOptions,
  report: MigrationReport, out: MonthAllocation[],
): void {
  const d = data as { version?: unknown; eid?: unknown; openingMinutes?: unknown; allocations?: unknown } | null;
  // Same structural checks as legacy UweWorkAccount.validate().
  if (!d || typeof d !== "object" || d.eid !== eid || !(d.version === 1 || d.version === 2) ||
      d.openingMinutes !== LEGACY_OPENING_MINUTES || !d.allocations || typeof d.allocations !== "object" || Array.isArray(d.allocations)) {
    report.invalid.push({ key, reason: "Arbeitszeitkonto beschädigt oder einem anderen Mitarbeiter zugeordnet.", raw });
    return;
  }
  const employeeId = opts.employeeIdByPersonnelNumber[eid];
  const months = Object.entries(d.allocations as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  for (const [month, amount] of months) {
    const itemKey = key + ".allocations." + month;
    if (!isValidMonth(month) || month < LEGACY_ACCOUNT_START_MONTH || !Number.isSafeInteger(amount) ||
        (amount as number) < 0 || (amount as number) > 600000) {
      report.invalid.push({ key: itemKey, reason: "Ungültiger gespeicherter Arbeitszeitkontoeintrag.", raw: { month, minutes: amount } });
      continue;
    }
    if (amount === 0) continue; // legacy stores 0 as "no allocation"
    if (!employeeId) {
      report.invalid.push({ key: itemKey, reason: "Keine Zuordnung für Personalnummer " + eid + ".", raw: { month, minutes: amount } });
      continue;
    }
    // Replace an earlier allocation of the same employee & month (backup restore semantics).
    const existing = out.findIndex((a) => a.employeeId === employeeId && a.month === month);
    // Legacy allocations were the employee's wish without approval workflow → "proposed".
    const allocation: MonthAllocation = { employeeId, month: month as ISOMonth, minutes: amount as number, status: "proposed" };
    if (existing >= 0) {
      if (out[existing]!.minutes !== allocation.minutes)
        report.warnings.push("Arbeitszeitkonto " + eid + " " + month + ": Wert " + out[existing]!.minutes + " min durch " + allocation.minutes + " min ersetzt.");
      out[existing] = allocation;
    } else out.push(allocation);
  }
}

function addPlausibilityWarnings(entries: TimeEntry[], report: MigrationReport): void {
  const byEmployee = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const list = byEmployee.get(e.employeeId) ?? [];
    list.push(e);
    byEmployee.set(e.employeeId, list);
  }
  for (const [employeeId, list] of byEmployee) {
    const shifts = list.map((e) => ({ id: e.id, date: e.date, start: e.start, end: e.end, pause: e.pauseMinutes }));
    const months = [...new Set(shifts.map((s) => s.date.slice(0, 7)))].sort();
    for (const month of months) {
      for (const issue of errorsForMonth(shifts, month))
        report.warnings.push("Pausenhinweis (" + employeeId + ", " + issue.date + "): " + issue.message);
    }
    for (const s of shifts) {
      const other = findOverlap(s, shifts);
      if (other && s.id! < other.id!)
        report.warnings.push("Überschneidung (" + employeeId + ", " + s.date + "): " + s.start + "–" + s.end + " und " + other.start + "–" + other.end + ".");
    }
  }
}

// ---------------------------------------------------------------- backups

/**
 * Reads a legacy backup file (JSON text or already parsed object), versions
 * 2–4: `{ app: "UWE Stunden", version, eid, name, exportedAt, entries,
 * arbeitszeitkonto? }` (account only in v4).
 *
 * Unlike the legacy restore (which rejected the whole file if ONE entry was
 * invalid) every valid entry is migrated and invalid ones are reported.
 */
export function parseLegacyBackup(json: string | unknown, opts: MigrationOptions): MigrationResult {
  const empty = (reason: string, raw: unknown): MigrationResult => ({
    entries: [], allocations: [],
    report: { employees: [], entriesRead: 0, entriesMigrated: 0, duplicatesSkipped: 0, invalid: [{ key: "backup", reason, raw }], warnings: [] },
  });
  let data: unknown = json;
  if (typeof json === "string") {
    try {
      data = JSON.parse(json);
    } catch {
      return empty("Sicherungsdatei ist kein gültiges JSON.", json);
    }
  }
  const d = data as { app?: unknown; version?: unknown; eid?: unknown; entries?: unknown; arbeitszeitkonto?: unknown } | null;
  if (!d || typeof d !== "object" || d.app !== "UWE Stunden" || !(d.version === 2 || d.version === 3 || d.version === 4) ||
      typeof d.eid !== "string" || !EID.test(d.eid) || !Array.isArray(d.entries)) {
    return empty("Backup passt nicht zu diesem Mitarbeiterkonto oder ist beschädigt.", json);
  }
  const eid = d.eid;
  const snapshot: Record<string, string> = { [LEGACY_HOURS_PREFIX + eid]: JSON.stringify(d.entries) };
  if (d.version === 4 && d.arbeitszeitkonto !== undefined) snapshot[LEGACY_ACCOUNT_PREFIX + eid] = JSON.stringify(d.arbeitszeitkonto);
  const result = migrateLegacySnapshot(snapshot, opts);
  // Point invalid items at the backup file instead of the synthetic keys.
  for (const item of result.report.invalid) item.key = item.key.replace(LEGACY_HOURS_PREFIX + eid, "backup.entries").replace(LEGACY_ACCOUNT_PREFIX + eid, "backup.arbeitszeitkonto");
  if (d.version === 4 && d.arbeitszeitkonto === undefined)
    result.report.invalid.push({ key: "backup.arbeitszeitkonto", reason: "Die Datensicherung enthält kein Arbeitszeitkonto.", raw: null });
  if (!d.entries.every(isValidEntry))
    result.report.warnings.push("Die Legacy-App hätte diese Sicherung wegen ungültiger Einträge vollständig abgelehnt; gültige Einträge wurden übernommen.");
  return result;
}

/**
 * Merges migrated entries into already stored ones with the legacy restore
 * semantics: same id → incoming replaces stored; same content (same
 * employee) under a different id → skipped. An id that already belongs to a
 * DIFFERENT employee is returned as conflict and never overwritten.
 */
export function entriesToImport(
  existing: readonly TimeEntry[],
  incoming: readonly TimeEntry[],
): { write: TimeEntry[]; skipped: TimeEntry[]; conflicts: TimeEntry[] } {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const key = (e: TimeEntry) => e.employeeId + "|" + fingerprintOf(e);
  const fingerprints = new Set(existing.filter((e) => !e.deletedAt).map(key));
  const write: TimeEntry[] = [];
  const skipped: TimeEntry[] = [];
  const conflicts: TimeEntry[] = [];
  for (const item of incoming) {
    const stored = byId.get(item.id);
    if (stored) {
      if (stored.employeeId !== item.employeeId || stored.tenantId !== item.tenantId) conflicts.push(item);
      else if (key(stored) === key(item)) skipped.push(item);
      else write.push(item);
      continue;
    }
    const fp = key(item);
    if (fingerprints.has(fp)) {
      skipped.push(item);
      continue;
    }
    fingerprints.add(fp);
    byId.set(item.id, item);
    write.push(item);
  }
  return { write, skipped, conflicts };
}

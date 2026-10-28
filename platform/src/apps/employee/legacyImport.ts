/**
 * Legacy import of the employee app ("Daten aus der bisherigen UWE-App übernehmen").
 *
 * Pure planning logic: reads a legacy backup (v2–v4) or the legacy
 * localStorage keys of the same origin with the core migration
 * (parseLegacyBackup / migrateLegacySnapshot), compares the result with what
 * the platform already holds and produces a report BEFORE anything is
 * written. Writing happens in the page after the user confirmed.
 *
 * Legacy keys are only ever READ – never modified or deleted.
 */
import {
  LEGACY_ACCOUNT_PREFIX, LEGACY_HOURS_PREFIX, entriesToImport, migrateLegacySnapshot, parseLegacyBackup,
  type MigrationReport, type MigrationResult,
} from "../../core/migration";
import { activeShifts, netMinutes } from "../../core/time";
import { validateAllocation } from "../../core/workAccount";
import type { BreakPolicy, ISOMonth, MonthAllocation, MonthlyStatement, TimeEntry, UUID, WorkAccountPolicy } from "../../core/types";
import { validateEntryLocally } from "../../data/sync";

export interface ImportTarget {
  tenantId: UUID;
  employeeId: UUID;
  personnelNumber: string;
}

export type ImportSource = { kind: "backup"; fileName: string; text: string } | { kind: "browser"; snapshot: Record<string, string> };

/** Result of reading the source – either refused (with reason) or migrated data. */
export type ImportRead =
  | { ok: false; reason: string; report?: MigrationReport }
  | { ok: true; result: MigrationResult; personnelNumber: string; otherPersonnelNumbers: string[] };

export interface MonthComparison {
  month: ISOMonth;
  /** Net minutes of the readable legacy entries (what the old app shows). */
  legacyMinutes: number;
  /** Platform before the import. */
  beforeMinutes: number;
  /** Platform after the import (before + entries to write). */
  afterMinutes: number;
}

export interface ImportPlan {
  report: MigrationReport;
  toWrite: TimeEntry[];
  /** Already present in the new app (same id or same content) – nothing to do. */
  alreadyPresent: TimeEntry[];
  /** Readable legacy entries that cannot be written automatically (rule violations, locked months, …). */
  rejected: Array<{ entry: TimeEntry; reason: string }>;
  months: MonthComparison[];
  allocationsToWrite: MonthAllocation[];
  allocationsSkipped: Array<{ allocation: MonthAllocation; reason: string }>;
}

const KEY_RE = /^(uwe_hours_2_|uwe_arbeitszeitkonto_v1_)([A-Za-z0-9_-]{1,30})$/;

/** Copies all legacy keys ("uwe_*") of this origin. Read-only. */
export function readLegacyBrowserSnapshot(storage: Pick<Storage, "length" | "key" | "getItem">): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith("uwe_")) continue;
    const value = storage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** Personnel numbers that have legacy hours or work-account data in a snapshot. */
export function personnelNumbersIn(snapshot: Record<string, string>): string[] {
  const set = new Set<string>();
  for (const key of Object.keys(snapshot)) {
    const m = KEY_RE.exec(key);
    if (m) set.add(m[2]!);
  }
  return [...set].sort();
}

/** Personnel number stored in a backup file (null when unreadable). */
export function backupPersonnelNumber(text: string): string | null {
  try {
    const d = JSON.parse(text) as { eid?: unknown };
    return d && typeof d === "object" && typeof d.eid === "string" ? d.eid : null;
  } catch {
    return null;
  }
}

/** Reads and migrates the source for the signed-in employee; refuses data of another personnel number. */
export function readSource(source: ImportSource, target: ImportTarget, now?: string): ImportRead {
  const opts = { tenantId: target.tenantId, employeeIdByPersonnelNumber: { [target.personnelNumber]: target.employeeId }, ...(now ? { now } : {}) };
  if (source.kind === "backup") {
    const eid = backupPersonnelNumber(source.text);
    if (eid !== null && eid !== target.personnelNumber) {
      return { ok: false, reason: `Die Sicherung gehört zur Personalnummer ${eid}. Du bist mit der Personalnummer ${target.personnelNumber} angemeldet. Der Import wurde abgelehnt.` };
    }
    const result = parseLegacyBackup(source.text, opts);
    if (eid === null || (result.report.entriesRead === 0 && result.report.invalid.some((i) => i.key === "backup"))) {
      return { ok: false, reason: "Die Datei ist keine gültige Sicherung der bisherigen UWE-App (Version 2 bis 4).", report: result.report };
    }
    return { ok: true, result, personnelNumber: eid, otherPersonnelNumbers: [] };
  }
  const numbers = personnelNumbersIn(source.snapshot);
  const others = numbers.filter((n) => n !== target.personnelNumber);
  if (!numbers.includes(target.personnelNumber)) {
    return {
      ok: false,
      reason: numbers.length
        ? `In diesem Browser liegen nur Daten anderer Personalnummern (${numbers.join(", ")}). Es werden ausschließlich Daten zu deiner Personalnummer ${target.personnelNumber} übernommen.`
        : "In diesem Browser wurden keine Daten der bisherigen UWE-App gefunden.",
    };
  }
  const mine: Record<string, string> = {};
  for (const prefix of [LEGACY_HOURS_PREFIX, LEGACY_ACCOUNT_PREFIX]) {
    const key = prefix + target.personnelNumber;
    if (source.snapshot[key] !== undefined) mine[key] = source.snapshot[key]!;
  }
  return { ok: true, result: migrateLegacySnapshot(mine, opts), personnelNumber: target.personnelNumber, otherPersonnelNumbers: others };
}

/** Months touched by the migrated entries and allocations (sorted). */
export function monthsOf(result: MigrationResult): ISOMonth[] {
  return [...new Set([...result.entries.map((e) => e.date.slice(0, 7)), ...result.allocations.map((a) => a.month)])].sort();
}

const net = (e: TimeEntry) => netMinutes({ ...e, pause: e.pauseMinutes });
const sumByMonth = (list: TimeEntry[], month: string) => list.filter((e) => e.date.startsWith(month)).reduce((s, e) => s + net(e), 0);

/** Compares the migrated data with the platform state; nothing is written here. */
export function planImport(args: {
  result: MigrationResult;
  /** Active platform entries of the employee for (at least) all months of the import. */
  existing: TimeEntry[];
  existingAllocations: MonthAllocation[];
  statements: Record<string, MonthlyStatement | null>;
  breakPolicy: BreakPolicy;
  workAccount: WorkAccountPolicy;
}): ImportPlan {
  const { result, existing } = args;
  const active = existing.filter((e) => !e.deletedAt);
  const incoming = [...result.entries].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const diff = entriesToImport(active, incoming);
  const existingIds = new Set(active.map((e) => e.id));
  const rejected: ImportPlan["rejected"] = diff.conflicts.map((entry) => ({ entry, reason: "Die Eintrags-ID gehört bereits zu einem anderen Konto." }));
  const toWrite: TimeEntry[] = [];
  const accepted = [...active];
  for (const entry of diff.write) {
    if (existingIds.has(entry.id)) {
      rejected.push({ entry, reason: "Ein Eintrag mit derselben ID ist bereits vorhanden und weicht ab – er wird nicht überschrieben." });
      continue;
    }
    const st = args.statements[entry.date.slice(0, 7)];
    if (st && (st.status === "submitted" || st.status === "approved")) {
      rejected.push({ entry, reason: st.status === "approved" ? "Der Monat ist bereits freigegeben." : "Der Monatsnachweis ist bereits eingereicht." });
      continue;
    }
    try {
      validateEntryLocally(entry, activeShifts(accepted), args.breakPolicy);
    } catch (e) {
      rejected.push({ entry, reason: e instanceof Error ? e.message : "Ungültiger Eintrag." });
      continue;
    }
    accepted.push(entry);
    toWrite.push(entry);
  }

  const months = [...new Set(incoming.map((e) => e.date.slice(0, 7)))].sort().map((month) => {
    const before = sumByMonth(active, month);
    return { month, legacyMinutes: sumByMonth(incoming, month), beforeMinutes: before, afterMinutes: before + sumByMonth(toWrite, month) };
  });

  const allocationsToWrite: MonthAllocation[] = [];
  const allocationsSkipped: ImportPlan["allocationsSkipped"] = [];
  const allEntries = activeShifts(accepted);
  const knownAllocations = [...args.existingAllocations];
  for (const allocation of result.allocations) {
    const current = args.existingAllocations.find((a) => a.month === allocation.month);
    if (!args.workAccount.enabled) { allocationsSkipped.push({ allocation, reason: "Das Arbeitszeitkonto ist für dein Unternehmen nicht aktiviert." }); continue; }
    if (current && current.minutes === allocation.minutes) { allocationsSkipped.push({ allocation, reason: "Bereits vorhanden." }); continue; }
    if (current) { allocationsSkipped.push({ allocation, reason: `Für diesen Monat ist bereits eine Aufteilung gespeichert – sie wird nicht überschrieben.` }); continue; }
    if (args.statements[allocation.month]?.status === "approved") { allocationsSkipped.push({ allocation, reason: "Der Monat ist bereits freigegeben." }); continue; }
    try {
      validateAllocation({ entries: allEntries, allocations: knownAllocations.filter((a) => a.month !== allocation.month), month: allocation.month, minutes: allocation.minutes, policy: args.workAccount });
      allocationsToWrite.push(allocation);
      knownAllocations.push(allocation);
    } catch (e) {
      allocationsSkipped.push({ allocation, reason: e instanceof Error ? e.message : "Ungültige Aufteilung." });
    }
  }

  return { report: result.report, toWrite, alreadyPresent: diff.skipped, rejected, months, allocationsToWrite, allocationsSkipped };
}

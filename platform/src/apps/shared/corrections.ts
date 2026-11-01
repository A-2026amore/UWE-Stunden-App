/** Labels and formatting for correction requests (employee app and Chef-Portal). */
import type { CorrectionKind, CorrectionRequest, CorrectionStatus, EntryValues, TimeEntryRevision } from "../../core/types";
import { weekdayShort, formatDateDE } from "./format";

export const CORRECTION_KIND_LABEL: Record<CorrectionKind, string> = {
  change: "Änderung",
  delete: "Löschung",
  add: "Nachtrag",
};

export const CORRECTION_STATUS_LABEL: Record<CorrectionStatus, string> = {
  open: "Offen",
  accepted: "Angenommen",
  rejected: "Abgelehnt",
  withdrawn: "Zurückgezogen",
};

export const REVISION_LABEL: Record<TimeEntryRevision["operation"], string> = {
  insert: "Erfasst",
  update: "Geändert",
  delete: "Gelöscht",
  restore: "Wiederhergestellt",
};

/** "Mo, 01.09.2026 · 06:00–14:30 Uhr · Pause 30 Min. · Bemerkung" */
export function valuesLabel(v: EntryValues | null): string {
  if (!v) return "—";
  return `${weekdayShort(v.date)}, ${formatDateDE(v.date)} · ${v.start}–${v.end} Uhr · Pause ${v.pauseMinutes} Min.${v.note ? ` · ${v.note}` : ""}`;
}

/** Date the request is about (new date for changes and additions). */
export function requestDate(r: CorrectionRequest): string {
  return (r.proposed ?? r.before)?.date ?? "";
}

/** True when the request concerns the month (old or new date). */
export function requestInMonth(r: CorrectionRequest, month: string): boolean {
  return !!(r.before?.date.startsWith(month) || r.proposed?.date.startsWith(month));
}

/** Fields that differ between before and proposed (for highlighting). */
export function changedFields(r: CorrectionRequest): Array<keyof EntryValues> {
  if (!r.before || !r.proposed) return [];
  return (["date", "start", "end", "pauseMinutes", "note"] as const).filter((k) => r.before![k] !== r.proposed![k]);
}

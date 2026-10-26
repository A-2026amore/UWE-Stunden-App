import { formatHours, monthLabelDE, formatDateDE } from "../../core/time";

export { monthLabelDE, formatDateDE };

/** 750 → "12,50 Std." */
export function hoursLabel(minutes: number): string {
  return `${formatHours(minutes)} Std.`;
}

/** Signed hours with typographic minus: −6000 → "–100,00 Std." */
export function signedHours(minutes: number): string {
  const sign = minutes < 0 ? "–" : minutes > 0 ? "+" : "";
  return `${sign}${formatHours(Math.abs(minutes))} Std.`;
}

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WEEKDAYS_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

export function weekdayShort(date: string): string {
  return WEEKDAYS[new Date(date + "T12:00:00Z").getUTCDay()] ?? "";
}

export function dayLabel(date: string): string {
  return `${WEEKDAYS_LONG[new Date(date + "T12:00:00Z").getUTCDay()] ?? ""}, ${formatDateDE(date)}`;
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function currentMonth(): string {
  return todayISO().slice(0, 7);
}

export function dateTimeDE(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} Uhr`;
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "e" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** Downloads a Blob as file (fallback when sharing is not available). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const ROLE_LABEL: Record<string, string> = { employee: "Mitarbeiter/in", manager: "Vorgesetzte/r", owner: "Inhaber/in" };
export const PLAN_LABEL: Record<string, string> = { pilot_free: "Kostenlos – Pilot", standard: "Standard", business: "Business", enterprise: "Enterprise" };

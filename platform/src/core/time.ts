/**
 * Time and formatting primitives.
 *
 * Ported 1:1 from the legacy UWE Stunden-App (index.html inline script,
 * uwe-break-rules.js, uwe-arbeitszeitkonto.js). All durations are integer
 * minutes. User-facing texts keep the legacy German wording.
 */
import type { ISODate, ISOMonth, ShiftLike, TimeEntry } from "./types";

/** Minutes of a day. */
export const MINUTES_PER_DAY = 1440;

/**
 * "HH:MM" → minutes since midnight, NaN if invalid.
 * Legacy: `minutes()` (index.html) / `clock()` (uwe-break-rules.js).
 */
export function parseClock(value: unknown): number {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return NaN;
  const h = Number(value.slice(0, 2));
  const m = Number(value.slice(3));
  return h < 24 && m < 60 ? h * 60 + m : NaN;
}

/** Minutes since midnight → "HH:MM" (0–1439, wraps around). */
export function formatClock(minutes: number): string {
  const v = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
}

/**
 * Gross duration of a shift (end − start) in minutes. `end <= start` means
 * the shift crosses midnight; `start === end` is invalid (NaN).
 * Legacy: `UweBreakRules.gross`.
 */
export function grossMinutes(shift: Pick<ShiftLike, "start" | "end"> | null | undefined): number {
  if (!shift) return NaN;
  const start = parseClock(shift.start);
  const end = parseClock(shift.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return NaN;
  return end > start ? end - start : end + MINUTES_PER_DAY - start;
}

/** Gross minutes minus the entered pause. NaN if the shift is invalid. */
export function netMinutes(shift: Pick<ShiftLike, "start" | "end" | "pause"> | null | undefined): number {
  if (!shift) return NaN;
  const gross = grossMinutes(shift);
  const pause = Number(shift.pause);
  if (!Number.isFinite(gross) || !Number.isFinite(pause)) return NaN;
  return gross - pause;
}

/**
 * [start, end] in minutes relative to the shift's own date; a shift that
 * crosses midnight ends after 1440. Legacy: `timeWindow` (index.html).
 * Note: like legacy, `start === end` yields a 24 h window – callers validate
 * entries with `isValidEntry` first.
 */
export function timeWindow(shift: Pick<ShiftLike, "start" | "end">): [number, number] {
  const s = parseClock(shift.start);
  const e = parseClock(shift.end);
  return [s, e <= s ? e + MINUTES_PER_DAY : e];
}

/** Shift fields needed for overlap checks (other ShiftLike fields allowed). */
export type OverlapShift = Pick<ShiftLike, "date" | "start" | "end"> & Partial<ShiftLike>;

/** Legacy `overlaps`: only shifts with the SAME date are compared. */
export function overlaps(a: Pick<ShiftLike, "date" | "start" | "end">, b: Pick<ShiftLike, "date" | "start" | "end">): boolean {
  if (a.date !== b.date) return false;
  const [s1, e1] = timeWindow(a);
  const [s2, e2] = timeWindow(b);
  return Math.max(s1, s2) < Math.min(e1, e2);
}

/**
 * First existing shift that overlaps the candidate (legacy-identical:
 * `records.find(x => x.id !== editingId && overlaps(x, r))`). A candidate
 * without id is a new entry (legacy `editingId = null`).
 */
export function findOverlap<T extends Pick<ShiftLike, "id" | "date" | "start" | "end">>(
  candidate: OverlapShift,
  existing: readonly T[],
): T | undefined {
  const editingId = candidate.id || null;
  return existing.find((x) => x.id !== editingId && overlaps(x, candidate));
}

/** Whole days between two ISO dates (b − a), NaN when a date is malformed. */
export function daysBetween(a: ISODate, b: ISODate): number {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!pa || !pb) return NaN;
  const ta = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const tb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((tb - ta) / 86400000);
}

/**
 * Stricter overlap check (NOT legacy): additionally detects a shift that
 * crosses midnight overlapping an entry on the previous / next date
 * (e.g. 22:00–06:00 on the 1st vs. 05:00–08:00 on the 2nd). The legacy app
 * only compared entries of the same date, so such collisions were accepted.
 */
export function findOverlapAcrossDays<T extends Pick<ShiftLike, "id" | "date" | "start" | "end">>(
  candidate: OverlapShift,
  existing: readonly T[],
): T | undefined {
  const editingId = candidate.id || null;
  const [cs, ce] = timeWindow(candidate);
  return existing.find((x) => {
    if (x.id === editingId) return false;
    const offset = daysBetween(candidate.date, x.date);
    if (!Number.isFinite(offset) || Math.abs(offset) > 1) return false;
    const [xs, xe] = timeWindow(x);
    return Math.max(cs, xs + offset * MINUTES_PER_DAY) < Math.min(ce, xe + offset * MINUTES_PER_DAY);
  });
}

/** Minutes → "12,50" (legacy `hours()` / `fnum()`: two decimals, comma). */
export function formatHours(minutes: number): string {
  return (Number(minutes) / 60).toFixed(2).replace(".", ",");
}

/**
 * Hours text ("20", "12,5", "7.25") → integer minutes. Throws the legacy
 * German messages (uwe-arbeitszeitkonto.js `parseHours`).
 */
export function parseHours(raw: unknown): number {
  const v = String(raw ?? "").trim().replace(",", ".");
  if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(v)) throw new Error("Stunden bitte als Zahl eingeben (z. B. 20 oder 12,5).");
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error("Ungültiger Stundenwert.");
  return Math.round(n * 60);
}

/** "2026-11-05" → "05.11.2026"; other values are returned unchanged. */
export function formatDateDE(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(8, 10) + "." + value.slice(5, 7) + "." + value.slice(0, 4) : value;
}

/** "2026-11" → "11-2026" (legacy PDF / CSV month format). */
export function formatMonthShortDE(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? month.slice(5, 7) + "-" + month.slice(0, 4) : month;
}

export const GERMAN_MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
] as const;

/**
 * "2026-11" → "November 2026". Same result as the legacy
 * `toLocaleDateString("de-DE",{month:"long",year:"numeric"})`, but without
 * depending on the runtime's ICU data.
 */
export function monthLabelDE(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const name = GERMAN_MONTH_NAMES[Number(m[2]) - 1];
  return name ? name + " " + m[1] : month;
}

/** True for "YYYY-MM" with a month 01–12 (legacy work-account check, 20xx years). */
export function isValidMonth(value: unknown): value is ISOMonth {
  return typeof value === "string" && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(value);
}

/** True when the ISO date exists in the calendar (rejects 2026-02-30). */
export function isRealDate(value: unknown): value is ISODate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Legacy `worked(r)` of index.html, but in minutes: (end − start) mod day − pause. */
function legacyWorkedMinutes(r: { start: string; end: string; pause: number }): number {
  let v = parseClock(r.end) - parseClock(r.start);
  if (v < 0) v += MINUTES_PER_DAY;
  return v - r.pause;
}

/**
 * Legacy `valid(r)` of index.html – identical acceptance rules.
 *
 * Legacy quirk (kept): the date check uses `Date.parse(date+"T00:00:00")`,
 * which in V8 accepts non-existent days such as "2026-02-30" (rolled over).
 * Use `isRealDate` for a strict check.
 */
export function isValidEntry(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  // Legacy regex.test() coerces with String(), so do the same.
  const dateText = String(rec.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || Number.isNaN(Date.parse(dateText + "T00:00:00"))) return false;
  const st = parseClock(rec.start);
  const en = parseClock(rec.end);
  const pause = Number(rec.pause);
  if (!(Number.isFinite(st) && Number.isFinite(en) && Number.isInteger(pause) && pause >= 0 && pause < 1440 && st !== en)) return false;
  const w = legacyWorkedMinutes({ start: rec.start as string, end: rec.end as string, pause }) / 60;
  return w > 0 && w <= 24;
}

/** Converts a stored TimeEntry to the minimal shape used by the calculations. */
export function toShift(entry: Pick<TimeEntry, "id" | "date" | "start" | "end" | "pauseMinutes">): ShiftLike {
  return { id: entry.id, date: entry.date, start: entry.start, end: entry.end, pause: entry.pauseMinutes };
}

/** Accepts either a ShiftLike (`pause`) or a TimeEntry-like (`pauseMinutes`). */
export type ShiftInput = ShiftLike | (Pick<TimeEntry, "date" | "start" | "end" | "pauseMinutes"> & { id?: string; deletedAt?: string | null });

/** Normalises a ShiftInput to ShiftLike (keeps an `id` when present). */
export function asShift(input: ShiftInput): ShiftLike {
  if ("pauseMinutes" in input && !("pause" in input)) {
    const out: ShiftLike = { date: input.date, start: input.start, end: input.end, pause: input.pauseMinutes };
    if (input.id !== undefined) out.id = input.id;
    return out;
  }
  return input as ShiftLike;
}

/** Drops soft-deleted entries (`deletedAt` set). Legacy had hard deletes only. */
export function activeShifts(inputs: readonly ShiftInput[] | null | undefined): ShiftLike[] {
  const out: ShiftLike[] = [];
  for (const x of inputs ?? []) {
    if (!x) continue;
    if ("deletedAt" in x && x.deletedAt) continue;
    out.push(asShift(x));
  }
  return out;
}

/** Fingerprint used by legacy duplicate detection: date|start|end|pause|note. */
export function legacyFingerprint(r: { date: string; start: string; end: string; pause: unknown; note?: unknown }): string {
  return [r.date, r.start, r.end, Number(r.pause), r.note || ""].join("|");
}

/** Legacy deterministic id (`oldEntryId`, FNV-1a 32 bit over the fingerprint). */
export function legacyEntryId(r: { date: string; start: string; end: string; pause: unknown; note?: unknown }): string {
  const value = legacyFingerprint(r);
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return "legacy-" + (h >>> 0).toString(36);
}

/** Adds `count` days to an ISO date (UTC-noon arithmetic as in legacy). */
export function addDays(value: ISODate, count: number): ISODate {
  const d = new Date(value + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

/** Number of days in a month "YYYY-MM". */
export function daysInMonth(month: ISOMonth): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

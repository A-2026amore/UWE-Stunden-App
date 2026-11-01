/**
 * Aggregations for the small dashboard / month charts. Display only – the
 * business totals (worked, billing, account) come from core/workAccount.
 * A shift is counted on its start date (like the monthly list).
 */
import { netMinutes, type ShiftInput, asShift } from "../../core/time";
import type { BarDatum } from "../../design";
import { formatDateDE, hoursLabel, weekdayShort } from "./format";

function daysIn(month: string): string[] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Net minutes per calendar day of `month` (deleted entries ignored, invalid entries count 0). */
export function minutesPerDay(entries: readonly ShiftInput[], month: string): Map<string, number> {
  const out = new Map(daysIn(month).map((d) => [d, 0]));
  for (const e of entries) {
    if (!e || ("deletedAt" in e && e.deletedAt)) continue;
    const s = asShift(e);
    if (!out.has(s.date)) continue;
    const n = netMinutes(s);
    if (Number.isFinite(n) && n > 0) out.set(s.date, (out.get(s.date) ?? 0) + n);
  }
  return out;
}

/** ISO week number (Monday-based). */
export function isoWeek(date: string): number {
  const d = new Date(date + "T12:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** Bars per day; weekends muted, `today` highlighted. */
export function dailyBars(entries: readonly ShiftInput[], month: string, today: string): BarDatum[] {
  return [...minutesPerDay(entries, month)].map(([date, minutes]) => {
    const wd = weekdayShort(date);
    return {
      label: String(Number(date.slice(8))),
      title: `${wd}, ${formatDateDE(date)}: ${hoursLabel(minutes)}`,
      value: minutes / 60,
      highlight: date === today,
      muted: (wd === "Sa" || wd === "So") && date !== today,
    };
  });
}

/** Bars per ISO calendar week (only the days inside `month`). */
export function weeklyBars(entries: readonly ShiftInput[], month: string, today: string): BarDatum[] {
  const weeks = new Map<number, { minutes: number; from: string; to: string }>();
  for (const [date, minutes] of minutesPerDay(entries, month)) {
    const w = isoWeek(date);
    const cur = weeks.get(w);
    if (cur) { cur.minutes += minutes; cur.to = date; } else weeks.set(w, { minutes, from: date, to: date });
  }
  const todayWeek = today.startsWith(month) ? isoWeek(today) : -1;
  return [...weeks].map(([w, v]) => ({
    label: `KW ${w}`,
    title: `KW ${w} (${formatDateDE(v.from)}–${formatDateDE(v.to)}): ${hoursLabel(v.minutes)}`,
    value: v.minutes / 60,
    highlight: w === todayWeek,
  }));
}

/** Axis label for hour values: 0, 8, 16 … → "0 h", "8 h". */
export function hoursAxis(v: number): string {
  return `${Math.round(v * 10) / 10} h`.replace(".", ",");
}

/**
 * Free offer "until further notice" (decision of the client, 02.11.2026, migration 0029) as pure functions.
 * The database implements the same rules in SQL; the demo repository uses this module.
 *
 *  - Periods of whole calendar months in which nobody pays; a month is free when a period touches it.
 *  - Switching on: from the first day of the current month, open end. Switching on again while an end is
 *    planned withdraws the end.
 *  - Switching off: the end is the last day of a month and at least the end of the next month
 *    (one month notice for the customers, Anlage A § 1d).
 *  - In a free month every tenant has the Pro functions; the bill is 0 € (condition "platform_free").
 */
import { addDays, firstDayOf, monthOfDate } from "./subscription";
import type { FreeOffer, ISODate, ISOMonth } from "./types";

export interface FreePeriod {
  startsOn: ISODate;
  endsOn: ISODate | null;
}

function lastDayOf(month: ISOMonth): ISODate {
  return addDays(addDays(firstDayOf(month), 32).slice(0, 8) + "01", -1);
}

function addMonth(month: ISOMonth, n: number): ISOMonth {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** True when a free period touches the month. */
export function freeIn(periods: readonly FreePeriod[], month: ISOMonth): boolean {
  const first = firstDayOf(month);
  const last = lastDayOf(month);
  return periods.some((p) => p.startsOn <= last && (p.endsOn === null || p.endsOn >= first));
}

/** Current or coming free period (not over yet), or null. */
export function freeOfferOf(periods: readonly FreePeriod[], today: ISODate): FreeOffer | null {
  const p = [...periods].filter((x) => x.endsOn === null || x.endsOn >= today).sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0];
  return p ? { since: p.startsOn, endsOn: p.endsOn } : null;
}

/** Earliest end when switching off today: the last day of the next month. */
export function earliestFreeEnd(today: ISODate): ISODate {
  return lastDayOf(addMonth(monthOfDate(today), 1));
}

/** New list of periods after switching on (`on`) or off (with `endsOn`); throws the German messages of SQL. */
export function setFreeOffer(periods: readonly FreePeriod[], on: boolean, endsOn: ISODate | null, today: ISODate): FreePeriod[] {
  const month = firstDayOf(monthOfDate(today));
  const rows = periods.map((p) => ({ ...p }));
  const cur = rows.filter((x) => x.endsOn === null || x.endsOn >= today).sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0];
  if (on) {
    if (cur && cur.endsOn === null) throw new Error("Die Nutzung ist bereits kostenlos.");
    if (cur) { cur.endsOn = null; return rows; }
    const prev = rows.find((x) => x.endsOn === addDays(month, -1));
    if (prev) { prev.endsOn = null; return rows; }
    return [...rows, { startsOn: month, endsOn: null }];
  }
  if (!cur || cur.endsOn !== null) throw new Error("Die Nutzung ist nicht unbefristet kostenlos.");
  if (!endsOn || addDays(endsOn, 1).slice(8) !== "01") throw new Error("Das Ende muss der letzte Tag eines Monats sein.");
  const min = earliestFreeEnd(today);
  if (endsOn < min) throw new Error(`Das kostenlose Angebot kann frühestens zum ${min.split("-").reverse().join(".")} enden (einen Monat Vorlauf).`);
  cur.endsOn = endsOn;
  return rows;
}

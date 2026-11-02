/**
 * Editions Basic and Pro (decision of the client, 02.11.2026, migration 0027) as pure functions.
 * The database implements the same rules in SQL; the demo repository uses this module.
 *
 *  - Basic: record times and submit the monthly statement; the leadership manages employees,
 *    sees the times, accepts statements and downloads PDF/CSV. 1,99 € gross per billable employee
 *    and month (12-month subscription and monthly plan, platform settings).
 *  - Pro: everything (employment contract data with target/actual, work account, hours overview,
 *    correction requests, import from the old app). 5,00 € / 6,50 € as before.
 *  - Without a stored change a tenant is Pro (every tenant before 0027).
 *  - Pro applies from the current month. Basic from the next month; in a running 12-month subscription
 *    only after the current term; before the first paid month (trial) from the first paid month.
 *    Choosing the current edition again withdraws a planned change.
 *  - During the free trial every function is available.
 */
import { addDays, currentAnnualEnd, firstDayOf, monthOfDate, type TermRow } from "./subscription";
import type { Edition, ISODate, ISOMonth } from "./types";

export const EDITIONS: readonly Edition[] = ["basic", "pro"];

export const EDITION_LABEL: Record<Edition, string> = {
  basic: "Basic",
  pro: "Pro",
};

export const DEFAULT_BASIC_PRICE_CENTS = 199;
export const DEFAULT_BASIC_MONTHLY_PRICE_CENTS = 199;

/** What each edition contains (shown at contract conclusion and under "Abrechnung"). */
export const EDITION_FEATURES: Record<Edition, string[]> = {
  basic: [
    "Arbeitszeiten erfassen (mit Pausenregel)",
    "Monatsnachweis an den Chef senden",
    "Chef: Mitarbeiter verwalten, Zeiten ansehen, Nachweise annehmen",
    "PDF- und CSV-Export",
  ],
  pro: [
    "Alles aus Basic",
    "Vertragsdaten mit Soll/Ist (Stundenvertrag)",
    "Arbeitszeitkonto",
    "Stundenübersicht",
    "Korrekturanfragen",
    "Übernahme aus der alten Stunden-App",
  ],
};

/** Message when a Pro feature is used in Basic (same text as private.assert_pro). */
export const PRO_ONLY_MESSAGE = "Diese Funktion gibt es nur in der Pro-Version. Der Inhaber kann im Chef-Portal unter „Abrechnung“ zu Pro wechseln.";

/** One stored change (public.tenant_editions): valid from the first day of a month. */
export interface EditionRow {
  startsOn: ISODate;
  edition: Edition;
}

/** Edition in a month: the last change on or before its first day, else "pro". */
export function editionFor(rows: readonly EditionRow[], month: ISOMonth): Edition {
  const first = firstDayOf(month);
  let best: EditionRow | null = null;
  for (const r of rows) if (r.startsOn <= first && (!best || r.startsOn > best.startsOn)) best = r;
  return best?.edition ?? "pro";
}

/** Next planned change after the current month, or null. */
export function nextEdition(rows: readonly EditionRow[], today: ISODate): EditionRow | null {
  const first = firstDayOf(monthOfDate(today));
  return [...rows].filter((r) => r.startsOn > first).sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0] ?? null;
}

/** Pro features today: during the trial always, else when the current month is Pro. */
export function hasPro(rows: readonly EditionRow[], today: ISODate, trialEndsOn: ISODate | null): boolean {
  if (trialEndsOn && today <= trialEndsOn) return true;
  return editionFor(rows, monthOfDate(today)) === "pro";
}

function nextMonthFirst(date: ISODate): ISODate {
  return addDays(firstDayOf(monthOfDate(date)), 32).slice(0, 8) + "01";
}

/** First day from which a change to `edition` applies (private.edition_change_start). */
export function editionChangeStart(edition: Edition, terms: readonly TermRow[], today: ISODate, firstPaidMonth: ISOMonth): ISODate {
  if (edition === "pro") return firstDayOf(monthOfDate(today));
  const paid = firstDayOf(firstPaidMonth);
  if (today < paid) return paid;
  const term = [...terms]
    .filter((t) => (t.endsOn === null || t.endsOn >= t.startsOn) && t.startsOn <= today && (t.endsOn === null || t.endsOn >= today))
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0];
  if (term?.interval === "annual") return addDays(term.endsOn ?? currentAnnualEnd(term.startsOn, today), 1);
  return nextMonthFirst(today);
}

/** New list of stored changes after choosing `edition` (public.tenant_choose_edition); throws a German message. */
export function planEdition(rows: readonly EditionRow[], edition: Edition, terms: readonly TermRow[], today: ISODate, firstPaidMonth: ISOMonth): EditionRow[] {
  const current = editionFor(rows, monthOfDate(today));
  const next = nextEdition(rows, today);
  if (current === edition && !next) throw new Error("Diese Version ist bereits gewählt.");
  if (current !== edition && next?.edition === edition) throw new Error("Der Wechsel zu dieser Version ist bereits geplant.");
  const monthFirst = firstDayOf(monthOfDate(today));
  if (current === edition) return rows.filter((r) => r.startsOn <= monthFirst);
  return applyEdition(rows, edition, editionChangeStart(edition, terms, today, firstPaidMonth));
}

/** Drops changes from `start` and stores `edition` from `start` if it differs from the month before. */
export function applyEdition(rows: readonly EditionRow[], edition: Edition, start: ISODate): EditionRow[] {
  const kept = rows.filter((r) => r.startsOn < start);
  const before = editionFor(kept, monthOfDate(addDays(start, -1)));
  return before === edition ? kept : [...kept, { startsOn: start, edition }];
}

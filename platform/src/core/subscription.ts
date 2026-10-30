/**
 * Subscription rules (decision of the client, 30.10.2026, migration 0023) as pure functions.
 * The database implements the same rules in SQL; the demo repository uses this module.
 * Dates are calendar days in Europe/Berlin (ISODate), months are ISOMonth.
 *
 *  - Two plans: "annual" = 12-month subscription at the platform default price (5,00 € gross),
 *    "monthly" = monthly plan (6,50 € gross). Without a choice the monthly plan applies.
 *  - Introductory offer: a tenant created on a day inside the trial window set by the super admin
 *    gets a free trial until the end of the calendar month in which `trialMonths` months end
 *    (PostgreSQL date arithmetic). Billing starts with the following month.
 *    Without trial, billing starts with the month of creation.
 *  - Terms start on the first and end on the last day of a month. An annual term runs 12 months
 *    and renews by 6 months (repeatedly) unless cancelled by the last day of the term
 *    (minus `cancelNoticeDays`). A monthly term can be cancelled to the end of the current month.
 *    Cancelling a term that has not started yet (e.g. during the trial) costs nothing: it never runs.
 *  - Monthly → annual at any time from the next month (during the trial: from the first paid month).
 *    Annual → monthly only at the end of the term (cancel with "continue monthly afterwards").
 *  - After the contract has ended nothing is billed; a new plan can be chosen (from the current month).
 */
import type { ISODate, ISOMonth, SubscriptionInterval } from "./types";

export const TERM_MONTHS = 12;
export const RENEWAL_MONTHS = 6;
export const DEFAULT_MONTHLY_PRICE_CENTS = 650;
export const DEFAULT_TRIAL_MONTHS = 3;

/** Shown with every promo code (mail and UI), legal draft 0.9.3. */
export const PROMO_TERMS_NOTE = "Rabatt bis auf Weiteres; der Anbieter kann ihn zum Ende eines Kalendermonats beenden.";

/**
 * Versions the owner accepts at contract conclusion: the "Stand" notes of the documents shown under
 * /rechtliches/agb (AGB + Anlage A + Anlage B) and /rechtliches/avv (AVV + Anlage 1 TOM), texts in
 * platform/public/rechtliches-texte (drafts, not approved). Change together with the texts.
 */
export const TERMS_VERSION = "AGB 0.9.3, Anlage A 0.9.3, Anlage B 0.9.1";
export const DPA_VERSION = "AVV 0.9.2, Anlage 1 (TOM) 0.9.1";

export const INTERVAL_LABEL: Record<SubscriptionInterval, string> = {
  annual: "12-Monats-Abo",
  monthly: "Monatstarif",
};

// ------------------------------------------------------------------ calendar helpers (UTC dates)

function parts(date: ISODate): [number, number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Bitte ein gültiges Datum (JJJJ-MM-TT) angeben.");
  return date.split("-").map(Number) as [number, number, number];
}
function iso(y: number, m0: number, d: number): ISODate {
  const t = new Date(Date.UTC(y, m0, d));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** date + n months, clamped to the last day of the target month (like PostgreSQL `date + interval 'n months'`). */
export function addMonthsToDate(date: ISODate, n: number): ISODate {
  const [y, m, d] = parts(date);
  const lastOfTarget = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return iso(y, m - 1 + n, Math.min(d, lastOfTarget));
}
export function addDays(date: ISODate, n: number): ISODate {
  const [y, m, d] = parts(date);
  return iso(y, m - 1, d + n);
}
export function monthOfDate(date: ISODate): ISOMonth {
  return date.slice(0, 7);
}
export function firstDayOf(month: ISOMonth): ISODate {
  return `${month}-01`;
}
export function lastDayOf(month: ISOMonth): ISODate {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return iso(y, m, 0);
}
function nextMonthFirst(date: ISODate): ISODate {
  const [y, m] = parts(date);
  return iso(y, m, 1);
}
function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

// ------------------------------------------------------------------ trial

export interface TrialSettings {
  trialWindowFrom: ISODate | null;
  trialWindowUntil: ISODate | null;
  trialMonths: number;
}

/**
 * Last day of the free trial for a tenant created on `createdOn` (Berlin day), or null without
 * trial: the end of the calendar month in which the `trialMonths` months end (Anlage A § 1a Abs. 2,
 * draft 0.9.3). Example: created 15.11. → 3 months end 14.02. → trial until 28.02.
 */
export function trialEndsOnFor(createdOn: ISODate, s: TrialSettings): ISODate | null {
  if (!s.trialWindowFrom || !s.trialWindowUntil || s.trialMonths <= 0) return null;
  if (createdOn < s.trialWindowFrom || createdOn > s.trialWindowUntil) return null;
  return lastDayOf(monthOfDate(addDays(addMonthsToDate(createdOn, s.trialMonths), -1)));
}

/** First billed month: the month after the trial; without trial the month of creation. */
export function firstPaidMonthFor(createdOn: ISODate, trialEndsOn: ISODate | null): ISOMonth {
  return trialEndsOn ? monthOfDate(nextMonthFirst(trialEndsOn)) : monthOfDate(createdOn);
}

/** True when the month contains at least one trial day (such a month is free). */
export function isTrialMonth(trialEndsOn: ISODate | null, month: ISOMonth): boolean {
  return !!trialEndsOn && firstDayOf(month) <= trialEndsOn;
}

// ------------------------------------------------------------------ terms

/** Stored term (one row of public.subscription_terms). */
export interface TermRow {
  id: string;
  interval: SubscriptionInterval;
  startsOn: ISODate;
  /** Last day once cancelled or replaced; startsOn − 1 = never active; null = runs on. */
  endsOn: ISODate | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  thenMonthly: boolean;
}

/** Last day of an annual term after k renewals: startsOn + (12 + 6k) months − 1 day. */
export function annualTermEnd(startsOn: ISODate, renewals: number): ISODate {
  return addDays(addMonthsToDate(startsOn, TERM_MONTHS + RENEWAL_MONTHS * renewals), -1);
}

/** First annual term end that satisfies `ok` (renewals counted from 0). */
function firstAnnualEnd(startsOn: ISODate, ok: (end: ISODate) => boolean): ISODate {
  for (let k = 0; k < 2000; k++) {
    const end = annualTermEnd(startsOn, k);
    if (ok(end)) return end;
  }
  throw new Error("Laufzeitende nicht bestimmbar.");
}

/** End of the current annual term as of `today` (the first term end on or after today). */
export function currentAnnualEnd(startsOn: ISODate, today: ISODate): ISODate {
  return firstAnnualEnd(startsOn, (end) => end >= today);
}

/**
 * Last day of a term cancelled on `cancelDate`: a term that has not started yet never runs
 * (startsOn − 1); monthly ends with the current month; annual with the first term end that is
 * at least `noticeDays` days after the cancellation.
 */
export function cancellationEnd(term: Pick<TermRow, "interval" | "startsOn">, cancelDate: ISODate, noticeDays: number): ISODate {
  if (cancelDate < term.startsOn) return addDays(term.startsOn, -1);
  if (term.interval === "monthly") return lastDayOf(monthOfDate(cancelDate));
  return firstAnnualEnd(term.startsOn, (end) => addDays(end, -noticeDays) >= cancelDate);
}

function active(t: TermRow): boolean {
  return t.endsOn === null || t.endsOn >= t.startsOn;
}

/** Term that covers the month (terms never overlap), or null. */
export function termForMonth<T extends TermRow>(terms: readonly T[], month: ISOMonth): T | null {
  const first = firstDayOf(month);
  const last = lastDayOf(month);
  return terms.find((t) => active(t) && t.startsOn <= last && (t.endsOn === null || t.endsOn >= first)) ?? null;
}

/** Active terms that cover `day` or start later, ordered by start. */
function fromDay(terms: readonly TermRow[], day: ISODate): TermRow[] {
  return terms.filter((t) => active(t) && (t.endsOn === null || t.endsOn >= day)).sort((a, b) => a.startsOn.localeCompare(b.startsOn));
}

export interface SubscriptionView {
  current: TermRow | null;
  next: TermRow | null;
  /** Annual and not ended: end of the current term as of today. */
  currentTermEndsOn: ISODate | null;
  contractEndsOn: ISODate | null;
  ended: boolean;
}

/** What the tenant has as of `today`. */
export function subscriptionView(terms: readonly TermRow[], today: ISODate): SubscriptionView {
  const [current = null, next = null] = fromDay(terms, today);
  const last = next ?? current;
  return {
    current,
    next,
    currentTermEndsOn: current && current.interval === "annual" && current.endsOn === null ? currentAnnualEnd(current.startsOn, today) : null,
    contractEndsOn: last && last.endsOn !== null ? last.endsOn : null,
    ended: current === null,
  };
}

/** Planned change of the stored terms. */
export interface TermChange {
  /** Terms that never ran and are removed. */
  remove: string[];
  /** Terms that end (replaced or cancelled). */
  end: Array<{ id: string; endsOn: ISODate; cancelled: boolean; thenMonthly?: boolean }>;
  /** Cancelled terms that run on again (cancellation withdrawn). */
  reopen: string[];
  /** New term (interval and first day). */
  add: { interval: SubscriptionInterval; startsOn: ISODate } | null;
}

/**
 * Choose a plan.
 *  - annual while monthly runs or is planned: annual from the next month (at the earliest the first paid month);
 *    the monthly term ends the day before (or is removed if it never ran).
 *  - annual or monthly after the contract has ended (or ends): new term from the current month
 *    (at the earliest the first paid month), right after a term that still runs.
 *  - monthly while annual runs: not possible (only to the term end, by cancelling with thenMonthly).
 */
export function planChoice(terms: readonly TermRow[], interval: SubscriptionInterval, today: ISODate, firstPaidMonth: ISOMonth): TermChange {
  const paidFrom = firstDayOf(firstPaidMonth);
  const live = fromDay(terms, today);
  const running = live.filter((t) => t.endsOn === null);
  const open = running[0] ?? null;
  if (open?.interval === "annual") {
    throw new Error(interval === "annual"
      ? "Das 12-Monats-Abo läuft bereits."
      : "Zum Monatstarif können Sie nur zum Ende der Laufzeit wechseln: Abo kündigen und „danach monatlich weiter“ wählen.");
  }
  if (open?.interval === "monthly") {
    if (interval === "monthly") throw new Error("Der Monatstarif läuft bereits.");
    // Not before the monthly term itself starts (e.g. it follows a cancelled annual term that still runs).
    const start = maxDate(maxDate(paidFrom, nextMonthFirst(today)), open.startsOn);
    const change: TermChange = { remove: [], end: [], reopen: [], add: { interval: "annual", startsOn: start } };
    if (open.startsOn >= start) change.remove.push(open.id);
    else change.end.push({ id: open.id, endsOn: addDays(start, -1), cancelled: false });
    return change;
  }
  // Nothing runs on: new term after the last term that still ends, from the current month at the earliest.
  const lastEnd = live.length ? live[live.length - 1]!.endsOn! : null;
  let start = maxDate(paidFrom, firstDayOf(monthOfDate(today)));
  if (lastEnd && lastEnd >= start) start = addDays(lastEnd, 1);
  return { remove: [], end: [], reopen: [], add: { interval, startsOn: start } };
}

/** Cancel the running term. Annual with thenMonthly: a monthly term follows from the day after the end. */
export function planCancel(terms: readonly TermRow[], today: ISODate, noticeDays: number, thenMonthly: boolean): TermChange {
  const open = fromDay(terms, today).find((t) => t.endsOn === null) ?? null;
  if (!open) throw new Error("Es gibt keinen laufenden Vertrag, der gekündigt werden kann.");
  if (thenMonthly && open.interval !== "annual") throw new Error("„Danach monatlich weiter“ gibt es nur beim 12-Monats-Abo.");
  const endsOn = cancellationEnd(open, today, noticeDays);
  const change: TermChange = { remove: [], end: [{ id: open.id, endsOn, cancelled: true, thenMonthly }], reopen: [], add: null };
  if (thenMonthly) change.add = { interval: "monthly", startsOn: addDays(endsOn, 1) };
  return change;
}

/**
 * Withdraw a cancellation that has not taken effect yet (today ≤ end; for a term that never
 * started: before its start). The term runs on; terms planned after it are removed.
 */
export function planWithdraw(terms: readonly TermRow[], today: ISODate): TermChange {
  const cancelled = terms
    .filter((t) => t.cancelledAt !== null && t.endsOn !== null && t.endsOn >= today)
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0];
  if (!cancelled) throw new Error("Es gibt keine Kündigung, die noch zurückgenommen werden kann.");
  // Terms after its end (also the follow-up of a term that never started: same first day).
  const follower = terms.filter((t) => t.id !== cancelled.id && t.startsOn > cancelled.endsOn!).map((t) => t.id);
  return { remove: follower, end: [], reopen: [cancelled.id], add: null };
}

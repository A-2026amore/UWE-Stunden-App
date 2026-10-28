/**
 * Work-time account ("Arbeitszeitkonto").
 *
 * Port of the legacy uwe-arbeitszeitkonto.js. The legacy module models one
 * account per NRW school year: every cycle opens at −100 h (−6000 min), runs
 * from the first school day after the summer holidays to the last school day
 * before the next summer holidays, and older cycles stay documented. The
 * employee decides per month how many of the hours worked during school time
 * are booked into the account ("allocation"); the rest is intended for
 * payroll ("billing"). The actually worked minutes are NEVER modified.
 *
 * Generalisations for the multi-tenant platform (UWE behaviour unchanged):
 *  - opening balance, start month, federal state, model and approval are
 *    taken from WorkAccountPolicy;
 *  - holiday data comes from a pluggable HolidayProvider (official table +
 *    validated cached/online values, like the legacy localStorage cache);
 *  - "calendar-year" model: cycle = 1 Jan – 31 Dec, opening from policy,
 *    every month from `startMonth` is active, all worked minutes eligible;
 *  - disabled policy: status "disabled", no allocation possible,
 *    billing = worked.
 *
 * IMPORTANT (business / legal): a technically negative balance (e.g. the
 * opening −100 h) is a bookkeeping figure only. It is NOT a legal claim of
 * the employer against the employee, does not constitute debt, and must not
 * be offset against wages. Any binding arrangement requires a separate
 * agreement checked by the employer (legacy PDF: "Keine verbindliche
 * Lohnverrechnung").
 */
import type {
  ISODate, ISOMonth, MonthAllocation, MonthSummary, WorkAccountCycle, WorkAccountModel, WorkAccountPolicy,
} from "./types";
import { activeShifts, addDays, daysInMonth, formatHours, isValidMonth, type ShiftInput } from "./time";

// ---------------------------------------------------------------- policy

export const UWE_WORK_ACCOUNT_POLICY: WorkAccountPolicy = Object.freeze({
  enabled: true,
  model: "school-year",
  openingMinutes: -6000,
  federalState: "NW",
  startMonth: "2026-09",
  approvalRequired: false,
}) as WorkAccountPolicy;

/** Upper bound of a single monthly allocation (legacy `validate`). */
export const MAX_ALLOCATION_MINUTES = 600000;

// ---------------------------------------------------------------- holidays

export interface SummerHoliday {
  year: number;
  /** First day of the summer holidays. */
  start: ISODate;
  /** Last day of the summer holidays. */
  end: ISODate;
  source: string;
}

/**
 * Supplies summer-holiday dates. Must return null for unknown years – never
 * guess. Implementations: `nrwHolidayProvider` (official table + cache),
 * `staticHolidayProvider`, or a custom one (e.g. from the database).
 */
export interface HolidayProvider {
  summerHolidays(year: number): SummerHoliday | null;
}

export const NRW_HOLIDAY_SOURCE_URL = "https://bass.schule.nrw/191.htm";
export const OFFICIAL_SOURCE_LABEL = "Offizieller NRW-Ferienkalender";
export const ONLINE_SOURCE_LABEL = "OpenHolidays Online-Ferienkalender";

/**
 * Official NRW summer holidays (copied exactly from the legacy OFFICIAL table;
 * source https://bass.schule.nrw/191.htm). Years not listed are unknown.
 */
export const NRW_SUMMER_HOLIDAYS: Readonly<Record<number, { readonly start: ISODate; readonly end: ISODate }>> = Object.freeze({
  2026: Object.freeze({ start: "2026-07-20", end: "2026-09-01" }),
  2027: Object.freeze({ start: "2027-07-19", end: "2027-08-31" }),
  2028: Object.freeze({ start: "2028-07-10", end: "2028-08-22" }),
  2029: Object.freeze({ start: "2029-07-02", end: "2029-08-14" }),
  2030: Object.freeze({ start: "2030-06-24", end: "2030-08-06" }),
});

/** Cached online values: { "2031": { start, end } } (legacy key uwe_nrw_sommerferien_v2). */
export type HolidayCache = Record<string, { start: string; end: string }>;

function isRealISOInYear(value: unknown, year: number): value is ISODate {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y === year && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function sanitizeCache(cache: unknown): Record<string, unknown> {
  return cache && typeof cache === "object" && !Array.isArray(cache) ? (cache as Record<string, unknown>) : {};
}

/**
 * Legacy `holiday(year, store)`: official table first, then a validated cache
 * row (real dates in that year, end > start, start month May–September).
 * Years outside 2026–2100 → null.
 */
export function nrwHolidayProvider(cache?: unknown): HolidayProvider {
  const rows = sanitizeCache(cache);
  return {
    summerHolidays(year: number): SummerHoliday | null {
      const y = Number(year);
      if (!Number.isInteger(y) || y < 2026 || y > 2100) return null;
      const official = NRW_SUMMER_HOLIDAYS[y];
      if (official) return { year: y, start: official.start, end: official.end, source: OFFICIAL_SOURCE_LABEL };
      const row = rows[String(y)] as { start?: unknown; end?: unknown } | undefined;
      if (row && isRealISOInYear(row.start, y) && isRealISOInYear(row.end, y) && row.end > row.start &&
          row.start.slice(5, 7) >= "05" && row.start.slice(5, 7) <= "09")
        return { year: y, start: row.start, end: row.end, source: ONLINE_SOURCE_LABEL };
      return null;
    },
  };
}

/** Provider from an explicit table (e.g. loaded from the database). */
export function staticHolidayProvider(
  table: Readonly<Record<number | string, { start: ISODate; end: ISODate; source?: string }>>,
  source = "Ferienkalender",
): HolidayProvider {
  return {
    summerHolidays(year: number) {
      const row = table[year];
      return row ? { year, start: row.start, end: row.end, source: row.source ?? source } : null;
    },
  };
}

export const EMPTY_HOLIDAY_PROVIDER: HolidayProvider = Object.freeze({ summerHolidays: () => null });

/** Default provider for a policy: NRW data for "NW", otherwise none (→ "unknown"). */
export function holidayProviderFor(policy: WorkAccountPolicy, cache?: unknown): HolidayProvider {
  return policy.federalState === "NW" ? nrwHolidayProvider(cache) : EMPTY_HOLIDAY_PROVIDER;
}

/** OpenHolidays API URL used by legacy `findHolidayOnline`. */
export function openHolidaysUrl(year: number, subdivisionCode = "DE-NW"): string {
  return "https://openholidaysapi.org/SchoolHolidays?countryIsoCode=DE&subdivisionCode=" + subdivisionCode +
    "&validFrom=" + year + "-01-01&validTo=" + year + "-12-31&languageIsoCode=DE";
}

/**
 * Picks the summer holidays from an OpenHolidays response (legacy filter:
 * name matches /sommer|summer/i, real dates in that year, end > start,
 * earliest first). Returns a cache row or null.
 */
export function pickSummerHoliday(list: unknown, year: number): { start: ISODate; end: ISODate } | null {
  if (!Array.isArray(list)) return null;
  const matching = list.filter((x: unknown) => {
    if (!x || typeof x !== "object") return false;
    const item = x as { name?: unknown; startDate?: unknown; endDate?: unknown };
    const name = Array.isArray(item.name)
      ? item.name.map((t: unknown) => (t && typeof t === "object" ? String((t as { text?: unknown }).text || "") : "")).join(" ")
      : String(item.name || "");
    return /sommer|summer/i.test(name) && isRealISOInYear(item.startDate, year) && isRealISOInYear(item.endDate, year) &&
      (item.endDate as string) > (item.startDate as string);
  }) as { startDate: string; endDate: string }[];
  matching.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const item = matching[0];
  return item ? { start: item.startDate, end: item.endDate } : null;
}

/**
 * Online lookup with an injected fetch (legacy `findHolidayOnline`): only for
 * years 2031–2100 not already known. Returns the new cache (unchanged when
 * nothing reliable was found) – the caller persists it.
 */
export async function refreshHolidayCache(
  year: number,
  cache: HolidayCache,
  fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
  subdivisionCode = "DE-NW",
): Promise<HolidayCache> {
  if (nrwHolidayProvider(cache).summerHolidays(year)) return cache;
  if (!Number.isInteger(year) || year < 2031 || year > 2100) return cache;
  let list: unknown;
  try {
    const response = await fetchFn(openHolidaysUrl(year, subdivisionCode));
    if (!response.ok) return cache;
    list = await response.json();
  } catch {
    return cache;
  }
  const row = pickSummerHoliday(list, year);
  return row ? { ...cache, [String(year)]: row } : cache;
}

// ---------------------------------------------------------------- cycles

export type CycleStatus = MonthSummary["cycleStatus"];

/** WorkAccountCycle plus the numeric year and school-year details. */
export interface AccountCycle extends WorkAccountCycle {
  year: number;
  model: WorkAccountModel;
  /** School-year: last school day (= end). Calendar-year: 31 Dec. */
  lastSchoolDay: ISODate;
  /** School-year: first day after the next summer holidays (next cycle start). */
  afterSummerStart?: ISODate;
}

/** Legacy `lastSchoolday`: day before the holidays, skipping Sat/Sun only. */
function lastSchoolDayBefore(summerStart: ISODate): ISODate {
  let day = addDays(summerStart, -1);
  for (let j = 0; j < 7; j++) {
    const dow = new Date(day + "T12:00:00Z").getUTCDay();
    if (dow !== 0 && dow !== 6) return day;
    day = addDays(day, -1);
  }
  return day;
}

/**
 * School year `year`/`year+1` (legacy `cycle`). Null when either summer
 * holiday is unknown – unknown years are never guessed.
 */
export function schoolYearCycle(year: number, provider: HolidayProvider): AccountCycle | null {
  const y = Number(year);
  const previous = provider.summerHolidays(y);
  const next = provider.summerHolidays(y + 1);
  if (!previous || !next) return null;
  const start = addDays(previous.end, 1);
  const end = lastSchoolDayBefore(next.start);
  if (start >= next.start || end < start) return null;
  return {
    year: y,
    id: String(y),
    label: String(y) + "/" + String(y + 1).slice(2),
    model: "school-year",
    start,
    end,
    lastSchoolDay: end,
    summerStart: next.start,
    summerEnd: next.end,
    afterSummerStart: addDays(next.end, 1),
    source: next.source,
  };
}

/** Calendar-year cycle: 1 Jan – 31 Dec. */
export function calendarYearCycle(year: number): AccountCycle {
  const y = Number(year);
  return {
    year: y, id: String(y), label: String(y), model: "calendar-year",
    start: y + "-01-01", end: y + "-12-31", lastSchoolDay: y + "-12-31", source: "Kalenderjahr",
  };
}

function startYear(policy: WorkAccountPolicy): number {
  return Number(policy.startMonth.slice(0, 4));
}

/** Cycle a single day belongs to (legacy `schoolYearForDate`), null outside any cycle. */
export function cycleForDate(date: ISODate, policy: WorkAccountPolicy, provider: HolidayProvider = holidayProviderFor(policy)): AccountCycle | null {
  if (!policy.enabled) return null;
  if (typeof date !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) return null;
  const y = Number(date.slice(0, 4));
  if (policy.model === "calendar-year") return date.slice(0, 7) >= policy.startMonth ? calendarYearCycle(y) : null;
  for (const candidate of [y - 1, y]) {
    if (candidate < startYear(policy)) continue;
    const school = schoolYearCycle(candidate, provider);
    if (school && date >= school.start && date <= school.lastSchoolDay) return school;
  }
  return null;
}

/** Detailed month classification (legacy `calendarForMonth`). */
export interface CycleInfo {
  status: CycleStatus;
  /** Active: the month's cycle. Vacation: the cycle that just closed (may be null). */
  cycle: AccountCycle | null;
  /** Legacy `label`: cycle label, "Sommerferien" or "Termin offen". */
  label: string;
  /** Vacation only. */
  previous?: AccountCycle | null;
  next?: AccountCycle | null;
  summerStart?: ISODate;
  summerEnd?: ISODate;
  afterSummerStart?: ISODate;
}

export function cycleInfoForMonth(month: ISOMonth, policy: WorkAccountPolicy, provider: HolidayProvider = holidayProviderFor(policy)): CycleInfo {
  if (!isValidMonth(month)) throw new Error("Bitte gültigen Monat wählen.");
  if (!policy.enabled) return { status: "disabled", cycle: null, label: "Kein Arbeitszeitkonto" };
  if (policy.model === "calendar-year") {
    if (month < policy.startMonth) return { status: "before", cycle: null, label: "Termin offen" };
    const c = calendarYearCycle(Number(month.slice(0, 4)));
    return { status: "active", cycle: c, label: c.label };
  }
  const start = month + "-01";
  const end = addDays(start, daysInMonth(month) - 1);
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const found = cycleForDate(d, policy, provider);
    if (found) return { status: "active", cycle: found, label: found.label };
  }
  const year = Number(month.slice(0, 4));
  for (const candidate of [year - 1, year]) {
    const h = provider.summerHolidays(candidate);
    if (h && start <= h.end && end >= h.start) {
      const prev = schoolYearCycle(candidate - 1, provider);
      const next = schoolYearCycle(candidate, provider);
      return {
        status: "vacation", cycle: prev, label: prev?.label || "Sommerferien",
        previous: prev, next, summerStart: h.start, summerEnd: h.end, afterSummerStart: addDays(h.end, 1),
      };
    }
  }
  return { status: month < policy.startMonth ? "before" : "unknown", cycle: null, label: "Termin offen" };
}

/** active | vacation | before | unknown | disabled. */
export function cycleStatusForMonth(month: ISOMonth, policy: WorkAccountPolicy, provider: HolidayProvider = holidayProviderFor(policy)): CycleStatus {
  return cycleInfoForMonth(month, policy, provider).status;
}

// ---------------------------------------------------------------- minutes

/**
 * Legacy account `gross(record)`: span (end − start, +1440 if negative;
 * start === end ⇒ 0) minus `pause || 0`. NaN for malformed clock strings.
 */
function accountMinutes(r: { start: unknown; end: unknown; pause: unknown }): number {
  const a = String(r.start || "");
  const b = String(r.end || "");
  if (!/^\d{2}:\d{2}$/.test(a) || !/^\d{2}:\d{2}$/.test(b)) return NaN;
  const val = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let span = val(b) - val(a);
  if (span < 0) span += 1440;
  const pause = Number(r.pause || 0);
  return Number.isFinite(pause) ? span - pause : NaN;
}

/** Worked minutes of a month (legacy `worked`). Throws on invalid records. */
export function workedMinutesInMonth(entries: readonly ShiftInput[] | null | undefined, month: ISOMonth): number {
  let total = 0;
  for (const r of activeShifts(entries)) {
    if (!r?.date || r.date.slice(0, 7) !== month) continue;
    const m = accountMinutes(r);
    if (!Number.isFinite(m) || m < 0) throw new Error("Ungültige Monatsarbeitszeit.");
    total += m;
  }
  return total;
}

/** Minutes of `month` that fall inside the month's active cycle (legacy `eligibleWorked`). */
export function eligibleMinutesInMonth(
  entries: readonly ShiftInput[] | null | undefined,
  month: ISOMonth,
  policy: WorkAccountPolicy,
  provider: HolidayProvider = holidayProviderFor(policy),
  info: CycleInfo = cycleInfoForMonth(month, policy, provider),
): number {
  if (info.status !== "active" || !info.cycle) return 0;
  let total = 0;
  for (const r of activeShifts(entries)) {
    if (!r?.date || r.date.slice(0, 7) !== month) continue;
    if (cycleForDate(r.date, policy, provider)?.year !== info.cycle.year) continue;
    const minutes = accountMinutes(r);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error("Ungültige Einsatzzeit.");
    total += minutes;
  }
  return total;
}

// ---------------------------------------------------------------- allocations

/**
 * Allocations that count for the account, as month → minutes.
 * - rejected allocations never count;
 * - with `approvalRequired`, only approved allocations count;
 * - zero minutes = no allocation (legacy deletes them);
 * - a later array element for the same month overrides an earlier one.
 */
export function countedAllocations(allocations: readonly MonthAllocation[] | null | undefined, policy: WorkAccountPolicy): Map<ISOMonth, number> {
  const out = new Map<ISOMonth, number>();
  if (!policy.enabled) return out;
  for (const a of allocations ?? []) {
    if (!a || !isValidMonth(a.month)) continue;
    const counts = a.status !== "rejected" && (!policy.approvalRequired || a.status === "approved");
    if (counts && Number.isSafeInteger(a.minutes) && a.minutes > 0) out.set(a.month, a.minutes);
    else out.delete(a.month);
  }
  return out;
}

function balanceThrough(
  counted: Map<ISOMonth, number>,
  year: number,
  policy: WorkAccountPolicy,
  provider: HolidayProvider,
  throughMonth: ISOMonth | null,
): number {
  let total = policy.openingMinutes;
  for (const [month, minutes] of counted) {
    if (throughMonth && month > throughMonth) continue;
    const info = cycleInfoForMonth(month, policy, provider);
    if (info.status === "active" && info.cycle?.year === year) total += minutes;
  }
  return total;
}

/** Balance of cycle `year` (optionally up to and including `throughMonth`). */
export function cycleBalance(args: {
  allocations: readonly MonthAllocation[];
  year: number;
  policy: WorkAccountPolicy;
  provider?: HolidayProvider;
  throughMonth?: ISOMonth | null;
}): number {
  const provider = args.provider ?? holidayProviderFor(args.policy);
  return balanceThrough(countedAllocations(args.allocations, args.policy), args.year, args.policy, provider, args.throughMonth ?? null);
}

export interface AllocationProblem {
  month: ISOMonth;
  allocated: number;
  /** Eligible minutes actually available in that month. */
  worked: number;
}

/** Allocations exceeding the eligible minutes of their month (legacy `invalidAllocations`). */
export function invalidAllocations(args: {
  entries: readonly ShiftInput[];
  allocations: readonly MonthAllocation[];
  policy: WorkAccountPolicy;
  provider?: HolidayProvider;
  /** Only months <= endMonth. */
  endMonth?: ISOMonth | null;
}): AllocationProblem[] {
  const provider = args.provider ?? holidayProviderFor(args.policy);
  const problems: AllocationProblem[] = [];
  for (const [month, minutes] of countedAllocations(args.allocations, args.policy)) {
    if (args.endMonth && month > args.endMonth) continue;
    const available = eligibleMinutesInMonth(args.entries, month, args.policy, provider);
    if (minutes > available) problems.push({ month, allocated: minutes, worked: available });
  }
  return problems.sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Checks a new allocation for `month` (legacy `update`). Throws the legacy
 * German messages; returns the accepted minutes (0 = remove allocation).
 */
export function validateAllocation(args: {
  entries: readonly ShiftInput[];
  allocations?: readonly MonthAllocation[];
  month: ISOMonth;
  minutes: number;
  policy: WorkAccountPolicy;
  provider?: HolidayProvider;
}): number {
  const { policy, month, minutes } = args;
  const provider = args.provider ?? holidayProviderFor(policy);
  if (!policy.enabled) throw new Error("Das Arbeitszeitkonto ist für dieses Unternehmen nicht aktiviert.");
  const info = cycleInfoForMonth(month, policy, provider);
  if (info.status !== "active") {
    if (policy.model === "calendar-year")
      throw new Error("Übertragungen ins Arbeitszeitkonto sind erst ab " + policy.startMonth.slice(5, 7) + "-" + policy.startMonth.slice(0, 4) + " möglich.");
    throw new Error(info.status === "vacation"
      ? "In den Sommerferien ist das Schuljahreskonto geschlossen. Für das neue Schuljahr beginnt ein neuer Stand von " +
        formatOpening(policy.openingMinutes) + " Stunden."
      : "Für diesen Monat ist noch kein bestätigtes Schuljahr vorhanden. Bitte Ferienkalender online aktualisieren.");
  }
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new Error("Ungültige Stundenanzahl.");
  const available = eligibleMinutesInMonth(args.entries, month, policy, provider, info);
  if (minutes > available) {
    throw new Error(policy.model === "calendar-year"
      ? "Du kannst höchstens " + formatHours(available) + " Stunden dieses Monats übertragen."
      : "Du kannst höchstens " + formatHours(available) + " Stunden aus der Schulzeit dieses Monats übertragen.");
  }
  if (minutes > MAX_ALLOCATION_MINUTES) throw new Error("Ungültige Stundenanzahl.");
  return minutes;
}

/** "–100" for −6000 (legacy message wording uses an en dash). */
function formatOpening(minutes: number): string {
  const h = minutes / 60;
  const text = Number.isInteger(h) ? String(Math.abs(h)) : formatHours(Math.abs(minutes));
  return (minutes < 0 ? "–" : "") + text;
}

// ---------------------------------------------------------------- summaries

/** MonthSummary plus legacy extras used by the UI. */
export interface WorkAccountMonthSummary extends MonthSummary {
  info: CycleInfo;
  /** Raw allocation record for this month (any status), if present. */
  allocation: MonthAllocation | null;
  /** Balance of the same cycle including all its months (legacy `overallBalance`). Null without cycle. */
  overallBalanceMinutes: number | null;
  /** max(0, −overall balance); 0 without cycle. */
  remainingToZeroMinutes: number;
  /** 0–100 progress from opening to zero (legacy `progressPct`). */
  progressPct: number;
  /** Allocation problems up to and including this month. */
  invalid: AllocationProblem[];
}

/**
 * Monthly figures (legacy `summary`).
 *
 * billing = max(0, worked − allocated); worked is never modified.
 * `balanceMinutes` is null when no cycle applies (legacy showed the opening
 * value −6000 there but displayed "—" in the UI).
 */
export function summarizeMonth(args: {
  entries: readonly ShiftInput[];
  allocations: readonly MonthAllocation[];
  month: ISOMonth;
  policy: WorkAccountPolicy;
  provider?: HolidayProvider;
}): WorkAccountMonthSummary {
  const { month, policy } = args;
  const provider = args.provider ?? holidayProviderFor(policy);
  if (!isValidMonth(month)) throw new Error("Bitte gültigen Monat wählen.");
  const info = cycleInfoForMonth(month, policy, provider);
  const workedMinutes = workedMinutesInMonth(args.entries, month);
  const ownAllocation = [...(args.allocations ?? [])].reverse().find((a) => a && a.month === month) ?? null;
  if (!policy.enabled) {
    return {
      month, workedMinutes, eligibleMinutes: 0, allocatedMinutes: 0, billingMinutes: workedMinutes,
      cycle: null, cycleStatus: "disabled", balanceMinutes: null, info, allocation: ownAllocation,
      overallBalanceMinutes: null, remainingToZeroMinutes: 0, progressPct: 0, invalid: [],
    };
  }
  const counted = countedAllocations(args.allocations, policy);
  const eligibleMinutes = info.status === "active" ? eligibleMinutesInMonth(args.entries, month, policy, provider, info) : 0;
  const allocatedMinutes = counted.get(month) ?? 0;
  const year = info.cycle?.year ?? null;
  const balance = year != null ? balanceThrough(counted, year, policy, provider, month) : null;
  const overall = year != null ? balanceThrough(counted, year, policy, provider, null) : null;
  const overallOrOpening = overall ?? policy.openingMinutes;
  const opening = policy.openingMinutes;
  return {
    month,
    workedMinutes,
    eligibleMinutes,
    allocatedMinutes,
    billingMinutes: Math.max(0, workedMinutes - allocatedMinutes),
    cycle: info.cycle,
    cycleStatus: info.status,
    balanceMinutes: balance,
    info,
    allocation: ownAllocation,
    overallBalanceMinutes: overall,
    remainingToZeroMinutes: Math.max(0, -overallOrOpening),
    progressPct: opening < 0 ? Math.max(0, Math.min(100, ((overallOrOpening - opening) / -opening) * 100)) : 100,
    invalid: invalidAllocations({ entries: args.entries, allocations: args.allocations, policy, provider, endMonth: month }),
  };
}

export interface CycleBalance {
  cycle: AccountCycle;
  balanceMinutes: number;
}

/**
 * All cycles from the policy's start year up to `now` plus every cycle that
 * has an allocation, with their total balances (legacy `cyclesWithBalances`).
 */
export function cycleBalances(args: {
  allocations: readonly MonthAllocation[];
  policy: WorkAccountPolicy;
  provider?: HolidayProvider;
  now?: Date;
}): CycleBalance[] {
  const { policy } = args;
  if (!policy.enabled) return [];
  const provider = args.provider ?? holidayProviderFor(policy);
  const now = args.now ?? new Date();
  const first = startYear(policy);
  const counted = countedAllocations(args.allocations, policy);
  const cycleOf = (y: number) => (policy.model === "calendar-year" ? calendarYearCycle(y) : schoolYearCycle(y, provider));
  const years = new Set<number>([first]);
  for (let y = first; y <= now.getFullYear(); y++) if (cycleOf(y)) years.add(y);
  for (const month of counted.keys()) {
    const info = cycleInfoForMonth(month, policy, provider);
    if (info.status === "active" && info.cycle) years.add(info.cycle.year);
  }
  const out: CycleBalance[] = [];
  for (const year of [...years].sort((a, b) => a - b)) {
    const c = cycleOf(year);
    if (c) out.push({ cycle: c, balanceMinutes: balanceThrough(counted, year, policy, provider, null) });
  }
  return out;
}

/**
 * Next summer holidays starting on/after `reference` (legacy `nextSummer`).
 * Legacy quirk (kept): "today" is computed as
 * `new Date(y, m, d).toISOString()`, i.e. local midnight converted to UTC –
 * in German time zones that is the PREVIOUS calendar day, so holidays that
 * started yesterday still count as "next".
 */
export function nextSummerHoliday(provider: HolidayProvider, reference: Date = new Date()): SummerHoliday | null {
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).toISOString().slice(0, 10);
  const from = Math.max(reference.getFullYear(), 2026);
  for (let y = from; y <= from + 2; y++) {
    const h = provider.summerHolidays(y);
    if (h && h.start >= today) return h;
  }
  return null;
}

/** Days from the local date of `reference` until `value` (legacy `daysUntil`). */
export function daysUntil(value: ISODate, reference: Date = new Date()): number {
  const day = Date.UTC(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const target = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Math.round((target - day) / 86400000);
}

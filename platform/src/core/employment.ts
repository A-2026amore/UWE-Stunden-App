/**
 * Employment contract data and the hours account derived from it (migration 0025).
 *
 * The leadership records per employee: kind of employment (Minijob, Teilzeit,
 * Vollzeit, offen), hourly wage and target hours per month – or no target
 * ("offen": any number of hours, no hours account). Changes are stored as
 * versions with a first month (validFrom), so past months keep their values.
 *
 * Hours account ("Arbeitszeitkonto laut Vertrag"), per month from the first version on:
 *  - payable minutes = worked minutes minus what went into the work-time
 *    account of the tenant (summarizeMonth().billingMinutes; equal to the worked
 *    minutes when that account is not enabled);
 *  - difference = payable − target (plus = Mehrstunden, minus = Minderstunden);
 *  - finished months count fully; the running month counts only Mehrstunden
 *    (hours already worked stay worked – Minderstunden are known only at the
 *    end of the month);
 *  - a version's carry-over is booked once in its first month.
 * Months with an open contract change nothing. The worked minutes themselves are
 * never modified.
 *
 * IMPORTANT (business / legal): the figures are information for the employer,
 * not a payroll. Minimum wage and Minijob limit below are hints; exceptions
 * (e.g. trainees, minors) and the binding values must be checked by the employer.
 */
import type { EmploymentContract, EmploymentType, ISOMonth } from "./types";
import { isValidMonth } from "./time";

export const EMPLOYMENT_TYPES: readonly EmploymentType[] = ["minijob", "teilzeit", "vollzeit", "offen"];

export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  minijob: "Minijob",
  teilzeit: "Teilzeit",
  vollzeit: "Vollzeit",
  offen: "Sonstiges",
};

// ---------------------------------------------------------------- statutory values

export interface StatutoryLimits {
  /** First month the values apply to. */
  from: ISOMonth;
  /** Statutory minimum wage per hour (gross, cents). */
  minimumWageCents: number;
  /** Monthly earnings limit of a Minijob (cents) = minimum wage × 130 / 3, rounded up to full euros (§ 8 Abs. 1a SGB IV). */
  minijobLimitCents: number;
}

/**
 * Mindestlohn (Vierte/Fünfte Mindestlohnanpassungsverordnung) and the Minijob limit
 * derived from it. Sorted ascending; extend when a new ordinance is published.
 */
export const STATUTORY_LIMITS: readonly StatutoryLimits[] = Object.freeze([
  { from: "2025-01", minimumWageCents: 1282, minijobLimitCents: 55600 },
  { from: "2026-01", minimumWageCents: 1390, minijobLimitCents: 60300 },
  { from: "2027-01", minimumWageCents: 1460, minijobLimitCents: 63300 },
]);

/** Values in force in the month; null before the first known value. */
export function statutoryLimitsFor(month: ISOMonth): StatutoryLimits | null {
  let found: StatutoryLimits | null = null;
  for (const l of STATUTORY_LIMITS) if (l.from <= month) found = l;
  return found;
}

/** Full hours a Minijob may have at this wage without exceeding the limit (e.g. 14,00 € in 2026 → 43 h). */
export function suggestedMinijobTargetMinutes(hourlyWageCents: number | null, month: ISOMonth): number | null {
  const limits = statutoryLimitsFor(month);
  if (!limits || !hourlyWageCents || hourlyWageCents <= 0) return null;
  return Math.floor(limits.minijobLimitCents / hourlyWageCents) * 60;
}

// ---------------------------------------------------------------- input

export interface EmploymentInput {
  validFrom: ISOMonth;
  employmentType: EmploymentType;
  hourlyWageCents: number | null;
  monthlyTargetMinutes: number | null;
  carryOverMinutes: number;
}

/** Same limits as the database (0025). */
export const MAX_HOURLY_WAGE_CENTS = 100_000;
export const MAX_MONTHLY_TARGET_MINUTES = 400 * 60;
export const MAX_CARRY_OVER_MINUTES = 2000 * 60;

/** Checks a contract version; throws a German message. */
export function validateEmploymentInput(input: EmploymentInput): EmploymentInput {
  if (!isValidMonth(input.validFrom)) throw new Error("Bitte den Monat angeben, ab dem die Angaben gelten.");
  if (!EMPLOYMENT_TYPES.includes(input.employmentType)) throw new Error("Bitte die Art des Arbeitsvertrags wählen.");
  const wage = input.hourlyWageCents;
  if (wage !== null && (!Number.isSafeInteger(wage) || wage < 1 || wage > MAX_HOURLY_WAGE_CENTS)) {
    throw new Error("Der Stundenlohn muss zwischen 0,01 € und 1.000,00 € liegen.");
  }
  const target = input.monthlyTargetMinutes;
  if (target !== null && (!Number.isSafeInteger(target) || target < 1 || target > MAX_MONTHLY_TARGET_MINUTES)) {
    throw new Error("Die Soll-Stunden pro Monat müssen zwischen 0,01 und 400 Stunden liegen – oder „offen“.");
  }
  const carry = input.carryOverMinutes;
  if (!Number.isSafeInteger(carry) || Math.abs(carry) > MAX_CARRY_OVER_MINUTES) {
    throw new Error("Der Übertrag darf höchstens ±2000 Stunden betragen.");
  }
  return { ...input };
}

// ---------------------------------------------------------------- account

/** Version in force in the month (latest validFrom ≤ month); null = no contract data yet. */
export function contractForMonth<T extends Pick<EmploymentContract, "validFrom">>(versions: readonly T[], month: ISOMonth): T | null {
  let found: T | null = null;
  for (const v of versions) if (v.validFrom <= month && (!found || v.validFrom > found.validFrom)) found = v;
  return found;
}

export function nextMonth(month: ISOMonth): ISOMonth {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Months from `from` to `to` (both included); empty when from > to. */
export function monthsBetween(from: ISOMonth, to: ISOMonth): ISOMonth[] {
  const out: ISOMonth[] = [];
  for (let m = from; m <= to && out.length < 1200; m = nextMonth(m)) out.push(m);
  return out;
}

export interface EmploymentMonth {
  month: ISOMonth;
  contract: EmploymentContract;
  /** Null = open contract. */
  targetMinutes: number | null;
  payableMinutes: number;
  /** payable − target; null for an open contract. */
  differenceMinutes: number | null;
  /** Month not finished yet (only Mehrstunden are booked). */
  running: boolean;
  /** Booked into the account in this month (difference as described above + carry-over). */
  bookedMinutes: number;
  carryOverMinutes: number;
  balanceAfterMinutes: number;
  /** payable hours × hourly wage (cents); null without wage. */
  earningsCents: number | null;
  /** Minijob whose earnings exceed the monthly limit. */
  overMinijobLimit: boolean;
  minijobLimitCents: number | null;
  /** Hourly wage below the statutory minimum wage of the month (hint only). */
  belowMinimumWage: boolean;
}

export interface EmploymentAccount {
  /** First month with contract data; null when there is none (yet). */
  startMonth: ISOMonth | null;
  /** Chronological, from startMonth to the current month. */
  months: EmploymentMonth[];
  /** Balance after the current month (Mehrstunden positive). */
  balanceMinutes: number;
  /** Row of the current month (null when the contract starts later). */
  current: EmploymentMonth | null;
  /** Some month has a target – an hours account exists. */
  hasAccount: boolean;
}

/**
 * Hours account of one employee up to `currentMonth`.
 * `payableMinutes(month)` returns the payable minutes of that month.
 */
export function employmentAccount(args: {
  versions: readonly EmploymentContract[];
  payableMinutes: (month: ISOMonth) => number;
  currentMonth: ISOMonth;
}): EmploymentAccount {
  const { versions, currentMonth } = args;
  const sorted = [...versions].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const startMonth = sorted[0]?.validFrom ?? null;
  const months: EmploymentMonth[] = [];
  let balance = 0;
  let hasAccount = false;
  if (startMonth) {
    for (const month of monthsBetween(startMonth, currentMonth)) {
      const contract = contractForMonth(sorted, month)!;
      const targetMinutes = contract.monthlyTargetMinutes;
      const payableMinutes = Math.max(0, args.payableMinutes(month) || 0);
      const running = month === currentMonth;
      const differenceMinutes = targetMinutes === null ? null : payableMinutes - targetMinutes;
      const carryOverMinutes = contract.validFrom === month ? contract.carryOverMinutes : 0;
      const diffBooked = differenceMinutes === null ? 0 : running ? Math.max(0, differenceMinutes) : differenceMinutes;
      const bookedMinutes = diffBooked + carryOverMinutes;
      if (targetMinutes !== null || carryOverMinutes !== 0) hasAccount = true;
      balance += bookedMinutes;
      const wage = contract.hourlyWageCents;
      const earningsCents = wage === null ? null : Math.round((payableMinutes * wage) / 60);
      const limits = statutoryLimitsFor(month);
      const minijobLimitCents = contract.employmentType === "minijob" ? limits?.minijobLimitCents ?? null : null;
      months.push({
        month, contract, targetMinutes, payableMinutes, differenceMinutes, running, bookedMinutes, carryOverMinutes,
        balanceAfterMinutes: balance, earningsCents, minijobLimitCents,
        overMinijobLimit: minijobLimitCents !== null && earningsCents !== null && earningsCents > minijobLimitCents,
        belowMinimumWage: wage !== null && limits !== null && wage < limits.minimumWageCents,
      });
    }
  }
  return {
    startMonth, months, balanceMinutes: balance, current: months.find((m) => m.month === currentMonth) ?? null, hasAccount,
  };
}

export type TargetState = "open" | "over" | "under" | "met" | "running";

/** Over / under target; "running" = current month still below target. */
export function targetState(m: Pick<EmploymentMonth, "differenceMinutes" | "running">): TargetState {
  if (m.differenceMinutes === null) return "open";
  if (m.differenceMinutes > 0) return "over";
  if (m.differenceMinutes === 0) return "met";
  return m.running ? "running" : "under";
}

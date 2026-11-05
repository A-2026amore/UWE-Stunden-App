/**
 * Rough estimate of the employer's additional labour costs ("Lohnnebenkosten",
 * Arbeitgeberanteile) on top of the gross wage, shown in the chef dashboard.
 *
 * IMPORTANT (business / legal): this is a deliberately rough estimate for the
 * employer, NOT a payroll. Not included: Berufsgenossenschaft (depends on the
 * trade), contribution ceilings (Beitragsbemessungsgrenzen), special cases
 * (trainees, pensioners, students, private households), the individual
 * Zusatzbeitrag / U1 rate of the health insurer. Pauschalsteuer of a Minijob is
 * assumed (2 %).
 *
 * Model:
 *  - Minijob (gewerblich): flat rate = KV 13 % + RV 15 % + Pauschsteuer 2 % + Umlagen.
 *  - Teilzeit / Vollzeit: employer share of social insurance (half of the total
 *    rate) + Umlagen (U1/U2/Insolvenzgeld, approximate).
 *  - Übergangsbereich (Midijob, above the Minijob limit up to 2.000 €): employer
 *    share = total contribution on the reduced base BE minus the employee share on
 *    BE' (§ 20 Abs. 2a SGB IV, since 2023). Runs from about 28 % at the Minijob
 *    limit down to the normal share at 2.000 €.
 *  - Teilzeit / Vollzeit whose expected monthly pay does not exceed the Minijob
 *    limit is calculated like a Minijob.
 *  - "offen" (Sonstiges): no estimate (could be anything: trainee, student …).
 *
 * The category is chosen by the expected monthly pay (target hours × wage) when
 * there is a target, so a part-timer is not treated as a Minijob in the middle
 * of the month just because few hours have been worked yet.
 */
import type { EmploymentType, ISOMonth } from "./types";
import { statutoryLimitsFor } from "./employment";

export interface EmployerCostRates {
  /** First month the values apply to. */
  from: ISOMonth;
  /** Total social insurance rate KV (incl. average Zusatzbeitrag) + RV + AV + PV, in per mille × 10 (basis points). */
  totalSocialBp: number;
  /** Employer share of a regular employment (half of totalSocialBp), basis points. */
  employerSocialBp: number;
  /** U1 + U2 + Insolvenzgeldumlage of a regular employment, approximate, basis points. */
  levyBp: number;
  /** Minijob flat rates KV + RV + Pauschsteuer + Umlagen, basis points. */
  minijobBp: number;
  /** Upper limit of the Übergangsbereich (cents). */
  midijobUpperCents: number;
}

/**
 * Approximate values. Sorted ascending; the latest entry applies to later months
 * until a new one is added.
 *  2025: KV 14,6 + Ø-Zusatz 2,5, RV 18,6, AV 2,6, PV 3,6 = 41,9 %
 *  2026: KV 14,6 + Ø-Zusatz 2,9, RV 18,6, AV 2,6, PV 3,6 = 42,3 %
 *  Minijob: KV 13 + RV 15 + Steuer 2 + U1/U2/Insolvenz ca. 1,2 = 31,2 %
 */
export const EMPLOYER_COST_RATES: readonly EmployerCostRates[] = Object.freeze([
  { from: "2025-01", totalSocialBp: 4190, employerSocialBp: 2095, levyBp: 200, minijobBp: 3120, midijobUpperCents: 200000 },
  { from: "2026-01", totalSocialBp: 4230, employerSocialBp: 2115, levyBp: 200, minijobBp: 3120, midijobUpperCents: 200000 },
]);

export function employerCostRatesFor(month: ISOMonth): EmployerCostRates | null {
  let found: EmployerCostRates | null = null;
  for (const r of EMPLOYER_COST_RATES) if (r.from <= month) found = r;
  return found;
}

export type EmployerCostCategory = "minijob" | "midijob" | "regular";

export const EMPLOYER_COST_CATEGORY_LABEL: Record<EmployerCostCategory, string> = {
  minijob: "Minijob-Pauschalen",
  midijob: "Übergangsbereich (Midijob)",
  regular: "Sozialversicherung",
};

export interface EmployerCostEstimate {
  category: EmployerCostCategory;
  /** Approximate employer costs on top of the gross wage (cents). */
  costCents: number;
  /** Gross wage + costCents. */
  totalCents: number;
  /** Rate applied, basis points (3120 = 31,2 %). */
  rateBp: number;
  /** Teilzeit / Vollzeit calculated like a Minijob because the pay is not above the Minijob limit. */
  likeMinijob: boolean;
}

/** Employer rate (basis points) for a monthly pay in the Übergangsbereich, incl. levies. */
function midijobRateBp(payCents: number, limitCents: number, r: EmployerCostRates): number {
  const g = limitCents;
  const og = r.midijobUpperCents;
  const total = r.totalSocialBp / 10000;
  const half = r.employerSocialBp / 10000;
  const f = 0.28 / total;
  const ae = payCents;
  // Reduced base for the total contribution (BE) and for the employee share (BE').
  const be = f * g + (og / (og - g) - (g / (og - g)) * f) * (ae - g);
  const beEmployee = (og / (og - g)) * (ae - g);
  const employer = be * total - beEmployee * half;
  return Math.round((employer / ae) * 10000) + r.levyBp;
}

/**
 * Rough employer costs for `earningsCents` of one month.
 * `expectedMonthlyCents` (target hours × wage) decides the category when given.
 * Returns null for "offen", without earnings or without known rates.
 */
export function estimateEmployerCosts(args: {
  employmentType: EmploymentType;
  earningsCents: number | null;
  expectedMonthlyCents?: number | null;
  month: ISOMonth;
}): EmployerCostEstimate | null {
  const { employmentType, earningsCents, month } = args;
  if (employmentType === "offen" || earningsCents === null || earningsCents < 0) return null;
  const r = employerCostRatesFor(month);
  const limits = statutoryLimitsFor(month);
  if (!r || !limits) return null;
  const base = Math.max(earningsCents, args.expectedMonthlyCents ?? 0);
  let category: EmployerCostCategory;
  let rateBp: number;
  let likeMinijob = false;
  if (employmentType === "minijob" || base <= limits.minijobLimitCents) {
    category = "minijob";
    rateBp = r.minijobBp;
    likeMinijob = employmentType !== "minijob";
  } else if (base <= r.midijobUpperCents) {
    category = "midijob";
    rateBp = midijobRateBp(base, limits.minijobLimitCents, r);
  } else {
    category = "regular";
    rateBp = r.employerSocialBp + r.levyBp;
  }
  const costCents = Math.round((earningsCents * rateBp) / 10000);
  return { category, costCents, totalCents: earningsCents + costCents, rateBp, likeMinijob };
}

/** "31 %" – rate rounded to full percent for display. */
export function formatRate(rateBp: number): string {
  return `${Math.round(rateBp / 100)} %`;
}

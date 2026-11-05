import { describe, expect, it } from "vitest";
import { employerCostRatesFor, estimateEmployerCosts, formatRate } from "./employerCosts";

describe("employer cost estimate", () => {
  it("rates per month", () => {
    expect(employerCostRatesFor("2024-12")).toBeNull();
    expect(employerCostRatesFor("2025-07")?.totalSocialBp).toBe(4190);
    expect(employerCostRatesFor("2027-05")?.totalSocialBp).toBe(4230);
  });

  it("Minijob: flat rates of about 31 %", () => {
    const e = estimateEmployerCosts({ employmentType: "minijob", earningsCents: 6950, expectedMonthlyCents: 59770, month: "2026-11" })!;
    expect(e).toMatchObject({ category: "minijob", rateBp: 3120, costCents: 2168, totalCents: 9118, likeMinijob: false });
    expect(formatRate(e.rateBp)).toBe("31 %");
  });

  it("Vollzeit: employer share of social insurance + levies (about 23 %)", () => {
    const e = estimateEmployerCosts({ employmentType: "vollzeit", earningsCents: 300000, expectedMonthlyCents: 300000, month: "2026-11" })!;
    expect(e).toMatchObject({ category: "regular", rateBp: 2315, costCents: 69450, totalCents: 369450 });
  });

  it("Midijob: about 30 % at the Minijob limit down to the normal rate at 2.000 €", () => {
    const low = estimateEmployerCosts({ employmentType: "teilzeit", earningsCents: 60400, month: "2026-11" })!;
    expect(low.category).toBe("midijob");
    expect(low.rateBp).toBeGreaterThanOrEqual(2990);
    expect(low.rateBp).toBeLessThanOrEqual(3000);
    const mid = estimateEmployerCosts({ employmentType: "teilzeit", earningsCents: 120000, month: "2026-11" })!;
    expect(mid.rateBp).toBeLessThan(low.rateBp);
    expect(mid.rateBp).toBeGreaterThan(2315);
    const top = estimateEmployerCosts({ employmentType: "teilzeit", earningsCents: 200000, month: "2026-11" })!;
    expect(top).toMatchObject({ category: "midijob", rateBp: 2315 });
  });

  it("category follows the expected monthly pay, not the hours worked so far", () => {
    // Teilzeit 50 h × 15 € = 750 € expected; only 7,5 h worked yet (112,50 €).
    const e = estimateEmployerCosts({ employmentType: "teilzeit", earningsCents: 11250, expectedMonthlyCents: 75000, month: "2026-11" })!;
    expect(e.category).toBe("midijob");
    expect(e.likeMinijob).toBe(false);
    expect(e.costCents).toBe(Math.round((11250 * e.rateBp) / 10000));
  });

  it("Teilzeit not above the Minijob limit is calculated like a Minijob", () => {
    const e = estimateEmployerCosts({ employmentType: "teilzeit", earningsCents: 45000, expectedMonthlyCents: 45000, month: "2026-11" })!;
    expect(e).toMatchObject({ category: "minijob", rateBp: 3120, likeMinijob: true });
  });

  it("no estimate for Sonstiges, missing wage or unknown years", () => {
    expect(estimateEmployerCosts({ employmentType: "offen", earningsCents: 100000, month: "2026-11" })).toBeNull();
    expect(estimateEmployerCosts({ employmentType: "minijob", earningsCents: null, month: "2026-11" })).toBeNull();
    expect(estimateEmployerCosts({ employmentType: "minijob", earningsCents: 1000, month: "2020-01" })).toBeNull();
  });
});

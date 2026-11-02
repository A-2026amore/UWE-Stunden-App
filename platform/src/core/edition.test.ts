import { describe, expect, it } from "vitest";
import { applyEdition, editionChangeStart, editionFor, hasPro, nextEdition, planEdition, type EditionRow } from "./edition";
import { billingConditionFor } from "./billing";
import type { TermRow } from "./subscription";

const monthly = (startsOn: string, endsOn: string | null = null): TermRow =>
  ({ id: `m-${startsOn}`, interval: "monthly", startsOn, endsOn, cancelledAt: null, cancelReason: null, thenMonthly: false });
const annual = (startsOn: string, endsOn: string | null = null): TermRow =>
  ({ id: `a-${startsOn}`, interval: "annual", startsOn, endsOn, cancelledAt: endsOn ? "2027-01-01T00:00:00Z" : null, cancelReason: null, thenMonthly: false });

describe("edition rules (migration 0027)", () => {
  it("without a stored change every month is Pro; later changes apply from their month", () => {
    expect(editionFor([], "2026-11")).toBe("pro");
    const rows: EditionRow[] = [{ startsOn: "2026-12-01", edition: "basic" }, { startsOn: "2027-03-01", edition: "pro" }];
    expect(editionFor(rows, "2026-11")).toBe("pro");
    expect(editionFor(rows, "2026-12")).toBe("basic");
    expect(editionFor(rows, "2027-02")).toBe("basic");
    expect(editionFor(rows, "2027-03")).toBe("pro");
    expect(nextEdition(rows, "2026-11-20")).toEqual(rows[0]);
    expect(nextEdition(rows, "2027-01-05")).toEqual(rows[1]);
  });

  it("Pro features: during the trial always, else only in a Pro month", () => {
    const basic: EditionRow[] = [{ startsOn: "2026-11-01", edition: "basic" }];
    expect(hasPro(basic, "2026-11-15", null)).toBe(false);
    expect(hasPro(basic, "2026-11-15", "2027-01-31")).toBe(true);
    expect(hasPro(basic, "2027-02-01", "2027-01-31")).toBe(false);
    expect(hasPro([], "2026-11-15", null)).toBe(true);
  });

  it("change start: Pro now; Basic next month, after the annual term, or from the first paid month", () => {
    expect(editionChangeStart("pro", [monthly("2026-01-01")], "2026-11-15", "2026-01")).toBe("2026-11-01");
    expect(editionChangeStart("basic", [monthly("2026-01-01")], "2026-11-15", "2026-01")).toBe("2026-12-01");
    expect(editionChangeStart("basic", [monthly("2026-01-01")], "2026-12-31", "2026-01")).toBe("2027-01-01");
    // running annual term (12 months from 01.03.2026 → 28.02.2027)
    expect(editionChangeStart("basic", [annual("2026-03-01")], "2026-11-15", "2026-03")).toBe("2027-03-01");
    // after one renewal (+6 months) the next term end counts
    expect(editionChangeStart("basic", [annual("2026-03-01")], "2027-04-10", "2026-03")).toBe("2027-09-01");
    // cancelled annual term: its end
    expect(editionChangeStart("basic", [annual("2026-03-01", "2027-02-28")], "2026-11-15", "2026-03")).toBe("2027-03-01");
    // trial: first paid month
    expect(editionChangeStart("basic", [monthly("2027-02-01")], "2026-11-15", "2027-02")).toBe("2027-02-01");
  });

  it("choosing: Basic is planned, choosing Pro again withdraws; Pro from Basic applies now", () => {
    const terms = [monthly("2026-01-01")];
    const planned = planEdition([], "basic", terms, "2026-11-15", "2026-01");
    expect(planned).toEqual([{ startsOn: "2026-12-01", edition: "basic" }]);
    expect(() => planEdition(planned, "basic", terms, "2026-11-20", "2026-01")).toThrow(/bereits geplant/);
    expect(planEdition(planned, "pro", terms, "2026-11-20", "2026-01")).toEqual([]);
    expect(() => planEdition([], "pro", terms, "2026-11-15", "2026-01")).toThrow(/bereits gewählt/);
    // in Basic since December: Pro from the current month
    expect(planEdition(planned, "pro", terms, "2027-01-10", "2026-01")).toEqual([...planned, { startsOn: "2027-01-01", edition: "pro" }]);
    // Basic started this month and Pro is chosen in the same month: the Basic row disappears
    expect(planEdition(planned, "pro", terms, "2026-12-03", "2026-01")).toEqual([]);
    expect(applyEdition([], "pro", "2026-12-01")).toEqual([]);
  });

  it("billing: Basic months use the Basic prices; special price and promo still apply", () => {
    const sub = { trialEndsOn: null, interval: "monthly" as const, monthlyPriceCents: 650, edition: "basic" as const, basicPriceCents: 199, basicMonthlyPriceCents: 249 };
    expect(billingConditionFor(null, 500, "2026-11", null, null, sub)).toEqual({ condition: "monthly", unitPriceCents: 249 });
    expect(billingConditionFor(null, 500, "2026-11", null, null, { ...sub, interval: "annual" })).toEqual({ condition: "standard", unitPriceCents: 199 });
    expect(billingConditionFor(null, 500, "2026-11", null, null, { ...sub, edition: "pro" })).toEqual({ condition: "monthly", unitPriceCents: 650 });
    expect(billingConditionFor(null, 500, "2026-11", null, { discountPercent: 50 }, { ...sub, interval: "annual" })).toEqual({ condition: "promo", unitPriceCents: 100 });
    const special = { plan: "standard" as const, status: "active" as const, employeePriceCents: 300, freeOfCharge: false, conditionValidFrom: null, conditionValidUntil: null };
    expect(billingConditionFor(special, 500, "2026-11", null, null, sub)).toEqual({ condition: "special", unitPriceCents: 300 });
  });
});

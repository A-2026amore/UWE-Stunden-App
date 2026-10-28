import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMPLOYEE_PRICE_CENTS, billableReason, billingAmount, billingConditionFor, berlinMidnight, berlinMonthOf,
  formatEuro, monthBounds, monthsBack, parseEuro, revenueTotals, type LicenseCondition, type StatusPeriod,
} from "./billing";

const active = (from: string, to: string | null = null, role: StatusPeriod["role"] = "employee"): StatusPeriod => ({ status: "active", role, from, to });

describe("price examples of the client", () => {
  it.each([[5, 2500], [20, 10000], [100, 50000], [0, 0], [1, 500]])("%i billable employees → %i cents", (n, cents) => {
    expect(billingAmount(n, DEFAULT_EMPLOYEE_PRICE_CENTS)).toBe(cents);
  });
  it("rejects fractions and negative values", () => {
    expect(() => billingAmount(1.5, 500)).toThrow();
    expect(() => billingAmount(2, 4.5)).toThrow();
    expect(() => billingAmount(-1, 500)).toThrow();
  });
  it("formats and parses euro amounts", () => {
    expect(formatEuro(2500)).toBe("25,00 €");
    expect(formatEuro(123456)).toBe("1.234,56 €");
    expect(formatEuro(5)).toBe("0,05 €");
    expect(parseEuro("5,00")).toBe(500);
    expect(parseEuro("4,5")).toBe(450);
    expect(parseEuro("12 €")).toBe(1200);
    expect(() => parseEuro("fünf")).toThrow("Betrag");
  });
});

describe("month boundaries in Europe/Berlin", () => {
  it("summer and winter time", () => {
    expect(new Date(berlinMidnight("2026-10-01")).toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(new Date(berlinMidnight("2026-11-01")).toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(new Date(berlinMidnight("2027-04-01")).toISOString()).toBe("2027-03-31T22:00:00.000Z");
    const b = monthBounds("2026-10");
    expect(b).toMatchObject({ firstDay: "2026-10-01", lastDay: "2026-10-31" });
    expect(b.end - b.start).toBe((31 * 24 + 1) * 3600000); // 25-hour day at the end of DST
    expect(monthBounds("2028-02").lastDay).toBe("2028-02-29");
  });
  it("month of an instant", () => {
    expect(berlinMonthOf("2026-09-30T21:30:00Z")).toBe("2026-09"); // 23:30 Berlin
    expect(berlinMonthOf("2026-09-30T22:30:00Z")).toBe("2026-10"); // 00:30 Berlin
    expect(berlinMonthOf("2026-12-31T23:30:00Z")).toBe("2027-01");
  });
  it("months back to the first month", () => {
    expect(monthsBack("2027-01", "2026-11", 12)).toEqual(["2027-01", "2026-12", "2026-11"]);
    expect(monthsBack("2027-01", "2020-01", 2)).toEqual(["2027-01", "2026-12"]);
  });
});

describe("billable persons", () => {
  it("employee active at any time in the month", () => {
    expect(billableReason([active("2026-08-01T00:00:00+02:00")], [], "2026-10")).toBe("employee");
  });
  it("locked mid-month: billed this month, not the next", () => {
    const p: StatusPeriod[] = [active("2026-08-01T00:00:00+02:00", "2026-11-10T09:00:00+01:00"),
      { status: "locked", role: "employee", from: "2026-11-10T09:00:00+01:00", to: null }];
    expect(billableReason(p, [], "2026-11")).toBe("employee");
    expect(billableReason(p, [], "2026-12")).toBeNull();
  });
  it("deactivated one minute before the month: not billed", () => {
    const p: StatusPeriod[] = [active("2026-08-01T00:00:00+02:00", "2026-09-30T23:59:00+02:00"),
      { status: "deactivated", role: "employee", from: "2026-09-30T23:59:00+02:00", to: null }];
    expect(billableReason(p, [], "2026-09")).toBe("employee");
    expect(billableReason(p, [], "2026-10")).toBeNull();
  });
  it("activation at the boundary uses Berlin time", () => {
    expect(billableReason([active("2026-09-30T23:30:00+02:00")], [], "2026-09")).toBe("employee");
    expect(billableReason([active("2026-10-01T00:30:00+02:00")], [], "2026-09")).toBeNull();
  });
  it("invited only: never billable, even with an entry date", () => {
    expect(billableReason([{ status: "invited", role: "employee", from: "2026-08-01T00:00:00Z", to: null }], ["2026-10-02"], "2026-10")).toBeNull();
  });
  it("leadership free without own times, billable with own times in the month", () => {
    const lead = [active("2026-08-01T00:00:00+02:00", null, "manager")];
    expect(billableReason(lead, [], "2026-10")).toBeNull();
    expect(billableReason(lead, ["2026-09-30", "2026-11-01"], "2026-10")).toBeNull();
    expect(billableReason(lead, ["2026-10-31"], "2026-10")).toBe("leader_with_time");
    expect(billableReason([active("2026-08-01T00:00:00+02:00", null, "owner")], ["2026-10-01"], "2026-10")).toBe("leader_with_time");
  });
  it("promoted to manager mid-month: still billed as employee for that month", () => {
    const p = [active("2026-08-01T00:00:00+02:00", "2026-10-15T12:00:00+02:00"), active("2026-10-15T12:00:00+02:00", null, "manager")];
    expect(billableReason(p, [], "2026-10")).toBe("employee");
    expect(billableReason(p, [], "2026-11")).toBeNull();
  });
});

describe("conditions", () => {
  const base: LicenseCondition = { plan: "standard", status: "active", employeePriceCents: null, freeOfCharge: false, conditionValidFrom: null, conditionValidUntil: null };
  it("default price without condition or licence", () => {
    expect(billingConditionFor(base, 500, "2026-10")).toEqual({ condition: "standard", unitPriceCents: 500 });
    expect(billingConditionFor(null, 600, "2026-10")).toEqual({ condition: "standard", unitPriceCents: 600 });
    expect(billingConditionFor({ ...base, status: "expired", freeOfCharge: true }, 500, "2026-10").condition).toBe("standard");
  });
  it("pilot_free is always free", () => {
    expect(billingConditionFor({ ...base, plan: "pilot_free", conditionValidUntil: "2020-01-01" }, 500, "2026-10")).toEqual({ condition: "pilot_free", unitPriceCents: 0 });
  });
  it("special price and free account apply to every month their validity overlaps", () => {
    const special = { ...base, employeePriceCents: 350, conditionValidFrom: "2026-10-15", conditionValidUntil: "2026-12-01" };
    expect(billingConditionFor(special, 500, "2026-09").condition).toBe("standard");
    expect(billingConditionFor(special, 500, "2026-10")).toEqual({ condition: "special", unitPriceCents: 350 });
    expect(billingConditionFor(special, 500, "2026-12").condition).toBe("special");
    expect(billingConditionFor(special, 500, "2027-01").condition).toBe("standard");
    expect(billingConditionFor({ ...special, freeOfCharge: true }, 500, "2026-11")).toEqual({ condition: "free", unitPriceCents: 0 });
  });
});

describe("revenue totals", () => {
  it("excludes demo tenants and reports waived months separately", () => {
    const t = revenueTotals([
      { isDemo: false, status: "paid", billableCount: 20, amountCents: 10000 },
      { isDemo: false, status: "open", billableCount: 5, amountCents: 2500 },
      { isDemo: false, status: "waived", billableCount: 2, amountCents: 1000 },
      { isDemo: false, status: "open", billableCount: 7, amountCents: 0 },
      { isDemo: true, status: "open", billableCount: 3, amountCents: 1500 },
    ]);
    expect(t).toEqual({ billableCount: 34, amountCents: 12500, waivedCents: 1000, demoAmountCents: 1500 });
  });
});

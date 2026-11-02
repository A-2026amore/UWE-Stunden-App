import { describe, expect, it } from "vitest";
import { earliestFreeEnd, freeIn, freeOfferOf, setFreeOffer, type FreePeriod } from "./free-offer";
import { billingConditionFor } from "./billing";

describe("free offer (migration 0029)", () => {
  it("a month is free when a period touches it", () => {
    const p: FreePeriod[] = [{ startsOn: "2026-11-01", endsOn: "2027-01-31" }];
    expect(freeIn(p, "2026-10")).toBe(false);
    expect(freeIn(p, "2026-11")).toBe(true);
    expect(freeIn(p, "2027-01")).toBe(true);
    expect(freeIn(p, "2027-02")).toBe(false);
    expect(freeIn([{ startsOn: "2026-11-01", endsOn: null }], "2030-05")).toBe(true);
    expect(freeIn([], "2026-11")).toBe(false);
  });

  it("switching on: from the current month, open end; again = already free", () => {
    const on = setFreeOffer([], true, null, "2026-11-20");
    expect(on).toEqual([{ startsOn: "2026-11-01", endsOn: null }]);
    expect(freeOfferOf(on, "2026-11-20")).toEqual({ since: "2026-11-01", endsOn: null });
    expect(() => setFreeOffer(on, true, null, "2026-11-21")).toThrow(/bereits kostenlos/);
  });

  it("switching off: last day of a month, at least the end of the next month; on again withdraws the end", () => {
    const on: FreePeriod[] = [{ startsOn: "2026-11-01", endsOn: null }];
    expect(earliestFreeEnd("2026-11-20")).toBe("2026-12-31");
    expect(earliestFreeEnd("2027-01-31")).toBe("2027-02-28");
    expect(() => setFreeOffer(on, false, "2026-11-30", "2026-11-20")).toThrow(/frühestens zum 31.12.2026/);
    expect(() => setFreeOffer(on, false, "2027-01-15", "2026-11-20")).toThrow(/letzte Tag eines Monats/);
    const off = setFreeOffer(on, false, "2026-12-31", "2026-11-20");
    expect(off).toEqual([{ startsOn: "2026-11-01", endsOn: "2026-12-31" }]);
    expect(() => setFreeOffer(off, false, "2027-01-31", "2026-11-20")).toThrow(/nicht unbefristet/);
    expect(setFreeOffer(off, true, null, "2026-12-05")).toEqual(on);
    // after the end: a new period; directly after the end the periods are joined
    expect(setFreeOffer(off, true, null, "2027-01-10")).toEqual(on);
    expect(setFreeOffer(off, true, null, "2027-03-02")).toEqual([...off, { startsOn: "2027-03-01", endsOn: null }]);
    expect(freeOfferOf(off, "2027-01-01")).toBeNull();
  });

  it("billing: 0 € in a free month; blocked tenants and pilots keep their condition", () => {
    const sub = { trialEndsOn: null, interval: "monthly" as const, monthlyPriceCents: 699 };
    expect(billingConditionFor(null, 499, "2026-11", null, { discountPercent: 50 }, sub, true)).toEqual({ condition: "platform_free", unitPriceCents: 0 });
    expect(billingConditionFor(null, 499, "2026-11", null, null, sub, false)).toEqual({ condition: "monthly", unitPriceCents: 699 });
    expect(billingConditionFor(null, 499, "2026-11", { status: "suspended", since: "2026-10-01T00:00:00Z" }, null, sub, true).condition).toBe("tenant_suspended");
    const pilot = { plan: "pilot_free" as const, status: "active" as const, employeePriceCents: null, freeOfCharge: true, conditionValidFrom: null, conditionValidUntil: null };
    expect(billingConditionFor(pilot, 499, "2026-11", null, null, sub, true).condition).toBe("pilot_free");
  });
});

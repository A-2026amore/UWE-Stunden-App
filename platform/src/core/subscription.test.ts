import { describe, expect, it } from "vitest";
import { billingConditionFor } from "./billing";
import {
  addMonthsToDate, annualTermEnd, cancellationEnd, currentAnnualEnd, firstPaidMonthFor, isTrialMonth, planCancel, planChoice,
  planWithdraw, subscriptionView, termForMonth, trialEndsOnFor, type TermRow,
} from "./subscription";

const window = { trialWindowFrom: "2026-11-01", trialWindowUntil: "2027-04-30", trialMonths: 3 };
const term = (p: Partial<TermRow> & Pick<TermRow, "id" | "interval" | "startsOn">): TermRow =>
  ({ endsOn: null, cancelledAt: null, cancelReason: null, thenMonthly: false, ...p });

describe("calendar", () => {
  it("adds months like PostgreSQL (clamped to the month end)", () => {
    expect(addMonthsToDate("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonthsToDate("2027-11-30", 3)).toBe("2028-02-29");
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDate("2026-12-15", 2)).toBe("2027-02-15");
  });
});

describe("trial (introductory offer)", () => {
  it("only inside the window; until the end of the month in which the 3 months end", () => {
    expect(trialEndsOnFor("2026-11-15", window)).toBe("2027-02-28");
    expect(trialEndsOnFor("2026-11-01", window)).toBe("2027-01-31");
    expect(trialEndsOnFor("2027-04-30", window)).toBe("2027-07-31");
    expect(trialEndsOnFor("2026-10-31", window)).toBeNull();
    expect(trialEndsOnFor("2027-05-01", window)).toBeNull();
    expect(trialEndsOnFor("2026-11-15", { ...window, trialWindowFrom: null })).toBeNull();
    expect(firstPaidMonthFor("2026-11-15", "2027-02-28")).toBe("2027-03");
    expect(firstPaidMonthFor("2026-11-01", "2027-01-31")).toBe("2027-02");
    expect(firstPaidMonthFor("2027-06-10", null)).toBe("2027-06");
    expect(isTrialMonth("2027-02-14", "2027-02")).toBe(true);
    expect(isTrialMonth("2027-02-14", "2027-03")).toBe(false);
    expect(isTrialMonth(null, "2027-03")).toBe(false);
  });
});

describe("annual term", () => {
  it("12 months, then +6 months per renewal", () => {
    expect(annualTermEnd("2027-03-01", 0)).toBe("2028-02-29");
    expect(annualTermEnd("2027-03-01", 1)).toBe("2028-08-31");
    expect(annualTermEnd("2027-03-01", 2)).toBe("2029-02-28");
    expect(currentAnnualEnd("2027-03-01", "2027-03-01")).toBe("2028-02-29");
    expect(currentAnnualEnd("2027-03-01", "2028-02-29")).toBe("2028-02-29");
    expect(currentAnnualEnd("2027-03-01", "2028-03-01")).toBe("2028-08-31");
  });
  it("cancellation by the last day ends the term, a day later renews by 6 months; notice days", () => {
    const t = { interval: "annual" as const, startsOn: "2027-03-01" };
    expect(cancellationEnd(t, "2027-05-10", 0)).toBe("2028-02-29");
    expect(cancellationEnd(t, "2028-02-29", 0)).toBe("2028-02-29");
    expect(cancellationEnd(t, "2028-03-01", 0)).toBe("2028-08-31");
    expect(cancellationEnd(t, "2028-02-01", 30)).toBe("2028-08-31");
    expect(cancellationEnd(t, "2028-01-30", 30)).toBe("2028-02-29");
    expect(cancellationEnd(t, "2027-02-10", 0)).toBe("2027-02-28"); // not started: never runs
  });
  it("monthly ends with the current month", () => {
    expect(cancellationEnd({ interval: "monthly", startsOn: "2027-03-01" }, "2027-05-31", 0)).toBe("2027-05-31");
    expect(cancellationEnd({ interval: "monthly", startsOn: "2027-03-01" }, "2027-02-01", 0)).toBe("2027-02-28");
  });
});

describe("plans", () => {
  const monthly = term({ id: "m", interval: "monthly", startsOn: "2027-03-01" });

  it("monthly → annual from the next month, at the earliest the first paid month", () => {
    expect(planChoice([monthly], "annual", "2027-05-20", "2027-03")).toEqual({
      remove: [], reopen: [], end: [{ id: "m", endsOn: "2027-05-31", cancelled: false }], add: { interval: "annual", startsOn: "2027-06-01" },
    });
    // during the trial the monthly term never ran: it is replaced
    expect(planChoice([monthly], "annual", "2026-12-01", "2027-03")).toEqual({
      remove: ["m"], reopen: [], end: [], add: { interval: "annual", startsOn: "2027-03-01" },
    });
  });

  it("annual → monthly only at the term end; same plan twice is refused", () => {
    const annual = term({ id: "a", interval: "annual", startsOn: "2027-03-01" });
    expect(() => planChoice([annual], "monthly", "2027-05-01", "2027-03")).toThrow(/Ende der Laufzeit/);
    expect(() => planChoice([annual], "annual", "2027-05-01", "2027-03")).toThrow(/läuft bereits/);
    expect(() => planChoice([monthly], "monthly", "2027-05-01", "2027-03")).toThrow(/läuft bereits/);
    const c = planCancel([annual], "2027-05-01", 0, true);
    expect(c.end).toEqual([{ id: "a", endsOn: "2028-02-29", cancelled: true, thenMonthly: true }]);
    expect(c.add).toEqual({ interval: "monthly", startsOn: "2028-03-01" });
  });

  it("annual again while a cancelled annual still runs: starts when the planned monthly follow-up would", () => {
    const annual = term({ id: "a", interval: "annual", startsOn: "2027-03-01", endsOn: "2028-02-29", cancelledAt: "2027-05-01T00:00:00Z", thenMonthly: true });
    const follow = term({ id: "f", interval: "monthly", startsOn: "2028-03-01" });
    expect(planChoice([annual, follow], "annual", "2027-06-10", "2027-03")).toEqual({
      remove: ["f"], reopen: [], end: [], add: { interval: "annual", startsOn: "2028-03-01" },
    });
  });

  it("after the end a new term starts in the current month, after a term that still runs", () => {
    const ended = term({ id: "m", interval: "monthly", startsOn: "2027-03-01", endsOn: "2027-04-30", cancelledAt: "2027-04-02T10:00:00Z" });
    expect(planChoice([ended], "monthly", "2027-07-10", "2027-03").add).toEqual({ interval: "monthly", startsOn: "2027-07-01" });
    const ending = { ...ended, endsOn: "2027-07-31" };
    expect(planChoice([ending], "annual", "2027-07-10", "2027-03").add).toEqual({ interval: "annual", startsOn: "2027-08-01" });
  });

  it("cancel in the trial costs nothing; withdraw before it takes effect", () => {
    const c = planCancel([monthly], "2026-12-05", 0, false);
    expect(c.end).toEqual([{ id: "m", endsOn: "2027-02-28", cancelled: true, thenMonthly: false }]);
    const cancelled = { ...monthly, endsOn: "2027-02-28", cancelledAt: "2026-12-05T09:00:00Z" };
    expect(termForMonth([cancelled], "2027-03")).toBeNull();
    expect(subscriptionView([cancelled], "2026-12-06").ended).toBe(true);
    expect(planWithdraw([cancelled], "2026-12-06")).toEqual({ remove: [], end: [], reopen: ["m"], add: null });
    expect(() => planWithdraw([cancelled], "2027-03-01")).toThrow(/keine Kündigung/);
    expect(() => planCancel([cancelled], "2026-12-06", 0, false)).toThrow(/keinen laufenden Vertrag/);
  });

  it("withdraw removes a planned follow-up term", () => {
    const annual = term({ id: "a", interval: "annual", startsOn: "2027-03-01", endsOn: "2028-02-29", cancelledAt: "2027-05-01T00:00:00Z", thenMonthly: true });
    const follow = term({ id: "f", interval: "monthly", startsOn: "2028-03-01" });
    expect(planWithdraw([annual, follow], "2028-02-29")).toEqual({ remove: ["f"], end: [], reopen: ["a"], add: null });
    const v = subscriptionView([annual, follow], "2027-06-01");
    expect(v.current?.id).toBe("a");
    expect(v.next?.id).toBe("f");
    expect(v.contractEndsOn).toBeNull();
  });

  it("withdraw of a cancelled annual term that never started removes its monthly follow-up (same first day)", () => {
    const monthly = term({ id: "m", interval: "monthly", startsOn: "2026-09-01", endsOn: "2026-11-30" });
    const annual = term({ id: "a", interval: "annual", startsOn: "2026-12-01", endsOn: "2026-11-30", cancelledAt: "2026-11-20T09:00:00Z", thenMonthly: true });
    const follow = term({ id: "f", interval: "monthly", startsOn: "2026-12-01" });
    expect(planWithdraw([monthly, annual, follow], "2026-11-20")).toEqual({ remove: ["f"], end: [], reopen: ["a"], add: null });
  });

  it("view: running annual shows the current term end; contract end without follow-up", () => {
    const annual = term({ id: "a", interval: "annual", startsOn: "2027-03-01" });
    expect(subscriptionView([annual], "2028-04-01")).toMatchObject({ currentTermEndsOn: "2028-08-31", contractEndsOn: null, ended: false });
    const cancelled = { ...annual, endsOn: "2028-08-31", cancelledAt: "2028-04-01T00:00:00Z" };
    expect(subscriptionView([cancelled], "2028-04-01")).toMatchObject({ currentTermEndsOn: null, contractEndsOn: "2028-08-31", ended: false });
  });
});

describe("price per month with subscription", () => {
  const sub = (interval: "annual" | "monthly" | null, trialEndsOn: string | null = null) => ({ trialEndsOn, interval, monthlyPriceCents: 650 });
  it("trial free, ended free, annual standard, monthly price, special and promo on top", () => {
    expect(billingConditionFor(null, 500, "2027-02", null, null, sub("monthly", "2027-02-14"))).toEqual({ condition: "trial", unitPriceCents: 0 });
    expect(billingConditionFor(null, 500, "2027-03", null, null, sub(null))).toEqual({ condition: "ended", unitPriceCents: 0 });
    expect(billingConditionFor(null, 500, "2027-03", null, null, sub("annual"))).toEqual({ condition: "standard", unitPriceCents: 500 });
    expect(billingConditionFor(null, 500, "2027-03", null, null, sub("monthly"))).toEqual({ condition: "monthly", unitPriceCents: 650 });
    expect(billingConditionFor(null, 500, "2027-03", null, { discountPercent: 50 }, sub("monthly"))).toEqual({ condition: "promo", unitPriceCents: 325 });
    const special = { plan: "standard" as const, status: "active" as const, employeePriceCents: 400, freeOfCharge: false, conditionValidFrom: null, conditionValidUntil: null };
    expect(billingConditionFor(special, 500, "2027-03", null, null, sub("monthly"))).toEqual({ condition: "special", unitPriceCents: 400 });
    expect(billingConditionFor(special, 500, "2027-03", { status: "suspended", since: "2027-01-01T00:00:00Z" }, null, sub("monthly"))).toEqual({ condition: "tenant_suspended", unitPriceCents: 0 });
  });
});

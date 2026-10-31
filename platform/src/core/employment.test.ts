import { describe, expect, it } from "vitest";
import type { EmploymentContract } from "./types";
import {
  contractForMonth, employmentAccount, monthsBetween, statutoryLimitsFor, suggestedMinijobTargetMinutes, targetState,
  validateEmploymentInput, type EmploymentInput,
} from "./employment";

const H = 60;

function version(v: Partial<EmploymentContract> & Pick<EmploymentContract, "validFrom">): EmploymentContract {
  return {
    employeeId: "e1", tenantId: "t1", employmentType: "minijob", hourlyWageCents: 1400, monthlyTargetMinutes: 43 * H,
    carryOverMinutes: 0, updatedAt: "2026-09-01T00:00:00Z", ...v,
  };
}

const input = (v: Partial<EmploymentInput> = {}): EmploymentInput => ({
  validFrom: "2026-10", employmentType: "minijob", hourlyWageCents: 1400, monthlyTargetMinutes: 43 * H, carryOverMinutes: 0, ...v,
});

describe("statutory values", () => {
  it("minimum wage and Minijob limit per month", () => {
    expect(statutoryLimitsFor("2024-12")).toBeNull();
    expect(statutoryLimitsFor("2025-06")).toMatchObject({ minimumWageCents: 1282, minijobLimitCents: 55600 });
    expect(statutoryLimitsFor("2026-10")).toMatchObject({ minimumWageCents: 1390, minijobLimitCents: 60300 });
    expect(statutoryLimitsFor("2027-01")).toMatchObject({ minimumWageCents: 1460, minijobLimitCents: 63300 });
  });

  it("Minijob limit = minimum wage × 130 / 3 rounded up to full euros", () => {
    for (const l of [statutoryLimitsFor("2025-01")!, statutoryLimitsFor("2026-01")!, statutoryLimitsFor("2027-01")!]) {
      expect(l.minijobLimitCents).toBe(Math.ceil((l.minimumWageCents * 130) / 3 / 100) * 100);
    }
  });

  it("suggests the full hours of a Minijob (14 € in 2026 → 43 h)", () => {
    expect(suggestedMinijobTargetMinutes(1400, "2026-10")).toBe(43 * H);
    expect(suggestedMinijobTargetMinutes(1390, "2026-10")).toBe(43 * H);
    expect(suggestedMinijobTargetMinutes(1500, "2027-03")).toBe(42 * H);
    expect(suggestedMinijobTargetMinutes(null, "2026-10")).toBeNull();
    expect(suggestedMinijobTargetMinutes(1400, "2020-01")).toBeNull();
  });
});

describe("validateEmploymentInput", () => {
  it("accepts valid data incl. open target and no wage", () => {
    expect(validateEmploymentInput(input())).toEqual(input());
    expect(validateEmploymentInput(input({ employmentType: "offen", hourlyWageCents: null, monthlyTargetMinutes: null }))).toBeTruthy();
    expect(validateEmploymentInput(input({ carryOverMinutes: -300 }))).toBeTruthy();
  });

  it("rejects invalid values with German messages", () => {
    expect(() => validateEmploymentInput(input({ validFrom: "2026-13" }))).toThrow(/Monat/);
    expect(() => validateEmploymentInput(input({ employmentType: "x" as never }))).toThrow(/Art des Arbeitsvertrags/);
    expect(() => validateEmploymentInput(input({ hourlyWageCents: 0 }))).toThrow(/Stundenlohn/);
    expect(() => validateEmploymentInput(input({ hourlyWageCents: 100_001 }))).toThrow(/Stundenlohn/);
    expect(() => validateEmploymentInput(input({ hourlyWageCents: 12.5 }))).toThrow(/Stundenlohn/);
    expect(() => validateEmploymentInput(input({ monthlyTargetMinutes: 0 }))).toThrow(/Soll-Stunden/);
    expect(() => validateEmploymentInput(input({ monthlyTargetMinutes: 401 * H }))).toThrow(/Soll-Stunden/);
    expect(() => validateEmploymentInput(input({ carryOverMinutes: 2001 * H }))).toThrow(/Übertrag/);
  });
});

describe("contract versions", () => {
  it("picks the latest version that has started", () => {
    const vs = [version({ validFrom: "2026-09" }), version({ validFrom: "2026-11", monthlyTargetMinutes: 40 * H })];
    expect(contractForMonth(vs, "2026-08")).toBeNull();
    expect(contractForMonth(vs, "2026-10")?.validFrom).toBe("2026-09");
    expect(contractForMonth(vs, "2026-11")?.validFrom).toBe("2026-11");
    expect(contractForMonth([...vs].reverse(), "2027-02")?.validFrom).toBe("2026-11");
  });

  it("months between two months, across the year", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthsBetween("2026-11", "2026-10")).toEqual([]);
  });
});

describe("employmentAccount", () => {
  const worked = (m: Record<string, number>) => (month: string) => m[month] ?? 0;

  it("Minijob 43 h: Mehrstunden go into the account, Minderstunden of finished months reduce it", () => {
    const acc = employmentAccount({
      versions: [version({ validFrom: "2026-08" })],
      payableMinutes: worked({ "2026-08": 47 * H, "2026-09": 40 * H, "2026-10": 45 * H + 30 }),
      currentMonth: "2026-10",
    });
    expect(acc.startMonth).toBe("2026-08");
    expect(acc.hasAccount).toBe(true);
    expect(acc.months.map((m) => [m.month, m.differenceMinutes, m.bookedMinutes, m.balanceAfterMinutes])).toEqual([
      ["2026-08", 4 * H, 4 * H, 4 * H],
      ["2026-09", -3 * H, -3 * H, H],
      ["2026-10", 2 * H + 30, 2 * H + 30, 3 * H + 30],
    ]);
    expect(acc.balanceMinutes).toBe(3 * H + 30);
    expect(acc.current?.running).toBe(true);
    expect(targetState(acc.months[0]!)).toBe("over");
    expect(targetState(acc.months[1]!)).toBe("under");
  });

  it("the running month books only Mehrstunden (Minderstunden are not final yet)", () => {
    const acc = employmentAccount({
      versions: [version({ validFrom: "2026-10" })], payableMinutes: worked({ "2026-10": 20 * H }), currentMonth: "2026-10",
    });
    expect(acc.current).toMatchObject({ differenceMinutes: -23 * H, bookedMinutes: 0, running: true });
    expect(acc.balanceMinutes).toBe(0);
    expect(targetState(acc.current!)).toBe("running");
    expect(targetState({ differenceMinutes: 0, running: false })).toBe("met");
  });

  it("earnings, Minijob limit and minimum wage hints", () => {
    const acc = employmentAccount({
      versions: [version({ validFrom: "2026-10", hourlyWageCents: 1400 })],
      payableMinutes: worked({ "2026-10": 44 * H }), currentMonth: "2026-10",
    });
    expect(acc.current).toMatchObject({ earningsCents: 61600, minijobLimitCents: 60300, overMinijobLimit: true, belowMinimumWage: false });
    const low = employmentAccount({
      versions: [version({ validFrom: "2026-10", hourlyWageCents: 1200, employmentType: "teilzeit" })],
      payableMinutes: worked({ "2026-10": 10 * H + 15 }), currentMonth: "2026-10",
    });
    expect(low.current).toMatchObject({ earningsCents: 12300, minijobLimitCents: null, overMinijobLimit: false, belowMinimumWage: true });
  });

  it("open contract: no target, no account; wage still gives earnings", () => {
    const acc = employmentAccount({
      versions: [version({ validFrom: "2026-09", employmentType: "offen", monthlyTargetMinutes: null })],
      payableMinutes: worked({ "2026-09": 100 * H, "2026-10": 5 * H }), currentMonth: "2026-10",
    });
    expect(acc.hasAccount).toBe(false);
    expect(acc.balanceMinutes).toBe(0);
    expect(acc.current).toMatchObject({ differenceMinutes: null, bookedMinutes: 0, earningsCents: 7000 });
    expect(targetState(acc.current!)).toBe("open");
  });

  it("versions: a new target applies from its month on; carry-over is booked once", () => {
    const acc = employmentAccount({
      versions: [
        version({ validFrom: "2026-08", carryOverMinutes: 10 * H }),
        version({ validFrom: "2026-10", employmentType: "teilzeit", monthlyTargetMinutes: 80 * H, carryOverMinutes: -2 * H }),
      ],
      payableMinutes: worked({ "2026-08": 43 * H, "2026-09": 50 * H, "2026-10": 81 * H, "2026-11": 70 * H }),
      currentMonth: "2026-12",
    });
    expect(acc.months.map((m) => [m.month, m.targetMinutes, m.bookedMinutes])).toEqual([
      ["2026-08", 43 * H, 10 * H],
      ["2026-09", 43 * H, 7 * H],
      ["2026-10", 80 * H, -H],
      ["2026-11", 80 * H, -10 * H],
      ["2026-12", 80 * H, 0],
    ]);
    expect(acc.balanceMinutes).toBe(6 * H);
  });

  it("no versions or a contract starting later → empty account", () => {
    expect(employmentAccount({ versions: [], payableMinutes: () => 0, currentMonth: "2026-10" }))
      .toEqual({ startMonth: null, months: [], balanceMinutes: 0, current: null, hasAccount: false });
    const later = employmentAccount({ versions: [version({ validFrom: "2026-12" })], payableMinutes: () => 0, currentMonth: "2026-10" });
    expect(later.months).toEqual([]);
    expect(later.current).toBeNull();
  });
});

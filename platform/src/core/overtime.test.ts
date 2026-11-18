import { describe, expect, it } from "vitest";
import { splitOvertime, targetForMonth } from "./overtime";
import type { EmploymentContract } from "./types";

const e = (date: string, start: string, end: string, pause = 0) => ({ date, start, end, pause });

describe("splitOvertime", () => {
  // 3 × 10 h + 1 × 0,25 h = 30,25 h, target 28 h (the Minijob example of the owner).
  const entries = [e("2026-11-18", "15:00", "16:15"), e("2026-11-02", "08:00", "18:00"), e("2026-11-05", "08:00", "18:00"), e("2026-11-10", "08:00", "18:00")]
    .map((x) => ({ ...x, note: "" }));

  it("puts the latest hours of the month onto the overtime sheet, splitting the crossing entry", () => {
    const s = splitOvertime({ entries, targetMinutes: 28 * 60, payableMinutes: 31 * 60 + 15 })!;
    expect(s.overtimeMinutes).toBe(3 * 60 + 15);
    expect(s.overtime.map((x) => [x.date, x.minutes, x.partial])).toEqual([["2026-11-10", 120, true], ["2026-11-18", 75, false]]);
    expect(s.regular.map((x) => [x.date, x.minutes, x.partial])).toEqual([["2026-11-02", 600, false], ["2026-11-05", 600, false], ["2026-11-10", 480, true]]);
    // Nothing lost, nothing added.
    const sum = (l: { minutes: number }[]) => l.reduce((a, x) => a + x.minutes, 0);
    expect(sum(s.regular)).toBe(28 * 60);
    expect(sum(s.regular) + sum(s.overtime)).toBe(31 * 60 + 15);
  });

  it("returns null without target or without overtime", () => {
    expect(splitOvertime({ entries, targetMinutes: null, payableMinutes: 1875 })).toBeNull();
    expect(splitOvertime({ entries, targetMinutes: 1875, payableMinutes: 1875 })).toBeNull();
    expect(splitOvertime({ entries, targetMinutes: 2000, payableMinutes: 1875 })).toBeNull();
  });

  it("uses payable minutes: hours moved to the work-time account are not overtime", () => {
    const s = splitOvertime({ entries, targetMinutes: 28 * 60, payableMinutes: 28 * 60 + 30 })!;
    expect(s.overtimeMinutes).toBe(30);
    expect(s.overtime).toEqual([expect.objectContaining({ date: "2026-11-18", minutes: 30, partial: true })]);
  });
});

describe("targetForMonth", () => {
  const v = (validFrom: string, target: number | null): EmploymentContract => ({
    employeeId: "e", tenantId: "t", validFrom, employmentType: "minijob", hourlyWageCents: 1500, monthlyTargetMinutes: target, carryOverMinutes: 0, updatedAt: "",
  });
  it("takes the version in force", () => {
    expect(targetForMonth([v("2026-10", 1680), v("2026-12", null)], "2026-11")).toBe(1680);
    expect(targetForMonth([v("2026-10", 1680), v("2026-12", null)], "2026-12")).toBeNull();
    expect(targetForMonth([], "2026-11")).toBeNull();
  });
});

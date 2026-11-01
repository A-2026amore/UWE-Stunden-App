import { describe, expect, it } from "vitest";
import { dailyBars, hoursAxis, isoWeek, minutesPerDay, weeklyBars } from "./charts";

const e = (date: string, start: string, end: string, pauseMinutes = 0, deletedAt: string | null = null) =>
  ({ date, start, end, pauseMinutes, deletedAt });

describe("chart aggregations", () => {
  it("sums net minutes per day, ignores deleted entries and other months", () => {
    const m = minutesPerDay([
      e("2026-11-02", "08:00", "12:00"), e("2026-11-02", "13:00", "16:30", 30),
      e("2026-11-03", "22:00", "06:00", 30), // over midnight, counted on the start day
      e("2026-11-04", "08:00", "10:00", 0, "2026-11-05T10:00:00Z"),
      e("2026-10-31", "08:00", "10:00"),
    ], "2026-11");
    expect(m.size).toBe(30);
    expect(m.get("2026-11-02")).toBe(240 + 180);
    expect(m.get("2026-11-03")).toBe(450);
    expect(m.get("2026-11-04")).toBe(0);
  });

  it("ISO calendar weeks", () => {
    expect(isoWeek("2026-11-20")).toBe(47);
    expect(isoWeek("2026-01-01")).toBe(1);
    expect(isoWeek("2027-01-01")).toBe(53);
    expect(isoWeek("2026-12-28")).toBe(53);
  });

  it("daily bars: weekend muted, today highlighted, readable titles", () => {
    const bars = dailyBars([e("2026-11-20", "08:00", "12:30")], "2026-11", "2026-11-20");
    expect(bars).toHaveLength(30);
    const today = bars[19]!;
    expect(today).toMatchObject({ label: "20", value: 4.5, highlight: true, muted: false });
    expect(today.title).toBe("Fr, 20.11.2026: 4,50 Std.");
    expect(bars[20]!.muted).toBe(true); // Saturday 21.11.
  });

  it("weekly bars add up to the month", () => {
    const entries = [e("2026-11-02", "08:00", "16:00", 30), e("2026-11-20", "08:00", "12:00")];
    const bars = weeklyBars(entries, "2026-11", "2026-11-20");
    expect(bars.map((b) => b.label)).toEqual(["KW 44", "KW 45", "KW 46", "KW 47", "KW 48", "KW 49"]);
    expect(bars.reduce((s, b) => s + b.value, 0)).toBeCloseTo(11.5);
    expect(bars.find((b) => b.highlight)?.label).toBe("KW 47");
    expect(hoursAxis(7.5)).toBe("7,5 h");
  });
});
